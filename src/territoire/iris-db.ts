/**
 * Lookups IRIS DB-backed (Phase B). L'IRIS n'est PAS servi par l'API INSEE
 * Melodi (vérifié 2026-05-28) → contrairement à `getPopulationByCommune`
 * (Melodi live), la population au grain IRIS provient des tables ingérées
 * (`iris`, `iris_population`, …) via la RPC `iris_profil_by_code`.
 *
 * Pas d'import depuis `sante/` (qui importe déjà `territoire/`) → on n'utilise
 * pas `expectSingleRow` (sante/db-helpers) ici : `code_iris` est une PK, la RPC
 * renvoie 0 ou 1 ligne, `rows[0] ?? null` suffit (pas de cycle de couche).
 */

import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { getUntypedAnonClient } from "../storage/supabase.js";

/** code_iris = dept(2, dont 2A/2B) + commune(3) + iris(4) = 9 caractères. */
const IRIS_CODE_PATTERN = /^(?:[0-9]{2}|2[AB])[0-9]{7}$/u;

/**
 * Ligne brute retournée par `iris_profil_by_code` : `iris` + ses 3 blocs stats
 * en LEFT JOIN (champs NULL si l'IRIS n'a pas la donnée — hors couverture
 * FILOSOFI, etc.). Réutilisée par `profil_iris` mode îlot (étape 5).
 */
export interface IrisProfilRow {
  code_iris: string;
  code_commune: string;
  libelle: string | null;
  type_iris: string | null;
  pop_total: number | null;
  pop_0_14: number | null;
  pop_15_29: number | null;
  pop_30_44: number | null;
  pop_45_59: number | null;
  pop_60_74: number | null;
  pop_75p: number | null;
  pop_65p: number | null;
  pop_15p: number | null;
  csp_agriculteurs: number | null;
  csp_artisans_comm: number | null;
  csp_cadres: number | null;
  csp_prof_interm: number | null;
  csp_employes: number | null;
  csp_ouvriers: number | null;
  csp_retraites: number | null;
  csp_autres: number | null;
  menages_total: number | null;
  couples_avec_enfants: number | null;
  couples_sans_enfants: number | null;
  familles_monoparentales: number | null;
  revenu_median: number | null;
  revenu_d1: number | null;
  revenu_d9: number | null;
  taux_pauvrete: number | null;
}

const IRIS_RP_SOURCE = "INSEE Recensement de la population 2022 (IRIS)";

/** Valide le format d'un code IRIS au boundary. Throw `RangeError` si invalide. */
export function assertIrisCode(code: string): void {
  if (!IRIS_CODE_PATTERN.test(code)) {
    throw new RangeError(
      `Code IRIS "${code}" invalide : attendu 9 caractères = code commune INSEE (5) + numéro d'IRIS (4), ex "751103701".`,
    );
  }
}

/**
 * Récupère le profil complet d'un îlot par code_iris (0 ou 1 ligne). Throw si
 * la RPC échoue (panne DB ≠ "pas trouvé" : ne jamais masquer en `null`).
 * Retourne `null` si le code est absent du référentiel.
 */
export async function fetchIrisProfilByCode(codeIris: string): Promise<IrisProfilRow | null> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("iris_profil_by_code", { p_code_iris: codeIris });
  if (error) {
    throw new Error(
      `[france-data-mcp] iris_profil_by_code(${codeIris}) RPC failed: ${error.message}`,
    );
  }
  const rows = (Array.isArray(data) ? data : []) as IrisProfilRow[];
  return rows[0] ?? null;
}

/** Helper interne : appelle une RPC IRIS renvoyant une liste de lignes profil. */
async function callIrisRowsRpc(
  rpc: string,
  params: Record<string, unknown>,
): Promise<IrisProfilRow[]> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc(rpc, params);
  if (error) {
    throw new Error(`[france-data-mcp] ${rpc} RPC failed: ${error.message}`);
  }
  return (Array.isArray(data) ? data : []) as IrisProfilRow[];
}

