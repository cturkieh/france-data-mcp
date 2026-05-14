/**
 * Logging structuré pour l'endpoint MCP public.
 *
 * On émet une ligne JSON par requête MCP (méthode + tool + IP hashée +
 * User-Agent + durée + statut). Vercel capture stdout/stderr et l'affiche
 * tel quel dans `vercel logs`, donc une ligne JSON est directement
 * parsable côté ops (jq, BigQuery, Logs Drain externe).
 *
 * Pas d'IP en clair, pas d'argument tool (les `tools/call` peuvent contenir
 * un nom de commune ou un SIREN — anodin, mais on évite par défaut pour
 * rester safe RGPD). Si tu en as besoin un jour pour debug, ajoute un
 * flag `LOG_TOOL_ARGS=true` plutôt que de l'activer en dur.
 *
 * Push miroir vers Axiom (dataset structuré, recherche/agrégats sur 30j) si
 * `AXIOM_TOKEN` + `AXIOM_DATASET` sont set. Buffer module-level vidé en fin
 * de requête via `flushMcpEventsToAxiom()` (à appeler dans le `finally` du
 * handler root). Fail-soft : Axiom down ou env absente = no-op, jamais throw.
 */

import type { VercelRequest } from "@vercel/node";

export type LogLevel = "info" | "warn" | "error";

/**
 * Contexte partagé d'une requête HTTP MCP, calculé une fois en début de
 * handler et réutilisé sur tous les logs / events Sentry / metrics. Vit ici
 * pour rester source-of-truth — `sentry.ts` et `mcp.ts` l'importent.
 */
export type McpRequestContext = {
  ipHash: string;
  userAgent: string;
};

/**
 * Outcomes possibles d'une requête MCP. Union fermé pour catch les fautes de
 * frappe au compile time et garder l'agrégation BigQuery/jq fiable côté ops.
 */
export type McpOutcome =
  | "success"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "internal_error";

export type McpEventInput = {
  /** JSON-RPC method (`tools/call`, `tools/list`, `initialize`, …). */
  method: string;
  /** Tool name when method === `tools/call`. */
  tool?: string;
  ipHash: string;
  userAgent: string;
  durationMs: number;
  /** HTTP-ish status: 200 OK, 429 rate limited, 400 bad request, 500 error. */
  status: number;
  outcome: McpOutcome;
  /** Optional extra fields (e.g. rate-limit backend, error message). */
  extra?: Record<string, unknown>;
  /** Override default `info` level (warn/error map to console.warn/error). */
  level?: LogLevel;
};

/** Truncate User-Agent to a reasonable length so logs stay scannable. */
const UA_MAX_LEN = 200;

/**
 * Read User-Agent header in a normalised, truncated form. Empty header is
 * reported as `"unknown"` so the field is always present in logs.
 */
export function extractUserAgent(req: VercelRequest): string {
  const ua = req.headers["user-agent"];
  if (typeof ua !== "string" || ua.length === 0) return "unknown";
  return ua.length > UA_MAX_LEN ? `${ua.slice(0, UA_MAX_LEN)}…` : ua;
}

function levelFromStatus(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

/**
 * Construit les champs canoniques d'un event. Le caller fusionne ensuite avec
 * `extra` pour le payload final, en spreadant `{ ...extra, ...canonical }` pour
 * garantir qu'aucune clé custom ne peut écraser `status`, `outcome`, `method`,
 * etc. — c'est le contrat qu'on documente dans `McpEventInput`.
 */
function buildCanonicalRecord(event: McpEventInput): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    component: "mcp-endpoint",
    method: event.method,
    ...(event.tool ? { tool: event.tool } : {}),
    ip_hash: event.ipHash,
    user_agent: event.userAgent,
    duration_ms: event.durationMs,
    status: event.status,
    outcome: event.outcome,
  };
}

/** Emit a single structured log line + enqueue pour push Axiom (si configuré). */
export function logMcpEvent(event: McpEventInput): void {
  const canonical = buildCanonicalRecord(event);
  const extra = event.extra ?? {};
  const payload = { ...extra, ...canonical };
  const line = serializeSafe(payload, canonical);
  const level = event.level ?? levelFromStatus(event.status);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  enqueueAxiomEvent(payload);
}

/**
 * Fail-soft sur payload non-sérialisable (objet circulaire dans `extra`) :
 * on retombe sur les champs canoniques seuls plutôt que de throw et perdre
 * toute la ligne. La shape dégradée reste cohérente avec la shape normale.
 */
