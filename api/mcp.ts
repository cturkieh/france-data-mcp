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
import { HttpError, isTransientHttpStatus } from "../src/core/http.js";
import { VERSION } from "../src/core/version.js";
import {
  type LogLevel,
  type McpOutcome,
  type McpRequestContext,
  extractUserAgent,
  logMcpEvent,
  scheduleObservabilityFlush,
} from "./_lib/observability.js";
import { checkRateLimit, extractIp, hashIp } from "./_lib/rate-limit.js";
import { captureMcpError } from "./_lib/sentry.js";
import { TOOLS, findTool } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "france-data-mcp",
  version: VERSION,
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

/**
 * Shared logging context, populated once per HTTP request. Réexporté depuis
 * `observability.ts` pour rester source-of-truth et éviter la divergence avec
 * `SentryContext`.
 */
type RequestContext = McpRequestContext;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Horodatage d'entrée du handler — sert de `start` aux chemins meta
  // early-return (405 non-POST, 400 POST vide) qui n'ont pas de `start`
  // par-sous-requête. SANS lui, `emit(ctx, 0, …)` loggait `Date.now() - 0`
  // = l'epoch entier (~1.7e12) au lieu d'une durée ~0 ms, polluant tout
  // agrégat `duration_ms` côté Axiom (avg/percentiles faussés).
  const requestStart = Date.now();
  try {
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
      emit(ctx, requestStart, `http_${req.method ?? "unknown"}`, {
        status: 405,
        outcome: "bad_request",
        level: "warn",
      });
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (!body) {
      emit(ctx, requestStart, "http_post_empty", {
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
          // Filet de sécurité pour exceptions synchrones hors du try interne de
          // handleRpc (ex: request.id null, JSON.stringify circulaire). En pratique
          // handleRpc catch déjà tout — ce filet ne devrait jamais s'activer.
          // reportInternalError centralise console.error + emit + Sentry.captureException.
          const method = request?.method ?? "malformed_request";
          const message = reportInternalError(err, ctx, start, method, {
            layer: "batch_loop",
            logPrefix: "unexpected error in batch loop",
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // SyntaxError = JSON malformé caller-side (`req.body` getter @vercel/node
    // throw quand Content-Type=application/json + payload non parseable) →
    // -32700 Parse error (spec JSON-RPC 2.0 §5.1), status 400, SANS Sentry
    // (faute caller, pas serveur — complète `beforeSendEvent` bot-noise drop
    // en évitant l'appel). PAS de re-throw : Vercel renvoie la 400 propre.
    if (err instanceof SyntaxError) {
      console.warn(`[france-data-mcp] handler root: invalid JSON (${message})`);
      // Réutilise le helper `error()` (ligne 501) — source unique de la shape
      // JsonRpcError, évite la divergence si on ajoute des champs spec.
      res.status(400).json(error(null, -32700, `Parse error: ${message}`));
      return;
    }
    // Filet root pour les autres exceptions HORS boucle batch (ex: extractIp/
    // hashIp/extractUserAgent en cold start exotique). Sans ce filet,
    // l'invariant "100% des 500 sont capturés par Sentry" serait cassé.
    console.error(`[france-data-mcp] handler root error: ${message}`);
    captureMcpError(err, {
      method: "handler_root",
      outcome: "internal_error",
      ipHash: "unknown",
      userAgent: "unknown",
      extra: { layer: "handler_root", error: message },
    });
    throw err;
  } finally {
    // Flush observabilité DÉPORTÉ en arrière-plan (latence client ZÉRO) — toute
    // la mécanique (puits Sentry+Axiom, `waitUntil`, fail-soft) est encapsulée
    // dans `scheduleObservabilityFlush`. Le `finally` garantit que tout chemin
    // de retour (early returns OPTIONS/GET/405/400, re-throw du catch root)
    // programme le flush en attente.
    scheduleObservabilityFlush();
  }
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
        // `resources` et `prompts` annoncés (listes vides actuellement) pour
        // (1) supprimer les warnings Smithery ranking et (2) éviter les
        // -32601 Method not found côté clients qui sondent ces capacités
        // par convenance après initialize. Sémantique : "le serveur supporte
        // la primitive mais n'en publie aucune entrée". Si on ajoute un jour
        // une vraie ressource/prompt, basculer `listChanged: true` (la spec
        // MCP attend alors une notification de changement).
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
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
          // Spec MCP 2025-06-18 §6.2 : annotations optionnelles consommées
          // par les clients pour décider si une confirmation utilisateur
          // est nécessaire avant invocation. Omis si non déclaré.
          ...(t.annotations ? { annotations: t.annotations } : {}),
          // Spec MCP 2025-06-18 §6.3 : outputSchema permet aux clients de
          // type-check les réponses et de mieux grounder un LLM consommateur.
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        })),
      });
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return response;
    }

    // Stubs MCP : annoncés dans `initialize.capabilities` mais aucune entrée
    // exposée actuellement. Préférable à un -32601 qui ferait paniquer Smithery
    // ranker et certains clients MCP qui sondent ces capacités par convenance.
    if (request.method === "resources/list") {
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return success(id, { resources: [] });
    }

    if (request.method === "prompts/list") {
      emit(ctx, start, request.method, { status: 200, outcome: "success" });
      return success(id, { prompts: [] });
    }

    if (request.method === "tools/call") {
      const params = request.params ?? {};
      // Validation explicite : un cast `as string` masquerait un caller qui
      // envoie un number/object/null/undefined. Sans cette garde, le tag Sentry
      // `mcp.tool` est corrompu ("[object Object]") et l'outcome part en
      // `not_found` (faux signal — c'est un `bad_request` côté caller).
      if (typeof params.name !== "string" || params.name.length === 0) {
        emit(ctx, start, request.method, {
          status: 400,
          outcome: "bad_request",
          level: "warn",
          extra: { error: "missing_or_invalid_tool_name" },
        });
        return error(id, -32602, "Invalid params: 'name' must be a non-empty string");
      }
      const name = params.name;
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

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
        reportInternalError(
          new Error(`Tool ${name} returned undefined`),
          ctx,
          start,
          request.method,
          {
            tool: name,
            layer: "tool_result_check",
            logPrefix: `tool ${name} returned undefined`,
          },
        );
        return error(id, -32603, `Tool ${name} returned no value`);
      }
      let resultText: string;
      try {
        resultText = JSON.stringify(result, null, 2);
      } catch (stringifyErr) {
        // reportInternalError centralise console.error + emit + Sentry.captureException.
        const msg = reportInternalError(stringifyErr, ctx, start, request.method, {
          tool: name,
          layer: "json_stringify",
          logPrefix: `tools/call ${name}: JSON.stringify failed`,
        });
        return error(id, -32603, `Tool ${name} returned a non-serialisable value: ${msg}`);
      }
      emit(ctx, start, request.method, {
        tool: name,
        status: 200,
        outcome: "success",
        extra: { rl_backend: rl.backend, rl_remaining: rl.remaining },
      });
      // Spec MCP 2025-06-18 §6.3 : si le tool a un `outputSchema`, on émet aussi
      // `structuredContent` pour que les clients MCP modernes (Inspector,
      // Claude Desktop récent) puissent valider la réponse contre le schema
      // déclaré dans `tools/list`. Le `content` text reste pour rétrocompat.
      // `structuredContent` doit être un object (le SDK officiel typé
      // `{ [key: string]: unknown }`). On exclut donc null, arrays et primitives.
      const wantsStructured =
        tool.outputSchema !== undefined &&
        result !== null &&
        typeof result === "object" &&
        !Array.isArray(result);
      return success(id, {
        content: [{ type: "text", text: resultText }],
        ...(wantsStructured ? { structuredContent: result } : {}),
      });
    }

    emit(ctx, start, request.method, { status: 404, outcome: "not_found" });
    return error(id, -32601, `Method not found: ${request.method}`);
  } catch (err) {
    // JSON-RPC 2.0 §5.1 distingue Invalid params (-32602, faute caller) de
    // Internal error (-32603, faute serveur). Les validators (clampLimit /
    // validateCoords / validateRadiusKm / etc.) throw RangeError pour signaler
    // un input client invalide. Sans ce mapping, un client typé voit -32603
    // et conclut "panne serveur, retry plus tard" alors qu'il faut juste
    // corriger sa saisie. reportInternalError gère console.error + Sentry.captureException.
    if (err instanceof RangeError) {
      const message = err.message;
      // V0.19.0 — propage `err.cause` (payload structuré ES2022) au 4ème arg
      // de `error()` qui le câble dans `error.data` JSON-RPC (cf. signature
      // `function error(id, code, message, data?)` plus bas). Permet aux
      // callers (Geo Intel) de distinguer programmiquement les sous-types
      // d'erreurs (`ambiguous_commune`, `commune_not_in_department`, etc.)
      // sans parser le message texte. Test garde-fou :
      // `api/mcp-handler-error-cause.test.ts`.
      const data = err.cause;
      console.warn(`[france-data-mcp] bad_request on ${request.method}: ${message}`);
      emit(ctx, start, request.method, {
        status: 400,
        outcome: "bad_request",
        level: "warn",
        extra: { error: message },
      });
      return error(id, -32602, message, data);
    }
    const tool = typeof request.params?.name === "string" ? request.params.name : undefined;
    const message = reportInternalError(err, ctx, start, request.method, {
      tool,
      layer: "handle_rpc",
    });
    return error(id, -32603, message);
  }
}

