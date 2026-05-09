/**
 * Recherche de communes françaises via geo.api.gouv.fr (DINUM/Etalab).
 *
 * Pas de rate limit documenté (testé à 5+ req/s sans 429). Source COG INSEE,
 * mise à jour annuelle (1er janvier). API gratuite, sans clé.
 *
 * Doc : https://geo.api.gouv.fr/decoupage-administratif/communes
 */

import { fetchJson } from "../core/http.js";
import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { clamp } from "../core/numbers.js";
import { pickDefined } from "../core/object-utils.js";
import type { Coordinates } from "../core/types.js";

const BASE_URL = "https://geo.api.gouv.fr";

export type Commune = {
  /** Code INSEE (5 caractères, ex: "08105" pour Charleville-Mézières) */
  code: string;
  /** Nom officiel de la commune */
  nom: string;
  /** Liste des codes postaux desservant la commune */
  codesPostaux: string[];
  /** Centre géographique (centroïde) */
  centre?: Coordinates;
  /** Population municipale (recensement le plus récent disponible) */
  population?: number;
  /** Code département (ex: "08") */
  codeDepartement?: string;
  /** Code région (ex: "44" pour Grand Est) */
  codeRegion?: string;
  /** Code EPCI (intercommunalité) */
  codeEpci?: string;
};

export type SearchCommunesOptions = {
  /** Recherche par nom (autocomplétion). Insensible à la casse. */
  nom?: string;
  /** Recherche exacte par code postal (5 chiffres). */
  codePostal?: string;
  /** Recherche exacte par code INSEE (5 caractères). */
  code?: string;
  /** Nombre maximum de résultats (1-30, défaut 10). */
  limit?: number;
  /**
   * Trier par population décroissante. Recommandé pour les recherches `nom`
   * ambiguës (ex: "Charleville" → on veut Charleville-Mézières en premier,
   * pas Charleville-sous-Bois 284 hab.).
   */
  boostPopulation?: boolean;
  signal?: AbortSignal;
};

const DEFAULT_FIELDS = [
  "nom",
  "code",
  "codesPostaux",
  "centre",
  "population",
  "codeDepartement",
  "codeRegion",
  "codeEpci",
].join(",");

type ApiCommune = {
  nom: string;
  code: string;
  codesPostaux?: string[];
  centre?: { type: "Point"; coordinates: [number, number] };
  population?: number;
  codeDepartement?: string;
  codeRegion?: string;
  codeEpci?: string;
};

/**
 * Recherche des communes selon différents critères.
 *
 * @example Autocomplétion par nom
 * ```ts
 * const villes = await searchCommunes({ nom: "Charleville", boostPopulation: true });
 * // → [{ code: "08105", nom: "Charleville-Mézières", population: 45560, ... }, ...]
 * ```
 *
 * @example Recherche par code postal
 * ```ts
 * const villes = await searchCommunes({ codePostal: "08000" });
 * ```
 */
export async function searchCommunes(options: SearchCommunesOptions): Promise<Commune[]> {
  const { nom, codePostal, code, limit = 10, boostPopulation = false, signal } = options;

  if (!nom && !codePostal && !code) {
    throw new Error("searchCommunes: au moins un critère (nom, codePostal, code) est requis");
  }

  const params = new URLSearchParams();
  if (nom) params.set("nom", nom);
  if (codePostal) params.set("codePostal", codePostal);
  if (code) params.set("code", code);
  params.set("fields", DEFAULT_FIELDS);
  params.set("limit", String(clamp(limit, 1, 30)));
  if (boostPopulation) params.set("boost", "population");

  const url = `${BASE_URL}/communes?${params.toString()}`;
  const data = await fetchJson<ApiCommune[]>(url, { signal });

  return data.map(toCommune);
}

/**
 * Récupère une commune unique par son code INSEE.
 *
 * Retourne un `LookupResult` discriminé par `found`. Si le code n'existe pas
 * dans le COG INSEE (commune fusionnée, code mal formé, code de canton…),
 * la fonction renvoie `{ found: false, lookupStatus: "not_found", message }`
 * au lieu d'un `null` silencieux. Pattern aligné sur `getEntrepriseBySiren`
 * et `getFinessByNumFiness` (cf. `src/core/lookup-result.ts`).
 */
export async function getCommuneByCode(
  code: string,
  signal?: AbortSignal,
): Promise<LookupResult<Commune>> {
  const results = await searchCommunes({ code, limit: 1, signal });
  const first = results[0];
  if (!first) {
    return lookupNotFound(
      code,
      `Commune introuvable pour le code INSEE "${code}". Causes possibles : code mal formé (attendu 5 caractères), commune fusionnée (référentiel COG INSEE bouge au 1er janvier), code de canton/EPCI mal interprété comme commune. Pour disambiguer : utiliser \`autocomplete_commune\` avec un nom partiel.`,
    );
  }
  return lookupFound(first);
}

/**
 * Récupère TOUTES les communes de France en un seul appel (~35 000 communes,
 * ~4 Mo de JSON). Inclut métropole, Corse, DOM-TOM. À utiliser pour bâtir un
 * cache local pour l'ingestion (ex: matching CP+ville → centroïde lors de
 * l'ingestion Annuaire Ameli).
 *
 * ⚠️ NE PAS APPELER depuis un endpoint serverless / un cold start MCP : le
 * download fait 4 Mo et la déserialisation construit un objet de 35 000
 * entrées. C'est conçu pour les workflows d'ingestion (cron GitHub Actions),
 * pas pour le runtime de requête.
 */
export async function fetchAllCommunes(signal?: AbortSignal): Promise<Commune[]> {
  const params = new URLSearchParams();
  params.set("fields", DEFAULT_FIELDS);
  params.set("format", "json");
  params.set("geometry", "centre");
  const url = `${BASE_URL}/communes?${params.toString()}`;
  const data = await fetchJson<ApiCommune[]>(url, { signal });
  return data.map(toCommune);
}

function toCommune(api: ApiCommune): Commune {
  const centre = api.centre?.coordinates
    ? { lon: api.centre.coordinates[0], lat: api.centre.coordinates[1] }
    : undefined;
  return {
    code: api.code,
    nom: api.nom,
    codesPostaux: api.codesPostaux ?? [],
    ...(centre ? { centre } : {}),
    ...(api.population !== undefined ? { population: api.population } : {}),
    ...pickDefined({
      codeDepartement: api.codeDepartement,
      codeRegion: api.codeRegion,
      codeEpci: api.codeEpci,
    }),
  };
}
