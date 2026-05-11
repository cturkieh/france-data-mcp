/**
 * Rate limiting pour l'endpoint MCP public.
 *
 * Stratégie : sliding window 60 req/min par IP (paramétrable via env).
 * Backend principal : Upstash Redis REST (latence sub-50ms depuis Vercel
 * Frankfurt, free tier suffit largement). Fallback in-memory si les env
 * Upstash sont absents OU si l'appel Upstash throw — on choisit le
 * fail-open (laisser passer) plutôt que fail-closed, parce qu'un MCP qui
 * crash sur un blip Redis casserait l'UX de tous les users en cascade.
 *
 * Le fallback in-memory ne partage pas l'état entre invocations Vercel
 * serverless. C'est OK comme protection de dernier recours : il bloque
 * les bursts à l'intérieur d'une même invocation chaude (cold start
 * réinitialise le Map), pas les flood distribués. Pour ça il faut Upstash.
 *
 * IP : extraite de `x-forwarded-for` (Vercel pose toujours ce header).
 * On hash en SHA-256 tronqué 16 chars avant tout log/stockage Redis pour
 * RGPD (aucune IP en clair persistée).
 */

import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { VercelRequest } from "@vercel/node";

const WINDOW = "1 m" as const;
const DEFAULT_LIMIT = 60;

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the next request will be allowed (only meaningful if !success). */
  resetAt: number;
  /** Seconds to wait before retry. Returned to the client in `Retry-After`. */
  retryAfterSeconds: number;
  /** Which backend served the decision — useful in logs. */
  backend: "upstash" | "memory" | "disabled";
};

/** Built lazily on first call so unit tests can mutate process.env. */
let cachedLimiter: Ratelimit | null | undefined;

/**
 * Returns the limit from env or the default. Exported for tests + reused by
 * the in-memory fallback so both backends share the same number.
 */
export function getRateLimitPerMinute(): number {
  const raw = process.env.RATE_LIMIT_PER_MINUTE;
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

function isDisabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED === "false";
}

function getUpstashLimiter(): Ratelimit | null {
  if (cachedLimiter !== undefined) return cachedLimiter;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    cachedLimiter = null;
    return null;
  }
  const redis = new Redis({ url, token });
  cachedLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(getRateLimitPerMinute(), WINDOW),
    prefix: "france-data-mcp:ratelimit",
    analytics: false,
  });
  return cachedLimiter;
}

/** Test-only hook. Resets the cached limiter so env changes take effect. */
export function __resetForTesting(): void {
  cachedLimiter = undefined;
  memoryBuckets.clear();
  lastUpstashErrorLogBySig.clear();
}

/**
 * Throttle pour le log d'erreur Upstash : un outage de 60 minutes à 60 req/min
 * × N IPs émettrait des centaines de milliers de lignes `console.error`, ce
 * qui pollue Vercel logs et fait exploser la facture Sentry. On garde un log
 * par signature d'erreur par minute. Pourquoi par signature et pas global :
 * si l'erreur passe de `ECONNRESET` (blip réseau) à `WRONGPASS` (token révoqué)
 * en moins de 60s, un throttle global masquerait le second mode pendant
 * presque toute la fenêtre alors que c'est une panne distincte qui mérite son
 * propre log. La métrique fine (chaque fallback) reste traçable côté ops via
 * `extra.rl_backend: "memory"` qui est émis dans chaque event `tools/call`.
 */
const lastUpstashErrorLogBySig = new Map<string, number>();
const UPSTASH_ERROR_LOG_THROTTLE_MS = 60_000;

function errorSignature(err: unknown): string {
  if (err instanceof Error) return `${err.constructor.name}:${err.message.slice(0, 80)}`;
  return String(err).slice(0, 80);
}

/**
 * Extracts the caller IP from Vercel request headers.
 *
 * SECURITY : `x-forwarded-for` est trivialement spoofable côté client. Vercel
 * APPEND la vraie IP edge en queue (`<client_supplied>, <real_client>, <vercel>`),
 * donc lire l'élément de gauche revient à donner au client le contrôle total
 * du rate limit (spoofer une IP différente à chaque requête = bypass total).
 *
 * Source de vérité non-spoofable : `x-real-ip` que Vercel pose toujours en
 * single-value avec la vraie IP edge. C'est notre header prioritaire. Fallback
 * sur le DERNIER segment non vide de `x-forwarded-for` (segment Vercel) puis
 * sur `socket.remoteAddress` en dernier recours.
 */
export function extractIp(req: VercelRequest): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** Hash IP to SHA-256 truncated to 16 chars. Stable across invocations. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* In-memory fallback                                                 */
/* ------------------------------------------------------------------ */

type MemoryBucket = { count: number; resetAt: number };
const memoryBuckets = new Map<string, MemoryBucket>();
/** Bound memory bucket map to avoid unbounded growth on a hot instance. */
const MEMORY_MAX_KEYS = 10_000;

function memoryRateLimit(key: string): RateLimitResult {
  const limit = getRateLimitPerMinute();
  const now = Date.now();
  const windowMs = 60_000;
  const existing = memoryBuckets.get(key);

  if (!existing || existing.resetAt <= now) {
    if (memoryBuckets.size >= MEMORY_MAX_KEYS) {
      // Hot instance saw too many distinct IPs in 1 minute — drop the
      // oldest half (Map preserves insertion order) before inserting.
      const drop = Math.floor(MEMORY_MAX_KEYS / 2);
      let removed = 0;
      for (const k of memoryBuckets.keys()) {
        if (removed >= drop) break;
        memoryBuckets.delete(k);
        removed += 1;
      }
    }
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return {
      success: true,
      limit,
      remaining: limit - 1,
      resetAt: now + windowMs,
      retryAfterSeconds: 0,
      backend: "memory",
    };
  }

  existing.count += 1;
  const success = existing.count <= limit;
  return {
    success,
    limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: success ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    backend: "memory",
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Check whether a given client may proceed.
 *
 * Resolution order:
 *  1. If RATE_LIMIT_ENABLED=false → always allow (`backend: "disabled"`).
 *  2. Try Upstash (sliding window, distributed).
 *  3. On any Upstash failure → log and fall back to in-memory window.
 */
export async function checkRateLimit(ipHash: string): Promise<RateLimitResult> {
  if (isDisabled()) {
    return {
      success: true,
      limit: getRateLimitPerMinute(),
      remaining: getRateLimitPerMinute(),
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
      backend: "disabled",
    };
  }

  const limiter = getUpstashLimiter();
  if (limiter) {
    try {
      const res = await limiter.limit(ipHash);
      const retryAfterSeconds = res.success
        ? 0
        : Math.max(1, Math.ceil((res.reset - Date.now()) / 1000));
      return {
        success: res.success,
        limit: res.limit,
        remaining: res.remaining,
        resetAt: res.reset,
        retryAfterSeconds,
        backend: "upstash",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const sig = errorSignature(err);
      const now = Date.now();
      const last = lastUpstashErrorLogBySig.get(sig) ?? 0;
      if (now - last >= UPSTASH_ERROR_LOG_THROTTLE_MS) {
        console.error(`[france-data-mcp] upstash rate-limit error, falling back: ${message}`);
        lastUpstashErrorLogBySig.set(sig, now);
      }
      // fallthrough to memory
    }
  }

  return memoryRateLimit(ipHash);
}
