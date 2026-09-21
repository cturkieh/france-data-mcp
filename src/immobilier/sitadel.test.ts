import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Supabase : .from().select().eq().lte().order().limit() → { data, error }
// ---------------------------------------------------------------------------

const mockFrom = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ from: mockFrom }),
}));

import { permitsForCommune } from "./sitadel.js";

type Row = { annee: unknown; log_aut: unknown; log_com: unknown };
type DbError = { message: string; code?: string };

function mockQuery(result: { data: Row[] | null; error: DbError | null }) {
  const limit = vi.fn().mockResolvedValue(result);
  const order = vi.fn().mockReturnValue({ limit });
  const lte = vi.fn().mockReturnValue({ order });
  const eq = vi.fn().mockReturnValue({ lte });
  const select = vi.fn().mockReturnValue({ eq });
  mockFrom.mockReturnValue({ select });
  return { select, eq, lte, order, limit };
}

beforeEach(() => {
  mockFrom.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permitsForCommune", () => {
  it("(a) somme la fenêtre, calcule habitants_attendus, trie les années", async () => {
    // Chiffres RÉELS Villejuif 94076 (parité live prouvée 2026-09-21).
    mockQuery({
      data: [
        { annee: 2026, log_aut: 68, log_com: 126 },
        { annee: 2024, log_aut: 557, log_com: 411 },
        { annee: 2025, log_aut: 328, log_com: 306 },
      ],
      error: null,
    });

    const result = await permitsForCommune("94076", { years: 3, currentYear: 2026 });

    expect(result.couverture).toBe("ok");
    expect(result.annees).toEqual(["2024", "2025", "2026"]);
    expect(result.logements_autorises_recent).toBe(953);
    expect(result.logements_commences_recent).toBe(843);
    expect(result.par_annee["2024"]).toEqual({ aut: 557, com: 411 });
    expect(result.habitants_attendus).toBe(Math.round(953 * 2.2));
  });

  it("sert les N dernières années PUBLIÉES (ordre décroissant + limit), pas une fenêtre d'horloge", async () => {
    const { select, eq, lte, order, limit } = mockQuery({ data: [], error: null });

    // 10 janvier 2027 : 2027 n'existe pas encore chez le SDES. Une borne basse
    // `2027 − 5 + 1 = 2023` ne servirait que 4 années (2023-2026).
    await permitsForCommune("94076", { years: 5, currentYear: 2027 });

    expect(mockFrom).toHaveBeenCalledWith("sitadel_logements");
    expect(select).toHaveBeenCalledWith("annee, log_aut, log_com");
    expect(eq).toHaveBeenCalledWith("code_insee", "94076");
    expect(lte).toHaveBeenCalledWith("annee", 2027);
    expect(order).toHaveBeenCalledWith("annee", { ascending: false });
    expect(limit).toHaveBeenCalledWith(5);
  });

  it.each([
    ["75115", "75056"],
    ["69383", "69123"],
    ["13208", "13055"],
  ])(
    "replie l'arrondissement %s sur la commune %s (Sit@del ignore les arrondissements)",
    async (arr, commune) => {
      const { eq } = mockQuery({ data: [], error: null });
      await permitsForCommune(arr);
      expect(eq).toHaveBeenCalledWith("code_insee", commune);
    },
  );

  it("(b) aucune ligne → 'indisponible:no_data' avec zéros", async () => {
    mockQuery({ data: [], error: null });

    const result = await permitsForCommune("99999");

    expect(result).toEqual({
      couverture: "indisponible:no_data",
      logements_autorises_recent: 0,
      logements_commences_recent: 0,
      par_annee: {},
      habitants_attendus: 0,
      annees: [],
    });
  });

  it("(b2) commune connue à 0 logement → couverture 'ok' (0 est une donnée, pas une absence)", async () => {
    mockQuery({ data: [{ annee: 2025, log_aut: 0, log_com: 0 }], error: null });

    const result = await permitsForCommune("55189", { currentYear: 2026 });

    expect(result.couverture).toBe("ok");
    expect(result.logements_autorises_recent).toBe(0);
    expect(result.annees).toEqual(["2025"]);
  });

  it("(c) erreur DB → warn + throw (jamais confondue avec 'pas de donnée')", async () => {
    mockQuery({ data: null, error: { message: "relation does not exist", code: "42P01" } });

    await expect(permitsForCommune("94076")).rejects.toThrow(/DB error \[code=42P01\]/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp] sitadel"));
  });

  it("réalisme PostgREST : des valeurs en STRING s'additionnent, ne se concatènent pas", async () => {
    mockQuery({
      data: [
        { annee: "2025", log_aut: "100", log_com: "40" },
        { annee: "2026", log_aut: "23", log_com: "7" },
      ],
      error: null,
    });

    const result = await permitsForCommune("94076", { currentYear: 2026 });

    expect(result.logements_autorises_recent).toBe(123);
    expect(result.logements_commences_recent).toBe(47);
  });

  it("null n'est PAS 0 : une valeur nulle est une ligne illisible (Number(null) vaut 0)", async () => {
    mockQuery({
      data: [
        { annee: 2025, log_aut: null, log_com: 3 },
        { annee: 2026, log_aut: 5, log_com: 2 },
      ],
      error: null,
    });

    const result = await permitsForCommune("94076", { currentYear: 2026 });

    expect(result.annees).toEqual(["2026"]);
    expect(result.logements_autorises_recent).toBe(5);
  });

  it("des lignes en base mais AUCUNE lisible → throw (corruption), jamais 'no_data'", async () => {
    mockQuery({ data: [{ annee: 2025, log_aut: "N/A", log_com: null }], error: null });

    await expect(permitsForCommune("94076", { currentYear: 2026 })).rejects.toThrow(
      /AUCUNE lisible — corruption/,
    );
  });

  it("fenêtre demandée plus large que le stock → warn (troncature jamais muette)", async () => {
    mockQuery({ data: [], error: null });
    await permitsForCommune("94076", { years: 10, currentYear: 2026 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("fenêtre demandée 10 ans"));
  });

  it("ligne illisible → ignorée + warn, les autres sont servies", async () => {
    mockQuery({
      data: [
        { annee: 2025, log_aut: "N/A", log_com: 1 },
        { annee: 2026, log_aut: 5, log_com: 2 },
      ],
      error: null,
    });

    const result = await permitsForCommune("94076", { currentYear: 2026 });

    expect(result.annees).toEqual(["2026"]);
    expect(result.logements_autorises_recent).toBe(5);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("ligne illisible"));
  });
});
