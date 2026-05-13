/**
 * INSEE Melodi — population de référence par commune / département.
 *
 * URL : https://api.insee.fr/melodi/data/DS_POPULATIONS_REFERENCE
 * Doc : https://portail-api.insee.fr (API "Melodi" du catalogue INSEE)
 *
 * Sans authentification, rate limit documenté 30 req/min (HTTP 429 au-delà).
 * `fetchJson` honore le header `retry-after`.
 *
 * Format réponse : SDMX-like JSON. Chaque observation = 1 mesure pour une zone
 * et une année. 3 mesures sont retournées par défaut pour une zone donnée :
 *  - PMUN (population municipale, base légale officielle — recommandée DREES)
 *  - PCAP (population comptée à part : résidences secondaires, étudiants, militaires)
 *  - PTOT (total = PMUN + PCAP)
 *
 * Plusieurs années sont retournées si dispos — on garde la plus récente.
 *
 * Format `GEO` Melodi : `[<MILLESIME>-]<TYPE>-<CODE>` où TYPE ∈ {COM, DEP, REG}.
 * Le préfixe millésime est optionnel : si absent, l'API utilise le découpage
 * géographique courant.
 */

import { HttpError, fetchJson } from "../core/http.js";
import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { isValidDept } from "./dept-codes.js";

const MELODI_BASE_URL = "https://api.insee.fr/melodi";
const POPULATION_DATASET = "DS_POPULATIONS_REFERENCE";
const SOURCE_LABEL = "INSEE Melodi (DS_POPULATIONS_REFERENCE)";

/** Niveaux géographiques exposés (commune, département, région, France entière). */
export type GeoLevel = "COM" | "DEP" | "REG" | "FRANCE";

/**
 * Code GEO Melodi pour la France entière (DOM inclus). `FRANCE-FM` existe
 * aussi pour la France Métropolitaine seule mais la méthodo DREES (densités
 * médicales nationales) inclut les DOM — on utilise donc `FRANCE-F`.
 */
const FRANCE_GEO_FILTER = "FRANCE-F";
const FRANCE_CODE_LABEL = "FRANCE";

export type PopulationData = {
  /** Code INSEE fourni en entrée (ex: "75056" commune Paris, "75" dept Paris). */
  codeInsee: string;
  geoLevel: GeoLevel;
  /** Année du recensement INSEE (TIME_PERIOD). */
  annee: number;
  /** Population municipale — base légale officielle, recommandée DREES. */
  populationMunicipale: number;
  /** Population comptée à part (résid. secondaires, étudiants, militaires). */
  populationComptageApart: number;
  /** Population totale = PMUN + PCAP. */
  populationTotale: number;
  /** Millésime du découpage géographique INSEE (ex: "2025"). */
  millesimeGeographique: string;
  source: typeof SOURCE_LABEL;
};

type PopMeasure = "PMUN" | "PCAP" | "PTOT";

type MelodiObservation = {
  dimensions: {
    GEO: string;
    FREQ: string;
    TIME_PERIOD: string;
    POPREF_MEASURE: PopMeasure;
  };
  measures: {
    OBS_VALUE_NIVEAU: { value: number };
  };
};

type MelodiResponse = {
  observations: MelodiObservation[];
  identifier: string;
  paging?: { first?: string; next?: string; previous?: string };
};

const COMMUNE_CODE_RE = /^[0-9][0-9AB][0-9]{3}$/u;

/**
 * Cache in-memory au niveau module. Un container Vercel warm peut servir
 * plusieurs requêtes — on évite de re-frapper Melodi pour les mêmes codes
 * pendant la durée de vie de l'instance. Pas de persistance entre cold
 * starts (acceptable : la pop bouge annuellement). Pour batches massifs,
 * un cache Upstash distribué pourra être ajouté en V0.8.1+ si nécessaire.
 *
 * TTL 24h : la pop INSEE est mise à jour annuellement, 1 jour de drift
 * acceptable et suffit largement à amortir un batch.
 */
