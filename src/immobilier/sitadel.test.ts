import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permitsForCommune } from "./sitadel.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

function csvOk(csvText: string): Response {
  return new Response(csvText, {
    status: 200,
    headers: { "content-type": "text/csv" },
  });
}

// Build a CSV body with header + rows.
// Separator: ;  all values double-quoted (as the real DiDo API).
function buildCsv(rows: Array<Record<string, string>>): string {
  const headers = [
    "ANNEE",
    "MOIS",
    "CODE_INSEE",
    "TYPE_LGT",
    "LOG_AUT",
    "LOG_COM",
    "SDP_AUT",
    "SDP_COM",
  ];
  const quote = (v: string) => `"${v}"`;
  const headerLine = headers.map(quote).join(";");
  const dataLines = rows.map((r) => headers.map((h) => quote(r[h] ?? "0")).join(";"));
  return [headerLine, ...dataLines].join("\n");
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("permitsForCommune", () => {
  it("(a) sums only 'Tous Logements', ignores sub-types, respects year window, computes habitants_attendus", async () => {
    // currentYear = 2026, years = 3 → window = [2024, 2025, 2026]
    // Rows 2023 (in range year window only if years=4+) → should be excluded
    const csv = buildCsv([
      // "Tous Logements" in window — should be counted
      {
        ANNEE: "2024",
        MOIS: "01",
        CODE_INSEE: "50041",
        TYPE_LGT: "Tous Logements",
        LOG_AUT: "100",
        LOG_COM: "80",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
      {
        ANNEE: "2025",
        MOIS: "01",
        CODE_INSEE: "50041",
        TYPE_LGT: "Tous Logements",
        LOG_AUT: "120",
        LOG_COM: "90",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
      {
        ANNEE: "2026",
        MOIS: "01",
        CODE_INSEE: "50041",
        TYPE_LGT: "Tous Logements",
        LOG_AUT: "50",
        LOG_COM: "30",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
      // Sub-type — must be ignored
      {
        ANNEE: "2024",
        MOIS: "01",
        CODE_INSEE: "50041",
        TYPE_LGT: "Individuel pur",
        LOG_AUT: "999",
        LOG_COM: "999",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
      {
        ANNEE: "2025",
        MOIS: "01",
        CODE_INSEE: "50041",
        TYPE_LGT: "Collectif",
        LOG_AUT: "999",
        LOG_COM: "999",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
      // "Tous Logements" outside window (2023) — must be ignored
      {
        ANNEE: "2023",
        MOIS: "01",
        CODE_INSEE: "50041",
        TYPE_LGT: "Tous Logements",
        LOG_AUT: "999",
        LOG_COM: "999",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
    ]);

    fetchMock.mockResolvedValue(csvOk(csv));

    const result = await permitsForCommune("50041", { years: 3, currentYear: 2026 });

    expect(result.couverture).toBe("ok");
    // 100 + 120 + 50 = 270
    expect(result.logements_autorises_recent).toBe(270);
    // 80 + 90 + 30 = 200
    expect(result.logements_commences_recent).toBe(200);
    // round(270 * 2.2) = round(594) = 594
    expect(result.habitants_attendus).toBe(594);
    expect(result.annees).toEqual(["2024", "2025", "2026"]);
    expect(result.par_annee["2024"]).toEqual({ aut: 100, com: 80 });
    expect(result.par_annee["2025"]).toEqual({ aut: 120, com: 90 });
    expect(result.par_annee["2026"]).toEqual({ aut: 50, com: 30 });
    // Sub-types and out-of-window year must NOT appear
    expect(result.par_annee["2023"]).toBeUndefined();
  });

  it("(b) empty / no matching rows → couverture 'indisponible:no_data' with zeros", async () => {
    // Body with only sub-type rows (no "Tous Logements")
    const csv = buildCsv([
      {
        ANNEE: "2025",
        MOIS: "01",
        CODE_INSEE: "12345",
        TYPE_LGT: "Individuel pur",
        LOG_AUT: "50",
        LOG_COM: "30",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
    ]);
    fetchMock.mockResolvedValue(csvOk(csv));

    const result = await permitsForCommune("12345", { years: 5, currentYear: 2026 });

    expect(result.couverture).toBe("indisponible:no_data");
    expect(result.logements_autorises_recent).toBe(0);
    expect(result.logements_commences_recent).toBe(0);
    expect(result.habitants_attendus).toBe(0);
    expect(result.annees).toEqual([]);
    expect(result.par_annee).toEqual({});
  });

  it("(b2) completely empty body → couverture 'indisponible:no_data'", async () => {
    // Header only, no data rows
    fetchMock.mockResolvedValue(
      csvOk('"ANNEE";"MOIS";"CODE_INSEE";"TYPE_LGT";"LOG_AUT";"LOG_COM";"SDP_AUT";"SDP_COM"'),
    );

    const result = await permitsForCommune("00000", { years: 5, currentYear: 2026 });

    expect(result.couverture).toBe("indisponible:no_data");
    expect(result.logements_autorises_recent).toBe(0);
  });

  it("(c) fetch rejects → permitsForCommune rejects (error propagates)", async () => {
    fetchMock.mockRejectedValue(new TypeError("network failure"));

    await expect(permitsForCommune("50041")).rejects.toThrow(/network failure/);
    expect(console.warn).toHaveBeenCalled();
  });

  it("(c2) HTTP error → permitsForCommune rejects", async () => {
    fetchMock.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    await expect(permitsForCommune("50041")).rejects.toThrow(/HTTP 500/);
    expect(console.warn).toHaveBeenCalled();
  });

  it("calls the correct DiDo URL with CODE_INSEE filter", async () => {
    const csv = buildCsv([
      {
        ANNEE: "2025",
        MOIS: "01",
        CODE_INSEE: "75056",
        TYPE_LGT: "Tous Logements",
        LOG_AUT: "10",
        LOG_COM: "8",
        SDP_AUT: "0",
        SDP_COM: "0",
      },
    ]);
    fetchMock.mockResolvedValue(csvOk(csv));

    await permitsForCommune("75056", { years: 5, currentYear: 2026 });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("577a8a66-4157-4787-b00a-031b61afea61");
    expect(calledUrl).toContain("CODE_INSEE=eq:75056");
  });
});
