import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, RateLimitExceededError, fetchJson } from "./http.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchJson", () => {
  it("retourne le JSON parsé sur 200", async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true, count: 42 }));
    const data = await fetchJson<{ ok: boolean; count: number }>("https://example.test/api");
    expect(data).toEqual({ ok: true, count: 42 });
  });

  it("envoie un User-Agent identifiable par défaut", async () => {
    fetchMock.mockResolvedValue(jsonOk({}));
    await fetchJson("https://example.test/api");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/france-data-mcp/);
  });

  it("retry sur 429 avec respect de retry-after", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(jsonOk({ ok: true }));

    const data = await fetchJson<{ ok: boolean }>("https://example.test/api", { baseDelayMs: 10 });
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throw RateLimitExceededError après maxRetries de 429", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }),
    );

    await expect(
      fetchJson("https://example.test/api", { maxRetries: 1, baseDelayMs: 10 }),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("throw HttpError immédiatement sur 404 (pas de retry)", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(fetchJson("https://example.test/api")).rejects.toMatchObject({
      name: "HttpError",
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retry sur 503 puis réussit", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(jsonOk({ ok: true }));
    const data = await fetchJson<{ ok: boolean }>("https://example.test/api", { baseDelayMs: 10 });
    expect(data).toEqual({ ok: true });
  });

  it("loggue les erreurs réseau et bascule en console.error sur dernière tentative", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));

    await expect(
      fetchJson("https://example.test/api", { maxRetries: 1, baseDelayMs: 10 }),
    ).rejects.toThrow(/network down/);

    expect(console.error).toHaveBeenCalled();
  });

  it("HttpError expose status + url", () => {
    const err = new HttpError("boom", 500, "https://example.test/api", "body");
    expect(err.status).toBe(500);
    expect(err.url).toContain("example.test");
    expect(err.body).toBe("body");
  });
});