/**
 * Pipe unique « erreur 500 → log + metric + Sentry » : applique mécaniquement
 * la discipline CLAUDE.md (zéro catch silencieux, console.error + Sentry
 * obligatoires) et empêche l'oubli d'une sortie sur un nouveau chemin d'erreur.
 *
 * Retourne le message normalisé pour que le caller puisse l'embarquer dans
 * la réponse JSON-RPC sans le re-calculer.
 */
/**
 * Message caller-facing actionnable pour une panne de DÉPENDANCE AMONT.
 *
 * Sans ça, une `HttpError` (geo.api.gouv.fr 502, INSEE 503…) remontait en
 * `-32603` avec un `err.message` opaque (`HTTP 502 on https://…?q=<adresse>`)
 * : le caller ne pouvait pas distinguer « bug serveur, n'insiste pas » de
 * « dépendance amont transitoire, réessaie » (post-mortem P3). On expose le
 * STATUT + le HOST amont (infrastructure publique, non sensible) sans la
 * query (= input du caller, hors du message). Le détail complet (URL+body)
 * reste capturé côté Sentry/console via {@link captureMcpError}.
 */
export function describeUpstreamFailure(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null;
  let host = "amont";
  try {
    host = new URL(err.url).host;
  } catch {
    // err.url non parsable (ne devrait pas arriver — toujours une URL fetch
    // complète) : on reste sur le placeholder plutôt que de fuiter l'URL brute.
  }
  const hint = isTransientHttpStatus(err.status)
    ? "panne transitoire — réessayer après un court délai"
    : "réponse inattendue de la dépendance amont";
  return `Dépendance amont ${host} a renvoyé HTTP ${err.status} (${hint}).`;
}

function reportInternalError(
  err: unknown,
  ctx: RequestContext,
  start: number,
  method: string,
  opts: { layer: string; tool?: string; logPrefix?: string },
): string {
  const message =
    describeUpstreamFailure(err) ?? (err instanceof Error ? err.message : String(err));
  console.error(`[france-data-mcp] ${opts.logPrefix ?? `handler ${method}`}: ${message}`);
  emit(ctx, start, method, {
    tool: opts.tool,
    status: 500,
    outcome: "internal_error",
    level: "error",
    extra: { error: message, layer: opts.layer },
  });
  captureMcpError(err, {
    method,
    tool: opts.tool,
    outcome: "internal_error",
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
    extra: { layer: opts.layer },
  });
  return message;
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
