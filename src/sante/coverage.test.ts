/**
 * Tests unitaires pour `getCoverageFinessVsSireneInRadius` (P2.2).
 *
 * Stratégie de mock :
 * - `getFinessInRadius` (finess-db) → spy sur l'import
 * - `getEntrepriseBySiren` (dinum) → spy sur l'import
 * - `searchEntreprises` (dinum) → spy sur l'import
 * - `reverseGeocode` (territoire/geocode) → spy sur l'import
 * - `getAnonClient` (storage/supabase) → mock statique minimal pour satisfaire
 *   les imports transitifs de finess-db.ts au chargement du module
 */

vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ from: vi.fn() }),
  getAnonClient: () => ({ rpc: vi.fn().mockResolvedValue({ data: [], error: null }) }),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as communesMod from "../territoire/communes.js";
import * as geocodeMod from "../territoire/geocode.js";
import { getCoverageFinessVsSireneInRadius } from "./coverage.js";
import * as dinumMod from "./dinum.js";
import type { Entreprise, Etablissement } from "./dinum.js";
import * as finessDbMod from "./finess-db.js";
import type { FinessResult } from "./finess-db.js";

// ── Helpers fixtures ──────────────────────────────────────────────────────────

const CENTER = { lon: 4.7192, lat: 49.7672 };
const NAF = "8690B";
const RADIUS_KM = 5;

/** Construit un FinessResult minimal avec coords et adresse dans le rayon. */
function makeFiness(id: string, label: string, lon = 4.7192, lat = 49.7672): FinessResult {
  return {
    num_finess: `99000000${id}`,
    raison_sociale: label,
    categorie: { code: "611", libelle: "LBM", famille: "labo" },
    adresse: {
      voie: `${id} RUE DU LABO`,
      code_postal: "08000",
      ville: "CHARLEVILLE",
      code_departement: "08",
      code_insee: "08105",
    },
    coords: { lat, lon },
    distance_km: 0.5,
    telephone: null,
    email: null,
  };
}

/** Construit un établissement DINUM avec point, actif, NAF. */
function makeEtab(
  siret: string,
  adresse: string,
  lon: number,
  lat: number,
  actif = true,
  naf = NAF,
): Etablissement {
  return {
    siret,
    adresse,
    actif,
    point: { lon, lat },
    naf,
    codePostal: "08000",
    commune: "CHARLEVILLE",
    dateCreation: "2020-01-01",
  };
}

/** Construit une Entreprise DINUM minimale (fond de mock). */
function makeEntrepriseLookup(
  siren: string,
  nomComplet: string,
  etablissements: Etablissement[],
): Awaited<ReturnType<typeof dinumMod.getEntrepriseBySiren>> {
  return {
    found: true,
    lookupStatus: "found",
    siren,
    nomComplet,
    finances: [],
    dirigeants: [],
    actif: true,
    etablissements,
    siren_source: "dinum",
    enrichmentStatus: "success",
  } as Entreprise & { found: true; lookupStatus: "found" };
}

/** Résultat searchEntreprises avec 1 UL contenant le SIREN donné. */
function makeSearchResult(siren: string, nomComplet: string) {
  return {
    total: 1,
    page: 1,
    perPage: 25,
    totalPages: 1,
    entreprises: [
      {
        siren,
        nomComplet,
        finances: [],
        dirigeants: [],
        actif: true,
        etablissements: [],
        siren_source: "dinum" as const,
      },
    ] as Entreprise[],
  };
}

