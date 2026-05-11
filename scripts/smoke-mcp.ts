/**
 * Smoke test local du handler MCP : valide handshake (initialize, tools/list)
 * libre, puis le rate limit kicks in après N tools/call.
 *
 * Usage : `pnpm exec tsx scripts/smoke-mcp.ts`
 * Force RATE_LIMIT_PER_MINUTE=3 + Upstash absent → fallback in-memory.
 */

process.env.RATE_LIMIT_PER_MINUTE = "3";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

const handler = (await import("../api/mcp.js")).default;

function fakeReq(body: unknown) {
  return {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.99", "user-agent": "smoke-test/1.0" },
    socket: { remoteAddress: "127.0.0.1" },
    body,
  };
}

type ResLike = {
  status: (s: number) => ResLike;
  json: (p: unknown) => ResLike;
  end: () => void;
  _status: number;
  _payload: unknown;
};

function fakeRes(): ResLike {
  let status = 0;
  let payload: unknown;
  const r: ResLike = {
    status(s) {
      status = s;
      return r;
    },
    json(p) {
      payload = p;
      return r;
    },
    end() {},
    get _status() {
      return status;
    },
    get _payload() {
      return payload;
    },
  };
  return r;
}

type JsonRpcResult = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { protocolVersion?: string; tools?: unknown[]; [k: string]: unknown };
  error?: { code: number; message: string; data?: unknown };
};

async function call(
  method: string,
  params: unknown,
): Promise<{ status: number; payload: JsonRpcResult }> {
  const res = fakeRes();
  // biome-ignore lint/suspicious/noExplicitAny: handler signature is from @vercel/node
  await handler(fakeReq({ jsonrpc: "2.0", id: 1, method, params }) as any, res as any);
  return { status: res._status, payload: (res._payload as JsonRpcResult) ?? {} };
}

async function callBatch(
  requests: Array<{ method: string; params?: unknown; id: number }>,
): Promise<{ status: number; payload: JsonRpcResult[] }> {
  const res = fakeRes();
  const body = requests.map((r) => ({ jsonrpc: "2.0", ...r }));
  // biome-ignore lint/suspicious/noExplicitAny: handler signature is from @vercel/node
  await handler(fakeReq(body) as any, res as any);
  return { status: res._status, payload: (res._payload as JsonRpcResult[]) ?? [] };
}

console.log("=== Smoke test france-data-mcp ===\n");

console.log("--- initialize ---");
const init = await call("initialize", {});
console.log("HTTP:", init.status);
console.log("result.protocolVersion:", init.payload.result?.protocolVersion);

console.log("\n--- tools/list ---");
const tl = await call("tools/list", {});
console.log("HTTP:", tl.status);
console.log("tools count:", tl.payload.result?.tools?.length);

console.log("\n--- 5x tools/call autocomplete_commune (limit=3) ---");
for (let i = 1; i <= 5; i++) {
  const r = await call("tools/call", {
    name: "autocomplete_commune",
    arguments: { nom: "Paris" },
  });
  const err = r.payload.error;
  console.log(
    `#${i} HTTP=${r.status} ${err ? `ERROR code=${err.code} msg="${err.message}" data=${JSON.stringify(err.data)}` : "OK"}`,
  );
}

console.log("\n--- ping (méthode meta, jamais rate limited) ---");
const p = await call("ping", {});
console.log("HTTP:", p.status, "result:", p.payload.result);

console.log(
  "\n--- batch JSON-RPC : 3 tools/call (déjà 3 OK) + ping → tous rate-limited sauf ping ---",
);
const batch = await callBatch([
  {
    id: 10,
    method: "tools/call",
    params: { name: "autocomplete_commune", arguments: { nom: "Paris" } },
  },
  { id: 11, method: "ping" },
  {
    id: 12,
    method: "tools/call",
    params: { name: "autocomplete_commune", arguments: { nom: "Lyon" } },
  },
]);
console.log("HTTP:", batch.status, "batch length:", batch.payload.length);
for (const item of batch.payload) {
  const err = item.error;
  console.log(`  id=${item.id} ${err ? `ERROR code=${err.code}` : "OK"}`);
}

export {};
