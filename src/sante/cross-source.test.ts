import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock RPPS select chain (`.from("rpps").select(...).eq(...).not(...)` → await).
// Les chainables sont rebranchés dans `beforeEach` parce que `vi.restoreAllMocks`
// (utilisé en afterEach pour restorer les spies finess/insee) reset aussi les
// `mockReturnValue` des `vi.fn()` partagés — sans rebranchement, le 2e test
// du describe verrait `from()` retourner undefined.
const mockNot = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ from: mockFrom }),
  // getAnonClient utilisé par finess-db.ts — on mocke un rpc minimal.
  getAnonClient: () => ({
    rpc: () => ({ data: [], error: null }),
  }),
}));

import * as finessDb from "./finess-db.js";
import * as inseeSirene from "./insee-sirene.js";
import {
  compareRaisonSocialeFinessVsRpps,
  diceCoefficient,
  historiqueEtablissement,
  reconcilierFinessSirene,
  verifierSiteActif,
} from "./cross-source.js";

const VALID_FINESS = "590048997";
const SIRET_A = "78712043500015";

// Fakes typés directement en `LookupResult<>` (= incluent `found: true` +
// `lookupStatus: "found"`). Évite de répéter le spread `{ found: true,
// lookupStatus: "found", ...fakeXxxFound() }` à chaque vi.spyOn — 14 callsites
// avant V0.6.2 /simplify pass 2.
function fakeFinessLookupFound(
  overrides: Partial<finessDb.FinessResult> = {},
): finessDb.FinessResult & { found: true; lookupStatus: "found" } {
  return {
    found: true,
    lookupStatus: "found",
    num_finess: VALID_FINESS,
    raison_sociale: "DIAGNOVIE",
    categorie: { code: "611", libelle: "LBM", famille: "labo" },
    adresse: {
      voie: "27 BD BIZET",
      code_postal: "59290",
      ville: "WASQUEHAL",
      code_departement: "59",
      code_insee: "59646",
    },
    coords: { lat: 50.67, lon: 3.13 },
    distance_km: null,
    telephone: "03 20 05 15 00",
    email: null,
    ...overrides,
  };
}

function fakeFinessLookupNotFound(): {
  found: false;
  key: string;
  lookupStatus: "not_found";
  message: string;
} {
  return { found: false, key: VALID_FINESS, lookupStatus: "not_found", message: "noop" };
}

