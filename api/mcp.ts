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
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TOOLS, findTool } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "france-data-mcp",
  version: "0.1.0",
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

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
  if (!body) {
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
      try {
        if (!request || typeof request !== "object") {
          return error(null, -32600, "Invalid Request: not a JSON-RPC object");
        }
        return await handleRpc(request);
      } catch (err) {
        // Filet de sécurité pour les exceptions synchrones hors du try interne
        // de handleRpc (ex: accès à request.id sur un null, JSON.stringify d'un
        // objet circulaire). Sans ce filet, la fonction Vercel crash sans réponse
        // et le client MCP timeout sans diagnostic.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[france-data-mcp] unexpected error in batch loop: ${message}`);
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

async function handleRpc(request: JsonRpcRequest): Promise<JsonRpcSuccess | JsonRpcError | null> {
  const id = request.id ?? null;

  try {
    if (request.method === "initialize") {
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
          tools: { listChanged: false },
        },
        instructions:
          "Données publiques françaises pour analyse territoriale (santé, démographie, entreprises, géocodage). Mentionne toujours la source officielle (FINESS/ANS, INSEE, IGN, DINUM, etc.) quand tu cites des chiffres.",
      });
    }

    if (request.method === "notifications/initialized") {
      return null;
    }

    if (request.method === "ping") {
      return success(id, {});
    }

    if (request.method === "tools/list") {
      return success(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (request.method === "tools/call") {
      const params = request.params ?? {};
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = findTool(name);
      if (!tool) {
        return error(id, -32602, `Unknown tool: ${name}`);
      }
      const result = await tool.handler(args);
      let resultText: string;
      try {
        resultText = JSON.stringify(result, null, 2);
      } catch (stringifyErr) {
        const msg = stringifyErr instanceof Error ? stringifyErr.message : String(stringifyErr);
        console.error(`[france-data-mcp] tools/call ${name}: JSON.stringify failed: ${msg}`);
        return error(id, -32603, `Tool ${name} returned a non-serialisable value: ${msg}`);
      }
      return success(id, {
        content: [{ type: "text", text: resultText }],
      });
    }

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
    const code = err instanceof RangeError ? -32602 : -32603;
    return error(id, code, message);
  }
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
