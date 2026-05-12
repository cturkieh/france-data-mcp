/**
 * Intégration Sentry pour l'endpoint MCP public.
 *
 * Mode : capture d'erreurs uniquement (pas de tracing ni profiling) — sur
 * Vercel serverless, l'init coûte sur le cold start et le tracing produit
 * du bruit pour un endpoint stateless qui répond en quelques secondes. Si
 * besoin un jour d'instrumentation perf, passer par OTLP côté Vercel.
 *
 * Comportement :
 *  - Init idempotente déclenchée au 1er `captureMcpError` (lazy : un cold
 *    start `tools/list` qui ne lève aucune erreur ne paye pas l'init).
 *  - No-op transparent si `SENTRY_DSN` absent ou vide → le code appelant
 *    n'a aucune condition à vérifier, et les tests / dev local marchent
 *    sans config Sentry.
 *  - `flushSentry()` à appeler en fin de requête : Vercel coupe le process
 *    juste après la réponse HTTP, ce qui peut perdre des events en attente.
 */

import * as Sentry from "@sentry/node";
import type { McpOutcome, McpRequestContext } from "./observability.js";

let initialized = false;
let enabled = false;

/** Reset state — exposé pour les tests uniquement. Ne pas appeler en prod. */
export function __resetSentryForTesting(): void {
  initialized = false;
  enabled = false;
}

/**
 * Initialise Sentry si `SENTRY_DSN` est défini. Idempotent. Sécuritaire à
 * appeler plusieurs fois (par exemple dans un test ou en cold start chaud).
 */
function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No-op : on logge une seule fois pour rendre le no-op visible côté ops
    // (un déploiement prod sans DSN doit pouvoir être détecté).
    console.warn("[france-data-mcp] Sentry désactivé (SENTRY_DSN absent)");
    return;
  }

  try {
    Sentry.init({
      dsn,
      // `||` (pas `??`) pour traiter les env vars vides comme non set —
      // les CI/CD propagent souvent les vars en string vide quand elles
      // ne sont pas configurées, et on veut le même fallback dans ce cas.
      environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA || process.env.SENTRY_RELEASE || undefined,
      // Pas de tracing : l'observabilité fine passe par les logs JSON
      // structurés (cf. `observability.ts`).
      tracesSampleRate: 0,
      // Pas de PII : on ne logge déjà ni IP claire ni arguments tool.
      sendDefaultPii: false,
      // Filtre defense-in-depth : si un jour un appelant met sa clé API
      // dans l'URL d'un tool et que le SDK la pick up dans un breadcrumb,
      // on ne l'envoie pas à Sentry.
      beforeSend(event) {
        const req = event.request;
        if (!req?.headers) return event;
        // `req.headers` peut techniquement contenir des `string[]` (multi-header
        // côté Node http natif) même si le SDK type ça en `string`. On normalise
        // pour ne pas mentir à Sentry sur la shape.
        const sanitized: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          const lower = key.toLowerCase();
          if (lower === "authorization" || lower === "cookie" || lower === "x-api-key") continue;
          sanitized[key] = value;
        }
        req.headers = sanitized as typeof req.headers;
        return event;
      },
    });
    enabled = true;
  } catch (err) {
    // Si init échoue (DSN malformé, etc.) on dégrade en no-op plutôt que
    // de crash le handler MCP — Sentry n'est pas un service critique.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[france-data-mcp] Sentry init failed: ${reason}`);
    enabled = false;
  }
}

export type SentryContext = McpRequestContext & {
  method: string;
  tool?: string;
  outcome: McpOutcome;
  extra?: Record<string, unknown>;
};

/**
 * Capture une exception côté Sentry avec les tags MCP standard. No-op si
 * Sentry n'est pas configuré. Ne throw jamais — un échec d'envoi à Sentry
 * ne doit pas faire échouer la réponse MCP au client.
 */
export function captureMcpError(err: unknown, ctx: SentryContext): void {
  ensureInit();
  if (!enabled) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag("mcp.method", ctx.method);
      // Defense-in-depth : si un caller appelle captureMcpError avec un `tool`
      // non-string (cast forcé en TS, ou JS pur), on n'envoie pas le tag plutôt
      // que de corrompre l'indexation Sentry avec "[object Object]" / "42".
      if (typeof ctx.tool === "string" && ctx.tool.length > 0) {
        scope.setTag("mcp.tool", ctx.tool);
      }
      scope.setTag("mcp.outcome", ctx.outcome);
      scope.setContext("mcp_request", {
        ip_hash: ctx.ipHash,
        user_agent: ctx.userAgent,
        ...ctx.extra,
      });
      Sentry.captureException(err);
    });
  } catch (sentryErr) {
    const reason = sentryErr instanceof Error ? sentryErr.message : String(sentryErr);
    console.error(`[france-data-mcp] Sentry captureException failed: ${reason}`);
  }
}

/**
 * Force le flush des events en attente. Vercel coupe le process serverless
 * juste après la réponse HTTP, sans ce flush les events en file d'attente
 * sont perdus. Timeout court par défaut (2s) pour ne pas pénaliser la
 * latence des réponses sans erreur.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[france-data-mcp] Sentry flush failed: ${reason}`);
  }
}

/**
 * Indique si Sentry est activé. Volontairement passif : NE déclenche PAS
 * l'init — sinon un caller innocent (middleware, healthcheck) paierait le
 * coût Sentry sur le cold start. La lazyness est garantie par le fait que
 * seul `captureMcpError` peut déclencher `ensureInit`.
 *
 * Helper exposé pour les tests, mais safe à appeler ailleurs.
 */
export function isSentryEnabled(): boolean {
  return enabled;
}

/** Force l'init Sentry. Helper de test — ne pas appeler en code de prod. */
export function __ensureInitForTesting(): void {
  ensureInit();
}
