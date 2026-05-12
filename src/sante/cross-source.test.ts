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

import { diceCoefficient } from "./address-match.js";
import {
  compareRaisonSocialeFinessVsRpps,
  historiqueEtablissement,
  reconcilierFinessSirene,
  verifierSiteActif,
} from "./cross-source.js";
import * as dinum from "./dinum.js";
import * as finessDb from "./finess-db.js";
import * as inseeSirene from "./insee-sirene.js";

// SIREN Biogroup Nord + SIRETs du cas reproductible (Fix V0.7.1).
const SIREN_BIOGROUP = "507815942";
const SIRET_SIEGE = "50781594200333";
const SIRET_FERME = "50781594200218";

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
  // Stub DINUM par défaut : `not_found` pour que les tests focus RPPS-only
  // passent sans I/O réseau. Les tests qui exercent le pivot DINUM override
  // via `vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue(...)`.
  vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue({
    found: false,
    key: "default-mock",
    lookupStatus: "not_found",
    message: "default test mock: DINUM not_found",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Helper : construit une `Entreprise` DINUM minimale avec une liste
 * d'établissements. Permet aux tests V0.7.0 d'exercer le pivot DINUM du
 * resolver sans avoir à dupliquer le shape complet à chaque test.
 */
function fakeEntrepriseDinum(opts: {
  siren: string;
  actif?: boolean;
  etablissements?: dinum.Etablissement[];
}): Awaited<ReturnType<typeof dinum.getEntrepriseBySiren>> {
  return {
    found: true,
    lookupStatus: "found",
    siren: opts.siren,
    nomComplet: "BIOGROUP NORD",
    finances: [],
    dirigeants: [],
    actif: opts.actif ?? true,
    etablissements: opts.etablissements ?? [],
    siren_source: "dinum",
  };
}

describe("verifierSiteActif (V0.7.0 — pivot SIRET élargi via DINUM)", () => {
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

  it("verdict 'indetermine' quand aucun SIRET candidat en RPPS (pivot impossible)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [], error: null });
    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict_site).toBe("indetermine");
      expect(result.verdict_groupe).toBe("indetermine");
      expect(result.candidates).toEqual([]);
      expect(result.best_match).toBeNull();
      expect(result.finess.raison_sociale).toBe("DIAGNOVIE");
    }
  });

  it("verdict_site='actif' + verdict_groupe='actif' quand DINUM matche l'adresse FINESS sur un SIRET actif", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue(
      fakeEntrepriseDinum({
        siren: SIRET_A.slice(0, 9),
        actif: true,
        etablissements: [
          {
            siret: SIRET_A,
            adresse: "27 BD BIZET 59290 WASQUEHAL",
            actif: true,
            dateCreation: "2020-01-01",
          },
        ],
      }),
    );

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict_site).toBe("actif");
      expect(result.verdict_groupe).toBe("actif");
      expect(result.best_match?.siret).toBe(SIRET_A);
      expect(result.best_match?.actif).toBe(true);
    }
  });

  it("verdict_site='ferme' + verdict_groupe='actif' quand le SIRET physique est fermé mais l'UL reste active (cas Biogroup Bd Bizet 2024)", async () => {
    // Cas réel reproductible : FINESS 590048997 LABORATOIRE SECONDAIRE
    // DIAGNOVIE BD BIZET, 27 BD BIZET 59491 VILLENEUVE D ASCQ. SIRENE V3.11
    // confirme que le SIRET 218 est FERMÉ depuis 2024-02-16 mais l'UL
    // (Biogroup Nord, SIREN 507815942) reste active via le SIRET 333 siège
    // (rue des Fusillés).
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({
        adresse: {
          voie: "27 BD BIZET",
          code_postal: "59491",
          ville: "VILLENEUVE D ASCQ",
          code_departement: "59",
          code_insee: "59009",
        },
      }),
    );
    const SIRET_SIEGE = "50781594200333";
    const SIRET_FERME = "50781594200218";
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_SIEGE }], error: null });
    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue(
      fakeEntrepriseDinum({
        siren: "507815942",
        actif: true,
        etablissements: [
          {
            siret: SIRET_SIEGE,
            adresse: "46 RUE DES FUSILLES 59493 VILLENEUVE-D'ASCQ",
            actif: true,
            dateCreation: "2024-02-16",
          },
          {
            siret: SIRET_FERME,
            adresse: "27 BD BIZET 59491 VILLENEUVE-D'ASCQ",
            actif: false,
            dateCreation: "2018-07-31",
          },
        ],
      }),
    );

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.best_match?.siret).toBe(SIRET_FERME);
      expect(result.verdict_site).toBe("ferme");
      expect(result.verdict_groupe).toBe("actif");
    }
  });

  it("verdict_site='indetermine' quand aucun SIRET DINUM ne matche l'adresse FINESS (score<0.6)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue(
      fakeEntrepriseDinum({
        siren: SIRET_A.slice(0, 9),
        actif: true,
        etablissements: [
          {
            siret: SIRET_A,
            adresse: "999 RUE COMPLETEMENT AUTRE 75001 PARIS",
            actif: true,
            dateCreation: "2020-01-01",
          },
        ],
      }),
    );

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.best_match).toBeNull();
      expect(result.verdict_site).toBe("indetermine");
      expect(result.verdict_groupe).toBe("actif");
      // Le candidat RPPS est tout de même listé (donnée déclarative)
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.sources).toEqual(["rpps"]);
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
    const dinumSpy = vi
      .spyOn(dinum, "getEntrepriseBySiren")
      .mockResolvedValue(fakeEntrepriseDinum({ siren: SIRET_A.slice(0, 9) }));

    await verifierSiteActif(VALID_FINESS);
    // Seul SIRET_A (14 chiffres valides) a un SIREN dérivé → 1 appel DINUM.
    expect(dinumSpy).toHaveBeenCalledTimes(1);
    expect(dinumSpy).toHaveBeenCalledWith(SIRET_A.slice(0, 9));
  });

  it("propage le throw quand l'accès à `rpps.siret` échoue (pas de fallback silencieux)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(verifierSiteActif(VALID_FINESS)).rejects.toThrow(/permission denied/);
  });

  it("verdict_groupe reste 'indetermine' quand DINUM échoue (panne / not_found / rejected)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });
    // DINUM rejette (panne) — le mock default not_found est override.
    vi.spyOn(dinum, "getEntrepriseBySiren").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict_site).toBe("indetermine");
      expect(result.verdict_groupe).toBe("indetermine");
      // Le SIRET RPPS reste dans les candidats (donnée déclarative)
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.sources).toEqual(["rpps"]);
      expect(result.candidates[0]?.actif).toBeNull();
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

  it("V0.7.0 status='all_sirene_failed' quand tous les INSEE rejettent (panne) → retry justifié", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretHistoriqueViaInsee").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.status).toBe("all_sirene_failed");
      // Le mock DINUM default retourne not_found pour le SIREN extrait du SIRET RPPS,
      // ce qui alimente bien dinum_errors avec status: "not_found".
      expect(result.dinum_errors).toHaveLength(1);
      expect(result.dinum_errors[0]?.status).toBe("not_found");
    }
    errSpy.mockRestore();
  });

  it("V0.7.0 status='all_sirene_not_found' quand tous les SIRET sont introuvables côté SIRENE (légitime, pas de retry)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretHistoriqueViaInsee").mockResolvedValue({
      found: false,
      key: SIRET_A,
      lookupStatus: "not_found",
      message: `SIRET "${SIRET_A}" introuvable dans SIRENE INSEE.`,
    });

    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.status).toBe("all_sirene_not_found");
    }
  });

  it("V0.7.0 dinum_errors propagé depuis le resolver quand DINUM échoue", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(dinum, "getEntrepriseBySiren").mockRejectedValue(new Error("DINUM HTTP 500"));
    vi.spyOn(inseeSirene, "lookupSiretHistoriqueViaInsee").mockResolvedValue({
      ...fakeInseeLookupFound(),
      periodes: [],
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await historiqueEtablissement(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.dinum_errors).toHaveLength(1);
      expect(result.dinum_errors[0]?.status).toBe("rejected");
      expect(result.dinum_errors[0]?.message).toContain("HTTP 500");
    }
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

  it("V0.7.0 status='all_sirene_failed' quand tous les INSEE rejettent (panne)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValueOnce({ data: [{ siret: SIRET_A }], error: null });
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.status).toBe("all_sirene_failed");
    }
    errSpy.mockRestore();
  });

  it("V0.7.0 status='all_sirene_not_found' + dinum_errors exposé", async () => {
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
      expect(result.status).toBe("all_sirene_not_found");
      // Cohérent avec mock DINUM par défaut qui retourne not_found.
      expect(result.dinum_errors).toHaveLength(1);
      expect(result.dinum_errors[0]?.status).toBe("not_found");
    }
    warnSpy.mockRestore();
  });
});

