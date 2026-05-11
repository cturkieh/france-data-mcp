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
 */

import type { VercelRequest } from "@vercel/node";

export type LogLevel = "info" | "warn" | "error";

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

/** Emit a single structured log line. */
export function logMcpEvent(event: McpEventInput): void {
  // Spread `extra` AVANT les champs canoniques pour qu'aucune clé custom ne
  // puisse écraser `status`, `outcome`, `method`, etc. — c'est le contrat
  // qu'on documente dans McpEventInput.
  const extra = event.extra ?? {};
  const canonical: Record<string, unknown> = {
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
  const line = serializeSafe({ ...extra, ...canonical }, canonical);
  const level = event.level ?? levelFromStatus(event.status);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
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