function fakeInseeLookupFound(
  overrides: Partial<inseeSirene.EtablissementSireneDetail> = {},
): inseeSirene.EtablissementSireneDetail & { found: true; lookupStatus: "found" } {
  return {
    found: true,
    lookupStatus: "found",
    siret: SIRET_A,
    siren: SIRET_A.slice(0, 9),
    raisonSocialeUniteLegale: "BIOGROUP NORD",
    enseigne: null,
    denominationUsuelle: null,
    naf: "86.90B",
    actif: true,
    dateCreation: "2020-01-01",
    dateFermeture: null,
    estSiege: false,
    trancheEffectif: "11",
    adresse: {
      libelle: "27 BD BIZET 59290 WASQUEHAL",
      numeroVoie: "27",
      typeVoie: "BD",
      libelleVoie: "BIZET",
      codePostal: "59290",
      libelleCommune: "WASQUEHAL",
      codeCommune: "59646",
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockFrom.mockReset();
  mockSelect.mockReset();
  mockEq.mockReset();
  mockNot.mockReset();
  // Rebrancher le chain à chaque test : `vi.restoreAllMocks` (afterEach)
  // détruit les `mockReturnValue` des vi.fn() partagés. Sans ce
  // rebranchement, `from()` retournerait undefined dès le 2e test.
  mockFrom.mockReturnValue({ select: mockSelect });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockEq.mockReturnValue({ not: mockNot });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifierSiteActif", () => {
  it("throw RangeError quand num_finess est mal formé (avant tout I/O)", async () => {
    await expect(verifierSiteActif("123")).rejects.toThrow(RangeError);
    await expect(verifierSiteActif("abcdefghi")).rejects.toThrow(RangeError);
  });

  it("retourne LookupResult not_found quand FINESS est introuvable", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupNotFound());
    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toContain("introuvable");
    }
  });

  it("verdict 'indetermine_pas_de_siret' quand aucun SIRET candidat en RPPS", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [], error: null });
    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict).toBe("indetermine_pas_de_siret");
      expect(result.siret_candidates).toEqual([]);
      expect(result.finess.raison_sociale).toBe("DIAGNOVIE");
    }
  });

  it("verdict 'actif' quand ≥1 SIRET candidat est actif côté SIRENE", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue(
      fakeInseeLookupFound({ actif: true }),
    );

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict).toBe("actif");
      expect(result.siret_candidates).toHaveLength(1);
      expect(result.siret_candidates[0]?.insee?.actif).toBe(true);
    }
  });

  it("verdict 'ferme' quand tous les SIRETs sont fermés avec dateFermeture", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue(
      fakeInseeLookupFound({ actif: false, dateFermeture: "2024-06-30" }),
    );

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict).toBe("ferme");
      expect(result.explication).toContain("2024-06-30");
    }
  });

  it("verdict 'indetermine_pas_de_cle_insee' quand INSEE renvoie not_found avec message clé absente", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue({
      found: false,
      key: SIRET_A,
      lookupStatus: "not_found",
      message:
        "INSEE_SIRENE_API_KEY non configurée — ce tool requiert une clé INSEE pour interroger l'endpoint /siret/<siret>.",
    });

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict).toBe("indetermine_pas_de_cle_insee");
      expect(result.siret_candidates[0]?.insee).toBeNull();
      expect(result.siret_candidates[0]?.insee_error).toContain("INSEE_SIRENE_API_KEY");
    }
  });

  it("filtre les SIRET malformés (sentinelle 'finess_unmatched' V0.5.1)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({
      data: [
        { siret: "finess_unmatched" },
        { siret: SIRET_A },
        { siret: "12345" },
        { siret: "  " },
      ],
      error: null,
    });
    const inseeSpy = vi
      .spyOn(inseeSirene, "lookupSiretViaInsee")
      .mockResolvedValue(fakeInseeLookupFound());

    await verifierSiteActif(VALID_FINESS);
    // Seul SIRET_A (14 chiffres valides) doit avoir été passé à INSEE.
    expect(inseeSpy).toHaveBeenCalledTimes(1);
    expect(inseeSpy).toHaveBeenCalledWith(SIRET_A);
  });

  it("propage le throw quand l'accès à `rpps.siret` échoue (pas de fallback silencieux)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(verifierSiteActif(VALID_FINESS)).rejects.toThrow(/permission denied/);
  });

  it("collecte les insee_error quand le lookup INSEE throw (5xx/timeout)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.siret_candidates[0]?.insee).toBeNull();
      expect(result.siret_candidates[0]?.insee_error).toContain("HTTP 503");
      // Tous les lookups INSEE ont échoué → verdict dédié (pas "pas de SIRET").
      expect(result.verdict).toBe("indetermine_insee_unreachable");
    }
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("diceCoefficient (V0.6.2 — primitive de similarité)", () => {
  it("retourne 1 pour deux chaînes identiques", () => {
    expect(diceCoefficient("biogroup nord", "biogroup nord")).toBe(1);
  });

  it("retourne 0 pour deux chaînes totalement différentes", () => {
    expect(diceCoefficient("abc", "xyz")).toBe(0);
  });

  it("retourne un score élevé pour deux chaînes proches (typo)", () => {
    const score = diceCoefficient("biogroup nord", "biogroup norde");
    expect(score).toBeGreaterThan(0.85);
  });

  it("retourne un score moyen pour deux chaînes qui partagent des mots-clés", () => {
    const score = diceCoefficient("eurofins biomnis", "eurofins lbm");
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.7);
  });

  it("retourne 0 ou 1 pour des chaînes < 2 chars (égalité stricte)", () => {
    expect(diceCoefficient("a", "a")).toBe(1);
    expect(diceCoefficient("a", "b")).toBe(0);
    expect(diceCoefficient("", "")).toBe(1);
  });
});

describe("compareRaisonSocialeFinessVsRpps (V0.6.2)", () => {
  it("retourne lookupNotFound quand FINESS DREES est introuvable (cohérent autres tools)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupNotFound());
    const result = await compareRaisonSocialeFinessVsRpps(VALID_FINESS);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toContain("introuvable");
    }
  });

  it("statut 'rpps_absent' quand aucune RPPS n'a déclaré ce FINESS", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    const result = await compareRaisonSocialeFinessVsRpps(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.statut).toBe("rpps_absent");
      expect(result.finess_raison_sociale).toBe("DIAGNOVIE");
    }
  });

  it("statut 'exact_match' quand FINESS et RPPS sont identiques (case-insensitive)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "BIOGROUP NORD" }),
    );
    mockNot.mockResolvedValueOnce({
      data: [{ raison_sociale: "biogroup nord" }],
      error: null,
    });

    const result = await compareRaisonSocialeFinessVsRpps(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.statut).toBe("exact_match");
    }
  });

  it("statut 'divergent_after_normalization' quand FINESS ≠ RPPS (ex: rebranding M&A)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "DIAGNOVIE" }),
    );
    mockNot.mockResolvedValueOnce({
      data: [{ raison_sociale: "BIOGROUP NORD" }],
      error: null,
    });

    const result = await compareRaisonSocialeFinessVsRpps(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.statut).toBe("divergent_after_normalization");
      expect(result.finess_raison_sociale).toBe("DIAGNOVIE");
      expect(result.rpps_raisons_sociales).toEqual(["BIOGROUP NORD"]);
    }
  });

  it("rejette num_finess malformé", async () => {
    await expect(compareRaisonSocialeFinessVsRpps("abc")).rejects.toThrow(RangeError);
  });
});