/** Mock reverseGeocode → département 08. */
function mockReverseGeocodeOk() {
  vi.spyOn(geocodeMod, "reverseGeocode").mockResolvedValue({
    point: CENTER,
    label: "Charleville-Mézières",
    score: 0.9,
    confidence_low: false,
    type: "municipality",
    codeCommune: "08105",
    codePostal: "08000",
    commune: "Charleville-Mézières",
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockReverseGeocodeOk();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getCoverageFinessVsSireneInRadius — cas heureux", () => {
  it("calcule matched/finess_only/sirene_only correctement avec 3 FINESS et 1 UL (3 SIRET in + 2 hors rayon)", async () => {
    // 3 FINESS dans le rayon
    const f1 = makeFiness("1", "LABO ALPHA");
    const f2 = makeFiness("2", "LABO BETA");
    const f3 = makeFiness("3", "LABO GAMMA");
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 3,
      truncated: false,
      results: [f1, f2, f3],
    });

    const SIREN = "123456789";

    // 1 UL DINUM retournée par searchEntreprises
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue(
      makeSearchResult(SIREN, "BIOLAB SAS"),
    );

    // getEntrepriseBySiren → 5 SIRET :
    //   - 3 dans le rayon avec le bon NAF (actifs)
    //   - 2 hors rayon (coords distantes)
    const siretIn1 = makeEtab(`${SIREN}00001`, "1 RUE DU LABO 08000 CHARLEVILLE", 4.7192, 49.7672);
    const siretIn2 = makeEtab(`${SIREN}00002`, "2 RUE DU LABO 08000 CHARLEVILLE", 4.7193, 49.7673);
    const siretIn3 = makeEtab(`${SIREN}00003`, "3 RUE DU LABO 08000 CHARLEVILLE", 4.7194, 49.7674);
    const siretOut1 = makeEtab(`${SIREN}00004`, "1 RUE TRES LOIN 75001 PARIS", 2.3, 48.8);
    const siretOut2 = makeEtab(`${SIREN}00005`, "2 RUE TRES LOIN 69001 LYON", 4.8, 45.7);

    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockResolvedValue(
      makeEntrepriseLookup(SIREN, "BIOLAB SAS", [
        siretIn1,
        siretIn2,
        siretIn3,
        siretOut1,
        siretOut2,
      ]),
    );

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF,
    });

    expect(result.finess_sites).toBe(3);
    expect(result.sirene_sirets).toBe(3);
    // Les adresses FINESS ("1 RUE DU LABO 08000 CHARLEVILLE") et SIRET ("1 RUE DU LABO 08000 CHARLEVILLE")
    // sont identiques → score Dice = 1.0 ≥ 0.7 → 3 matchés
    expect(result.matched_count).toBe(3);
    expect(result.coverage_ratio).toBe(1);
    expect(result.truncated_unites_legales).toBe(false);
    expect(result.dinum_errors).toHaveLength(0);
    expect(result.methodology).toContain(NAF);
    expect(result.caveats.length).toBeGreaterThan(0);
  });
});

describe("getCoverageFinessVsSireneInRadius — cas FINESS vide", () => {
  it("0 FINESS, 2 SIRET DINUM dans le rayon → coverage_ratio=0, sirene_only_count=2", async () => {
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });

    const SIREN = "987654321";
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue(
      makeSearchResult(SIREN, "PHARMA CENTRALE"),
    );

    const NAF_PHARMA = "4773Z";
    const etab1 = makeEtab(
      `${SIREN}00010`,
      "10 AVE DE LA PHARMACIE 08000 CHARLEVILLE",
      4.719,
      49.767,
      true,
      NAF_PHARMA,
    );
    const etab2 = makeEtab(
      `${SIREN}00011`,
      "11 AVE DE LA PHARMACIE 08000 CHARLEVILLE",
      4.718,
      49.766,
      true,
      NAF_PHARMA,
    );

    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockResolvedValue(
      makeEntrepriseLookup(SIREN, "PHARMA CENTRALE", [etab1, etab2]),
    );

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF_PHARMA,
    });

    expect(result.finess_sites).toBe(0);
    expect(result.sirene_sirets).toBe(2);
    expect(result.coverage_ratio).toBe(0);
    expect(result.sirene_only_count).toBe(2);
    expect(result.finess_only_count).toBe(0);
    expect(result.matched_count).toBe(0);
    expect(result.sirene_only_samples).toHaveLength(2);
    expect(result.finess_only_samples).toHaveLength(0);
  });
});

describe("getCoverageFinessVsSireneInRadius — cas SIRENE vide", () => {
  it("2 FINESS, 0 SIRET DINUM → coverage_ratio=null, finess_only_count=2", async () => {
    const f1 = makeFiness("4", "LABO DELTA");
    const f2 = makeFiness("5", "LABO EPSILON");
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 2,
      truncated: false,
      results: [f1, f2],
    });

    // searchEntreprises retourne 0 UL
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    // getEntrepriseBySiren ne sera pas appelé (pas d'UL)
    const spySiren = vi.spyOn(dinumMod, "getEntrepriseBySiren");

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF,
    });

    expect(result.finess_sites).toBe(2);
    expect(result.sirene_sirets).toBe(0);
    expect(result.coverage_ratio).toBeNull();
    expect(result.finess_only_count).toBe(2);
    expect(result.sirene_only_count).toBe(0);
    expect(result.matched_count).toBe(0);
    expect(result.finess_only_samples).toHaveLength(2);
    expect(spySiren).not.toHaveBeenCalled();
  });
});

