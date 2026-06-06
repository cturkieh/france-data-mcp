/**
 * Composite `dynamique_immobiliere` — intelligence foncière et immobilière
 * sur un rayon géographique.
 *
 * Orchestre 3 briques leaf (Sit@del permis · Apicarto PLU · DVF foncier) et
 * retourne un résultat à 2 registres :
 *   - `note`  = données de VOLUME → alimente le scoring LLM
 *   - `info`  = contexte / localisation (quartiers AU, prix) → n'alimente PAS le score
 *
 * Doctrine de dégradation (identique à panorama_implantation) :
 *   - Échec géocodage inverse → rejet total (pas de commune → rien n'est calculable)
 *   - Échec d'une section → `couverture.<section>` = "indisponible:<raison>",
 *     le reste du résultat est préservé.
 */

import { type SectionStatus, runSection } from "../sante/panorama-implantation.js";
import { reverseGeocode } from "../territoire/geocode.js";
import { getZonesAU } from "./apicarto-plu.js";
import { aggregatePrix, dvfInRadius } from "./dvf.js";
import { permitsForCommune } from "./sitadel.js";

const LOG_TAG = "[france-data-mcp] dynamique_immobiliere";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DynamiqueImmobiliereInput {
  lat: number;
  lon: number;
  rayon_km: number;
}

export interface DynamiqueImmobiliereNote {
  /** Logements autorisés sur la fenêtre Sit@del (5 ans). */
  logements_autorises_recent: number;
  /** Logements commencés sur la fenêtre Sit@del (5 ans). */
  logements_commences_recent: number;
  /** Nombre total de zones AU dans le rayon. */
  zones_au_nombre: number;
  /** Zones AU « ouvertes » (typezone upper commence par "AUC"). */
  zones_au_immediates: number;
  /** Surface totale des zones AU en hectares, ou null si non calculable. */
  zones_au_surface_ha: number | null;
  /** Signal synthétique fondé sur le volume. */
  signal: "fort" | "modéré" | "faible";
}

export interface DynamiqueImmobiliereInfo {
  /** Estimation habitants attendus (permis × 2,2). */
  habitants_attendus: number;
  /** Jusqu'à 5 zones AU avec libellé et secteur (null si centroïde non géocodable). */
  quartiers_au: { libelle: string; secteur: string | null }[];
  /** Prix médian m² des ventes bâties DVF dans le rayon, ou null si absent. */
  prix_m2_median: number | null;
  /** Ventes de terrains (surface_terrain > 0). */
  terrains: { n: number; prix_terrain_median: number | null };
}

export interface DynamiqueImmobiliereResult {
  meta: {
    code_commune: string;
    commune: string;
    lat: number;
    lon: number;
    rayon_km: number;
  };
  couverture: {
    permis: SectionStatus;
    zones_au: SectionStatus;
    terrains: SectionStatus;
  };
  note: DynamiqueImmobiliereNote;
  info: DynamiqueImmobiliereInfo;
  geojson: { type: "FeatureCollection"; features: unknown[] };
}

// ---------------------------------------------------------------------------
// Centroid helper
// ---------------------------------------------------------------------------

/**
 * Calcule le centroïde d'une feature GeoJSON (Polygon ou MultiPolygon) en
 * aplatissant toutes les coordonnées et en moyennant [lon, lat].
 * Retourne null si aucune coordonnée exploitable n'est trouvée.
 */
function featureCentroid(feature: unknown): { lat: number; lon: number } | null {
  const geom = (feature as { geometry?: unknown })?.geometry;
  if (!geom || typeof geom !== "object") return null;

  const g = geom as { type?: unknown; coordinates?: unknown };
  const coords = g.coordinates;
  if (!Array.isArray(coords)) return null;

  // Flatten récursif jusqu'aux paires [lon, lat] (number[])
  const pairs: [number, number][] = [];

  function flatten(node: unknown): void {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      pairs.push([node[0] as number, node[1] as number]);
      return;
    }
    for (const child of node) {
      flatten(child);
    }
  }

  flatten(coords);
  if (pairs.length === 0) return null;

  let sumLon = 0;
  let sumLat = 0;
  for (const [pLon, pLat] of pairs) {
    sumLon += pLon;
    sumLat += pLat;
  }
  return { lon: sumLon / pairs.length, lat: sumLat / pairs.length };
}

// ---------------------------------------------------------------------------
// Signal heuristic
// ---------------------------------------------------------------------------

