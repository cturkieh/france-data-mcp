/**
 * Garde-fou FRANCE-DATA-MCP-S : une dépendance amont en HTTP 429 APRÈS les
 * retries de `fetchJson` (`RateLimitExceededError`) est une limite de débit
 * transitoire, pas un bug serveur.
 *
 * Contrat : JSON-RPC `-32000` + `error.data = { retryAfterSeconds, upstreamHost }`,
 * log `outcome=upstream_rate_limited` (status 503, level warn), et une capture
 * Sentry `warning` agrégée par host (`captureUpstreamRateLimit`, fingerprint
 * `["mcp_upstream_rate_limited", upstreamHost]`), JAMAIS `captureMcpError`
 * (avant le fix : `-32603` + `captureMcpError` niveau `error` par event).
 *
 * Bout-en-bout : `fetch` stubbé renvoie 429 sur l'IGN, le vrai `fetchJson`
 * épuise ses retries (timers simulés) puis throw la vraie classe d'erreur.
 * Setup similaire à `api/mcp-handler-error-cause.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockVercelRes } from "./_lib/test-helpers.js";

const mocks = vi.hoisted(() => ({
  captureMcpError: vi.fn(),
  captureUpstreamRateLimit: vi.fn(),
  logMcpEvent: vi.fn(),
}));

vi.mock("./_lib/sentry.js", () => ({
  captureMcpError: mocks.captureMcpError,
  captureUpstreamRateLimit: mocks.captureUpstreamRateLimit,
  captureMcpConfigWarning: vi.fn(),
  flushSentry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./_lib/observability.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logMcpEvent: mocks.logMcpEvent,
    flushMcpEventsToAxiom: vi.fn().mockResolvedValue(undefined),
  };
});

import handler from "./mcp.js";

const fetchMock = vi.fn<typeof fetch>();

describe("api/mcp.ts — dépendance amont en 429 après retries (FRANCE-DATA-MCP-S)", () => {
  beforeEach(() => {
    mocks.captureMcpError.mockClear();
    mocks.captureUpstreamRateLimit.mockClear();
    mocks.logMcpEvent.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // Seul setTimeout est simulé : le backoff `retry-after` de fetchJson est
    // court-circuité, Date.now (durées de log, rate limit) reste réel.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("geocode_adresse sur IGN 429 → -32000 + retryAfterSeconds/upstreamHost, Sentry warning agrégé par host", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(
      async () =>
        new Response("Too Many Requests", { status: 429, headers: { "retry-after": "7" } }),
    );

    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "geocode_adresse", arguments: { adresse: "10 rue de Rivoli Paris" } },
      },
    };
    const { res, captured } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    const pending = handler(req as any, res);
    await vi.runAllTimersAsync();
    await pending;

    expect(captured.status).toBe(200);
    const json = captured.json as {
      error: { code: number; message: string; data?: unknown };
    };
    expect(json.error.code).toBe(-32000);
    expect(json.error.message).toContain("data.geopf.fr");
    expect(json.error.message).toContain("HTTP 429");
    expect(json.error.message).toContain("7 s");
    // La query (= input du caller) ne fuit pas dans le message.
    expect(json.error.message).not.toContain("Rivoli");
    expect(json.error.data).toEqual({ retryAfterSeconds: 7, upstreamHost: "data.geopf.fr" });

    // Pas un bug serveur : jamais captureMcpError (exception niveau error)…
    expect(mocks.captureMcpError).not.toHaveBeenCalled();
    // …mais un warning agrégé par host (fingerprint/level : sentry.test.ts).
    expect(mocks.captureUpstreamRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.captureUpstreamRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamHost: "data.geopf.fr",
        retryAfterSeconds: 7,
        method: "tools/call",
        tool: "geocode_adresse",
      }),
    );
    // Log structuré dédié, jamais `internal_error`.
    expect(mocks.logMcpEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "geocode_adresse",
        status: 503,
        outcome: "upstream_rate_limited",
        level: "warn",
      }),
    );
    expect(mocks.logMcpEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "internal_error" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp] upstream_rate_limited"),
    );
  });

  it("une HttpError amont non-429 (503) reste internal_error capturée Sentry (-32603)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));

    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "geocode_adresse", arguments: { adresse: "10 rue de Rivoli Paris" } },
      },
    };
    const { res, captured } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    const pending = handler(req as any, res);
    await vi.runAllTimersAsync();
    await pending;

    const json = captured.json as { error: { code: number } };
    expect(json.error.code).toBe(-32603);
    expect(mocks.captureMcpError).toHaveBeenCalledTimes(1);
    expect(mocks.captureUpstreamRateLimit).not.toHaveBeenCalled();
  });
});