function serializeSafe(
  payload: Record<string, unknown>,
  canonicalOnly: Record<string, unknown>,
): string {
  try {
    return JSON.stringify(payload);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[france-data-mcp] logMcpEvent: payload non-serialisable: ${reason}`);
    return JSON.stringify({ ...canonicalOnly, log_serialize_error: reason });
  }
}

/* ------------------------------------------------------------------ */
/* Axiom push (logs miroir pour recherche/agrégats sur 30j)           */
/* ------------------------------------------------------------------ */

/** Event au format Axiom : exige `_time` (ISO 8601) que la plateforme utilise pour indexer. */
type AxiomEvent = Record<string, unknown> & { _time: string };

/**
 * Buffer module-level d'events à envoyer en batch à Axiom. Rempli par
 * `enqueueAxiomEvent` (appelée par `logMcpEvent`), vidé par `flushMcpEventsToAxiom`
 * (à appeler dans le `finally` du handler root). On garde un cap dur pour éviter
 * qu'une instance Vercel chaude qui n'aurait jamais reçu de flush (cas pathologique)
 * accumule indéfiniment en mémoire.
 */
const axiomBuffer: AxiomEvent[] = [];
const AXIOM_BUFFER_MAX = 500;
const AXIOM_INGEST_TIMEOUT_MS = 1500;
const AXIOM_DEFAULT_HOST = "api.axiom.co";

let bufferOverflowWarned = false;

function enqueueAxiomEvent(payload: Record<string, unknown>): void {
  if (axiomBuffer.length >= AXIOM_BUFFER_MAX) {
    axiomBuffer.shift();
    if (!bufferOverflowWarned) {
      bufferOverflowWarned = true;
      console.warn(
        `[france-data-mcp] Axiom buffer overflow (>${AXIOM_BUFFER_MAX} events sans flush) — drop du plus ancien. Indique soit un trafic burst soit un flush jamais déclenché. Investiguer le finally du handler root.`,
      );
    }
  }
  // Axiom indexe les events par `_time` (ISO 8601). On réutilise le `ts` canonique.
  const ts = typeof payload.ts === "string" ? payload.ts : new Date().toISOString();
  axiomBuffer.push({ ...payload, _time: ts });
}

/**
 * Flush le buffer vers Axiom en un seul POST. Appelée dans le `finally` du
 * handler root, en parallèle de `flushSentry` via `Promise.allSettled`.
 *
 * **Latence client** : sur `@vercel/node`, la réponse HTTP n'est libérée au
 * gateway qu'à la résolution du handler async. Le `await` dans le `finally`
 * bloque donc la réponse jusqu'à `AXIOM_INGEST_TIMEOUT_MS` (1.5s max si Axiom
 * lent). Acceptable pour un endpoint MCP non-temps-réel. Si la latence p99
 * devient un problème, migrer vers `waitUntil` de `@vercel/functions`.
 *
 * No-op si `AXIOM_TOKEN`/`AXIOM_DATASET` absent (dev local marche sans).
 * Fail-soft : tout échec réseau ou 4xx/5xx Axiom est loggué en warn et drop.
 * On ne retry PAS — sur serverless, les retries augmentent la latence et la
 * complexité sans bénéfice (un event perdu n'est pas critique pour observabilité).
 *
 * Host configurable via `AXIOM_HOST` (default `api.axiom.co` = région US).
 * Pour un dataset en région EU, utiliser `api.eu.axiom.co` — cohérence avec
 * la localisation des données promise dans PRIVACY.md.
 */
export async function flushMcpEventsToAxiom(): Promise<void> {
  if (axiomBuffer.length === 0) return;
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) {
    // Drop silencieux : pas configuré = dev local OU env vars oubliées. Le
    // warn dédié pour "AXIOM_TOKEN absent en prod" est dans `warnMissingAxiomOnce`.
    axiomBuffer.length = 0;
    warnMissingAxiomOnce();
    return;
  }
  const host = process.env.AXIOM_HOST?.trim() || AXIOM_DEFAULT_HOST;
  const batch = axiomBuffer.splice(0);
  try {
    const res = await fetch(
      `https://${host}/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(AXIOM_INGEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch (bodyErr) {
        const bodyReason = bodyErr instanceof Error ? bodyErr.message : String(bodyErr);
        console.warn(`[france-data-mcp] Axiom ingest body unreadable: ${bodyReason}`);
      }
      console.warn(
        `[france-data-mcp] Axiom ingest HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[france-data-mcp] Axiom ingest error: ${reason}`);
  }
}

/**
 * Émet UN warn par instance Vercel si Axiom n'est pas configuré en production.
 * Symétrique à `warnMissingSaltOnce` côté rate-limit : sans ce signal, un oubli
 * d'env var Axiom = dégrade silencieusement la rétention 30j promise par PRIVACY.md.
 */
let axiomWarningEmitted = false;
function warnMissingAxiomOnce(): void {
  if (axiomWarningEmitted) return;
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "";
  if (env !== "production") return;
  axiomWarningEmitted = true;
  console.error(
    "[france-data-mcp] AXIOM_TOKEN ou AXIOM_DATASET absent en production — logs détaillés non persistés au-delà de la fenêtre Vercel Runtime Logs. PRIVACY.md rétention 30j non tenue.",
  );
}

/**
 * Test-only : reset complet de l'état module Axiom (buffer + flags one-shot
 * warn). À appeler dans `beforeEach`/`afterEach` pour isoler chaque test.
 */
export function __resetAxiomStateForTesting(): void {
  axiomBuffer.length = 0;
  axiomWarningEmitted = false;
  bufferOverflowWarned = false;
}

/** Test-only : taille du buffer pour les assertions de tests. */
export function __getAxiomBufferLengthForTesting(): number {
  return axiomBuffer.length;
}
