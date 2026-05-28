import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
vi.mock("./supabase.js", () => ({
  getUntypedAnonClient: () => ({ from: mockFrom }),
}));

import { __resetIngestLogCacheForTesting, getDataFreshness } from "./ingest-log.js";

beforeEach(() => {
  __resetIngestLogCacheForTesting();
  mockFrom.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Helper qui construit le chainable supabase-js `.select().in().order().limit()`.
 * Le terminal `.limit()` est awaitable et retourne `{ data, error }`.
 */
function mockQuery(rows: unknown[], error: { message: string } | null = null) {
  const limit = vi.fn().mockResolvedValue({ data: rows, error });
  const order = vi.fn().mockReturnValue({ limit });
  const _in = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ in: _in });
  mockFrom.mockReturnValue({ select });
  return { select, _in, order, limit };
}

describe("getDataFreshness", () => {
  it("retourne une ligne par source connue, même quand ingest_log est vide", async () => {
    mockQuery([]);
    const result = await getDataFreshness();
    expect(result.map((r) => r.source).sort()).toEqual([
      "ameli_ps",
      "cds",
      "finess",
      "iris",
      "rpps",
    ]);
    for (const r of result) {
      expect(r.last_success_at).toBeNull();
      expect(r.staleness_days).toBeNull();
      expect(r.cadence_hint).toBeTruthy();
    }
  });

  it("calcule last_success_at et staleness_days depuis la dernière row 'success'", async () => {
    const now = new Date("2026-05-11T10:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockQuery([
      {
        source: "finess",
        started_at: fiveDaysAgo,
        finished_at: fiveDaysAgo,
        status: "success",
        row_count: 90000,
      },
    ]);
    const result = await getDataFreshness();
    const finess = result.find((r) => r.source === "finess");
    expect(finess?.last_success_at).toBe(fiveDaysAgo);
    expect(finess?.staleness_days).toBe(5);
    expect(finess?.last_success_row_count).toBe(90000);

    vi.useRealTimers();
  });

  it("la dernière tentative peut être un échec mais last_success_at remonte au dernier 'success'", async () => {
    const now = new Date("2026-05-11T10:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mockQuery([
      // Plus récente = échec (1er dans l'ordre desc)
      {
        source: "rpps",
        started_at: yesterday,
        finished_at: yesterday,
        status: "failed",
        row_count: null,
      },
      // Plus ancienne = succès
      {
        source: "rpps",
        started_at: tenDaysAgo,
        finished_at: tenDaysAgo,
        status: "success",
        row_count: 2_200_000,
      },
    ]);
    const result = await getDataFreshness();
    const rpps = result.find((r) => r.source === "rpps");
    expect(rpps?.last_attempt_status).toBe("failed");
    expect(rpps?.last_attempt_at).toBe(yesterday);
    expect(rpps?.last_success_at).toBe(tenDaysAgo);
    expect(rpps?.staleness_days).toBe(10);

    vi.useRealTimers();
  });

  it("throw quand l'accès à ingest_log échoue (pas de silent failure)", async () => {
    mockQuery([], { message: "permission denied" });
    await expect(getDataFreshness()).rejects.toThrow(/permission denied/);
  });

  it("cache mémoire 5 min : un 2e appel ne refait pas la query DB", async () => {
    mockQuery([]);
    await getDataFreshness();
    await getDataFreshness();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
