import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IrisProfilRow } from "./iris-db.js";

// Mock UNIQUEMENT les fetchers DB ; on garde assertIrisCode (validation réelle).
vi.mock("./iris-db.js", async (importActual) => {
  const actual = await importActual<typeof import("./iris-db.js")>();
  return {
    ...actual,
    fetchIrisProfilByCode: vi.fn(),
    fetchIrisAtPoint: vi.fn(),
    fetchIrisInRadius: vi.fn(),
    fetchIrisInRadiusOfCode: vi.fn(),
  };
});

import {
  fetchIrisAtPoint,
  fetchIrisInRadius,
  fetchIrisInRadiusOfCode,
  fetchIrisProfilByCode,
} from "./iris-db.js";
import { aggregateBassin, buildIletProfile, getProfilIris } from "./iris-profil.js";

const mFetchByCode = vi.mocked(fetchIrisProfilByCode);
const mFetchAtPoint = vi.mocked(fetchIrisAtPoint);
const mFetchInRadius = vi.mocked(fetchIrisInRadius);
const mFetchOfCode = vi.mocked(fetchIrisInRadiusOfCode);

/** Ligne profil avec tous les champs à null par défaut (n(null)=0 côté somme). */
function row(overrides: Partial<IrisProfilRow>): IrisProfilRow {
  const base: IrisProfilRow = {
    code_iris: "751103701",
    code_commune: "75110",
    libelle: "Test",
    type_iris: "H",
    pop_total: null,
    pop_0_14: null,
    pop_15_29: null,
    pop_30_44: null,
    pop_45_59: null,
    pop_60_74: null,
    pop_75p: null,
    pop_65p: null,
    pop_15p: null,
    csp_agriculteurs: null,
    csp_artisans_comm: null,
    csp_cadres: null,
    csp_prof_interm: null,
    csp_employes: null,
    csp_ouvriers: null,
    csp_retraites: null,
    csp_autres: null,
    menages_total: null,
    couples_avec_enfants: null,
    couples_sans_enfants: null,
    familles_monoparentales: null,
    revenu_median: null,
    revenu_d1: null,
    revenu_d9: null,
    taux_pauvrete: null,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  mFetchByCode.mockReset();
  mFetchAtPoint.mockReset();
  mFetchInRadius.mockReset();
  mFetchOfCode.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("aggregateBassin — R3 (parts sur comptes bruts Σ/Σ)", () => {
  it("part_65_plus et parts CSP = Σ(catégorie)/Σ(total), pas une moyenne de %", () => {
    const rows = [
      row({ pop_total: 100, pop_65p: 20, pop_15p: 80, csp_cadres: 10 }),
      row({ pop_total: 200, pop_65p: 40, pop_15p: 160, csp_cadres: 50 }),
    ];
    const agg = aggregateBassin(rows, 2);
    expect(agg.population_bassin).toBe(300);
    expect(agg.age.part_65_plus).toBeCloseTo(60 / 300); // 0.2, PAS (0.2+0.2)/2
    expect(agg.csp.cadres).toBeCloseTo(60 / 240); // 0.25 (Σ cadres / Σ pop_15p)
    expect(agg.nb_iris_agreges).toBe(2);
  });

  it("familles_avec_enfants = Σ(couples avec enfants + monoparentales)", () => {
    const rows = [
      row({ couples_avec_enfants: 30, familles_monoparentales: 10 }),
      row({ couples_avec_enfants: 50, familles_monoparentales: 20 }),
    ];
    expect(aggregateBassin(rows, 2).familles_avec_enfants).toBe(110);
  });
});

describe("aggregateBassin — R1 (revenu = moyenne pondérée des médianes, JAMAIS médiane vraie)", () => {
  it("pondère les médianes par la population (≠ moyenne simple)", () => {
    const rows = [
      row({ pop_total: 100, revenu_median: 20000 }),
      row({ pop_total: 300, revenu_median: 30000 }),
    ];
    const agg = aggregateBassin(rows, 2);
    // (20000×100 + 30000×300) / 400 = 27500 — PAS la moyenne simple 25000.
    expect(agg.revenu_median_pondere).toBe(27500);
    expect(agg.couverture.revenu_pct_population).toBe(1);
    expect(agg.couverture.iris_revenu_manquants).toBe(0);
  });

  it("exclut les îlots non couverts FILOSOFI du proxy + expose la couverture", () => {
    const rows = [
      row({ pop_total: 100, revenu_median: 20000 }), // couvert
      row({ pop_total: 200, revenu_median: null }), // hors couverture (rural)
    ];
    const agg = aggregateBassin(rows, 2);
    expect(agg.revenu_median_pondere).toBe(20000); // seul l'îlot couvert pèse
    expect(agg.couverture.revenu_pct_population).toBeCloseTo(100 / 300); // 0.333
    expect(agg.couverture.iris_revenu_manquants).toBe(1);
  });

  it("revenu_median_pondere = null si AUCUN îlot couvert (jamais 0 trompeur)", () => {
    const agg = aggregateBassin([row({ pop_total: 100, revenu_median: null })], 2);
    expect(agg.revenu_median_pondere).toBeNull();
    expect(agg.couverture.revenu_pct_population).toBe(0);
  });

  it("un îlot revenu-présent-mais-pop-null est COMPTÉ manquant, jamais avalé (M2)", () => {
    const agg = aggregateBassin(
      [
        row({ pop_total: 100, revenu_median: 20000 }),
        row({ pop_total: null, revenu_median: 99999 }),
      ],
      2,
    );
    expect(agg.revenu_median_pondere).toBe(20000); // l'îlot sans pop ne pèse pas
    expect(agg.couverture.iris_revenu_manquants).toBe(1); // mais il est compté
  });
});

describe("buildIletProfile", () => {
  it("expose les parts de l'îlot + la médiane RÉELLE (pas pondérée)", () => {
    const p = buildIletProfile(
      row({ pop_total: 2000, pop_65p: 300, pop_15p: 1600, csp_cadres: 400, revenu_median: 32510 }),
    );
    expect(p.mode).toBe("ilot");
    expect(p.population).toBe(2000);
    expect(p.age.part_65_plus).toBeCloseTo(0.15);
    expect(p.csp.cadres).toBeCloseTo(0.25);
    expect(p.revenu_median).toBe(32510);
  });

  it("parts à null si dénominateur nul (pas de division par zéro)", () => {
    const p = buildIletProfile(row({ pop_total: 0, pop_15p: 0 }));
    expect(p.age.part_65_plus).toBeNull();
    expect(p.csp.cadres).toBeNull();
  });
});

describe("réalisme PostgREST — NUMERIC sérialisé en STRING (garde-fou P1/P2)", () => {
  // PostgREST renvoie les colonnes NUMERIC en STRING (préservation de précision) ;
  // iris-db.test.ts le teste déjà pour pop_total. Ici on verrouille les chemins
  // d'AGRÉGATION (R1) et d'EXPOSITION brute (revenu_median/taux_pauvrete de l'îlot)
  // — un `+=` sur une string concatène ("0100" au lieu de 100), un champ exposé
  // brut viole le type `number | null`. Les valeurs brutes sont des string par
  // construction du backend ; le cast `as unknown as number` reproduit le runtime.
  const num = (v: string) => v as unknown as number;

  it("aggregateBassin somme des pop_total/revenu STRING sans JAMAIS concaténer (R1)", () => {
    const rows = [
      row({
        pop_total: num("100"),
        revenu_median: num("20000"),
        pop_65p: num("20"),
        pop_15p: num("80"),
      }),
      row({
        pop_total: num("300"),
        revenu_median: num("30000"),
        pop_65p: num("60"),
        pop_15p: num("160"),
      }),
    ];
    const agg = aggregateBassin(rows, 2);
    expect(agg.population_bassin).toBe(400); // PAS "0100300" → 100300
    expect(agg.revenu_median_pondere).toBe(27500); // (20000×100 + 30000×300) / 400
    expect(agg.couverture.revenu_pct_population).toBe(1); // popCouverte=400, pas une string
  });

  it("buildIletProfile coerce revenu_median/taux_pauvrete STRING → number (contrat number|null)", () => {
    const p = buildIletProfile(
      row({ pop_total: num("2000"), revenu_median: num("32510"), taux_pauvrete: num("19.0") }),
    );
    expect(p.revenu_median).toBe(32510);
    expect(typeof p.revenu_median).toBe("number"); // PAS la string "32510"
    expect(p.taux_pauvrete).toBe(19);
    expect(typeof p.taux_pauvrete).toBe("number");
  });

  it("buildIletProfile garde null pour un revenu hors couverture FILOSOFI (jamais 0)", () => {
    const p = buildIletProfile(
      row({ pop_total: num("2000"), revenu_median: null, taux_pauvrete: null }),
    );
    expect(p.revenu_median).toBeNull();
    expect(p.taux_pauvrete).toBeNull();
  });

  it("buildIletProfile dégrade un revenu NUMERIC corrompu en null + warn (jamais avalé muet)", () => {
    // Distingue "absent légitime" (null → null muet, OK) de "source corrompue"
    // (string non numérique → null MAIS warn grep-able, règle projet).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = buildIletProfile(row({ pop_total: num("2000"), revenu_median: num("N/A") }));
    expect(p.revenu_median).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/revenu_median non numérique/u));
  });
});

