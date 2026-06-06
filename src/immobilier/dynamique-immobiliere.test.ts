/**
 * Tests unitaires — dynamique_immobiliere composite.
 *
 * Tous les leaf services (permitsForCommune, getZonesAU, dvfInRadius) et
 * reverseGeocode sont mockés via vi.spyOn / vi.mock. Pas de réseau.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock leaf services AVANT les imports du module testé
// ---------------------------------------------------------------------------

vi.mock("./sitadel.js", () => ({
  permitsForCommune: vi.fn(),
}));

vi.mock("./apicarto-plu.js", () => ({
  getZonesAU: vi.fn(),
}));

vi.mock("./dvf.js", () => ({
  dvfInRadius: vi.fn(),
  aggregatePrix: vi.fn(),
}));

vi.mock("../territoire/geocode.js", () => ({
  reverseGeocode: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (après mocks)
// ---------------------------------------------------------------------------

import * as geocodeModule from "../territoire/geocode.js";
import type { GeocodeResult } from "../territoire/geocode.js";
import * as pluModule from "./apicarto-plu.js";
import type { ZonesAUResult } from "./apicarto-plu.js";
import * as dvfModule from "./dvf.js";
import type { DvfMutation } from "./dvf.js";
import { dynamiqueImmobiliere } from "./dynamique-immobiliere.js";
import * as sitadelModule from "./sitadel.js";
import type { PermitsResult } from "./sitadel.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT = { lat: 48.86, lon: 2.35, rayon_km: 3 };

/** Reverse-geocode nominal (Paris) */
const REV_GEO_OK: GeocodeResult = {
  point: { lat: 48.86, lon: 2.35 },
  label: "Paris 1er Arrondissement",
  score: 0.95,
  confidence_low: false,
  type: "municipality",
  codeCommune: "75056",
  commune: "Paris",
};

/** Permis nominal : 120 logements autorisés → signal "fort" */
const PERMITS_OK: PermitsResult = {
  couverture: "ok",
  logements_autorises_recent: 120,
  logements_commences_recent: 80,
  par_annee: { "2023": { aut: 120, com: 80 } },
  habitants_attendus: 264,
  annees: ["2023"],
};

/** Deux zones AU : 1 AUC (ouverte) + 1 AUs (stricte) */
const AU_FEATURE_AUC = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [2.33, 48.85],
        [2.34, 48.85],
        [2.34, 48.86],
        [2.33, 48.86],
        [2.33, 48.85],
      ],
    ],
  },
  properties: { typezone: "AUc", libelle: "1AUc", libelong: "Zone ouverte" },
};

const AU_FEATURE_AUS = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [2.35, 48.87],
        [2.36, 48.87],
        [2.36, 48.88],
        [2.35, 48.88],
        [2.35, 48.87],
      ],
    ],
  },
  properties: { typezone: "AUs", libelle: "2AUs", libelong: "Zone stricte" },
};

const ZONES_OK: ZonesAUResult = {
  couverture: "ok",
  n_zones_au: 2,
  zones_au: [
    { typezone: "AUc", libelle: "1AUc", libelong: "Zone ouverte", feature: AU_FEATURE_AUC },
    { typezone: "AUs", libelle: "2AUs", libelong: "Zone stricte", feature: AU_FEATURE_AUS },
  ],
  // geojson.features dérivé de zones_au.map(z=>z.feature) — source unique (B1)
  geojson: { type: "FeatureCollection", features: [AU_FEATURE_AUC, AU_FEATURE_AUS] },
};

/** DVF : une vente bâtie + un terrain */
const DVF_ROWS: DvfMutation[] = [
  {
    id_mutation: "m1",
    date_mutation: "2023-05-01",
    nature_mutation: "Vente",
    valeur_fonciere: 300000,
    code_commune: "75056",
    type_local: "Appartement",
    surface_reelle_bati: 60,
    surface_terrain: null,
    prix_m2: 5000,
    longitude: 2.35,
    latitude: 48.86,
  },
  {
    id_mutation: "m2",
    date_mutation: "2023-06-01",
    nature_mutation: "Vente",
    valeur_fonciere: 150000,
    code_commune: "75056",
    type_local: "",
    surface_reelle_bati: null,
    surface_terrain: 200,
    prix_m2: null,
    longitude: 2.36,
    latitude: 48.87,
  },
];