describe("getCoverageFinessVsSireneInRadius — cas truncated", () => {
  it("maxUnitesLegales=2 + DINUM retourne 5 UL → truncated_unites_legales=true, seules 2 traitées", async () => {
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 1,
      truncated: false,
      results: [makeFiness("6", "LABO ZETA")],
    });

    // searchEntreprises retourne 5 UL
    const ulList: Entreprise[] = Array.from({ length: 5 }, (_, idx) => ({
      siren: `10000000${idx}`,
      nomComplet: `LABO ${idx}`,
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [],
      siren_source: "dinum" as const,
    }));

    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 5,
      page: 1,
      perPage: 25,
      totalPages: 1,
      entreprises: ulList,
    });

    // getEntrepriseBySiren → SIRET vide pour chacun (on teste juste le count de calls)
    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockResolvedValue({
      found: false,
      key: "noop",
      lookupStatus: "not_found",
      message: "test mock not_found",
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF,
      maxUnitesLegales: 2,
    });

    expect(result.truncated_unites_legales).toBe(true);
    // Seulement 2 UL traitées (not_found → ajoutées dans dinum_errors)
    expect(dinumMod.getEntrepriseBySiren).toHaveBeenCalledTimes(2);
    // Les 2 not_found sont dans dinum_errors
    expect(result.dinum_errors).toHaveLength(2);
  });
});

describe("getCoverageFinessVsSireneInRadius — troncature upstream DINUM (H1+H2 régression)", () => {
  it("DINUM retourne total:100 entreprises:25, maxUnitesLegales:25 → truncated_unites_legales:true + total_unites_legales_estime:100 + caveat mentionnant 100", async () => {
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });

    // 25 UL dans la liste mais total=100 : troncature upstream DINUM
    const ulList25: Entreprise[] = Array.from({ length: 25 }, (_, idx) => ({
      siren: `20000${String(idx).padStart(4, "0")}`,
      nomComplet: `LABO ${idx}`,
      finances: [],
      dirigeants: [],
      actif: true,
      etablissements: [],
      siren_source: "dinum" as const,
    }));

    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 100,
      page: 1,
      perPage: 25,
      totalPages: 4,
      entreprises: ulList25,
    });

    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockResolvedValue({
      found: false,
      key: "noop",
      lookupStatus: "not_found",
      message: "test mock not_found",
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF,
      maxUnitesLegales: 25, // cap = taille de la liste → seule la troncature upstream joue
    });

    // H1 : truncated doit être true malgré cap == liste.length
    expect(result.truncated_unites_legales).toBe(true);
    // H1 : total_unites_legales_estime doit refléter le total DINUM
    expect(result.total_unites_legales_estime).toBe(100);
    // H2 : le caveat doit mentionner 100 (pas "25+")
    const truncCaveat = result.caveats.find((c) => c.includes("100"));
    expect(truncCaveat).toBeDefined();
  });
});

describe("getCoverageFinessVsSireneInRadius — dinum_errors", () => {
  it("1 UL en rejected (mock throw) → entrée dans dinum_errors, pas de crash", async () => {
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });

    const SIREN_FAIL = "555000111";
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue(
      makeSearchResult(SIREN_FAIL, "UL DEFAILLANTE"),
    );

    // Mock qui throw (rejected dans Promise.allSettled)
    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockRejectedValue(new Error("DINUM timeout simulé"));

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF,
    });

    // Pas de crash
    expect(result.dinum_errors).toHaveLength(1);
    expect(result.dinum_errors[0]?.siren).toBe(SIREN_FAIL);
    expect(result.dinum_errors[0]?.status).toBe("rejected");
    expect(result.dinum_errors[0]?.message).toContain("timeout");
    // Décomptes cohérents
    expect(result.finess_sites).toBe(0);
    expect(result.sirene_sirets).toBe(0);
    expect(result.coverage_ratio).toBeNull();
  });
});

// ── Tests V0.13.2 : gate d'activité NAF/famille (Franco-Britannique) ─────────

