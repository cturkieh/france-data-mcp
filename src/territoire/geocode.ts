/**
 * Géocodage d'adresse via la Géoplateforme IGN (data.geopf.fr).
 *
 * URL nouvelle (depuis 2025) : `https://data.geopf.fr/geocodage/search/`
 * URL ancienne (api-adresse.data.gouv.fr) : décommissionnée en 2026.
 *
 * Sources : BAN + BD TOPO + Parcellaire Express.
 * Rate limit : 50 req/s/IP en mode unitaire. Pas de clé API.
 *
 * Doc : https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage
 */

import { fetchJson } from "../core/http.js";
import { clamp } from "../core/numbers.js";
import { pickDefined } from "../core/object-utils.js";
import type { Coordinates } from "../core/types.js";

const BASE_URL = "https://data.geopf.fr/geocodage";

export type GeocodeResult = {
  /** Coordonnées GPS (WGS84) */
  point: Coordinates;
  /** Adresse normalisée renvoyée par l'IGN */
  label: string;
  /** Score de confiance (0-1). >= 0.8 = bon match, < 0.5 = douteux. */
  score: number;
  /** Code postal */
  codePostal?: string;
  /** Code INSEE de la commune */
  codeCommune?: string;
  /** Nom de la commune */
  commune?: string;
  /**
   * Type de match :
   *  - "housenumber" : adresse au numéro (la plus précise)
   *  - "street" : voie sans numéro
   *  - "locality" : lieu-dit
   *  - "municipality" : commune
   */
  type: "housenumber" | "street" | "locality" | "municipality" | (string & {});
};

export type GeocodeOptions = {
  /** Limiter au code postal (utile pour désambiguïser) */
  codePostal?: string;
  /** Limiter au code INSEE de commune */
  codeCommune?: string;
  /** Limiter le type de résultat */
  type?: GeocodeResult["type"];
  /** Nombre max de résultats (défaut 1) */
  limit?: number;
  signal?: AbortSignal;
};

type ApiFeature = {
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    label: string;
    score: number;
    type: string;
    postcode?: string;
    citycode?: string;
    city?: string;
  };
};

type ApiResponse = {
  type: "FeatureCollection";
  features: ApiFeature[];
};

/** Seuil sous lequel on considère qu'un match géocodage est très incertain. */
const LOW_SCORE_THRESHOLD = 0.5;

/**
 * Géocode une adresse en coordonnées GPS.
 * Renvoie `null` si aucun résultat n'est trouvé.
 *
 * Si le meilleur match a un score < 0.5, on émet un `console.warn` parce qu'un
 * faux match plausible est plus dangereux qu'un null (le caller risque
 * d'utiliser des coordonnées qui pointent vers une autre commune).
 *
 * @example
 * ```ts
 * const point = await geocode("64 Cours Aristide Briand 08000 Charleville-Mézières");
 * // → { point: { lon: 4.7192, lat: 49.7672 }, label: "...", score: 0.97, type: "housenumber" }
 * ```
 */
export async function geocode(
  address: string,
  options: GeocodeOptions = {},
): Promise<GeocodeResult | null> {
  const results = await geocodeMany(address, { ...options, limit: 1 });
  const top = results[0];
  if (!top) return null;
  if (top.score < LOW_SCORE_THRESHOLD) {
    console.warn(
      `[france-data-mcp] geocode("${address}"): score ${top.score.toFixed(2)} < ${LOW_SCORE_THRESHOLD} — résultat très incertain (label retourné: "${top.label}").`,
    );
  }
  return top;
}

/**
 * Géocode une adresse et renvoie plusieurs candidats triés par score décroissant.
 */
export async function geocodeMany(
  address: string,
  options: GeocodeOptions = {},
): Promise<GeocodeResult[]> {
  const { codePostal, codeCommune, type, limit = 5, signal } = options;

  const params = new URLSearchParams({ q: address });
  params.set("limit", String(clamp(limit, 1, 20)));
  if (codePostal) params.set("postcode", codePostal);
  if (codeCommune) params.set("citycode", codeCommune);
  if (type) params.set("type", type);

  const url = `${BASE_URL}/search/?${params.toString()}`;
  const data = await fetchJson<ApiResponse>(url, { signal });

  return data.features.map(toGeocodeResult);
}

/**
 * Géocodage inverse : à partir de coordonnées GPS, retrouve l'adresse la plus proche.
 */
export async function reverseGeocode(
  point: Coordinates,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    lon: String(point.lon),
    lat: String(point.lat),
  });
  const url = `${BASE_URL}/reverse/?${params.toString()}`;
  const data = await fetchJson<ApiResponse>(url, { signal });
  const feature = data.features[0];
  return feature ? toGeocodeResult(feature) : null;
}

function toGeocodeResult(feature: ApiFeature): GeocodeResult {
  const [lon, lat] = feature.geometry.coordinates;
  return {
    point: { lon, lat },
    label: feature.properties.label,
    score: feature.properties.score,
    type: feature.properties.type,
    ...pickDefined({
      codePostal: feature.properties.postcode,
      codeCommune: feature.properties.citycode,
      commune: feature.properties.city,
    }),
  };
}
