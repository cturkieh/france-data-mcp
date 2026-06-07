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
import { diceCoefficient, normalizeForCompare } from "../core/text-match.js";
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
   * `true` si `score` est sous le seuil PROPRE AU TYPE de match (housenumber
   * 0.7, street/locality 0.6, municipality/inconnu 0.5). Un seuil global
   * unique (0.5) laissait passer des faux `housenumber` plausibles : l'IGN
   * substitue une autre voie avec un score ~0.55-0.65 qui paraissait fiable.
   * Le caller ne doit PAS utiliser `point` pour une décision quand `true`.
   */
  confidence_low: boolean;
  /**
   * `true` si le libellé IGN retourné diverge significativement de l'adresse
   * demandée (Dice < 0.7 sur libellés normalisés). Signal complémentaire et
   * transparent à `confidence_low` : capte le cas « score correct mais l'IGN
   * a répondu une AUTRE adresse » (ex. demandé "rue du Pré aux Bœufs",
   * retourné "Pavé Bleu"). Absent en géocodage inverse (pas d'adresse
   * demandée à comparer).
   *
   * CONSERVATEUR par construction : la comparaison est query brute vs label
   * IGN complet (voie+CP+ville). Un caller passant une adresse partielle
   * ("8 rue X" sans CP/ville) contre un label complet aura un Dice
   * mécaniquement bas → `match_partial:true` possiblement faux-positif. Le
   * sur-flag est volontaire (sur-prudence > faux match santé silencieux) :
   * traiter ce flag comme « à re-vérifier », pas comme « erreur certaine ».
   */
  match_partial?: boolean;
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

/**
 * Seuil `confidence_low` PAR TYPE de match IGN. Un `housenumber` à 0.6 est
 * douteux (l'IGN a souvent substitué une autre voie au même numéro), alors
 * qu'une `municipality` à 0.55 est un fallback commune normal et acceptable.
 * Un seuil global unique (ancien 0.5) ne pouvait pas exprimer ça → faux
 * `housenumber` plausibles présentés comme fiables (audit P2).
 */
const LOW_SCORE_THRESHOLD_BY_TYPE: Record<string, number> = {
  housenumber: 0.7,
  street: 0.6,
  locality: 0.6,
  municipality: 0.5,
};

/** Défaut prudent pour tout `type` IGN inattendu (jamais < garde commune). */
const DEFAULT_LOW_SCORE_THRESHOLD = 0.5;

function lowScoreThreshold(type: string): number {
  return LOW_SCORE_THRESHOLD_BY_TYPE[type] ?? DEFAULT_LOW_SCORE_THRESHOLD;
}

/** Sous ce Dice (libellé demandé vs retourné, normalisés), match partiel. */
const PARTIAL_MATCH_DICE_THRESHOLD = 0.7;

/**
 * Géocode une adresse en coordonnées GPS.
 * Renvoie `null` si aucun résultat n'est trouvé.
 *
 * Si le meilleur match est sous le seuil propre à son type (ou diverge du
 * libellé demandé), on émet un `console.warn` : un faux match plausible est
 * plus dangereux qu'un null (le caller risque d'utiliser des coordonnées qui
 * pointent vers une autre voie/commune).
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
  if (top.confidence_low || top.match_partial) {
    // Motif explicite : ne PAS afficher le seuil si l'alerte vient SEULEMENT
    // de match_partial (score au-dessus du seuil, mais libellé divergent) —
    // sinon le log suggère faussement un problème de scoring à l'opérateur.
    const reason = top.confidence_low
      ? `score ${top.score.toFixed(2)} < seuil ${lowScoreThreshold(top.type)} (type "${top.type}")`
      : `libellé IGN divergent de l'adresse demandée (match_partial)`;
    console.warn(
      `[france-data-mcp] geocode("${address}"): ${reason} — résultat incertain (label retourné: "${top.label}").`,
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

  return usableGeocodeResults(data.features, `q="${address}"`, address);
}

/**
 * Mappe les features IGN en résultats exploitables (coords valides). Émet un
 * warn AGRÉGÉ si l'IGN a renvoyé des features mais qu'AUCUNE n'est exploitable
 * : sans ça un retour vide serait indistinguable côté caller de « adresse
 * introuvable », alors que c'est une anomalie payload IGN à remonter (le
 * caller — ex. coverage.ts — attribuerait à tort le vide aux coordonnées).
 */
function usableGeocodeResults(
  features: ApiFeature[],
  context: string,
  requestedAddress?: string,
): GeocodeResult[] {
  const results = features
    .map((f) => toGeocodeResult(f, requestedAddress))
    .filter((r): r is GeocodeResult => r !== null);
  if (features.length > 0 && results.length === 0) {
    console.warn(
      `[france-data-mcp] geocode (${context}): IGN a renvoyé ${features.length} feature(s) mais toutes inexploitables — résultat vide ≠ « adresse introuvable », anomalie payload IGN.`,
    );
  }
  return results;
}

/**
 * Géocodage inverse : à partir de coordonnées GPS, retrouve l'adresse la plus
 * proche. Renvoie `null` si aucune adresse (couverture IGN = France
 * métropolitaine + DOM uniquement ; des coordonnées hors zone — ex. New York —
 * ou en pleine mer renvoient `null`, pas une erreur).
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
  // 0 feature en reverse = coordonnées hors couverture IGN (hors France) ou
  // en pleine mer. On warn pour l'observabilité serveur (parallèle au warn
  // agrégé de `usableGeocodeResults` pour les features inexploitables) :
  // sans ça, un `null` hors-zone est indistinguable côté logs d'un échec.
  if (data.features.length === 0) {
    console.warn(
      `[france-data-mcp] reverseGeocode(${point.lon},${point.lat}): 0 résultat IGN — coordonnées hors couverture (France métropolitaine + DOM) ou en mer. Retour null.`,
    );
    return null;
  }
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
 *
 * `requestedAddress` (absent en géocodage inverse) alimente `match_partial`
 * via Dice sur libellés normalisés : capte le « score correct mais l'IGN a
 * répondu une autre adresse » que le seul seuil de score ne voit pas.
 */
function toGeocodeResult(feature: ApiFeature, requestedAddress?: string): GeocodeResult | null {
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
  const type = feature.properties.type;
  const label = feature.properties.label;
  // Dice uniquement si une adresse a été demandée (forward geocode). En
  // inverse, le label EST la réponse — rien à comparer → match_partial omis.
  const matchPartial =
    requestedAddress !== undefined
      ? diceCoefficient(normalizeForCompare(requestedAddress), normalizeForCompare(label)) <
        PARTIAL_MATCH_DICE_THRESHOLD
      : undefined;
  return {
    point,
    label,
    score: scoreValid ? rawScore : 0,
    confidence_low: scoreValid ? rawScore < lowScoreThreshold(type) : true,
    type,
    // Spread conditionnel (pas `pickDefined`, typé string-only) : on expose
    // `match_partial:false` quand une adresse a été demandée ET matche bien
    // — l'absence du champ signifie "non évalué" (géocodage inverse), pas
    // "bon match". Distinction utile au caller.
    ...(matchPartial !== undefined ? { match_partial: matchPartial } : {}),
    ...pickDefined({
      codePostal: feature.properties.postcode,
      codeCommune: feature.properties.citycode,
      commune: feature.properties.city,
    }),
  };
}
