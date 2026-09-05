import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, RateLimitExceededError, fetchJson, parseRetryAfterSeconds } from "./http.js";
import { runWithFakeTimers } from "./test-helpers.js";

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

  // Garde-fou : si une API amont renvoie 429 SANS le header `retry-after` (cas
  // dégradé, observé sur certains proxies), `parseRetryAfterSeconds(null)` rend `null` et le caller doit
  // retourner un défaut > 0 ET un retry doit être tenté. Sans cet ensemble
  // d'assertions, un changement du défaut vers 0 (qui produirait une hot-loop
  // sur les 429 sans header) passerait silencieusement : un drain de timer
  // avec délai 0 résout instantanément et `fetchMock.toHaveBeenCalledTimes(2)`
  // resterait vrai. On vérifie donc EXPLICITEMENT qu'un timer non-trivial est
  // armé avant le drain (`expect(vi.getTimerCount()).toBeGreaterThan(0)`).
  it("429 sans retry-after : fallback timer armé > 0, retry réussit", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(jsonOk({ ok: true }));

      const promise = fetchJson<{ ok: boolean }>("https://example.test/api", {
        maxRetries: 1,
      });
      // Yield la 1re microtâche : sans ça, `fetchJson` n'a pas encore eu le
      // temps d'enregistrer son `setTimeout(retry-after)` au moment du check.
      await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      const result = await runWithFakeTimers(promise);
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("retry sur réponse non-JSON transitoire (HTML 200) puis réussit (P3)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("<html>503 maintenance</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(jsonOk({ ok: true }));
    const data = await fetchJson<{ ok: boolean }>("https://example.test/api", { baseDelayMs: 10 });
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("réponse non-JSON persistante → throw SyntaxError après épuisement des retries (P3)", async () => {
    // Response fraîche par appel : un body ne se lit qu'une fois (en prod
    // chaque fetch renvoie une nouvelle Response — le mock doit le simuler).
    fetchMock.mockImplementation(async () =>
      Promise.resolve(
        new Response("<html>down</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    await expect(
      fetchJson("https://example.test/api", { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalled();
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

describe("parseRetryAfterSeconds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("entier de secondes → tel quel ; absent / 0 / date passée → null sans warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRetryAfterSeconds("7")).toBe(7);
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds("0")).toBeNull();
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("HTTP-date future → secondes restantes (jamais lue comme « 21 s » par parseInt)", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const s = parseRetryAfterSeconds(future);
    expect(s).not.toBeNull();
    expect(s as number).toBeGreaterThanOrEqual(29);
    expect(s as number).toBeLessThanOrEqual(31);
  });

  it("header présent mais illisible → null + warn (dégradation amont jamais muette)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRetryAfterSeconds("banana")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retry-after header unreadable"));
  });

  it("au-delà du plafond → écrêté + warn (retry potentiellement prématuré)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRetryAfterSeconds("300")).toBe(60);
    expect(parseRetryAfterSeconds("300", 120)).toBe(120);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("capped to 60s"));
  });
});
