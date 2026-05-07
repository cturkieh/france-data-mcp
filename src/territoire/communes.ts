/**
 * Recherche de communes françaises via geo.api.gouv.fr (DINUM/Etalab).
 *
 * Pas de rate limit documenté (testé à 5+ req/s sans 429). Source COG INSEE,
 * mise à jour annuelle (1er janvier). API gratuite, sans clé.
 *
 * Doc : https://geo.api.gouv.fr/decoupage-administratif/communes
 */

import { fetchJson } from "../core/http.js";
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
  params.set("limit", String(Math.min(Math.max(limit, 1), 30)));
  if (boostPopulation) params.set("boost", "population");

  const url = `${BASE_URL}/communes?${params.toString()}`;
  const data = await fetchJson<ApiCommune[]>(url, { signal });

  return data.map(toCommune);
}

/**
 * Récupère une commune unique par son code INSEE.
 * Renvoie `null` si le code n'existe pas.
 */
export async function getCommuneByCode(
  code: string,
  signal?: AbortSignal,
): Promise<Commune | null> {
  const results = await searchCommunes({ code, limit: 1, signal });
  return results[0] ?? null;
}

function toCommune(api: ApiCommune): Commune {
  const commune: Commune = {
    code: api.code,
    nom: api.nom,
    codesPostaux: api.codesPostaux ?? [],
  };
  if (api.centre?.coordinates) {
    const [lon, lat] = api.centre.coordinates;
    commune.centre = { lon, lat };
  }
  if (api.population !== undefined) commune.population = api.population;
  if (api.codeDepartement) commune.codeDepartement = api.codeDepartement;
  if (api.codeRegion) commune.codeRegion = api.codeRegion;
  if (api.codeEpci) commune.codeEpci = api.codeEpci;
  return commune;
}