const POPULATION_CACHE = new Map<string, { value: PopulationData; expiry: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheGet(key: string): PopulationData | undefined {
  const entry = POPULATION_CACHE.get(key);
  if (!entry) return undefined;
  if (entry.expiry < Date.now()) {
    POPULATION_CACHE.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: PopulationData): void {
  POPULATION_CACHE.set(key, { value, expiry: Date.now() + CACHE_TTL_MS });
}

/**
 * Parse les observations Melodi pour une zone unique. Garde la TIME_PERIOD
 * la plus récente. Retourne null si aucune observation (zone inconnue Melodi
 * ou code invalide accepté par l'API mais sans data — ex: commune fusionnée).
 */
function parseObservations(
  observations: MelodiObservation[],
  codeInsee: string,
  geoLevel: GeoLevel,
): PopulationData | null {
  // Empty observations = zone légitimement absente du dataset (commune fusionnée,
  // code inexistant). Mappé en lookupNotFound côté caller, pas un incident.
  if (observations.length === 0) return null;

  let latestYear = 0;
  for (const obs of observations) {
    const year = Number.parseInt(obs.dimensions.TIME_PERIOD, 10);
    if (Number.isFinite(year) && year > latestYear) latestYear = year;
  }
  // observations présentes mais aucune TIME_PERIOD parsable = régression schéma
  // SDMX upstream (ex: format "2024-Q1" au lieu de "2024"). NE PAS retourner null
  // (qui masquerait l'incident en "zone introuvable") — throw pour signaler.
  if (latestYear === 0) {
    throw new Error(
      `[france-data-mcp] INSEE Melodi: ${observations.length} observations reçues pour ${geoLevel}=${codeInsee} mais aucune TIME_PERIOD parsable — régression schéma SDMX upstream ?`,
    );
  }

  const measures = new Map<PopMeasure, number>();
  let millesime = "unknown";
  for (const obs of observations) {
    if (Number.parseInt(obs.dimensions.TIME_PERIOD, 10) !== latestYear) continue;
    measures.set(obs.dimensions.POPREF_MEASURE, obs.measures.OBS_VALUE_NIVEAU.value);
    const geoMatch = obs.dimensions.GEO.match(/^(\d{4})-/u);
    if (geoMatch?.[1]) millesime = geoMatch[1];
  }

  // PMUN est requis pour la méthodo DREES (toutes les densités s'appuient
  // dessus). Son absence = payload incomplet upstream → throw plutôt que
  // populationMunicipale: 0 silencieux qui ferait conclure "désert médical
  // absolu" à un LLM downstream. PCAP/PTOT restent optionnels (?? 0 OK car
  // certains datasets historiques n'ont que PMUN).
  const pmun = measures.get("PMUN");
  if (pmun === undefined) {
    throw new Error(
      `[france-data-mcp] INSEE Melodi: PMUN absent du payload pour ${geoLevel}=${codeInsee} (mesures reçues: ${[...measures.keys()].join(",")}) — payload incomplet`,
    );
  }

  return {
    codeInsee,
    geoLevel,
    annee: latestYear,
    populationMunicipale: pmun,
    populationComptageApart: measures.get("PCAP") ?? 0,
    populationTotale: measures.get("PTOT") ?? 0,
    millesimeGeographique: millesime,
    source: SOURCE_LABEL,
  };
}

async function fetchPopulation(
  geoFilter: string,
  codeInsee: string,
  geoLevel: GeoLevel,
  signal?: AbortSignal,
): Promise<PopulationData | null> {
  const cacheKey = `${geoLevel}:${codeInsee}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `${MELODI_BASE_URL}/data/${POPULATION_DATASET}?GEO=${encodeURIComponent(geoFilter)}`;
  const data = await fetchJson<MelodiResponse>(url, { signal });

  const parsed = parseObservations(data.observations, codeInsee, geoLevel);
  if (parsed) cacheSet(cacheKey, parsed);
  return parsed;
}

/**
 * Récupère la population d'une commune par son code INSEE (5 caractères).
 * Format Corse accepté ("2A123", "2B045").
 */
export async function getPopulationByCommune(
  codeInsee: string,
  options: { signal?: AbortSignal } = {},
): Promise<LookupResult<PopulationData>> {
  if (typeof codeInsee !== "string" || !COMMUNE_CODE_RE.test(codeInsee)) {
    throw new RangeError(
      `Code INSEE de commune invalide: "${codeInsee}" (attendu : 5 caractères, ex "75056" ou "2A004")`,
    );
  }
  try {
    const data = await fetchPopulation(`COM-${codeInsee}`, codeInsee, "COM", options.signal);
    if (!data) {
      return lookupNotFound(
        codeInsee,
        `Commune ${codeInsee} introuvable dans INSEE Melodi (DS_POPULATIONS_REFERENCE). Vérifier le code via autocomplete_commune — la commune a peut-être fusionné ou changé de code.`,
      );
    }
    return lookupFound(data);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      console.warn(
        `[france-data-mcp] INSEE Melodi 400 on commune ${codeInsee} — body: ${err.body ?? "<empty>"}`,
      );
      return lookupNotFound(
        codeInsee,
        `Code INSEE ${codeInsee} rejeté par INSEE Melodi (${err.body ?? "format invalide"}).`,
      );
    }
    console.error(
      `[france-data-mcp] INSEE Melodi failed for commune ${codeInsee}: ${(err as Error).message}`,
    );
    throw err;
  }
}

/**
 * Récupère la population d'un département par son code INSEE (2-3 caractères).
 * Format Corse ("2A", "2B") et DOM-TOM (3 chiffres) acceptés.
 */
export async function getPopulationByDept(
  codeDept: string,
  options: { signal?: AbortSignal } = {},
): Promise<LookupResult<PopulationData>> {
  if (typeof codeDept !== "string" || !isValidDept(codeDept)) {
    throw new RangeError(
      `Code INSEE de département invalide: "${codeDept}" (attendu : 01-95 métropole, 2A/2B Corse, 971-978 DROM, 984-988 COM)`,
    );
  }
  try {
    const data = await fetchPopulation(`DEP-${codeDept}`, codeDept, "DEP", options.signal);
    if (!data) {
      return lookupNotFound(
        codeDept,
        `Département ${codeDept} introuvable dans INSEE Melodi (DS_POPULATIONS_REFERENCE).`,
      );
    }
    return lookupFound(data);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      console.warn(
        `[france-data-mcp] INSEE Melodi 400 on dept ${codeDept} — body: ${err.body ?? "<empty>"}`,
      );
      return lookupNotFound(
        codeDept,
        `Code INSEE ${codeDept} rejeté par INSEE Melodi (${err.body ?? "format invalide"}).`,
      );
    }
    console.error(
      `[france-data-mcp] INSEE Melodi failed for dept ${codeDept}: ${(err as Error).message}`,
    );
    throw err;
  }
}

/**
 * Récupère la population de la France entière (DOM inclus, conforme méthodo
 * DREES). Pas de `LookupResult` car la France existe toujours — un échec ici
 * est forcément une erreur réseau/upstream que le caller doit voir.
 */
export async function getPopulationFrance(
  options: { signal?: AbortSignal } = {},
): Promise<PopulationData> {
  const data = await fetchPopulation(
    FRANCE_GEO_FILTER,
    FRANCE_CODE_LABEL,
    "FRANCE",
    options.signal,
  );
  if (!data) {
    throw new Error(
      "[france-data-mcp] INSEE Melodi a renvoyé 0 observations pour FRANCE-F — incident upstream ?",
    );
  }
  return data;
}

/** Vide le cache in-memory. Réservé aux tests. */
export function _clearPopulationCacheForTests(): void {
  POPULATION_CACHE.clear();
}
