#!/usr/bin/env node
/**
 * france-data-mcp — wrapper npm.
 *
 * Forwarde le protocole MCP stdio (NDJSON sur stdin/stdout) vers l'endpoint
 * HTTP `france-data-mcp.vercel.app/mcp`. Permet aux clients MCP qui ne savent
 * pas appeler un endpoint HTTP distant (Claude Desktop natif, certains IDE)
 * d'utiliser le serveur via `npx france-data-mcp`.
 *
 * Architecture :
 *  - Lit stdin ligne par ligne (NDJSON, spec MCP stdio transport). Trim le
 *    whitespace périphérique avant forward — transformation volontaire et
 *    inoffensive (n'altère pas le JSON-RPC payload).
 *  - Pour chaque ligne non vide, POST vers `ENDPOINT` et écrit la réponse
 *    sur stdout (NDJSON).
 *  - En cas d'erreur réseau, HTTP >= 400, ou body stream interrompu, émet
 *    une réponse JSON-RPC error (-32603) pour ne JAMAIS faire hang le client.
 *
 * stdout doit rester pur JSON-RPC (NDJSON) — tout log interne va sur stderr
 * via `console.error` (jamais `stdout.write` pour autre chose qu'une réponse
 * JSON-RPC). Pas d'état stateful : le serveur HTTP est stateless lui aussi.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { VERSION } from "../src/core/version.js";

const DEFAULT_ENDPOINT = "https://france-data-mcp.vercel.app/mcp";
const ENDPOINT = process.env.FRANCE_DATA_MCP_URL || DEFAULT_ENDPOINT;
const USER_AGENT = `france-data-mcp-npm/${VERSION}`;
const JSON_RPC_INTERNAL_ERROR = -32603;

const rawTimeoutEnv = process.env.FRANCE_DATA_MCP_TIMEOUT_MS;
const parsedTimeout = Number(rawTimeoutEnv);
const isValidTimeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0;
const REQUEST_TIMEOUT_MS = isValidTimeout ? parsedTimeout : 60_000;
// Signaler le fallback côté stderr (jamais stdout — réservé au JSON-RPC) pour
// éviter un silent failure si l'utilisateur a tapé une valeur invalide.
if (rawTimeoutEnv !== undefined && !isValidTimeout) {
  console.error(
    `[france-data-mcp-npm] FRANCE_DATA_MCP_TIMEOUT_MS="${rawTimeoutEnv}" invalide, fallback ${REQUEST_TIMEOUT_MS}ms`,
  );
}

type JsonRpcId = string | number | null;
type JsonRpcMessage = { id?: JsonRpcId; method?: string };

/**
 * Extrait l'id JSON-RPC d'une ligne (best-effort). Utilisé uniquement pour
 * construire une réponse error propre quand le forward réseau échoue.
 */
function parseId(line: string): JsonRpcId {
  try {
    const msg = JSON.parse(line) as unknown;
    if (msg && typeof msg === "object" && "id" in msg) {
      const id = (msg as JsonRpcMessage).id;
      if (typeof id === "string" || typeof id === "number" || id === null) return id;
    }
  } catch {
    // Best-effort : si la ligne n'est pas du JSON valide, forwardLine émettra
    // quand même une réponse JSON-RPC error sur stdout avec id=null. Le
    // diagnostic texte va sur stderr via console.error.
  }
  return null;
}

const defaultWriteOut = (s: string): void => {
  stdout.write(s);
};

/**
 * Émet une réponse JSON-RPC error sur stdout. NDJSON appliqué de façon
 * uniforme (1 message = 1 ligne).
 */
function emitJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  writeOut: (s: string) => void,
): void {
  const payload = { jsonrpc: "2.0", id, error: { code, message } };
  writeOut(`${JSON.stringify(payload)}\n`);
}

/**
 * POST une ligne JSON-RPC vers l'endpoint HTTP et écrit la réponse sur stdout.
 * Catche toutes les erreurs (réseau, timeout, HTTP >=400, stream interrompu)
 * en émettant une réponse JSON-RPC error — le client MCP voit toujours une
 * réponse pour chaque request, jamais de hang.
 */
