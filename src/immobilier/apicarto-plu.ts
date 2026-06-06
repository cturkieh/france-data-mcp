/**
 * Zonage PLU via l'API Apicarto IGN — Géoportail de l'Urbanisme.
 *
 * Endpoint : https://apicarto.ign.fr/api/gpu/zone-urba?geom=<GeoJSON Point URL-encoded>
 * Pas de clé API. Pas d'ingestion : chaque appel interroge l'API en direct.
 *
 * Doc : https://apicarto.ign.fr/api/doc/gpu
 *
 * Zones AU = terrains à urbaniser (future urbanisation) → signal immobilier.
 * Commune sans PLU dématérialisé (RNU) → features[] vide → couverture "indisponible:no_plu".
 *
 * ⚠️ Le `typezone` CNIG/GPU pour « à urbaniser » N'EST PAS la chaîne nue "AU" :
 * c'est "AUc" (ouverte/immédiate) ou "AUs" (stricte/différée), et le `libelle`
 * peut être "1AU", "2AUc", "1AUz"… Un filtre strict `=== "AU"` comptait 0 AU
 * partout (cas réel Cherbourg : 38 AU — 19 AUc + 19 AUs — comptées 0). On teste
 * donc par PRÉFIXE insensible à la casse sur `typezone` (catch AU/AUc/AUs +
 * variantes futures), tout en excluant U / A / N.
 */

import { fetchJson } from "../core/http.js";
import type { RateLimitOptions } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZoneUrbaFeature = {
  type: "Feature";
  geometry: unknown;
  properties: {
    typezone: string;
    libelle: string;
    libelong: string | null;
    [key: string]: unknown;
  };
};

type ZoneUrbaResponse = {
  type: "FeatureCollection";
  features: ZoneUrbaFeature[];
};

export type ZonesAUResult = {
  /** "ok" = PLU présent (même si aucune zone AU à cet endroit). "indisponible:no_plu" = pas de PLU dématérialisé. */
  couverture: "ok" | "indisponible:no_plu";
  n_zones_au: number;
  zones_au: { libelle: string; libelong: string | null; typezone: string }[];
  /** GeoJSON FeatureCollection contenant uniquement les features AU (pour couche carto). */
  geojson: { type: "FeatureCollection"; features: unknown[] };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://apicarto.ign.fr/api/gpu/zone-urba";

/**
 * Une feature est une zone « à urbaniser » si son `typezone` commence par "AU"
 * (insensible à la casse) : couvre "AU", "AUc" (ouverte), "AUs" (stricte) et
 * toute variante future. `typezone` peut être absent/non-string sur une feature
 * dégradée (pas de validation Zod côté `fetchJson`) → coercition défensive en
 * chaîne avant le test, sinon `undefined.toUpperCase()` planterait.
 */
function isZoneAU(typezone: unknown): boolean {
  return String(typezone ?? "")
    .toUpperCase()
    .startsWith("AU");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Construit un GeoJSON Polygon bbox autour d'un point.
 * Offsets en degrés : dLat = radiusKm/111, dLon = radiusKm/(111*cos(lat)).
 */
function bboxPolygon(lat: number, lon: number, radiusKm: number): object {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  const minLon = lon - dLon;
  const maxLon = lon + dLon;
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

/**
 * Retourne les zones AU (à urbaniser) au niveau d'un point géographique ou
 * dans un rayon donné.
 *
 * @param lat - Latitude WGS84
 * @param lon - Longitude WGS84
 * @param opts.radiusKm - Si fourni, interroge apicarto sur un bbox Polygon
 *   (zones intersectant la zone) plutôt que sur le Point seul.
 *
 * Comportement :
 * - features[] vide → commune sans PLU dématérialisé (RNU) : couverture "indisponible:no_plu"
 * - features présentes mais aucune typezone=AU → couverture "ok", n_zones_au=0
 * - erreur réseau/HTTP → console.warn + re-throw (le composite caller gère la dégradation)
 *
 * @param options - Options HTTP transmises à `fetchJson` (signal d'annulation,
 *   baseDelayMs pour les tests, etc.) + `radiusKm` pour mode zone.
 */
export async function getZonesAU(
  lat: number,
  lon: number,
  options?: RateLimitOptions & { signal?: AbortSignal; radiusKm?: number },
): Promise<ZonesAUResult> {
  const geomObj =
    options?.radiusKm !== undefined
      ? bboxPolygon(lat, lon, options.radiusKm)
      : { type: "Point", coordinates: [lon, lat] };
  const geom = encodeURIComponent(JSON.stringify(geomObj));
  const url = `${BASE_URL}?geom=${geom}`;

  let data: ZoneUrbaResponse;
  try {
    data = await fetchJson<ZoneUrbaResponse>(url, options);
  } catch (err) {
    console.warn(
      `[france-data-mcp] apicarto-plu: erreur lors de l'appel GPU (${lat},${lon}): ${(err as Error).message}`,
    );
    throw err;
  }

  // Commune sans PLU dématérialisé (RNU) → features vide
  if (data.features.length === 0) {
    return {
      couverture: "indisponible:no_plu",
      n_zones_au: 0,
      zones_au: [],
      geojson: { type: "FeatureCollection", features: [] },
    };
  }

  // PLU présent : filtrer les zones AU (préfixe insensible casse — cf. isZoneAU)
  const auFeatures = data.features.filter((f) => isZoneAU(f.properties.typezone));

  return {
    couverture: "ok",
    n_zones_au: auFeatures.length,
    zones_au: auFeatures.map((f) => ({
      typezone: f.properties.typezone,
      libelle: f.properties.libelle,
      libelong: f.properties.libelong,
    })),
    geojson: {
      type: "FeatureCollection",
      features: auFeatures,
    },
  };
}