// ============================================================================
// Fix V0.7.1 — Fallback INSEE /siret?q=siren:XXX quand DINUM partial
// ============================================================================

describe("verifierSiteActif (V0.7.1 — fallback INSEE quand DINUM partial)", () => {
  /**
   * Construit un fake LookupResult lookupSiretsBySirenViaInsee pour simuler
   * le cas où DINUM retourne partial et INSEE retourne la liste complète.
   */
  function fakeInseeSearchFound(etabs: Array<inseeSirene.EtablissementSireneDetail>): {
    found: true;
    lookupStatus: "found";
    etablissements: inseeSirene.EtablissementSireneDetail[];
  } {
    return { found: true, lookupStatus: "found", etablissements: etabs };
  }

  it("pin Biogroup Bd Bizet : verdict_site='ferme' + best_match=SIRET_FERME quand DINUM partial + fallback INSEE retourne le SIRET fermé", async () => {
    // Scénario exact du brief : FINESS 590048997 = "BD BIZET 59491 VILLENEUVE D ASCQ".
    // RPPS déclare uniquement SIRET_SIEGE (siège actuel). DINUM retourne partial
    // (38 sites Biogroup) et ne liste QUE le siège. Sans fallback, verdict = indetermine.
    // Avec fallback INSEE, le SIRET fermé 50781594200218 (BD BIZET) est retrouvé.
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({
        adresse: {
          voie: "BD BIZET",
          code_postal: "59491",
          ville: "VILLENEUVE D ASCQ",
          code_departement: "59",
          code_insee: "59009",
        },
      }),
    );
    // RPPS : seul le siège est déclaré
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_SIEGE }], error: null });

    // DINUM partial : ne liste que le siège (cas réel Biogroup Nord 38 sites)
    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      siren: SIREN_BIOGROUP,
      nomComplet: "BIOGROUP NORD",
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [
        {
          siret: SIRET_SIEGE,
          adresse: "46 RUE DES FUSILLES 59493 VILLENEUVE-D'ASCQ",
          actif: true,
          dateCreation: "2024-02-16",
        },
      ],
      enrichmentStatus: "partial",
      enrichmentWarning: "multi-sites tronqué",
      siren_source: "dinum",
    });

    // Fallback INSEE : retourne le SIRET fermé à l'adresse BD BIZET
    vi.spyOn(inseeSirene, "lookupSiretsBySirenViaInsee").mockResolvedValue(
      fakeInseeSearchFound([
        {
          siret: SIRET_SIEGE,
          siren: SIREN_BIOGROUP,
          raisonSocialeUniteLegale: "BIOGROUP NORD",
          enseigne: null,
          denominationUsuelle: null,
          naf: "86.90B",
          actif: true,
          dateCreation: "2024-02-16",
          dateFermeture: null,
          estSiege: true,
          trancheEffectif: null,
          adresse: {
            libelle: "46 RUE DES FUSILLES 59493 VILLENEUVE-D'ASCQ",
            numeroVoie: "46",
            typeVoie: "RUE",
            libelleVoie: "DES FUSILLES",
            codePostal: "59493",
            libelleCommune: "VILLENEUVE-D'ASCQ",
            codeCommune: "59009",
          },
        },
        {
          siret: SIRET_FERME,
          siren: SIREN_BIOGROUP,
          raisonSocialeUniteLegale: "BIOGROUP NORD",
          enseigne: null,
          denominationUsuelle: null,
          naf: "86.90B",
          actif: false,
          dateCreation: "2018-07-31",
          dateFermeture: "2024-02-16",
          estSiege: false,
          trancheEffectif: null,
          adresse: {
            libelle: "27 BD BIZET 59491 VILLENEUVE-D'ASCQ",
            numeroVoie: "27",
            typeVoie: "BD",
            libelleVoie: "BIZET",
            codePostal: "59491",
            libelleCommune: "VILLENEUVE-D'ASCQ",
            codeCommune: "59009",
          },
        },
      ]),
    );

    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.verdict_site).toBe("ferme");
      expect(result.best_match?.siret).toBe(SIRET_FERME);
      // Le candidat fermé doit avoir la source dinum_address_match (via fallback INSEE)
      expect(result.best_match?.sources).toContain("dinum_address_match");
    }
  });

  it("pas de fallback INSEE quand DINUM enrichmentStatus='success' (fallback non déclenché)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });

    // DINUM success : pas de fallback attendu
    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue(
      fakeEntrepriseDinum({
        siren: SIRET_A.slice(0, 9),
        actif: true,
        etablissements: [
          {
            siret: SIRET_A,
            adresse: "27 BD BIZET 59290 WASQUEHAL",
            actif: true,
            dateCreation: "2020-01-01",
          },
        ],
      }),
    );

    const inseeSearchSpy = vi.spyOn(inseeSirene, "lookupSiretsBySirenViaInsee");

    await verifierSiteActif(VALID_FINESS);

    // enrichmentStatus non setté dans fakeEntrepriseDinum = undefined ≠ "partial"
    // → le fallback ne doit PAS être déclenché
    expect(inseeSearchSpy).not.toHaveBeenCalled();
  });

  it("H5 régression — pas de fallback INSEE quand DINUM enrichmentStatus='failed' (panne transitoire, pas une troncature)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });

    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      siren: SIRET_A.slice(0, 9),
      nomComplet: "LABO BETA",
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [{ siret: SIRET_A, adresse: "27 BD BIZET 59290 WASQUEHAL", actif: true }],
      enrichmentStatus: "failed", // panne second appel DINUM — pas une troncature multi-sites
      siren_source: "dinum" as const,
    });

    const inseeSearchSpy = vi.spyOn(inseeSirene, "lookupSiretsBySirenViaInsee");

    const result = await verifierSiteActif(VALID_FINESS);

    // "failed" ne doit PAS déclencher le fallback INSEE (H5)
    expect(inseeSearchSpy).not.toHaveBeenCalled();
    // Pass 2 — discipline observabilité : DINUM enrichment_failed doit être
    // signalé au caller via dinum_errors (sinon panne second-appel silencieuse).
    expect(result.found).toBe(true);
    if (result.found) {
      const enrichmentEntry = result.dinum_errors.find((e) => e.status === "enrichment_failed");
      expect(enrichmentEntry).toBeDefined();
      expect(enrichmentEntry?.siren).toBe(SIRET_A.slice(0, 9));
      // L'explication doit mentionner le diagnostic DINUM (préfixe "DINUM erreurs")
      expect(result.explication).toMatch(/DINUM erreurs/);
    }
  });

  it("pas de clé INSEE → fallback skipped gracieusement, dinum_errors contient l'entrée explicative, pas de crash", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_SIEGE }], error: null });

    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      siren: SIREN_BIOGROUP,
      nomComplet: "BIOGROUP NORD",
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [
        { siret: SIRET_SIEGE, adresse: "46 RUE DES FUSILLES 59493 VILLENEUVE-D'ASCQ", actif: true },
      ],
      enrichmentStatus: "partial",
      siren_source: "dinum",
    });

    // Pas de clé INSEE → lookupSiretsBySirenViaInsee retourne not_found
    vi.spyOn(inseeSirene, "lookupSiretsBySirenViaInsee").mockResolvedValue({
      found: false,
      key: SIREN_BIOGROUP,
      lookupStatus: "not_found",
      message: "INSEE_SIRENE_API_KEY non configurée — fallback INSEE désactivé.",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await verifierSiteActif(VALID_FINESS);
    // Pas de crash
    expect(result.found).toBe(true);
    if (result.found) {
      // dinum_errors doit signaler le fallback skipped avec status config_missing
      // (distingué de not_found réel = SIREN absent SIRENE — H4 régression)
      const inseeEntry = result.dinum_errors.find((e) => e.message.includes("insee_fallback"));
      expect(inseeEntry).toBeDefined();
      expect(inseeEntry?.status).toBe("config_missing");
    }
    warnSpy.mockRestore();
  });

  it("INSEE 5xx pendant fallback → dinum_errors avec status=rejected, pas de propagation d'exception", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessLookupFound());
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_SIEGE }], error: null });

    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      siren: SIREN_BIOGROUP,
      nomComplet: "BIOGROUP NORD",
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [
        { siret: SIRET_SIEGE, adresse: "46 RUE DES FUSILLES 59493 VILLENEUVE-D'ASCQ", actif: true },
      ],
      enrichmentStatus: "partial",
      siren_source: "dinum",
    });

    // INSEE 5xx → throw propagé jusqu'au Promise.allSettled du fallback
    vi.spyOn(inseeSirene, "lookupSiretsBySirenViaInsee").mockRejectedValue(new Error("HTTP 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Ne doit PAS throw — graceful degradation
    const result = await verifierSiteActif(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      const rejectedEntry = result.dinum_errors.find((e) => e.status === "rejected");
      expect(rejectedEntry).toBeDefined();
    }
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ============================================================================
// Fix P2.3 — reconcilierFinessSirene : optimisation INSEE via raison_sociale_ul
// ============================================================================

describe("reconcilierFinessSirene (P2.3 — optimisation INSEE via DINUM-enriched)", () => {
  it("cas 1 (all DINUM-enriched) : 0 appel INSEE quand tous les candidats ont raison_sociale_ul + adresse_libelle", async () => {
    // Les candidats DINUM-enriched ont raison_sociale_ul et adresse_libelle
    // populés par le resolver → pas besoin d'appeler INSEE.
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "BIOGROUP NORD" }),
    );
    // RPPS liste le siège
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_SIEGE }], error: null });

    // DINUM retourne l'établissement avec nomComplet → raison_sociale_ul sera populée
    vi.spyOn(dinum, "getEntrepriseBySiren").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      siren: SIREN_BIOGROUP,
      nomComplet: "BIOGROUP NORD",
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [
        {
          siret: SIRET_SIEGE,
          adresse: "27 BD BIZET 59290 WASQUEHAL",
          actif: true,
          dateCreation: "2020-01-01",
        },
      ],
      enrichmentStatus: "success",
      siren_source: "dinum",
    });

    const inseeSpySiret = vi.spyOn(inseeSirene, "lookupSiretViaInsee");

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.candidates).toHaveLength(1);
      // Score nom BIOGROUP NORD vs BIOGROUP NORD = 1 → verdict match
      expect(result.candidates[0]?.verdict).toBe("match");
      expect(result.candidates[0]?.scores.nom).toBe(1);
    }
    // Aucun appel INSEE — les données DINUM suffisent
    expect(inseeSpySiret).not.toHaveBeenCalled();
  });

  it("cas 2 (mixed) : 1 appel INSEE sur le candidat RPPS-only, 0 sur le DINUM-enriched", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "BIOGROUP NORD" }),
    );
    const SIRET_B = "12345678901234";
    // RPPS liste 2 SIRETs : SIRET_SIEGE (SIREN Biogroup) + SIRET_B (autre SIREN)
    mockNot.mockResolvedValue({
      data: [{ siret: SIRET_SIEGE }, { siret: SIRET_B }],
      error: null,
    });

    // DINUM pour SIREN Biogroup → success, enrichit SIRET_SIEGE avec nomComplet
    vi.spyOn(dinum, "getEntrepriseBySiren").mockImplementation(async (siren) => {
      if (siren === SIREN_BIOGROUP) {
        return {
          found: true,
          lookupStatus: "found",
          siren: SIREN_BIOGROUP,
          nomComplet: "BIOGROUP NORD",
          finances: [],
          dirigeants: [],
          actif: true,
          etablissements: [
            { siret: SIRET_SIEGE, adresse: "27 BD BIZET 59290 WASQUEHAL", actif: true },
          ],
          enrichmentStatus: "success" as const,
          siren_source: "dinum" as const,
        };
      }
      // SIREN du SIRET_B : DINUM not_found → candidat reste RPPS-only
      return { found: false, key: siren, lookupStatus: "not_found" as const, message: "absent" };
    });

    const inseeSpySiret = vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue(
      fakeInseeLookupFound({
        siret: SIRET_B,
        siren: SIRET_B.slice(0, 9),
        raisonSocialeUniteLegale: "AUTRE LABO",
      }),
    );

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    if (result.found) {
      // 2 candidats : 1 DINUM-enriched + 1 RPPS-only via INSEE
      expect(result.candidates).toHaveLength(2);
    }
    // INSEE appelé 1 seule fois — uniquement pour SIRET_B (RPPS-only)
    expect(inseeSpySiret).toHaveBeenCalledTimes(1);
    expect(inseeSpySiret).toHaveBeenCalledWith(SIRET_B);
  });

  it("cas 3 (all RPPS-only) : comportement V0.7.0 préservé — appel INSEE pour chaque candidat", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(
      fakeFinessLookupFound({ raison_sociale: "BIOGROUP NORD" }),
    );
    mockNot.mockResolvedValue({ data: [{ siret: SIRET_A }], error: null });

    // DINUM not_found → candidat reste RPPS-only (raison_sociale_ul = null)
    // (mock default beforeEach déjà configuré en not_found)

    const inseeSpySiret = vi
      .spyOn(inseeSirene, "lookupSiretViaInsee")
      .mockResolvedValue(fakeInseeLookupFound({ raisonSocialeUniteLegale: "BIOGROUP NORD" }));

    const result = await reconcilierFinessSirene(VALID_FINESS);
    expect(result.found).toBe(true);
    // INSEE appelé : le candidat RPPS-only doit passer par la branche inseeRequired
    expect(inseeSpySiret).toHaveBeenCalledTimes(1);
    expect(inseeSpySiret).toHaveBeenCalledWith(SIRET_A);
  });
});
