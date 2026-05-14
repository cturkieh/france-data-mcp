import type { VercelRequest } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getAxiomBufferLengthForTesting,
  __resetAxiomStateForTesting,
  extractUserAgent,
  flushMcpEventsToAxiom,
  logMcpEvent,
} from "./observability.js";

function fakeReq(headers: Record<string, string | undefined>) {
  return { headers } as unknown as VercelRequest;
}

describe("extractUserAgent", () => {
  it("retourne 'unknown' si header absent", () => {
    expect(extractUserAgent(fakeReq({}))).toBe("unknown");
  });

  it("retourne 'unknown' si header vide", () => {
    expect(extractUserAgent(fakeReq({ "user-agent": "" }))).toBe("unknown");
  });

  it("retourne le user-agent tel quel sous 200 chars", () => {
    const ua = "Claude/1.0 (claude.ai)";
    expect(extractUserAgent(fakeReq({ "user-agent": ua }))).toBe(ua);
  });

  it("tronque à 200 chars avec ellipsis si trop long", () => {
    const ua = "X".repeat(500);
    const result = extractUserAgent(fakeReq({ "user-agent": ua }));
    expect(result.length).toBeLessThanOrEqual(201);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("logMcpEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("émet une seule ligne JSON avec les champs canoniques", () => {
    logMcpEvent({
      method: "tools/call",
      tool: "autocomplete_commune",
      ipHash: "deadbeefcafe1234",
      userAgent: "Claude/1.0",
      durationMs: 42,
      status: 200,
      outcome: "success",
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      component: "mcp-endpoint",
      method: "tools/call",
      tool: "autocomplete_commune",
      ip_hash: "deadbeefcafe1234",
      user_agent: "Claude/1.0",
      duration_ms: 42,
      status: 200,
      outcome: "success",
    });
    expect(typeof payload.ts).toBe("string");
  });

  it("route les 4xx vers console.warn", () => {
    logMcpEvent({
      method: "tools/call",
      ipHash: "h",
      userAgent: "ua",
      durationMs: 10,
      status: 429,
      outcome: "rate_limited",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("route les 5xx vers console.error", () => {
    logMcpEvent({
      method: "tools/call",
      ipHash: "h",
      userAgent: "ua",
      durationMs: 10,
      status: 500,
      outcome: "internal_error",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("respecte un niveau forcé dans event.level", () => {
    logMcpEvent({
      method: "tools/call",
      ipHash: "h",
      userAgent: "ua",
      durationMs: 10,
      status: 200,
      outcome: "success",
      level: "warn",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("omet la clé `tool` si non fournie", () => {
    logMcpEvent({
      method: "initialize",
      ipHash: "h",
      userAgent: "ua",
      durationMs: 1,
      status: 200,
      outcome: "success",
    });
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload.tool).toBeUndefined();
  });

  it("merge les `extra` dans le payload sans écraser les champs canoniques", () => {
    logMcpEvent({
      method: "tools/call",
      tool: "x",
      ipHash: "h",
      userAgent: "ua",
      durationMs: 1,
      status: 429,
      outcome: "rate_limited",
      extra: { backend: "upstash", retry_after_s: 12 },
    });
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(payload.backend).toBe("upstash");
    expect(payload.retry_after_s).toBe(12);
    expect(payload.status).toBe(429);
  });

  it("garantit que `extra` ne peut écraser AUCUN champ canonique (status, outcome, method, tool, ts, component, ip_hash, user_agent, duration_ms)", () => {
    logMcpEvent({
      method: "tools/call",
      tool: "real_tool",
      ipHash: "h",
      userAgent: "ua",
      durationMs: 42,
      status: 429,
      outcome: "rate_limited",
      extra: {
        status: 999,
        outcome: "spoofed",
        method: "spoofed",
        tool: "spoofed",
        ip_hash: "spoofed",
        user_agent: "spoofed",
        ts: "spoofed-ts",
        component: "spoofed-component",
        duration_ms: 9999,
      },
    });
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(payload.status).toBe(429);
    expect(payload.outcome).toBe("rate_limited");
    expect(payload.method).toBe("tools/call");
    expect(payload.tool).toBe("real_tool");
    expect(payload.ip_hash).toBe("h");
    expect(payload.user_agent).toBe("ua");
    expect(payload.duration_ms).toBe(42);
    expect(payload.component).toBe("mcp-endpoint");
    expect(payload.ts).not.toBe("spoofed-ts");
    expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ne crash pas si `extra` contient un objet circulaire — émet un payload dégradé", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() =>
      logMcpEvent({
        method: "tools/call",
        tool: "x",
        ipHash: "h",
        userAgent: "ua",
        durationMs: 1,
        status: 500,
        outcome: "internal_error",
        extra: { circular },
      }),
    ).not.toThrow();
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const degraded = errorSpy.mock.calls.map((c) => c[0] as string).find((s) => s.startsWith("{"));
    expect(degraded).toBeDefined();
    const payload = JSON.parse(degraded as string);
    expect(payload.log_serialize_error).toMatch(/circular|Converting circular/i);
    expect(payload.status).toBe(500);
    expect(payload.outcome).toBe("internal_error");
  });
});

describe("flushMcpEventsToAxiom", () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = ["AXIOM_TOKEN", "AXIOM_DATASET", "VERCEL_ENV", "NODE_ENV"];

  beforeEach(() => {
    for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    __resetAxiomStateForTesting();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k];
    }
    __resetAxiomStateForTesting();
    vi.restoreAllMocks();
  });

  function logSuccessEvent(tool = "autocomplete_commune"): void {
    logMcpEvent({
      method: "tools/call",
      tool,
      ipHash: "deadbeef",
      userAgent: "Claude/1.0",
      durationMs: 12,
      status: 200,
      outcome: "success",
    });
  }

  it("no-op si buffer vide", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await flushMcpEventsToAxiom();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-op si AXIOM_TOKEN absent (dev local)", async () => {
    process.env.AXIOM_DATASET = "france-data-mcp";
    logSuccessEvent();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await flushMcpEventsToAxiom();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(__getAxiomBufferLengthForTesting()).toBe(0); // buffer drained
  });

  it("no-op si AXIOM_DATASET absent (dev local)", async () => {
    process.env.AXIOM_TOKEN = "tok";
    logSuccessEvent();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await flushMcpEventsToAxiom();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(__getAxiomBufferLengthForTesting()).toBe(0);
  });

  it("POST batch + bons headers + url encodée + _time injecté", async () => {
    process.env.AXIOM_TOKEN = "secret-token";
    process.env.AXIOM_DATASET = "france-data-mcp";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    logSuccessEvent("etablissement_by_finess");
    logSuccessEvent("entreprise_by_siren");

    await flushMcpEventsToAxiom();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.axiom.co/v1/datasets/france-data-mcp/ingest");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      tool: "etablissement_by_finess",
      method: "tools/call",
      status: 200,
    });
    expect(typeof body[0]._time).toBe("string");
    expect(body[0]._time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Invariant : `_time` réutilise le `ts` canonique pour éviter le drift de timing
    expect(body[0]._time).toBe(body[0].ts);
    expect(__getAxiomBufferLengthForTesting()).toBe(0);
  });

  it("respecte AXIOM_HOST override (région EU)", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "ds";
    process.env.AXIOM_HOST = "api.eu.axiom.co";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.eu.axiom.co/v1/datasets/ds/ingest");
  });

  it("AXIOM_HOST whitespace seul ignoré, fallback default", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "ds";
    process.env.AXIOM_HOST = "   ";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.axiom.co/v1/datasets/ds/ingest");
  });

  it("warn si body Axiom unreadable (text() throw)", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "ds";
    const fakeRes = new Response("", { status: 500 });
    Object.defineProperty(fakeRes, "text", {
      value: () => Promise.reject(new Error("body stream closed")),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeRes);
    logSuccessEvent();
    await expect(flushMcpEventsToAxiom()).resolves.toBeUndefined();
    const warnSpy = vi.mocked(console.warn);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("body unreadable"))).toBe(true);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("500"))).toBe(true);
  });

  it("encode l'URL si dataset contient des chars spéciaux", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "france/data mcp";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.axiom.co/v1/datasets/france%2Fdata%20mcp/ingest");
  });

  it("warn si Axiom répond 4xx/5xx (fail-soft, pas de throw)", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "ds";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    );
    logSuccessEvent();
    await expect(flushMcpEventsToAxiom()).resolves.toBeUndefined();
    const warnSpy = vi.mocked(console.warn);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("403"))).toBe(true);
  });

  it("warn si fetch reject (réseau down, fail-soft)", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "ds";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unreachable"));
    logSuccessEvent();
    await expect(flushMcpEventsToAxiom()).resolves.toBeUndefined();
    const warnSpy = vi.mocked(console.warn);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("network unreachable"))).toBe(
      true,
    );
  });

  it("logMcpEvent enqueue automatiquement dans le buffer", () => {
    expect(__getAxiomBufferLengthForTesting()).toBe(0);
    logSuccessEvent();
    expect(__getAxiomBufferLengthForTesting()).toBe(1);
    logSuccessEvent();
    expect(__getAxiomBufferLengthForTesting()).toBe(2);
  });

  it("buffer cap : drop le plus ancien au-delà de 500", () => {
    for (let i = 0; i < 510; i++) logSuccessEvent();
    expect(__getAxiomBufferLengthForTesting()).toBe(500);
  });

  it("warn une fois au premier buffer overflow (silent drop visibilisé)", () => {
    for (let i = 0; i < 510; i++) logSuccessEvent();
    const warnSpy = vi.mocked(console.warn);
    const overflowWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Axiom buffer overflow"),
    );
    expect(overflowWarns).toHaveLength(1);
  });

  it("warn en prod si AXIOM_TOKEN absent — promesse PRIVACY.md non tenue", async () => {
    process.env.VERCEL_ENV = "production";
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    const errSpy = vi.mocked(console.error);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("AXIOM_TOKEN"))).toBe(true);
  });

  it("ne warn pas en preview", async () => {
    process.env.VERCEL_ENV = "preview";
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    const errSpy = vi.mocked(console.error);
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes("AXIOM_TOKEN"))).toHaveLength(
      0,
    );
  });

  it("warn une seule fois par cold start, même sur plusieurs flush", async () => {
    process.env.VERCEL_ENV = "production";
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    logSuccessEvent();
    await flushMcpEventsToAxiom();
    const errSpy = vi.mocked(console.error);
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes("AXIOM_TOKEN"))).toHaveLength(
      1,
    );
  });
});