function computeSignal(
  logAuth: number,
  zonesImm: number,
  permisAvailable: boolean,
): "fort" | "modéré" | "faible" {
  if (permisAvailable) {
    if (logAuth >= 100 || zonesImm >= 3) return "fort";
    if (logAuth >= 30 || zonesImm >= 1) return "modéré";
    return "faible";
  }
  // Permis indisponible : signal uniquement sur les zones
  if (zonesImm >= 3) return "fort";
  if (zonesImm >= 1) return "modéré";
  return "faible";
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export async function dynamiqueImmobiliere(
  input: DynamiqueImmobiliereInput,
): Promise<DynamiqueImmobiliereResult> {
  const { lat, lon, rayon_km } = input;

  // Géocodage inverse : commune requise (code_commune pour Sit@del, label pour meta)
  const revGeo = await reverseGeocode({ lat, lon });
  if (!revGeo) {
    throw new Error(
      `${LOG_TAG}: géocodage inverse sans résultat (${lat},${lon}) — commune introuvable, impossible de continuer`,
    );
  }
  const code_commune = revGeo.codeCommune ?? "";
  if (!code_commune) {
    throw new Error(
      `${LOG_TAG}: géocodage inverse OK mais codeCommune absent (${lat},${lon}, label="${revGeo.label}")`,
    );
  }
  const commune = revGeo.commune ?? revGeo.label;

  // --- 3 sections en parallèle -------------------------------------------
  const [permisOut, zonesOut, dvfOut] = await Promise.all([
    runSection("permis", () => permitsForCommune(code_commune)),
    runSection("zones_au", () => getZonesAU(lat, lon, { radiusKm: rayon_km })),
    runSection("terrains", () => dvfInRadius(lat, lon, rayon_km)),
  ]);

  // --- Couverture ---------------------------------------------------------
  const couverture = {
    permis: permisOut.status,
    zones_au: zonesOut.status,
    terrains: dvfOut.status,
  };

  // --- Permis -------------------------------------------------------------
  const permisData = permisOut.data;
  const logAuth = permisData?.logements_autorises_recent ?? 0;
  const logCom = permisData?.logements_commences_recent ?? 0;
  const habitantsAttendus = permisData?.habitants_attendus ?? 0;
  const permisAvailable = permisOut.status === "ok";

  // --- PLU zones AU -------------------------------------------------------
  const zonesData = zonesOut.data;
  const auFeatures: unknown[] = zonesData?.geojson.features ?? [];
  const zonesNombre = zonesData?.n_zones_au ?? 0;

  // zones_au_immediates : typezone upper starts with "AUC"
  const zonesImm = (zonesData?.zones_au ?? []).filter((z) =>
    z.typezone.toUpperCase().startsWith("AUC"),
  ).length;

  // --- Quartiers AU (centroïde + reverse-geocode, ≤ 5) --------------------
  const topFeatures = auFeatures.slice(0, 5);
  const auLibelles = (zonesData?.zones_au ?? []).slice(0, 5).map((z) => z.libelle);

  const centroidsResults = await Promise.allSettled(
    topFeatures.map(async (feat, i) => {
      const centroid = featureCentroid(feat);
      if (!centroid) return { libelle: auLibelles[i] ?? "", secteur: null };
      const rg = await reverseGeocode({ lat: centroid.lat, lon: centroid.lon });
      const secteur = rg ? (rg.commune ?? rg.label) : null;
      return { libelle: auLibelles[i] ?? "", secteur };
    }),
  );

  const quartiersAu = centroidsResults.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    // Reverse-geocode du centroïde a échoué → secteur null
    console.warn(`${LOG_TAG}: reverse-geocode centroïde AU[${i}] échoué — secteur:null`);
    return { libelle: auLibelles[i] ?? "", secteur: null };
  });

  // --- DVF foncier --------------------------------------------------------
  const dvfRows = dvfOut.data ?? [];
  const agg = aggregatePrix(dvfRows);
  // n_terrains comes directly from aggregatePrix — no redundant re-filter
  const terrainsInfo = {
    n: agg.n_terrains,
    prix_terrain_median: agg.prix_terrain_median,
  };

  // --- Signal + result ---------------------------------------------------
  const signal = computeSignal(logAuth, zonesImm, permisAvailable);

  return {
    meta: { code_commune, commune, lat, lon, rayon_km },
    couverture,
    note: {
      logements_autorises_recent: logAuth,
      logements_commences_recent: logCom,
      zones_au_nombre: zonesNombre,
      zones_au_immediates: zonesImm,
      zones_au_surface_ha: null, // no external area lib available
      signal,
    },
    info: {
      habitants_attendus: habitantsAttendus,
      quartiers_au: quartiersAu,
      prix_m2_median: agg.prix_m2_median,
      terrains: terrainsInfo,
    },
    geojson: { type: "FeatureCollection", features: auFeatures },
  };
}