/**
 * Construit un FinessResult d'IFSI / école co-localisé (famille
 * `enfance_protection`, hors périmètre santé strict). Reproduit le cas
 * Hôpital Franco-Britannique 4 rue Kléber : l'IFSI partage l'adresse du
 * labo mais ne doit JAMAIS matcher un SIRET de labo via le gate NAF.
 */
function makeIfsiSameAddress(id: string, label: string): FinessResult {
  return {
    num_finess: `91000000${id}`,
    raison_sociale: label,
    categorie: { code: "300", libelle: "IFSI", famille: "enfance_protection" },
    adresse: {
      voie: "4 RUE KLEBER",
      code_postal: "92300",
      ville: "LEVALLOIS",
      code_departement: "92",
      code_insee: "92044",
    },
    coords: { lat: 48.8932, lon: 2.2872 },
    distance_km: 0.0,
    telephone: null,
    email: null,
  };
}

function makeLaboSameAddress(id: string, label: string): FinessResult {
  return {
    num_finess: `92000000${id}`,
    raison_sociale: label,
    categorie: { code: "611", libelle: "LBM", famille: "labo" },
    adresse: {
      voie: "4 RUE KLEBER",
      code_postal: "92300",
      ville: "LEVALLOIS",
      code_departement: "92",
      code_insee: "92044",
    },
    coords: { lat: 48.8932, lon: 2.2872 },
    distance_km: 0.0,
    telephone: null,
    email: null,
  };
}

describe("getCoverageFinessVsSireneInRadius — V0.13.2 gate NAF Franco-Britannique", () => {
  it("IFSI co-localisé éliminé du périmètre — finess_sites=1, matched=1, IFSI absent du rapport", async () => {
    // Cas réel Hôpital Franco-Britannique : labo + IFSI au 4 rue Kléber.
    // Pre-filter par nafCompatiblesSet en amont : l'IFSI (famille=enfance_protection)
    // n'apparaît plus du tout dans le rapport (ni matched, ni finess_only) —
    // garantit qu'un caller LLM ne le confondra pas avec une "sous-déclaration
    // DREES". Greedy first-served sur Dice 1.0 ne décide plus l'appariement.
    const labo = makeLaboSameAddress("1", "BIOLAB FRANCO");
    const ifsi = makeIfsiSameAddress("2", "IFSI FRANCO");
    // IFSI en tête : sans pre-filter, greedy first-served l'aurait apparié au SIRET labo.
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 2,
      truncated: false,
      results: [ifsi, labo],
    });

    const SIREN = "777111222";
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue(
      makeSearchResult(SIREN, "BIOLAB FRANCO SAS"),
    );
    const siretLabo = makeEtab(`${SIREN}00001`, "4 RUE KLEBER 92300 LEVALLOIS", 2.2872, 48.8932);
    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockResolvedValue(
      makeEntrepriseLookup(SIREN, "BIOLAB FRANCO SAS", [siretLabo]),
    );

    const result = await getCoverageFinessVsSireneInRadius({
      center: { lon: 2.2872, lat: 48.8932 },
      radiusKm: 0.1,
      naf: NAF, // 8690B
    });

    // Le périmètre FINESS est restreint au scope NAF — l'IFSI est invisible.
    expect(result.finess_sites).toBe(1);
    expect(result.sirene_sirets).toBe(1);
    expect(result.matched_count).toBe(1);
    expect(result.matched_samples).toHaveLength(1);
    expect(result.matched_samples[0]?.finess.num_finess).toBe(labo.num_finess);
    expect(result.matched_samples[0]?.finess.raison_sociale).toBe("BIOLAB FRANCO");
    // L'IFSI ne doit apparaître NULLE PART dans le rapport (pas dans finess_only,
    // pas dans matched, pas dans le count).
    const allFinessIds = [
      ...result.matched_samples.map((s) => s.finess.num_finess),
      ...result.finess_only_samples.map((s) => s.num_finess),
    ];
    expect(allFinessIds).not.toContain(ifsi.num_finess);
    expect(result.finess_only_count).toBe(0);
    expect(result.coverage_status).toBe("computed");
  });
});

