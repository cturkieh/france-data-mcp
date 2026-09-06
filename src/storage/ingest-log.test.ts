import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
vi.mock("./supabase.js", () => ({
  getUntypedAnonClient: () => ({ from: mockFrom }),
}));

import {
  REAL_INGEST_STATUSES,
  __resetIngestLogCacheForTesting,
  ageInDays,
  getDataFreshness,
  isFailedRun,
  isServedRun,
  lastDataChange,
  runEndedAt,
} from "./ingest-log.js";

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

describe("last_data_change_at / data_age_days — post-mortem FINESS 2026-09-05", () => {
  const row = (
    day: string,
    status: string,
    skip_reason: string | null,
    row_count: number | null = null,
  ) => ({
    source: "finess",
    started_at: `${day}T04:00:00Z`,
    finished_at: `${day}T04:20:00Z`,
    status,
    row_count,
    skip_reason,
  });

  it("sept court-circuits same_checksum en `success` ne rajeunissent PAS la donnée", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    try {
      // Séquence RÉELLE d'ingest_log : dernière ingestion effective le 15 mai,
      // puis sept skips bimensuels jusqu'au 1er septembre, tous `success`.
      mockQuery([
        row("2026-09-01", "success", "same_checksum"),
        row("2026-08-15", "success", "same_checksum"),
        row("2026-08-01", "success", "same_checksum"),
        row("2026-07-15", "success", "same_checksum"),
        row("2026-07-01", "success", "same_checksum"),
        row("2026-06-15", "success", "same_checksum"),
        row("2026-06-01", "success", "same_checksum"),
        row("2026-05-15", "success", null, 93403),
      ]);
      const finess = (await getDataFreshness()).find((r) => r.source === "finess");
      // Ce que l'ancien contrat disait — et dit toujours, il n'est pas faux :
      expect(finess?.last_success_at).toBe("2026-09-01T04:20:00Z");
      expect(finess?.staleness_days).toBe(4);
      // Ce qui manquait — l'âge de la donnée réellement servie :
      expect(finess?.last_data_change_at).toBe("2026-05-15T04:20:00Z");
      expect(finess?.data_age_days).toBe(113);
      expect(finess?.last_success_row_count).toBeNull();
      // La règle d'alerte est une comparaison exposée, pas une consigne en prose.
      expect(finess?.expected_max_age_days).toBe(30);
      expect((finess?.data_age_days ?? 0) > (finess?.expected_max_age_days ?? 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un run `partial` (swap OK, matview KO) compte comme changement de donnée", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    try {
      mockQuery([
        row("2026-09-03", "success", "same_checksum"),
        row("2026-09-01", "partial", null, 104734),
        row("2026-08-15", "success", null, 93403),
      ]);
      const finess = (await getDataFreshness()).find((r) => r.source === "finess");
      expect(finess?.last_data_change_at).toBe("2026-09-01T04:20:00Z");
      expect(finess?.data_age_days).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rows sans colonne skip_reason (historique pré-V0.12) = ingestion réelle", async () => {
    mockQuery([
      {
        source: "rpps",
        started_at: "2026-09-01T04:00:00Z",
        finished_at: "2026-09-01T05:00:00Z",
        status: "success",
        row_count: 2282339,
      },
    ]);
    const rpps = (await getDataFreshness()).find((r) => r.source === "rpps");
    expect(rpps?.last_data_change_at).toBe("2026-09-01T05:00:00Z");
    expect(rpps?.last_data_change_at).toBe(rpps?.last_success_at);
  });

  it("aucune ingestion réelle → last_data_change_at et data_age_days null", async () => {
    mockQuery([row("2026-09-01", "success", "same_checksum")]);
    const finess = (await getDataFreshness()).find((r) => r.source === "finess");
    expect(finess?.last_success_at).not.toBeNull();
    expect(finess?.last_data_change_at).toBeNull();
    expect(finess?.data_age_days).toBeNull();
  });
});

describe("règle « ingestion réelle » partagée (data_freshness ↔ vigie notify-ingest-anomaly)", () => {
  it("ageInDays : jours entiers ; absent OU illisible → null (jamais Math.floor(NaN))", () => {
    const now = Date.parse("2026-09-06T05:00:00Z");
    expect(ageInDays("2026-09-04T06:00:00Z", now)).toBe(1);
    expect(ageInDays(null, now)).toBeNull();
    expect(ageInDays(undefined, now)).toBeNull();
    expect(ageInDays("pas-une-date", now)).toBeNull();
  });

  it("lastDataChange : dernier run servi (success|partial) SANS skip_reason + skips depuis ; trie en interne", () => {
    const rows = [
      { started_at: "2026-09-01", status: "success", skip_reason: "same_checksum" },
      { started_at: "2026-08-25", status: "failed", skip_reason: null },
      { started_at: "2026-08-18", status: "partial", skip_reason: null },
      { started_at: "2026-08-11", status: "success", skip_reason: null },
    ];
    expect(lastDataChange(rows)).toEqual({ row: rows[2], skipsSince: 1 });
    // Ordre CROISSANT en entrée → même réponse (l'invariant « plus récent
    // d'abord » ne vit plus en JSDoc : un appelant mal trié obtiendrait sinon
    // la PLUS ANCIENNE ingestion, data_age_days faux ET alerte fantôme).
    expect(lastDataChange([...rows].reverse())).toEqual({ row: rows[2], skipsSince: 1 });
    expect(lastDataChange(rows.slice(0, 2))).toEqual({ row: null, skipsSince: 1 });
    expect(REAL_INGEST_STATUSES).toEqual(["success", "partial"]);
    expect(isServedRun({ started_at: "x", status: "failed" })).toBe(false);
    expect(isFailedRun({ started_at: "x", status: "failed" })).toBe(true);
    expect(runEndedAt({ started_at: "s", finished_at: null })).toBe("s");
    expect(runEndedAt({ started_at: "s", finished_at: "f" })).toBe("f");
  });
});
