/**
 * Endpoint HTTP serverless implémentant le protocole MCP (Model Context Protocol).
 *
 * Mode : Streamable HTTP en JSON-RPC stateless. Compatible avec :
 *  - claude.ai (Custom Connectors)
 *  - Claude Code, Claude Desktop
 *  - Cursor, Windsurf
 *  - Tout client MCP qui supporte HTTP Streamable.
 *
 * On gère les méthodes minimales : initialize, tools/list, tools/call,
 * notifications/initialized (no-op), ping. Pas de session stateful, pas de SSE
 * (suffisant pour les tools qui répondent en quelques secondes max).
 *
 * Garde-fous publics (V0.5.7) :
 *  - Rate limit 60 req/min par IP sur `tools/call` (Upstash sliding window
 *    + fallback in-memory). Ne s'applique PAS aux méthodes meta `initialize`,
 *    `tools/list`, `ping`, sinon le handshake MCP casse pour les clients
 *    qui re-listent les tools souvent.
 *  - Logging JSON structuré par requête (ip_hash, user_agent, duration,
 *    outcome). Aucune IP en clair, aucun argument tool persisté.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  type LogLevel,
  type McpOutcome,
  extractUserAgent,
  logMcpEvent,
} from "./_lib/observability.js";
import { checkRateLimit, extractIp, hashIp } from "./_lib/rate-limit.js";
import { TOOLS, findTool } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "france-data-mcp",
  version: "0.5.7",
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

/** Shared logging context, populated once per HTTP request. */
type RequestContext = {
  ipHash: string;
  userAgent: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({
      message: "france-data-mcp — serveur MCP HTTP",
      protocol: "MCP Streamable HTTP",
      version: SERVER_INFO.version,
      docs: "https://github.com/cturkieh/france-data-mcp",
      transport: "Send POST requests with JSON-RPC 2.0 messages.",
    });
    return;
  }

  // À partir d'ici on tracera tout — les rejets HTTP 405/400 doivent
  // apparaître dans les logs structurés pour qu'un spam GET/POST-vide
  // soit visible et aggregable côté ops, et pour qu'un éventuel DoS
  // log-silent ne reste pas invisible.
  const ctx: RequestContext = {
    ipHash: hashIp(extractIp(req)),
    userAgent: extractUserAgent(req),
  };

  if (req.method !== "POST") {
    emit(ctx, 0, `http_${req.method ?? "unknown"}`, {
      status: 405,
      outcome: "bad_request",
      level: "warn",
    });
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
  if (!body) {
    emit(ctx, 0, "http_post_empty", {
      status: 400,
      outcome: "bad_request",
      level: "warn",
    });
    res.status(400).json({ error: "Missing JSON-RPC payload" });
    return;
  }

  const isBatch = Array.isArray(body);
  const requests: JsonRpcRequest[] = isBatch ? body : [body];

  // Batch JSON-RPC : on traite les requêtes en parallèle. handleRpc catch déjà
  // toutes ses exceptions internes, donc aucune promise ne reject — Promise.all
  // ne court-circuite pas. L'ordre des réponses suit l'ordre des requêtes (sémantique
  // Promise.all). Win typique : un batch de 5 tools/call qui font chacun un appel
  // réseau ~300ms passe de ~1.5s à ~300ms.
  const settled = await Promise.all(
    requests.map(async (request) => {
      const start = Date.now();
      try {
        if (!request || typeof request !== "object") {
          emit(ctx, start, "invalid", { status: 400, outcome: "bad_request" });
          return error(null, -32600, "Invalid Request: not a JSON-RPC object");
        }
        return await handleRpc(request, ctx, start);
      } catch (err) {
        // Filet de sécurité pour les exceptions synchrones hors du try interne
        // de handleRpc (ex: accès à request.id sur un null, JSON.stringify d'un
        // objet circulaire). Sans ce filet, la fonction Vercel crash sans réponse
        // et le client MCP timeout sans diagnostic.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[france-data-mcp] unexpected error in batch loop: ${message}`);
        // Si `request.method` est manquant, c'est un request structurellement
        // cassé — distingué de "unknown" pour ne pas mélanger les buckets
        // d'aggregation côté ops (panne interne vs payload malformé).
        emit(ctx, start, request?.method ?? "malformed_request", {
          status: 500,
          outcome: "internal_error",
          extra: { error: message },
        });
        return error(null, -32603, `Internal error in batch handling: ${message}`);
      }
    }),
  );
  const responses: Array<JsonRpcSuccess | JsonRpcError> = settled.filter(
    (r): r is JsonRpcSuccess | JsonRpcError => r !== null,
  );

  if (responses.length === 0) {
    res.status(204).end();
    return;
  }
  res.status(200).json(isBatch ? responses : responses[0]);
}