/** Aggregate réel calculé depuis DVF_ROWS */
const AGG_OK = {
  prix_m2_median: 5000,
  prix_m2_p25: 5000,
  prix_m2_p75: 5000,
  n_ventes: 1,
  n_terrains: 1,
  prix_terrain_median: 150000,
};

/** Reverse-geocode centroïde AUC → Montrouge */
const REV_GEO_CENTROID_AUC: GeocodeResult = {
  point: { lat: 48.855, lon: 2.335 },
  label: "Montrouge",
  score: 0.9,
  confidence_low: false,
  type: "municipality",
  commune: "Montrouge",
};

/** Reverse-geocode centroïde AUS → Kremlin-Bicêtre */
const REV_GEO_CENTROID_AUS: GeocodeResult = {
  point: { lat: 48.875, lon: 2.355 },
  label: "Kremlin-Bicêtre",
  score: 0.9,
  confidence_low: false,
  type: "municipality",
  commune: "Kremlin-Bicêtre",
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (a) Toutes les sections OK
// ---------------------------------------------------------------------------

describe("dynamiqueImmobiliere", () => {
  it("(a) toutes sections ok — note volume + info quartiers + signal correct", async () => {
    // reverseGeocode : appel 1 = ancrage (lat,lon) ; appels 2–3 = centroïdes AU
    vi.mocked(geocodeModule.reverseGeocode)
      .mockResolvedValueOnce(REV_GEO_OK)
      .mockResolvedValueOnce(REV_GEO_CENTROID_AUC)
      .mockResolvedValueOnce(REV_GEO_CENTROID_AUS);

    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue(PERMITS_OK);
    vi.mocked(pluModule.getZonesAU).mockResolvedValue(ZONES_OK);
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue(DVF_ROWS);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);

    // meta
    expect(result.meta.code_commune).toBe("75056");
    expect(result.meta.commune).toBe("Paris");
    expect(result.meta.rayon_km).toBe(3);

    // couverture tout "ok"
    expect(result.couverture.permis).toBe("ok");
    expect(result.couverture.zones_au).toBe("ok");
    expect(result.couverture.terrains).toBe("ok");

    // note — volume
    expect(result.note.logements_autorises_recent).toBe(120);
    expect(result.note.logements_commences_recent).toBe(80);
    expect(result.note.zones_au_nombre).toBe(2);
    // AUC seule (AUs n'est pas AUC)
    expect(result.note.zones_au_immediates).toBe(1);
    // signal : 120 >= 100 → "fort"
    expect(result.note.signal).toBe("fort");
    // B2 : zones_au_surface_ha (toujours null, non calculé) a été RETIRÉ de note
    expect("zones_au_surface_ha" in result.note).toBe(false);

    // info — quartiers
    expect(result.info.habitants_attendus).toBe(264);
    expect(result.info.quartiers_au).toHaveLength(2);
    // B1 : le centroïde de chaque quartier provient de la feature portée par SA
    // propre entrée zones_au (AU_FEATURE_AUC → Montrouge, AU_FEATURE_AUS → Kremlin-Bicêtre)
    expect(result.info.quartiers_au[0]).toEqual({ libelle: "1AUc", secteur: "Montrouge" });
    expect(result.info.quartiers_au[1]).toEqual({ libelle: "2AUs", secteur: "Kremlin-Bicêtre" });

    // info — prix
    expect(result.info.prix_m2_median).toBe(5000);
    expect(result.info.terrains.n).toBe(1);
    expect(result.info.terrains.prix_terrain_median).toBe(150000);

    // geojson forwarde les features AU — B1 : égal à zones_au.map(z=>z.feature)
    expect(result.geojson.type).toBe("FeatureCollection");
    expect(result.geojson.features).toHaveLength(2);
    expect(result.geojson.features).toEqual(ZONES_OK.zones_au.map((z) => z.feature));
  });

  // -------------------------------------------------------------------------
  // (b) Section PLU throws → dégradation gracieuse
  // -------------------------------------------------------------------------

  it("(b) PLU throws → couverture.zones_au ~ /indisponible/, permis+terrains présents, composite résolu", async () => {
    vi.mocked(geocodeModule.reverseGeocode).mockResolvedValue(REV_GEO_OK);
    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue(PERMITS_OK);
    vi.mocked(pluModule.getZonesAU).mockRejectedValue(new Error("apicarto timeout"));
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue(DVF_ROWS);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);

    // PLU indisponible
    expect(result.couverture.zones_au).toMatch(/indisponible/);
    // Permis et terrains toujours présents
    expect(result.couverture.permis).toBe("ok");
    expect(result.couverture.terrains).toBe("ok");

    // Note dégradée mais présente
    expect(result.note.logements_autorises_recent).toBe(120);
    expect(result.note.zones_au_nombre).toBe(0); // fallback 0
    expect(result.note.zones_au_immediates).toBe(0);
    // signal uniquement sur permis : 120 >= 100 → "fort"
    expect(result.note.signal).toBe("fort");

    // Quartiers AU vides (pas de zones)
    expect(result.info.quartiers_au).toHaveLength(0);

    // Prix DVF toujours là
    expect(result.info.prix_m2_median).toBe(5000);

    // Composite ne throw pas
    await expect(dynamiqueImmobiliere(BASE_INPUT)).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // (b2) Ancrage reverse-geocode → null : RangeError (coordonnées hors France)
  // -------------------------------------------------------------------------

  it("(b2) reverseGeocode null → RangeError (coordonnées hors couverture IGN)", async () => {
    vi.mocked(geocodeModule.reverseGeocode).mockResolvedValueOnce(null);

    await expect(dynamiqueImmobiliere(BASE_INPUT)).rejects.toThrow(RangeError);
  });

  it("(b3) reverseGeocode ok mais codeCommune absent → RangeError", async () => {
    const revGeoNoCcommune: GeocodeResult = {
      ...REV_GEO_OK,
      codeCommune: undefined,
    };
    vi.mocked(geocodeModule.reverseGeocode).mockResolvedValueOnce(revGeoNoCcommune);

    await expect(dynamiqueImmobiliere(BASE_INPUT)).rejects.toThrow(RangeError);
  });

  // -------------------------------------------------------------------------
  // (c) Reverse-geocode d'un centroïde échoue pour une zone → secteur:null
  // -------------------------------------------------------------------------

  it("(c) reverse-geocode centroïde[1] échoue → quartiers_au[1].secteur === null, [0] intact", async () => {
    vi.mocked(geocodeModule.reverseGeocode)
      .mockResolvedValueOnce(REV_GEO_OK) // ancrage
      .mockResolvedValueOnce(REV_GEO_CENTROID_AUC) // centroïde AUC → ok
      .mockRejectedValueOnce(new Error("reverse geocode network error")); // centroïde AUs → fail

    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue(PERMITS_OK);
    vi.mocked(pluModule.getZonesAU).mockResolvedValue(ZONES_OK);
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue([]);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue({
      prix_m2_median: null,
      prix_m2_p25: null,
      prix_m2_p75: null,
      n_ventes: 0,
      n_terrains: 0,
      prix_terrain_median: null,
    });

    const result = await dynamiqueImmobiliere(BASE_INPUT);

    expect(result.info.quartiers_au).toHaveLength(2);
    // Premier centroïde ok
    expect(result.info.quartiers_au[0]).toEqual({ libelle: "1AUc", secteur: "Montrouge" });
    // Second centroïde a rejeté → secteur null
    expect(result.info.quartiers_au[1]).toEqual({ libelle: "2AUs", secteur: null });
    // Le composite ne throw pas malgré l'échec partiel
    expect(result.couverture.permis).toBe("ok");
    expect(result.couverture.zones_au).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // (B3) Garde structurelle : note = VOLUME uniquement, jamais de clé « prix »
  // -------------------------------------------------------------------------

  it("(B3) note ne contient AUCUNE clé prix-like (contrat note=VOLUME, prix→info)", async () => {
    vi.mocked(geocodeModule.reverseGeocode)
      .mockResolvedValueOnce(REV_GEO_OK)
      .mockResolvedValueOnce(REV_GEO_CENTROID_AUC)
      .mockResolvedValueOnce(REV_GEO_CENTROID_AUS);
    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue(PERMITS_OK);
    vi.mocked(pluModule.getZonesAU).mockResolvedValue(ZONES_OK);
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue(DVF_ROWS);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);

    const priceLike = /prix|price|cout|euro|m2/i;
    const offending = Object.keys(result.note).filter((k) => priceLike.test(k));
    expect(offending).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // (B4) computeSignal — couverture des branches (seuils réels lus du code)
  //   permisAvailable : logAuth>=100 || zonesImm>=3 → fort ;
  //                     logAuth>=30  || zonesImm>=1 → modéré ; sinon faible.
  //   permis indispo  : zonesImm>=3 → fort ; zonesImm>=1 → modéré ; sinon faible.
  // -------------------------------------------------------------------------

  it("(B4) logAuth=50, zones_au_immediates=0 → signal 'modéré' (30<=50<100, aucune AUc)", async () => {
    vi.mocked(geocodeModule.reverseGeocode).mockResolvedValueOnce(REV_GEO_OK);
    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue({
      ...PERMITS_OK,
      logements_autorises_recent: 50,
    });
    // Aucune zone AUc → zones_au_immediates = 0
    vi.mocked(pluModule.getZonesAU).mockResolvedValue({
      couverture: "ok",
      n_zones_au: 0,
      zones_au: [],
      geojson: { type: "FeatureCollection", features: [] },
    });
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue([]);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);
    expect(result.note.zones_au_immediates).toBe(0);
    expect(result.note.signal).toBe("modéré");
  });

  it("(B4) logAuth=29, zones_au_immediates=0 → signal 'faible' (29<30, aucune AUc)", async () => {
    vi.mocked(geocodeModule.reverseGeocode).mockResolvedValueOnce(REV_GEO_OK);
    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue({
      ...PERMITS_OK,
      logements_autorises_recent: 29,
    });
    vi.mocked(pluModule.getZonesAU).mockResolvedValue({
      couverture: "ok",
      n_zones_au: 0,
      zones_au: [],
      geojson: { type: "FeatureCollection", features: [] },
    });
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue([]);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);
    expect(result.note.zones_au_immediates).toBe(0);
    expect(result.note.signal).toBe("faible");
  });

  it("(B4) permis indisponible + 3 zones AUc → signal 'fort' (fallback zones-only)", async () => {
    vi.mocked(geocodeModule.reverseGeocode).mockResolvedValue(REV_GEO_OK);
    // permis throws → section indisponible → permisAvailable=false
    vi.mocked(sitadelModule.permitsForCommune).mockRejectedValue(new Error("sitadel down"));
    const aucFeature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { typezone: "AUc", libelle: "AUc", libelong: null },
    };
    vi.mocked(pluModule.getZonesAU).mockResolvedValue({
      couverture: "ok",
      n_zones_au: 3,
      zones_au: [
        { typezone: "AUc", libelle: "1AUc", libelong: null, feature: aucFeature },
        { typezone: "AUc", libelle: "2AUc", libelong: null, feature: aucFeature },
        { typezone: "AUc", libelle: "3AUc", libelong: null, feature: aucFeature },
      ],
      geojson: { type: "FeatureCollection", features: [aucFeature, aucFeature, aucFeature] },
    });
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue([]);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);
    expect(result.couverture.permis).toMatch(/indisponible/);
    expect(result.note.zones_au_immediates).toBe(3);
    expect(result.note.signal).toBe("fort");
  });

  // -------------------------------------------------------------------------
  // (B6) featureCentroid null path : feature sans géométrie → secteur null,
  //      reverseGeocode N'EST PAS appelé pour cette zone (pas de centroïde).
  // -------------------------------------------------------------------------

  it("(B6) zone avec geometry:null → secteur null ET reverseGeocode non appelé pour la zone", async () => {
    const FEATURE_NO_GEOM = {
      type: "Feature",
      geometry: null,
      properties: { typezone: "AUc", libelle: "1AUc", libelong: null },
    };
    const rgSpy = vi
      .mocked(geocodeModule.reverseGeocode)
      // Seul l'ancrage est résolu ; aucun appel centroïde attendu.
      .mockResolvedValueOnce(REV_GEO_OK);
    vi.mocked(sitadelModule.permitsForCommune).mockResolvedValue(PERMITS_OK);
    vi.mocked(pluModule.getZonesAU).mockResolvedValue({
      couverture: "ok",
      n_zones_au: 1,
      zones_au: [{ typezone: "AUc", libelle: "1AUc", libelong: null, feature: FEATURE_NO_GEOM }],
      geojson: { type: "FeatureCollection", features: [FEATURE_NO_GEOM] },
    });
    vi.mocked(dvfModule.dvfInRadius).mockResolvedValue([]);
    vi.mocked(dvfModule.aggregatePrix).mockReturnValue(AGG_OK);

    const result = await dynamiqueImmobiliere(BASE_INPUT);

    expect(result.info.quartiers_au).toHaveLength(1);
    expect(result.info.quartiers_au[0]).toEqual({ libelle: "1AUc", secteur: null });
    // reverseGeocode appelé UNE seule fois (ancrage) — pas pour le centroïde sans géométrie
    expect(rgSpy).toHaveBeenCalledTimes(1);
  });
});