describe("getProfilIris — validation & orchestration", () => {
  it("throw si NI point NI code_iris, ou les DEUX", async () => {
    await expect(getProfilIris({})).rejects.toThrow(RangeError);
    await expect(
      getProfilIris({ point: { lon: 2, lat: 48 }, codeIris: "751103701" }),
    ).rejects.toThrow(RangeError);
  });

  it("throw RangeError sur rayon_km hors ]0,10]", async () => {
    await expect(getProfilIris({ codeIris: "751103701", rayonKm: 0 })).rejects.toThrow(RangeError);
    await expect(getProfilIris({ codeIris: "751103701", rayonKm: 50 })).rejects.toThrow(RangeError);
  });

  it("mode îlot par code → fetchIrisProfilByCode, found", async () => {
    mFetchByCode.mockResolvedValue(row({ pop_total: 2000, code_iris: "751103701" }));
    const res = await getProfilIris({ codeIris: "751103701" });
    expect(res.found).toBe(true);
    if (res.found) expect(res.mode).toBe("ilot");
    expect(mFetchByCode).toHaveBeenCalledWith("751103701");
  });

  it("mode bassin par point → fetchIrisInRadius (rayon converti en mètres), agrège", async () => {
    mFetchInRadius.mockResolvedValue([row({ pop_total: 100, revenu_median: 25000 })]);
    const res = await getProfilIris({ point: { lon: 2.37, lat: 48.85 }, rayonKm: 2 });
    expect(res.found && res.mode).toBe("bassin");
    expect(mFetchInRadius).toHaveBeenCalledWith(2.37, 48.85, 2000);
  });

  it("not_found si point hors IRIS (îlot) ou bassin vide", async () => {
    mFetchAtPoint.mockResolvedValue(null);
    const r1 = await getProfilIris({ point: { lon: 0, lat: 0 } });
    expect(r1.found).toBe(false);
    mFetchOfCode.mockResolvedValue([]);
    const r2 = await getProfilIris({ codeIris: "759999999", rayonKm: 2 });
    expect(r2.found).toBe(false);
  });
});
