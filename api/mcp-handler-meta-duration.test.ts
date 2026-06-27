import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockVercelRes } from "./_lib/test-helpers.js";

/**
 * Garde-fou du fix `duration_ms` des chemins meta (early-return 405/400).
 *
 * Avant : `emit(ctx, 0, …)` loggait `Date.now() - 0` = l'epoch entier (~1.7e12)
 * au lieu d'une durée ~0 ms → polluait tout agrégat `duration_ms` Axiom. Le fix
 * passe le `requestStart` réel du handler. On capture l'event via le mock de
 * `logMcpEvent` et on vérifie que la durée est réaliste (pas un timestamp).
 */
const mocks = vi.hoisted(() => ({
  logMcpEvent: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("./_lib/observability.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, logMcpEvent: mocks.logMcpEvent };
});

vi.mock("./_lib/sentry.js", () => ({
  captureMcpError: vi.fn(),
  captureMcpConfigWarning: vi.fn(),
  flushSentry: vi.fn().mockResolvedValue(undefined),
}));

import handler from "./mcp.js";

/** Plus grand que toute durée d'early-return plausible, mais 8 ordres de
 *  grandeur sous l'epoch ms (~1.7e12) que produisait le bug `start=0`. */
const MAX_PLAUSIBLE_MS = 60_000;

function durationFor(method: string): number | undefined {
  const event = mocks.logMcpEvent.mock.calls
    .map((c: unknown[]) => c[0] as { method?: string; durationMs?: number })
    .find((e: { method?: string; durationMs?: number }) => e.method === method);
  return event?.durationMs;
}

describe("handler — duration_ms des chemins meta (early-return)", () => {
  beforeEach(() => mocks.logMcpEvent.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("HEAD (405) → http_HEAD loggé avec une durée RÉALISTE, pas l'epoch", async () => {
    const req = { method: "HEAD", headers: { "x-forwarded-for": "203.0.113.7" } };
    const { res } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res);

    const ms = durationFor("http_HEAD");
    expect(ms).toBeDefined();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(MAX_PLAUSIBLE_MS); // régression bug start=0 → ~1.7e12
  });

  it("POST vide (400) → http_post_empty loggé avec une durée réaliste", async () => {
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: undefined,
    };
    const { res } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res);

    const ms = durationFor("http_post_empty");
    expect(ms).toBeDefined();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(MAX_PLAUSIBLE_MS);
  });
});
