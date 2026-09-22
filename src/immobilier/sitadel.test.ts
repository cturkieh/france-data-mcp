import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Supabase : .from().select().eq().lte().order().limit() → { data, error }
// ---------------------------------------------------------------------------

const mockFrom = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ from: mockFrom }),
}));

import {
  MOIS_PAR_AN,
  type PermitsFenetre,
  type PermitsResult,
  SITADEL_DEFAULT_YEARS,
  SITADEL_YEARS_BACK,
  permitsForCommune,
} from "./sitadel.js";

type Row = { annee: unknown; log_aut: unknown; log_com: unknown; mois_couverts: unknown };
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

/** Narrowing de l'union : un test qui lit un total attend une fenêtre, jamais `no_data`. */
function fenetre(r: PermitsResult): PermitsFenetre {
  if (r.couverture === "indisponible:no_data") throw new Error("attendu une fenêtre, reçu no_data");
  return r;
}

beforeEach(() => {
  mockFrom.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permitsForCommune", () => {
  it("(a) somme les années PLEINES, sert l'année en cours À PART, trie les années", async () => {
    // Chiffres RÉELS Villejuif 94076 (parité live prouvée 2026-09-21) : 2026
    // n'a que 7 mois publiés. Sommée, elle passait pour une chute de 80 %.
    mockQuery({
      data: [
        { annee: 2026, log_aut: 68, log_com: 126, mois_couverts: 7 },
        { annee: 2023, log_aut: 410, log_com: 250, mois_couverts: 12 },
        { annee: 2024, log_aut: 557, log_com: 411, mois_couverts: 12 },
        { annee: 2025, log_aut: 328, log_com: 306, mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 3, currentYear: 2026 }));

    expect(result.couverture).toBe("ok");
    expect(result.annees).toEqual(["2023", "2024", "2025"]);
    expect(result.logements_autorises_recent).toBe(410 + 557 + 328);
    expect(result.logements_commences_recent).toBe(250 + 411 + 306);
    expect(result.par_annee["2024"]).toEqual({ aut: 557, com: 411, mois_couverts: 12 });
    expect(result.par_annee["2026"]).toBeUndefined();
    expect(result.annee_en_cours).toEqual({
      annee: 2026,
      mois_couverts: 7,
      logements_autorises: 68,
      logements_commences: 126,
    });
    expect(result.habitants_attendus).toBe(Math.round((410 + 557 + 328) * 2.2));
  });

  it("(a2) dernière année publiée COMPLÈTE (février) → annee_en_cours null, fenêtre = les N plus récentes", async () => {
    mockQuery({
      data: [
        { annee: 2026, log_aut: 100, log_com: 90, mois_couverts: 12 },
        { annee: 2025, log_aut: 328, log_com: 306, mois_couverts: 12 },
        { annee: 2024, log_aut: 557, log_com: 411, mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 2, currentYear: 2027 }));

    expect(result.annee_en_cours).toBeNull();
    expect(result.annees).toEqual(["2025", "2026"]);
    expect(result.logements_autorises_recent).toBe(428);
  });

  it("(a3) une année ANCIENNE à < 12 mois n'est pas « en cours » : sommée mais 'partiel:annees_incompletes' + warn (mois perdu par le SDES)", async () => {
    mockQuery({
      data: [
        { annee: 2025, log_aut: 10, log_com: 4, mois_couverts: 12 },
        { annee: 2024, log_aut: 3, log_com: 1, mois_couverts: 5 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 2, currentYear: 2026 }));

    expect(result.couverture).toBe("partiel:annees_incompletes");
    expect(result.annee_en_cours).toBeNull();
    expect(result.annees).toEqual(["2024", "2025"]);
    expect(result.par_annee["2024"]?.mois_couverts).toBe(5);
    expect(result.logements_autorises_recent).toBe(13);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("2024:5m"));
  });

  it("(a6) « année en cours » plus vieille que l'an dernier → servie hors total, mais warn « série tarie »", async () => {
    mockQuery({
      data: [
        { annee: 2024, log_aut: 9, log_com: 2, mois_couverts: 5 },
        { annee: 2023, log_aut: 10, log_com: 4, mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 1, currentYear: 2026 }));

    expect(result.couverture).toBe("ok");
    expect(result.annee_en_cours?.annee).toBe(2024);
    expect(result.logements_autorises_recent).toBe(10);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("série tarie"));
  });

  it("invariants structurels (fixture Villejuif) : annees = clés de par_annee, total = Σ, année en cours hors fenêtre et < 12 mois", async () => {
    mockQuery({
      data: [
        { annee: 2026, log_aut: 68, log_com: 126, mois_couverts: 7 },
        { annee: 2025, log_aut: 328, log_com: 306, mois_couverts: 12 },
        { annee: 2024, log_aut: 557, log_com: 411, mois_couverts: 12 },
        { annee: 2023, log_aut: 410, log_com: 250, mois_couverts: 12 },
        { annee: 2022, log_aut: 300, log_com: 200, mois_couverts: 12 },
        { annee: 2021, log_aut: 259, log_com: 180, mois_couverts: 12 },
      ],
      error: null,
    });

    const r = fenetre(await permitsForCommune("94076", { currentYear: 2026 }));

    expect(r.couverture).toBe("ok");
    expect(r.annees).toHaveLength(SITADEL_DEFAULT_YEARS);
    expect(Object.keys(r.par_annee).sort()).toEqual(r.annees);
    const entries = Object.values(r.par_annee);
    expect(entries.reduce((s, e) => s + e.aut, 0)).toBe(r.logements_autorises_recent);
    expect(entries.reduce((s, e) => s + e.com, 0)).toBe(r.logements_commences_recent);
    expect(entries.every((e) => e.mois_couverts === MOIS_PAR_AN)).toBe(true);
    expect(r.annee_en_cours).not.toBeNull();
    if (r.annee_en_cours) {
      expect(r.annees).not.toContain(String(r.annee_en_cours.annee));
      expect(r.annee_en_cours.annee).toBeGreaterThan(Math.max(...r.annees.map(Number)));
      expect(r.annee_en_cours.mois_couverts).toBeLessThan(MOIS_PAR_AN);
    }
  });

  it("rétention cron ≥ fenêtre par défaut + année en cours (sinon toute la France passe en partiel:fenetre_courte)", () => {
    const etiquettesStockees = SITADEL_YEARS_BACK + 1;
    expect(etiquettesStockees).toBeGreaterThanOrEqual(SITADEL_DEFAULT_YEARS + 1);
  });

  it.each([
    [{ years: 0 }, /years doit être un entier ≥ 1/],
    [{ years: 2.5 }, /years doit être un entier ≥ 1/],
    [{ currentYear: 2026.5 }, /currentYear doit être un entier/],
  ])(
    "opts=%j → RangeError au boundary (jamais un limit() ou un lte() absurde)",
    async (opts, re) => {
      mockQuery({ data: [], error: null });
      await expect(permitsForCommune("94076", opts)).rejects.toThrow(re);
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("(a5) moins d'années pleines que demandé → 'partiel:fenetre_courte' + warn (un total sur 2 ans n'est pas un total sur 5)", async () => {
    mockQuery({
      data: [
        { annee: 2025, log_aut: 10, log_com: 4, mois_couverts: 12 },
        { annee: 2024, log_aut: 3, log_com: 1, mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 5, currentYear: 2026 }));

    expect(result.couverture).toBe("partiel:fenetre_courte");
    expect(result.annees).toEqual(["2024", "2025"]);
    expect(result.logements_autorises_recent).toBe(13);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("partiel:fenetre_courte"));
  });

  it("(a4) seule l'année en cours existe → servie, mais couverture 'no_data' (aucun total fiable)", async () => {
    mockQuery({ data: [{ annee: 2026, log_aut: 9, log_com: 2, mois_couverts: 7 }], error: null });

    const result = await permitsForCommune("94076", { currentYear: 2026 });

    expect(result.couverture).toBe("indisponible:no_data");
    expect("annees" in result).toBe(false);
    expect(result.annee_en_cours).toEqual({
      annee: 2026,
      mois_couverts: 7,
      logements_autorises: 9,
      logements_commences: 2,
    });
  });

  it("mois_couverts illisible ou hors 1-12 → ligne ignorée + warn (jamais 12 par défaut)", async () => {
    mockQuery({
      data: [
        { annee: 2026, log_aut: 5, log_com: 2, mois_couverts: null },
        { annee: 2025, log_aut: 7, log_com: 3, mois_couverts: 13 },
        { annee: 2024, log_aut: 11, log_com: 6, mois_couverts: "12" },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 1, currentYear: 2026 }));

    expect(result.annees).toEqual(["2024"]);
    expect(result.logements_autorises_recent).toBe(11);
    // La ligne la plus récente jetée aurait pu être l'année en cours : `null`
    // ne peut pas être servi comme un fait → partiel.
    expect(result.couverture).toBe("partiel:lignes_illisibles");
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it("sert les N dernières années PUBLIÉES (ordre décroissant + limit), pas une fenêtre d'horloge", async () => {
    const { select, eq, lte, order, limit } = mockQuery({ data: [], error: null });

    // 10 janvier 2027 : 2027 n'existe pas encore chez le SDES. Une borne basse
    // `2027 − 5 + 1 = 2023` ne servirait que 4 années (2023-2026).
    await permitsForCommune("94076", { years: 5, currentYear: 2027 });

    expect(mockFrom).toHaveBeenCalledWith("sitadel_logements");
    expect(select).toHaveBeenCalledWith("annee, log_aut, log_com, mois_couverts");
    expect(eq).toHaveBeenCalledWith("code_insee", "94076");
    expect(lte).toHaveBeenCalledWith("annee", 2027);
    expect(order).toHaveBeenCalledWith("annee", { ascending: false });
    // years + 1 : la ligne la plus récente peut être l'année en cours (hors fenêtre).
    expect(limit).toHaveBeenCalledWith(6);
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

  it("(b) aucune ligne → 'indisponible:no_data' SANS aucun total", async () => {
    mockQuery({ data: [], error: null });

    const result = await permitsForCommune("99999");

    // Pas de zéros à lire : l'union ne porte AUCUN total sur `no_data`.
    expect(result).toEqual({ couverture: "indisponible:no_data", annee_en_cours: null });
  });

  it("(b2) commune connue à 0 logement → couverture 'ok' (0 est une donnée, pas une absence)", async () => {
    mockQuery({ data: [{ annee: 2025, log_aut: 0, log_com: 0, mois_couverts: 12 }], error: null });

    const result = fenetre(await permitsForCommune("55189", { years: 1, currentYear: 2026 }));

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
        { annee: "2025", log_aut: "100", log_com: "40", mois_couverts: 12 },
        { annee: "2026", log_aut: "23", log_com: "7", mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 2, currentYear: 2026 }));

    expect(result.couverture).toBe("ok");
    expect(result.logements_autorises_recent).toBe(123);
    expect(result.logements_commences_recent).toBe(47);
  });

  it("null n'est PAS 0 : une valeur nulle est une ligne illisible (Number(null) vaut 0)", async () => {
    mockQuery({
      data: [
        { annee: 2025, log_aut: null, log_com: 3, mois_couverts: 12 },
        { annee: 2026, log_aut: 5, log_com: 2, mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 1, currentYear: 2026 }));

    expect(result.annees).toEqual(["2026"]);
    expect(result.logements_autorises_recent).toBe(5);
    expect(result.couverture).toBe("partiel:lignes_illisibles");
  });

  it("des lignes en base mais AUCUNE lisible → throw (corruption), jamais 'no_data'", async () => {
    mockQuery({
      data: [{ annee: 2025, log_aut: "N/A", log_com: null, mois_couverts: 12 }],
      error: null,
    });

    await expect(permitsForCommune("94076", { currentYear: 2026 })).rejects.toThrow(
      /AUCUNE lisible — corruption/,
    );
  });

  it("fenêtre demandée plus large que le stock → warn (troncature jamais muette)", async () => {
    mockQuery({ data: [], error: null });
    await permitsForCommune("94076", { years: 10, currentYear: 2026 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("fenêtre demandée 10 ans"));
  });

  it("years: 6 n'est plus couvert (la 6e étiquette est le budget de l'année en cours) → warn", async () => {
    mockQuery({ data: [], error: null });
    await permitsForCommune("94076", { years: 6, currentYear: 2026 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("fenêtre demandée 6 ans"));
  });

  it("ligne illisible → ignorée + warn, les autres sont servies", async () => {
    mockQuery({
      data: [
        { annee: 2025, log_aut: "N/A", log_com: 1, mois_couverts: 12 },
        { annee: 2026, log_aut: 5, log_com: 2, mois_couverts: 12 },
      ],
      error: null,
    });

    const result = fenetre(await permitsForCommune("94076", { years: 1, currentYear: 2026 }));

    expect(result.annees).toEqual(["2026"]);
    expect(result.logements_autorises_recent).toBe(5);
    expect(result.couverture).toBe("partiel:lignes_illisibles");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("ligne illisible"));
  });
});