async function handleRpc(
  request: JsonRpcRequest,
  ctx: RequestContext,
  start: number,
): Promise<JsonRpcSuccess | JsonRpcError | null> {
  const id = request.id ?? null;

  try {
    if (request.method === "initialize") {
      const response = success(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
          tools: { listChanged: false },
        },
        instructions:
          "Données publiques françaises pour analyse territoriale (santé, démographie, entreprises, géocodage). Mentionne toujours la source officielle (FINESS/ANS, INSEE, IGN, DINUM, etc.) quand tu cites des chiffres.",
      });
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return response;
    }

    if (request.method === "notifications/initialized") {
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return null;
    }

    if (request.method === "ping") {
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return success(id, {});
    }

    if (request.method === "tools/list") {
      const response = success(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return response;
    }

    if (request.method === "tools/call") {
      const params = request.params ?? {};
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      // Rate limit appliqué uniquement aux tools/call (les méthodes meta
      // restent libres pour ne pas casser le handshake MCP des clients qui
      // re-`tools/list` souvent).
      const rl = await checkRateLimit(ctx.ipHash);
      if (!rl.success) {
        emit(ctx, start, request.method, {
          tool: name,
          status: 429,
          outcome: "rate_limited",
          level: "warn",
          extra: {
            backend: rl.backend,
            limit: rl.limit,
            retry_after_s: rl.retryAfterSeconds,
          },
        });
        return error(id, -32000, "Rate limit exceeded", {
          retryAfterSeconds: rl.retryAfterSeconds,
          limit: rl.limit,
          resetAt: rl.resetAt,
        });
      }

      const tool = findTool(name);
      if (!tool) {
        emit(ctx, start, request.method, { tool: name, status: 404, outcome: "not_found" });
        return error(id, -32602, `Unknown tool: ${name}`);
      }
      const result = await tool.handler(args);
      // `JSON.stringify(undefined)` retourne la string "undefined" (pas un JSON valide),
      // qui passe silencieusement au client MCP comme `text: undefined` → réponse cassée.
      // On bloque ici pour signaler le bug du tool plutôt que de dégrader silencieusement.
      if (result === undefined) {
        console.error(`[france-data-mcp] tool ${name} returned undefined`);
        emit(ctx, start, request.method, {
          tool: name,
          status: 500,
          outcome: "internal_error",
          extra: { error: "tool_returned_undefined" },
        });
        return error(id, -32603, `Tool ${name} returned no value`);
      }
      let resultText: string;
      try {
        resultText = JSON.stringify(result, null, 2);
      } catch (stringifyErr) {
        const msg = stringifyErr instanceof Error ? stringifyErr.message : String(stringifyErr);
        console.error(`[france-data-mcp] tools/call ${name}: JSON.stringify failed: ${msg}`);
        emit(ctx, start, request.method, {
          tool: name,
          status: 500,
          outcome: "internal_error",
          extra: { error: msg },
        });
        return error(id, -32603, `Tool ${name} returned a non-serialisable value: ${msg}`);
      }
      emit(ctx, start, request.method, {
        tool: name,
        status: 200,
        outcome: "success",
        extra: { rl_backend: rl.backend, rl_remaining: rl.remaining },
      });
      return success(id, {
        content: [{ type: "text", text: resultText }],
      });
    }

    emit(ctx, start, request.method, { status: 404, outcome: "not_found" });
    return error(id, -32601, `Method not found: ${request.method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[france-data-mcp] handler error on ${request.method}: ${message}`);
    // JSON-RPC 2.0 §5.1 distingue Invalid params (-32602, faute du caller) de
    // Internal error (-32603, faute serveur). Les validators (clampLimit /
    // clampOffset / validateCoords / validateRadiusKm / validateDepartement)
    // throw RangeError pour signaler un input client invalide. Sans ce mapping,
    // un client typé voit -32603 et conclut "panne serveur, retry plus tard"
    // alors qu'il faut juste corriger sa saisie. Le message reste verbatim
    // donc le caller MCP a toujours le diagnostic actionnable.
    if (err instanceof RangeError) {
      emit(ctx, start, request.method, {
        status: 400,
        outcome: "bad_request",
        level: "warn",
        extra: { error: message },
      });
      return error(id, -32602, message);
    }
    emit(ctx, start, request.method, {
      status: 500,
      outcome: "internal_error",
      level: "error",
      extra: { error: message },
    });
    return error(id, -32603, message);
  }
}

/**
 * Emit a single structured log line for a finished MCP sub-request.
 * Shared by every code path so every outcome is logged with the same shape.
 */
function emit(
  ctx: RequestContext,
  start: number,
  method: string,
  opts: {
    status: number;
    outcome: McpOutcome;
    tool?: string;
    level?: LogLevel;
    extra?: Record<string, unknown>;
  },
): void {
  logMcpEvent({
    method,
    tool: opts.tool,
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
    durationMs: Date.now() - start,
    status: opts.status,
    outcome: opts.outcome,
    level: opts.level,
    extra: opts.extra,
  });
}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function error(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
