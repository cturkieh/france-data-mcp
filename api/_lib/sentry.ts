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
 * Signatures connues d'exceptions levées par des bots scanners qui envoient un
 * body JSON-RPC malformé : les access `req.body.X`, destructurations, calls
 * `.toLowerCase()` sur non-string plantent dans le catch root.
 *
 * Patterns volontairement génériques (TypeError V8 + SyntaxError). Un genuine
 * bug `handler_root` (extractIp/hashIp throw exotique) a typiquement un message
 * distinct et reste capturé. L'invariant V0.7.2 pass 2 (100 % des 500
 * capturés) est préservé sur les paths non-noise.
 */
const BOT_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /Cannot read prop/i,
  /Cannot destructure prop/i,
  /Cannot convert undefined or null/i,
  /is not iterable/i,
  /is not a function/i,
  /Unexpected token/i,
];

/**
 * FRANCE-DATA-MCP-1 : true si l'event Sentry matche un pattern de bot scanner
 * sur le `handler_root`. Le log Vercel JSON garde la trace côté ops (ip_hash,
 * user_agent réel, error, layer) ; Sentry ne sert qu'au grouping/alerting et
 * chaque scan de l'internet n'a aucune valeur opérationnelle.
 *
 * Visibilité publique : utilisé par `beforeSendEvent` (plugué dans `Sentry.init`)
 * et exporté pour les tests.
 */
export function isBotNoiseEvent(event: Sentry.ErrorEvent): boolean {
  if (event.tags?.["mcp.method"] !== "handler_root") return false;
  const exMsg = event.exception?.values?.[0]?.value ?? "";
  return BOT_NOISE_PATTERNS.some((p) => p.test(exMsg));
}

/**
 * Liste des headers à drop avant envoi Sentry : credentials, cookies, tokens
 * proxy/CSRF/cloud auth. Couvre les vecteurs OWASP courants ET les headers
 * spécifiques aux infra fréquentes (Vercel preview bypass, AWS SigV4).
 *
 * Nécessaire pour conformité RGPD/santé : Sentry datacenter EU est moins
 * problématique que US, mais les headers d'auth restent du secret stricto
 * sensu — un breadcrumb capturé ne doit jamais les leak.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-vercel-protection-bypass",
]);

/**
 * Defense-in-depth headers sanitize : Sentry SDK peut picker des headers dans
 * un breadcrumb / event si on lui passe par accident, on droppe les headers
 * sensibles AVANT envoi. Préserve la shape multi-header `string | string[]`
 * sans re-coercer. Retourne un clone : ne mute pas l'event d'entrée
 * (idempotent si appelé 2 fois).
 */
function sanitizeEventHeaders(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const req = event.request;
  if (!req?.headers) return event;
  const sanitized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) continue;
    sanitized[key] = value;
  }
  return {
    ...event,
    request: { ...req, headers: sanitized as typeof req.headers },
  };
}

/**
 * Pipeline `beforeSend` : drop bot-noise (FRANCE-DATA-MCP-1) puis sanitize
 * headers. Plugué dans `Sentry.init` ET exporté pour les tests.
 *
 * Log d'observabilité côté Vercel sur les drops : un grep `bot-noise event`
 * dans les logs Vercel permet d'auditer le taux de drop (anomaly detection
 * si un genuine bug venait à matcher un pattern par erreur). Conforme
 * CLAUDE.md « zéro catch silencieux ».
 */
export function beforeSendEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (isBotNoiseEvent(event)) {
    const exMsg = event.exception?.values?.[0]?.value ?? "";
    console.warn(
      `[france-data-mcp] sentry: dropping bot-noise event (handler_root): ${exMsg.slice(0, 120)}`,
    );
    return null;
  }
  return sanitizeEventHeaders(event);
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
      beforeSend: beforeSendEvent,
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