describe("getCoverageFinessVsSireneInRadius — V0.13.2 auto-derive familles (couche 1)", () => {
  it("appel sans `familles` → getFinessInRadius reçoit familles auto-dérivées du NAF", async () => {
    // Cas réel Neuilly : caller appelle (naf=8690B) sans préciser familles.
    // Avant : finess_sites comptait 200 sites tous types (hôpital, EHPAD, etc.) —
    //         ratio coverage = 200/12 ≈ 17, complètement trompeur.
    // Après : auto-dérive `familles=["labo"]` → getFinessInRadius restreint
    //         au scope cohérent avec le NAF cible. Ratio recalibré.
    const finessSpy = vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B", // labos
    });

    expect(finessSpy).toHaveBeenCalledTimes(1);
    const callArg = finessSpy.mock.calls[0]?.[0];
    expect(callArg?.familles).toEqual(["labo"]);
    // Le résultat doit exposer la trace de la couche 1 pour la transparence
    expect(result.familles_auto_derivees).toEqual(["labo"]);
  });

  it("appel sans `familles` pour 8610Z hospitalier → many-to-many (mco/ssr/sld/had/psy...)", async () => {
    // 8610Z partagé par 8 familles. L'auto-derive doit toutes les propager
    // côté getFinessInRadius — sinon coverage hospitalier sous-compte.
    const finessSpy = vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8610Z",
    });

    const callArg = finessSpy.mock.calls[0]?.[0];
    expect(callArg?.familles).toContain("mco");
    expect(callArg?.familles).toContain("ssr");
    expect(callArg?.familles).toContain("psychiatrie");
    expect(callArg?.familles?.length).toBeGreaterThanOrEqual(5);
    expect(result.familles_auto_derivees).toEqual(callArg?.familles);
  });

  it("appel AVEC `familles` explicite → pas d'auto-derive (familles_auto_derivees=null)", async () => {
    // Le caller a fait un choix explicite — on ne le superpose pas. Le champ
    // `familles_auto_derivees` est null pour signaler "scope choisi par caller".
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B",
      familles: ["labo"],
    });

    expect(result.familles_auto_derivees).toBeNull();
  });
});

describe("getCoverageFinessVsSireneInRadius — V0.13.2 coverage_status typé", () => {
  it("flow nominal → coverage_status='computed' (toujours présent)", async () => {
    // Garde-fou : le champ doit être TOUJOURS sérialisé, jamais undefined,
    // pour que le caller LLM puisse router sans gérer le cas absent.
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B",
    });

    expect(result.coverage_status).toBe("computed");
  });

  it("NAF inconnu → coverage_status='scope_empty_unknown_naf' + warn ops", async () => {
    // 8542Z (école) n'a aucune famille FINESS mappée — court-circuit explicite.
    // Garantit qu'un typo NAF ne tombe pas silencieusement sur "rayon vide".
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8542Z", // NAF école — non mappé
    });

    expect(result.coverage_status).toBe("scope_empty_unknown_naf");
    expect(result.finess_sites).toBe(0);
    // Observability ops : warn explicite quand le mapping est incomplet
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("non mappé"));
    warnSpy.mockRestore();
  });

  it("familles toutes incompatibles → coverage_status='scope_empty_familles_incompatible'", async () => {
    // Caller a passé des familles, toutes incompatibles avec le NAF.
    // Distinct du cas précédent (NAF connu mais scope manuel cassé).
    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B",
      familles: ["enfance_protection"],
    });

    expect(result.coverage_status).toBe("scope_empty_familles_incompatible");
    expect(result.finess_sites).toBe(0);
  });
});