describe("historiqueEtablissement (V0.6.2)", () => {
  it("rejette num_finess malformé", async () => {
    await expect(historiqueEtablissement("123")).rejects.toThrow(RangeError);
  });

  it("LookupResult not_found quand FINESS est absent", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupNotFound());
    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(false);
  });

  it("retourne lookupNotFound quand aucun SIRET candidat (cohérent autres tools)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toContain("aucun SIRET candidat");
    }
  });

  it("appelle lookupSiretHistoriqueViaInsee pour chaque SIRET candidat et préserve les périodes", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    const fakePeriodes = [
      {
        dateDebut: "2010-01-01",
        dateFin: "2020-12-31",
        actif: true,
        naf: "86.90B",
        enseigne: "ANCIEN NOM",
        denominationUsuelle: null,
      },
      {
        dateDebut: "2021-01-01",
        dateFin: null,
        actif: true,
        naf: "86.90B",
        enseigne: "BIOGROUP NORD",
        denominationUsuelle: null,
      },
    ];
    vi.spyOn(inseeSirene, "lookupSiretHistoriqueViaInsee").mockResolvedValue({
      ...fakeInseeLookupFound({ enseigne: "BIOGROUP NORD" }),
      periodes: fakePeriodes,
    });

    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.siret_timelines).toHaveLength(1);
      expect(result.siret_timelines[0]?.sirene?.periodes).toEqual(fakePeriodes);
    }
  });

  it("collecte sirene_error quand le lookup INSEE throw", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretHistoriqueViaInsee").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.siret_timelines[0]?.sirene).toBeNull();
      expect(result.siret_timelines[0]?.sirene_error).toContain("HTTP 503");
    }
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("reconcilierFinessSirene (V0.6.2)", () => {
  it("rejette num_finess malformé", async () => {
    await expect(reconcilierFinessSirene("abc")).rejects.toThrow(RangeError);
  });

  it("LookupResult not_found quand FINESS introuvable", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupNotFound());
    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(false);
  });

  it("LookupResult not_found quand aucun SIRET candidat", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [], error: null });
    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(false);
  });

  it("calcule scores nom/adresse + verdict 'match' quand SIRENE colle au FINESS", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "BIOGROUP NORD" }),
    );
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue(
      fakeInseeLookupFound({ raisonSocialeUniteLegale: "BIOGROUP NORD" }),
    );

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.num_finess).toBe(VALID_FINESS);
      expect(result.candidates).toHaveLength(1);
      const r = result.candidates[0];
      expect(r?.verdict).toBe("match");
      expect(r?.scores.nom).toBe(1); // raisons sociales identiques
      expect(r?.score_global).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("verdict 'mismatch' quand SIRENE diverge fortement (raison sociale + adresse)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({
        raison_sociale: "DIAGNOVIE",
        adresse: {
          voie: "27 BD BIZET",
          code_postal: "59290",
          ville: "WASQUEHAL",
          code_departement: "59",
          code_insee: "59646",
        },
      }),
    );
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue(
      fakeInseeLookupFound({
        raisonSocialeUniteLegale: "ZZZZZZZZ COMPLETEMENT DIFFERENT",
        adresse: {
          libelle: "999 AUTRE RUE 75001 PARIS",
          numeroVoie: "999",
          typeVoie: "RUE",
          libelleVoie: "AUTRE",
          codePostal: "75001",
          libelleCommune: "PARIS",
          codeCommune: "75101",
        },
      }),
    );

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      const r = result.candidates[0];
      expect(r?.verdict).toBe("mismatch");
      expect(r?.score_global).toBeLessThan(0.5);
    }
  });

  it("trie les résultats par score_global décroissant (best candidate first)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "BIOGROUP NORD" }),
    );
    const SIRET_B = "12345678901234";
    mockNot.mockResolvedValueOnce({
      data: [{ siret: SIRET_A }, { siret: SIRET_B }],
      error: null,
    });
    const inseeSpy = vi.spyOn(inseeSirene, "lookupSiretViaInsee");
    inseeSpy.mockImplementation(async (siret) => {
      if (siret === SIRET_A) {
        return fakeInseeLookupFound({ raisonSocialeUniteLegale: "AUTRE TRUC" });
      }
      return fakeInseeLookupFound({
        siret: SIRET_B,
        raisonSocialeUniteLegale: "BIOGROUP NORD",
      });
    });

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.candidates).toHaveLength(2);
      // Le SIRET avec la meilleure correspondance nom (BIOGROUP NORD) doit
      // être en premier — c'est SIRET_B dans ce scénario.
      expect(result.candidates[0]?.siret).toBe(SIRET_B);
      expect(result.candidates[0]?.score_global).toBeGreaterThan(
        result.candidates[1]?.score_global ?? 0,
      );
    }
  });

  it("populate skipped[] quand INSEE rejette le SIRET (rejected = 5xx/timeout)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.candidates).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.siret).toBe(SIRET_A);
      expect(result.skipped[0]?.reason).toContain("HTTP 503");
    }
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("populate skipped[] quand INSEE renvoie not_found + log warn", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue({
      found: false,
      key: SIRET_A,
      lookupStatus: "not_found",
      message: `SIRET "${SIRET_A}" introuvable dans SIRENE INSEE.`,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.candidates).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.reason).toContain("introuvable");
    }
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
