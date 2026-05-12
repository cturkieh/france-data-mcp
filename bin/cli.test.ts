import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, USER_AGENT, forwardLine, parseId, safeEndpointForLog } from "./cli.js";

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Récupère la première ligne écrite sur stdout (mock writeOut) avec une
 * assertion explicite — évite les `!` non-null que Biome refuse.
 */
function firstWrite(writes: string[]): string {
  expect(writes.length).toBeGreaterThan(0);
  const first = writes[0];
  if (typeof first !== "string") throw new Error("writes[0] missing");
  return first;
}

describe("parseId", () => {
  it("retourne l'id quand la ligne est un JSON-RPC valide", () => {
    expect(parseId('{"jsonrpc":"2.0","id":42,"method":"x"}')).toBe(42);
    expect(parseId('{"jsonrpc":"2.0","id":"abc","method":"x"}')).toBe("abc");
    expect(parseId('{"jsonrpc":"2.0","id":null,"method":"x"}')).toBe(null);
  });

  it("retourne null sur JSON invalide (best-effort silencieux)", () => {
    expect(parseId("not json")).toBe(null);
    expect(parseId("{garbage")).toBe(null);
  });

  it("retourne null si id absent ou de type invalide", () => {
    expect(parseId('{"jsonrpc":"2.0","method":"x"}')).toBe(null);
    expect(parseId('{"jsonrpc":"2.0","id":{},"method":"x"}')).toBe(null);
    expect(parseId('{"jsonrpc":"2.0","id":[1,2],"method":"x"}')).toBe(null);
  });
});

describe("safeEndpointForLog", () => {
  it("masque les credentials userinfo (https://user:token@host)", () => {
    const sanitized = safeEndpointForLog("https://alice:supersecret@example.com/mcp");
    expect(sanitized).not.toContain("alice");
    expect(sanitized).not.toContain("supersecret");
    expect(sanitized).toContain("example.com");
  });

  it("retourne l'URL telle quelle si pas de credentials", () => {
    expect(safeEndpointForLog("https://france-data-mcp.vercel.app/mcp")).toBe(
      "https://france-data-mcp.vercel.app/mcp",
    );
  });

  it("retombe sur la string brute si URL malformée (best-effort)", () => {
    expect(safeEndpointForLog("not a url")).toBe("not a url");
  });
});

describe("constants", () => {
  it("ENDPOINT pointe par défaut sur l'endpoint public Vercel", () => {
    // L'override FRANCE_DATA_MCP_URL est lu au chargement du module — testé en
    // intégration via npx, pas en unitaire (sinon il faut un re-import dynamique).
    expect(ENDPOINT).toMatch(/france-data-mcp\.vercel\.app\/mcp$/);
  });

  it("USER_AGENT discrimine le wrapper npm avec sa version", () => {
    expect(USER_AGENT).toMatch(/^france-data-mcp-npm\/\d+\.\d+\.\d+$/);
  });
});