describe("getCoverageFinessVsSireneInRadius — V0.13.2 familles incohérentes (couche 2)", () => {
  it("familles=['enfance_protection'] + naf='8690B' → finess_sites=0 + caveat explicite", async () => {
    // Caller explicite mais incohérent : aucune famille passée n'est compatible
    // avec le NAF cible. On ne peut pas calculer un ratio sensé — on retourne
    // finess_sites=0 + caveat fort qui explique pourquoi (pas un silence muet).
    // getFinessInRadius peut être court-circuité ; pas une exigence stricte
    // sur l'appel, mais sur le résultat final + le caveat.
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 5,
      truncated: false,
      // Même si le mock dit "5 résultats", le scope dérivé est vide donc
      // finess_sites doit être 0.
      results: [makeIfsiSameAddress("9", "IFSI A"), makeIfsiSameAddress("10", "IFSI B")],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B",
      familles: ["enfance_protection"],
    });

    expect(result.finess_sites).toBe(0);
    expect(result.matched_count).toBe(0);
    // Caveat doit nommer explicitement la famille exclue ET le NAF
    const incompatibleCaveat = result.caveats.find(
      (c) => c.includes("enfance_protection") && c.includes("8690B"),
    );
    expect(
      incompatibleCaveat,
      `Caveat manquant pour familles incompatibles. Caveats actuels: ${JSON.stringify(result.caveats, null, 2)}`,
    ).toBeDefined();
    expect(result.familles_excluees_naf).toContain("enfance_protection");
  });

  it("familles=['labo','enfance_protection'] + naf='8690B' → scope=['labo'] + caveat sur exclu", async () => {
    // Intersection partielle : la famille labo passe le filtre, enfance_protection
    // est exclue (incompatible avec 8690B). getFinessInRadius doit recevoir
    // SEULEMENT ["labo"] et un caveat doit lister "enfance_protection" comme exclue.
    const finessSpy = vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 1,
      truncated: false,
      results: [makeLaboSameAddress("7", "LABO X")],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B",
      familles: ["labo", "enfance_protection"],
    });

    const callArg = finessSpy.mock.calls[0]?.[0];
    expect(callArg?.familles).toEqual(["labo"]);
    expect(result.familles_excluees_naf).toEqual(["enfance_protection"]);
    expect(result.familles_excluees_naf).not.toContain("labo");
    // Caveat de transparence sur l'exclusion
    const exclCaveat = result.caveats.find(
      (c) => c.includes("enfance_protection") && c.includes("8690B"),
    );
    expect(exclCaveat).toBeDefined();
  });

  it("familles non passées + auto-derive ⇒ familles_excluees_naf reste absent/vide", async () => {
    // Si le caller n'a rien passé, il n'a rien à se voir reprocher — pas de
    // familles_excluees_naf, juste familles_auto_derivees.
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });
    vi.spyOn(dinumMod, "searchEntreprises").mockResolvedValue({
      total: 0,
      page: 1,
      perPage: 25,
      totalPages: 0,
      entreprises: [],
    });

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: "8690B",
    });

    expect(
      result.familles_excluees_naf === undefined || result.familles_excluees_naf.length === 0,
      `familles_excluees_naf doit être vide/absent en cas d'auto-derive sans input. Reçu: ${JSON.stringify(result.familles_excluees_naf)}`,
    ).toBe(true);
  });
});

// ── Fallback frontières : point isolé sans adresse (ex. Orano La Hague) ────────
//   reverseGeocode d'adresse → null, mais le point appartient à une commune →
//   `communeContainingPoint` la retrouve → département dérivé, PAS de RangeError.
//   (Même angle mort que dynamique_immobiliere, corrigé par le même helper.)
// ──────────────────────────────────────────────────────────────────────────────

describe("getCoverageFinessVsSireneInRadius — fallback frontières (point isolé)", () => {
  it("reverseGeocode sans commune → département résolu via communeContainingPoint (pas de RangeError)", async () => {
    // Reverse d'adresse vide (site isolé / littoral)…
    vi.spyOn(geocodeMod, "reverseGeocode").mockResolvedValue(null);
    // …mais les frontières retrouvent la commune → dept 08.
    const boundarySpy = vi
      .spyOn(communesMod, "communeContainingPoint")
      .mockResolvedValue({ codeCommune: "08105", commune: "Charleville-Mézières" });

    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });
    const searchSpy = vi
      .spyOn(dinumMod, "searchEntreprises")
      .mockResolvedValue(makeSearchResult("000000000", "AUCUNE"));
    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockResolvedValue(
      makeEntrepriseLookup("000000000", "AUCUNE", []),
    );

    const result = await getCoverageFinessVsSireneInRadius({
      center: CENTER,
      radiusKm: RADIUS_KM,
      naf: NAF,
    });

    // Fallback interrogé avec le centre + département dérivé transmis à DINUM.
    expect(boundarySpy).toHaveBeenCalledWith(CENTER);
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "08" }));
    expect(result.finess_sites).toBe(0);
  });

  it("reverse null ET frontières null (point en mer) → RangeError (filet conservé)", async () => {
    vi.spyOn(geocodeMod, "reverseGeocode").mockResolvedValue(null);
    vi.spyOn(communesMod, "communeContainingPoint").mockResolvedValue(null);
    vi.spyOn(finessDbMod, "getFinessInRadius").mockResolvedValue({
      count: 0,
      truncated: false,
      results: [],
    });

    await expect(
      getCoverageFinessVsSireneInRadius({ center: CENTER, radiusKm: RADIUS_KM, naf: NAF }),
    ).rejects.toThrow(RangeError);
  });
});