export async function forwardLine(
  line: string,
  fetchFn: typeof fetch = fetch,
  writeOut: (s: string) => void = defaultWriteOut,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Parsing d'id fait UNE seule fois, réutilisé sur tous les chemins d'erreur.
  const id = parseId(trimmed);

  let response: Response;
  try {
    response = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
      body: trimmed,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = sanitizeReason(err instanceof Error ? err.message : String(err));
    console.error(`[france-data-mcp-npm] forward failed: ${reason}`);
    emitJsonRpcError(
      id,
      JSON_RPC_INTERNAL_ERROR,
      `Network error forwarding to ${SAFE_ENDPOINT}: ${reason}`,
      writeOut,
    );
    return;
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    // Stream interrompu après les headers (gateway timeout, réseau coupé) :
    // sans ce catch, la promise rejette → main() crash → client hang sur l'id.
    // console.error pour le diagnostic local, capture Sentry inapplicable
    // côté wrapper client (par design : pas de telemetry).
    const reason = sanitizeReason(err instanceof Error ? err.message : String(err));
    console.error(`[france-data-mcp-npm] body stream interrupted: ${reason}`);
    emitJsonRpcError(
      id,
      JSON_RPC_INTERNAL_ERROR,
      `Body stream interrupted from ${SAFE_ENDPOINT}: ${reason}`,
      writeOut,
    );
    return;
  }

  if (!response.ok) {
    emitJsonRpcError(
      id,
      JSON_RPC_INTERNAL_ERROR,
      `Upstream HTTP ${response.status} from ${SAFE_ENDPOINT}: ${sanitizeReason(text.slice(0, 200))}`,
      writeOut,
    );
    return;
  }

  // L'endpoint Vercel renvoie un seul objet JSON-RPC (status 200) ou rien
  // (204 pour les notifications). Passthrough verbatim — pas de re-sérialisation
  // pour préserver la précision (ordre des clés, formats numériques).
  if (text.length > 0) writeOut(`${text.replace(/\n+$/u, "")}\n`);
}

/**
 * Masque les credentials userinfo d'une URL connue (notre ENDPOINT) avant
 * inclusion dans un log stderr ou un message error JSON-RPC stdout.
 *
 * Surfaces couvertes :
 *  1. Banner stderr au démarrage (`SAFE_ENDPOINT`)
 *  2. Messages error JSON-RPC qui interpolent `${SAFE_ENDPOINT}`
 *  3. Messages error des exceptions `fetch` Node 22+ — leur `err.message`
 *     embarque l'URL fautive ENTIÈRE incluant userinfo ("Request cannot be
 *     constructed from a URL that includes credentials: https://user:pass@…").
 *     Cette surface est couverte par `sanitizeReason()` complémentaire — ne PAS
 *     se reposer sur cette fonction seule.
 */
function safeEndpointForLog(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return endpoint;
  }
}

// Calculé une seule fois au module load — réutilisé dans tous les messages
// (banner stderr + 3 chemins d'erreur stdout JSON-RPC).
const SAFE_ENDPOINT = safeEndpointForLog(ENDPOINT);

/**
 * Strip toute URL `scheme://user:pass@host` d'une string libre. Le runtime
 * `fetch` Node 22+ throw un `TypeError` dont le message contient verbatim
 * l'URL fautive, incluant userinfo. Sans sanitization, le `reason` d'une
 * erreur réseau fuiterait les credentials côté stdout (JSON-RPC error) ET
 * stderr (diagnostic). Defense-in-depth obligatoire — la même URL pourrait
 * arriver via un message d'erreur de proxy, DNS, gateway, etc.
 */
function sanitizeReason(reason: string): string {
  return reason.replace(/(https?:\/\/)[^/\s@]+@/giu, "$1[redacted]@");
}

async function main(): Promise<void> {
  console.error(`[france-data-mcp-npm] v${VERSION} → ${SAFE_ENDPOINT}`);
  const rl = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    await forwardLine(line);
  }
}

// `import.meta.url === pathToFileURL(process.argv[1])` détecte qu'on est lancé
// directement (vs importé par un test). Évite de boucler stdin pendant les tests.
const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[france-data-mcp-npm] fatal: ${reason}`);
    process.exit(1);
  });
}

export { ENDPOINT, USER_AGENT, parseId, safeEndpointForLog };
