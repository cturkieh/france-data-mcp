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

import { parseCoordinates } from "../core/coords.js";
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
  /**
   * `true` si `score < 0.5` : match très incertain (souvent un fallback
   * rue/commune sans rapport avec l'adresse demandée). Le caller ne doit PAS
   * utiliser `point` pour une décision quand ce flag est `true`.
   */
  confidence_low: boolean;
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
    /**
     * Optionnel à l'exécution : `fetchJson` ne valide pas le payload IGN
     * (pas de Zod). Une feature dégradée peut ne pas porter de `score` — le
     * traiter comme absent plutôt que faire confiance au type compilé.
     */
    score?: number;
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

  return usableGeocodeResults(data.features, `q="${address}"`);
}

/**
 * Mappe les features IGN en résultats exploitables (coords valides). Émet un
 * warn AGRÉGÉ si l'IGN a renvoyé des features mais qu'AUCUNE n'est exploitable
 * : sans ça un retour vide serait indistinguable côté caller de « adresse
 * introuvable », alors que c'est une anomalie payload IGN à remonter (le
 * caller — ex. coverage.ts — attribuerait à tort le vide aux coordonnées).
 */
function usableGeocodeResults(features: ApiFeature[], context: string): GeocodeResult[] {
  const results = features.map(toGeocodeResult).filter((r): r is GeocodeResult => r !== null);
  if (features.length > 0 && results.length === 0) {
    console.warn(
      `[france-data-mcp] geocode (${context}): IGN a renvoyé ${features.length} feature(s) mais toutes inexploitables — résultat vide ≠ « adresse introuvable », anomalie payload IGN.`,
    );
  }
  return results;
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
  // Premier résultat exploitable : une 1re feature au payload dégradé
  // (coords absentes) ne doit pas masquer un candidat valide en position 2+.
  const results = usableGeocodeResults(data.features, `reverse ${point.lon},${point.lat}`);
  return results[0] ?? null;
}

/**
 * Convertit une feature IGN en `GeocodeResult`, ou `null` si la feature est
 * inexploitable. `fetchJson` ne valide pas le payload (pas de Zod) : une
 * feature dégradée peut ne pas porter de `coordinates` numériques finies.
 * Sans ce garde-fou, `const [lon, lat] = coordinates` propagerait `undefined`
 * dans `point` silencieusement (même anti-pattern que le score, fix B1). Une
 * feature sans coords n'est pas "pas de résultat" : on warn + on l'écarte.
 */
function toGeocodeResult(feature: ApiFeature): GeocodeResult | null {
  const coords = feature.geometry?.coordinates;
  // `parseCoordinates` (helper partagé FINESS/DINUM/IGN) rejette
  // null/undefined/NaN/non-finite → undefined. Le check `Array` en amont
  // garde contre un `coordinates` primitif non-indexable (ex. number) sur
  // lequel `coords[0]` serait silencieusement undefined.
  const point = Array.isArray(coords) ? parseCoordinates(coords[0], coords[1]) : undefined;
  if (!point) {
    console.warn(
      `[france-data-mcp] geocode: feature sans coordonnées exploitables (label: "${feature.properties?.label ?? "<absent>"}", type: "${feature.properties?.type ?? "<absent>"}") — feature ignorée.`,
    );
    return null;
  }
  const rawScore = feature.properties.score;
  const scoreValid = typeof rawScore === "number" && Number.isFinite(rawScore);
  if (!scoreValid) {
    // Score absent/NaN = anomalie payload IGN, pas "pas de résultat". Sans ce
    // garde-fou, `undefined < 0.5` → false → un match douteux serait présenté
    // comme fiable silencieusement (faux négatif le plus dangereux ici).
    console.warn(
      `[france-data-mcp] geocode: feature sans score numérique exploitable (label: "${feature.properties.label}", type: "${feature.properties.type}") — confidence_low forcé à true par prudence.`,
    );
  }
  return {
    point,
    label: feature.properties.label,
    score: scoreValid ? rawScore : 0,
    confidence_low: scoreValid ? rawScore < LOW_SCORE_THRESHOLD : true,
    type: feature.properties.type,
    ...pickDefined({
      codePostal: feature.properties.postcode,
      codeCommune: feature.properties.citycode,
      commune: feature.properties.city,
    }),
  };
}