describe("forwardLine", () => {
  let writes: string[];
  let writeOut: (s: string) => void;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    writeOut = (s: string) => {
      writes.push(s);
    };
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignore les lignes vides (passthrough silencieux)", async () => {
    const fetchMock = vi.fn();
    await forwardLine("", fetchMock, writeOut);
    await forwardLine("   ", fetchMock, writeOut);
    await forwardLine("\n", fetchMock, writeOut);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("POST le payload tel quel et émet la réponse sur stdout avec newline", async () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeOkResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    await forwardLine(line, fetchMock, writeOut);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(ENDPOINT);
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.body).toBe(line);
    expect(call?.[1]?.headers?.["user-agent"]).toBe(USER_AGENT);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(firstWrite(writes).trim()).result.tools).toEqual([]);
  });

  it("trim la ligne avant POST (whitespace tolérant)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeOkResponse({ jsonrpc: "2.0", id: 1, result: {} }));
    await forwardLine('  {"jsonrpc":"2.0","id":1,"method":"ping"}  \n', fetchMock, writeOut);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  });

  it("émet une réponse JSON-RPC error -32603 sur erreur réseau (sans crash)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await forwardLine('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', fetchMock, writeOut);
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(firstWrite(writes).trim());
    expect(payload.id).toBe(7);
    expect(payload.error.code).toBe(-32603);
    expect(payload.error.message).toContain("ECONNREFUSED");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("forward failed: ECONNREFUSED"));
  });

  it("préserve l'id null si la ligne est malformée mais que le réseau throw", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("DNS"));
    await forwardLine("not even json", fetchMock, writeOut);
    const payload = JSON.parse(firstWrite(writes).trim());
    expect(payload.id).toBe(null);
    expect(payload.error.code).toBe(-32603);
  });

  it("émet une réponse error -32603 sur upstream HTTP 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("server exploded", { status: 500 }));
    await forwardLine('{"jsonrpc":"2.0","id":3,"method":"x"}', fetchMock, writeOut);
    const payload = JSON.parse(firstWrite(writes).trim());
    expect(payload.id).toBe(3);
    expect(payload.error.code).toBe(-32603);
    expect(payload.error.message).toContain("Upstream HTTP 500");
    expect(payload.error.message).toContain("server exploded");
  });

  it("tronque le corps upstream à 200 chars pour éviter les messages géants", async () => {
    const longBody = "X".repeat(5000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(longBody, { status: 502 }));
    await forwardLine('{"jsonrpc":"2.0","id":4,"method":"x"}', fetchMock, writeOut);
    const payload = JSON.parse(firstWrite(writes).trim());
    expect(payload.error.message.length).toBeLessThan(500);
    expect(payload.error.message).toContain("XXX");
  });

  it("masque les credentials userinfo si le reason fetch les inclut (CRITICAL régression)", async () => {
    // Node 22+ fetch throw un TypeError dont le message contient l'URL ENTIÈRE
    // avec userinfo en clair. Le wrapper doit sanitizer reason avant de l'écrire
    // sur stdout (visible client MCP) ET stderr (visible logs).
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          "Request cannot be constructed from a URL that includes credentials: https://alice:supersecret@example.com/mcp",
        ),
      );
    await forwardLine('{"jsonrpc":"2.0","id":1,"method":"x"}', fetchMock, writeOut);
    const stdoutPayload = firstWrite(writes);
    expect(stdoutPayload).not.toContain("supersecret");
    expect(stdoutPayload).not.toContain("alice:supersecret");
    expect(stdoutPayload).toContain("[redacted]@");
    const stderrJoined = errorSpy.mock.calls.flat().join(" ");
    expect(stderrJoined).not.toContain("supersecret");
    expect(stderrJoined).not.toContain("alice:supersecret");
  });

  it("masque aussi les credentials dans le reason d'un body stream interrupted", async () => {
    const brokenResponse = {
      ok: true,
      status: 200,
      text: () =>
        Promise.reject(
          new Error("stream aborted while reading https://user:token@upstream.example.com/path"),
        ),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(brokenResponse);
    await forwardLine('{"jsonrpc":"2.0","id":2,"method":"x"}', fetchMock, writeOut);
    const stdoutPayload = firstWrite(writes);
    expect(stdoutPayload).not.toContain("token");
    expect(stdoutPayload).toContain("[redacted]@");
  });

  it("émet une réponse error -32603 si le body stream est interrompu (text() throw)", async () => {
    // Simule une response où text() rejette (gateway coupe la connexion après
    // les headers). Sans le catch sur response.text(), le client MCP hang.
    const brokenResponse = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("stream aborted")),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(brokenResponse);
    await forwardLine('{"jsonrpc":"2.0","id":9,"method":"tools/call"}', fetchMock, writeOut);
    const payload = JSON.parse(firstWrite(writes).trim());
    expect(payload.id).toBe(9);
    expect(payload.error.code).toBe(-32603);
    expect(payload.error.message).toContain("Body stream interrupted");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("body stream interrupted: stream aborted"),
    );
  });

  it("ne réécrit pas un body vide en stdout (204 No Content équivalent)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("", { status: 200, headers: { "content-type": "application/json" } }),
      );
    await forwardLine(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      fetchMock,
      writeOut,
    );
    expect(writes).toEqual([]);
  });

  it("normalise les newlines en queue de body upstream (exactement un \\n final)", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":{}}\n\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    await forwardLine('{"jsonrpc":"2.0","id":1,"method":"ping"}', fetchMock, writeOut);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.match(/\n+$/u)?.[0]).toBe("\n");
  });
});