/** Profil de l'IRIS CONTENANT le point (point-in-polygon). `null` hors couverture (mer, étranger). */
export async function fetchIrisAtPoint(lon: number, lat: number): Promise<IrisProfilRow | null> {
  const rows = await callIrisRowsRpc("iris_at_point", { p_lon: lon, p_lat: lat });
  return rows[0] ?? null;
}

/** Îlots dont le CENTROÏDE est dans le disque (R2) centré sur un point. */
export function fetchIrisInRadius(
  lon: number,
  lat: number,
  rayonM: number,
): Promise<IrisProfilRow[]> {
  return callIrisRowsRpc("iris_in_radius", { p_lon: lon, p_lat: lat, p_rayon_m: rayonM });
}

/** Îlots du bassin centré sur le centroïde d'un IRIS. Liste VIDE = code_iris absent. */
export function fetchIrisInRadiusOfCode(
  codeIris: string,
  rayonM: number,
): Promise<IrisProfilRow[]> {
  return callIrisRowsRpc("iris_in_radius_of_code", { p_code_iris: codeIris, p_rayon_m: rayonM });
}

/** Population (RP 2022) d'un IRIS, exposée par le tool `population` (granularité 9 car.). */
export interface IrisPopulationLookup {
  codeIris: string;
  codeCommune: string;
  libelle: string | null;
  /** Type INSEE : H (habitat) / A (activité) / D (divers) / Z (commune non irisée). */
  typeIris: string | null;
  annee: number;
  /** Population totale de l'îlot au RP 2022, arrondie à l'entier (la source INSEE est décimale pondérée). */
  population: number;
  source: typeof IRIS_RP_SOURCE;
}

/**
 * Population d'un IRIS par son code (9 car.). Discrimine "introuvable" (code
 * absent du référentiel contours) vs "trouvé". Le cas rarissime d'un IRIS
 * présent mais sans ligne population RP (1 cas mesuré sur 48 569) est un
 * `not_found` motivé — jamais un 0 silencieux.
 */
export async function getPopulationByIris(
  codeIris: string,
): Promise<LookupResult<IrisPopulationLookup>> {
  const code = codeIris.trim();
  assertIrisCode(code);
  const row = await fetchIrisProfilByCode(code);
  if (!row) {
    return lookupNotFound(
      code,
      `IRIS "${code}" absent du référentiel (contours IGN 2024). Vérifier le code, ou utiliser autocomplete_commune / population (code commune 5 car.) pour la maille commune.`,
    );
  }
  if (row.pop_total === null) {
    return lookupNotFound(
      code,
      `IRIS "${code}" présent dans les contours mais sans population au RP 2022 (cas rare).`,
    );
  }
  // Garde isFinite : une valeur NUMERIC corrompue (string non numérique via
  // PostgREST) donnerait NaN → on discrimine en not_found motivé, JAMAIS un
  // `found` à NaN (qui empoisonnerait silencieusement tout calcul de densité
  // aval) NI un fallback 0 (0 habitant est une valeur réelle, donc trompeuse).
  // Pattern aligné sur rpps-db.ts / ameli-db.ts.
  const popRaw = Number(row.pop_total);
  if (!Number.isFinite(popRaw)) {
    console.warn(
      `[france-data-mcp] iris_profil_by_code(${code}): pop_total non numérique (raw=${JSON.stringify(row.pop_total)})`,
    );
    return lookupNotFound(
      code,
      `IRIS "${code}" : population au RP 2022 illisible (donnée source corrompue, à signaler).`,
    );
  }
  return lookupFound({
    codeIris: row.code_iris,
    codeCommune: row.code_commune,
    libelle: row.libelle,
    typeIris: row.type_iris,
    annee: 2022,
    // Arrondi à l'entier : l'INSEE diffuse des estimations DÉCIMALES pondérées
    // au grain IRIS (~43 % des îlots), mais une population = un compte
    // d'habitants entier (cohérent avec PMUN/PTOT commune/dept). Les valeurs
    // brutes décimales restent en base pour les Σ/Σ de profil_iris.
    population: Math.round(popRaw),
    source: IRIS_RP_SOURCE,
  });
}
