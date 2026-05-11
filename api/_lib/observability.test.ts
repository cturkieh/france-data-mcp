import type { VercelRequest } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractUserAgent, logMcpEvent } from "./observability.js";

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
