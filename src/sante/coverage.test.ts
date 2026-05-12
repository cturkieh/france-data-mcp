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
