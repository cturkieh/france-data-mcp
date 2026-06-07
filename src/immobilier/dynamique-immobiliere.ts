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
 *   - Résolution commune en 2 temps : reverse-geocode d'ADRESSE (IGN), puis en
 *     FALLBACK les frontières communales (`communeContainingPoint`, point-dans-
 *     polygone). Un site isolé / littoral (ex. Orano/La Hague) sans adresse proche
 *     est ainsi rattaché à SA commune → ses permis Sit@del restent servis. Si les
 *     DEUX échouent (point réellement en mer / hors France) → SEULE la section
 *     `permis` est dégradée (`indisponible:commune_introuvable`). La commune ne
 *     sert QU'AUX permis Sit@del (maille commune) ; les zones AU (apicarto) et les
 *     terrains (DVF) sont calculés PAR RAYON (lat/lon) → ils restent servis dans
 *     tous les cas. L'outil NE doit JAMAIS échouer en entier (régression prouvée :
 *     -32602 sur tout l'appel pour un point côtier).
 *   - Échec d'une section → `couverture.<section>` = "indisponible:<raison>",
 *     le reste du résultat est préservé.
 */

import {
  type SectionOutcome,
  type SectionStatus,
  runSection,
} from "../sante/panorama-implantation.js";
import { communeContainingPoint, reverseGeocode } from "../territoire/geocode.js";
import { getZonesAU } from "./apicarto-plu.js";
import { aggregatePrix, dvfInRadius } from "./dvf.js";
import { type PermitsResult, permitsForCommune } from "./sitadel.js";

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
  /**
   * Zones AU « ouvertes » (typezone upper commence par "AUC").
   * Note : les zones purement `AU` (sans suffixe) sont comptées dans
   * `zones_au_nombre` mais PAS ici — seules les `AUc` (ouverte /
   * immédiatement urbanisable) alimentent ce compteur.
   */
  zones_au_immediates: number;
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
    /** `null` si le point n'est rattaché à aucune commune (côtier/isolé) — cf. couverture.permis. */
    code_commune: string | null;
    /** `null` si le point n'est rattaché à aucune commune (côtier/isolé). */
    commune: string | null;
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

/**
 * Libellé de commune d'un reverse-geocode : `commune` si présent, sinon le
 * `label` complet, sinon `null` (point hors couverture). Factorisé : utilisé
 * pour l'ancrage ET pour le secteur de chaque quartier AU.
 */
function communeLabel(rg: { commune?: string; label: string } | null): string | null {
  return rg ? (rg.commune ?? rg.label) : null;
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

  // Géocodage inverse : la commune ne sert QU'AUX permis Sit@del (maille
  // commune). Un point sans commune (côtier/isolé : reverseGeocode null en mer,
  // ou codeCommune absent) NE doit PAS faire échouer tout l'outil — zones AU et
  // terrains sont par rayon. On dégrade alors `permis` et on continue (régression
  // prouvée : un point côtier rendait l'appel entier en -32602, card + carte vides).
  const revGeo = await reverseGeocode({ lat, lon });
  // `|| null` (pas `??`) : un codeCommune "" est aussi inexploitable que absent.
  let code_commune = revGeo?.codeCommune || null;
  let commune = communeLabel(revGeo);

  // FALLBACK frontières : le reverse d'ADRESSE échoue sur un point sans adresse
  // proche (site industriel isolé, littoral — ex. Orano/La Hague) ALORS que le
  // point appartient bien à une commune. On la résout par point-dans-polygone
  // (`communeContainingPoint`) → les permis Sit@del redeviennent disponibles.
  // Best-effort fail-safe (null si service down OU point réellement en mer) → la
  // dégradation `permis` ci-dessous reste le filet. N'allonge le chemin (1 appel
  // réseau de plus) QUE sur l'échec d'ancrage adresse (rare).
  if (!code_commune) {
    const byBoundary = await communeContainingPoint({ lat, lon });
    if (byBoundary) {
      code_commune = byBoundary.codeCommune;
      commune = byBoundary.commune;
      console.warn(
        `${LOG_TAG}: commune résolue par frontières (${byBoundary.commune} ${byBoundary.codeCommune}) après reverse-geocode adresse sans résultat (${lat},${lon}) — permis servis.`,
      );
    }
  }

  if (!code_commune) {
    const detail = revGeo
      ? `géocodage inverse OK mais codeCommune absent (label="${revGeo.label}")`
      : "géocodage inverse sans résultat";
    console.warn(
      `${LOG_TAG}: ${detail} (${lat},${lon}) — frontières aussi sans commune (point en mer / hors France) ; section 'permis' indisponible:commune_introuvable, zones_au + terrains servis par rayon`,
    );
  }

  // --- 3 sections en parallèle (permis seulement si la commune est connue) -
  // Pas de commune → outcome pré-dégradé (jamais appelé), aligné sur le contrat
  // SectionOutcome des deux autres sections — le LLM lit `couverture.permis`.
  const permisSection: Promise<SectionOutcome<PermitsResult>> = code_commune
    ? runSection("permis", () => permitsForCommune(code_commune))
    : Promise.resolve({ data: null, status: "indisponible:commune_introuvable" });

  const [permisOut, zonesOut, dvfOut] = await Promise.all([
    permisSection,
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
  const zonesNombre = zonesData?.n_zones_au ?? 0;

  // zones_au_immediates : seules les zones AUc (ouverte / immédiatement urbanisable)
  // sont comptées. Les zones bare `AU` figurent dans zones_au_nombre mais PAS ici
  // (délibérément, cohérent avec la doctrine PLU : AU strict ≠ constructible immédiatement).
  const zonesImm = (zonesData?.zones_au ?? []).filter((z) =>
    z.typezone.toUpperCase().startsWith("AUC"),
  ).length;

  // --- Quartiers AU (centroïde + reverse-geocode, ≤ 5) --------------------
  // Each zone entry carries its own feature (single source of truth — no parallel-array index).
  const topZones = (zonesData?.zones_au ?? []).slice(0, 5);

  const centroidsResults = await Promise.allSettled(
    topZones.map(async (zone) => {
      const centroid = featureCentroid(zone.feature);
      if (!centroid) return { libelle: zone.libelle, secteur: null };
      const rg = await reverseGeocode({ lat: centroid.lat, lon: centroid.lon });
      // rg === null means coords outside IGN coverage (e.g. centroid in sea) — log + null
      if (!rg) {
        console.warn(
          `${LOG_TAG}: reverse-geocode centroïde AU "${zone.libelle}" hors couverture IGN — secteur:null`,
        );
      }
      const secteur = communeLabel(rg);
      return { libelle: zone.libelle, secteur };
    }),
  );

  const quartiersAu = centroidsResults.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    // Reverse-geocode du centroïde a rejeté (erreur réseau) → secteur null
    console.warn(`${LOG_TAG}: reverse-geocode centroïde AU[${i}] échoué — secteur:null`);
    return { libelle: topZones[i]?.libelle ?? "", secteur: null };
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
      signal,
    },
    info: {
      habitants_attendus: habitantsAttendus,
      quartiers_au: quartiersAu,
      prix_m2_median: agg.prix_m2_median,
      terrains: terrainsInfo,
    },
    geojson: {
      type: "FeatureCollection",
      features: (zonesData?.zones_au ?? []).map((z) => z.feature),
    },
  };
}
