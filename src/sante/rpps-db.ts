/**
 * RPPS / Annuaire Santé ANS — wrappers typés autour des RPCs PostGIS.
 *
 * Source : data.gouv `annuaire-sante-extractions-...-rpps`, Licence Ouverte v2.0.
 * La mention obligatoire (ANS / Licence Ouverte v2.0) est portée par les
 * descriptions des tools MCP (`api/tools.ts`). Ce module est le boundary
 * technique, pas le boundary public.
 *
 * Diffère d'Ameli sur 3 points :
 * - couverture : libéraux + salariés + étudiants + agents publics
 *   (vs Ameli libéraux conventionnés uniquement)
 * - identifiant stable : `rpps_id` (IDNPS national) → lookup individuel + dédup
 * - pivot structure : `num_finess` exposé en colonne → croisement avec FINESS
 *
 * IMPORTANT : la base ne contient QUE des PS actifs. L'ANS pré-filtre le
 * fichier `PS_LibreAcces_Personne_activite` à la source : retraités, décédés,
 * radiés et suspendus n'apparaissent jamais dans cette extraction (cf. DSFT
 * v3.1 §5.1.2). Le filtre par `categorie_code` discrimine donc des **statuts
 * juridiques d'enregistrement** (Civil / Étudiant / Agent public), pas des
 * statuts d'activité.
 */

import { metersToKm } from "../core/numbers.js";
import {
  type QueryMetadata,
  rppsDeptMetadata,
  rppsEtablissementMetadata,
  rppsRadiusMetadata,
  rppsSearchByNameMetadata,
} from "../core/query-metadata.js";
import { getUntypedAnonClient } from "../storage/supabase.js";
import { assertValidCodeInsee, assertValidDept } from "../territoire/dept-codes.js";
import {
  RPPS_ID_PATTERN,
  assertValidNumFiness,
  clampLimit,
  clampOffset,
  expectRpcRows,
  formatRpcError,
  trimOrNull,
  validateCoords,
  validateRadiusKm,
} from "./db-helpers.js";
import { type GeoJsonPoint, TRE_R09_URL } from "./rpps-types.js";

// --- Public result shapes --------------------------------------------------

export interface RppsResult {
  id: number;
  rpps_id: string;
  identite: {
    nom: string;
    prenom: string;
    civilite: string | null;
  };
  profession: { code: string | null; libelle: string | null };
  /** Spécialité fine (DES/DESC). Plus riche que la spécialité Ameli simple. */
  savoir_faire: { code: string | null; libelle: string | null };
  mode_exercice: { code: string | null; libelle: string | null };
  /** Catégorie professionnelle ANS (TRE_R09) — voir `CATEGORIE_CODE_*` / `buildCategorieCodes`. */
  categorie: { code: string | null; libelle: string | null };
  /** Pivot vers FINESS / SIRENE. Souvent rempli pour les salariés, plus rare en libéral pur. */
  structure: {
    num_finess: string | null;
    num_finess_ej: string | null;
    siret: string | null;
    raison_sociale: string | null;
  };
  adresse: {
    voie: string | null;
    code_postal: string | null;
    ville: string | null;
    code_departement: string | null;
    code_insee: string | null;
  };
  coords: { lat: number; lon: number } | null;
  distance_km: number | null;
  telephone: string | null;
  /**
   * Score de pertinence trigram (0..1) — présent uniquement pour les retours
   * de `rpps_search_by_name`. Permet au caller de filtrer les homonymies
   * partielles (typiquement `< 0.5`).
   */
  match_score?: number;
}

export interface RppsLookupResult extends RppsResult {
  /** Identifiant PP legacy (pré-IDNPS), conservé quand fourni par l'extract. */
  identifiant_pp: string | null;
  siren: string | null;
  email: string | null;
}

export interface RppsInRadiusInput {
  center: { lat: number; lon: number };
  radiusKm: number;
  /** Codes profession ANS (ex: "10" Médecin, "60" Infirmier). */
  professionCodes?: string[];
  /** Codes savoir-faire (DES/DESC). Granularité fine. */
  savoirFaireCodes?: string[];
  /** Codes mode exercice (L libéral, S salarié, M mixte, R remplaçant…). */
  modeExerciceCodes?: string[];
  /**
   * Codes catégorie professionnelle ANS (table TRE_R09). Vide ou omis →
   * filtre default = `[CATEGORIE_CODE_CIVIL]` (cf. `buildCategorieCodes`).
   * Sinon → filtre exact ANY (le helper SQL `rpps_categorie_match` ajoute
   * `OR IS NULL` défensif pour ne pas exclure les rows à code absent).
   */
  categorieCodes?: string[];
  limit?: number;
}

export interface RppsParSpecialiteDeptInput {
  departement: string;
  professionCode?: string;
  savoirFaireCode?: string;
  modeExerciceCode?: string;
  /** Voir `RppsInRadiusInput.categorieCodes`. */
  categorieCodes?: string[];
  limit?: number;
  offset?: number;
}

export interface RppsDansEtablissementInput {
  /** Numéro FINESS (9 chiffres) du site d'exercice. */
  numFiness: string;
  /** Voir `RppsInRadiusInput.categorieCodes`. */
  categorieCodes?: string[];
  limit?: number;
}

export interface RppsSearchByNameInput {
  /** Nom de famille (obligatoire, non vide après trim). */
  nom: string;
  /** Prénom (optionnel — sans, le matching ne porte que sur le nom). */
  prenom?: string;
  /** Code département (2 chiffres métropole/Corse, 3 pour DOM). Optionnel. */
  departement?: string;
  /**
   * Codes catégorie ANS TRE_R09. Vide ou omis → default `[C]` (Civil seul),
   * cohérent avec les 3 autres tools RPPS.
   */
  categorieCodes?: string[];
  limit?: number;
}

/**
 * Codes catégorie professionnelle ANS — table de référence TRE_R09 (cf.
 * `TRE_R09_URL`). Le code `F` déprécié 2026-02-23 a été fusionné dans `M`,
 * et le fichier `PS_LibreAcces_Personne_activite` est pré-filtré aux actifs
 * à la source — d'où l'absence de codes `R`/`S`/`D` (cf. JSDoc de tête).
 */
export const CATEGORIE_CODE_CIVIL = "C";
export const CATEGORIE_CODE_ETUDIANT = "E";
export const CATEGORIE_CODE_AGENT_PUBLIC = "M";

/** Codes valides dans TRE_R09 actuellement présents en base. */
export const CATEGORIE_CODES_OFFICIELS = Object.freeze([
  CATEGORIE_CODE_CIVIL,
  CATEGORIE_CODE_ETUDIANT,
  CATEGORIE_CODE_AGENT_PUBLIC,
] as const);

/**
 * Default appliqué TS-side dans `getRppsParSpecialiteDept`. La RPC V0.5.4
 * (`EXECUTE format`) porte aussi son propre `COALESCE(... ARRAY['C'])` en
 * défense — KEEP IN SYNC si on change le default.
 */
export const CATEGORIE_CODES_DEFAUT = Object.freeze([
  CATEGORIE_CODE_CIVIL,
] as const) satisfies readonly string[];

/**
 * Construit `categorieCodes` à partir des 2 flags MCP. Source unique
 * consommée par les 3 handlers tools.
 */
export function buildCategorieCodes(opts: {
  includeEtudiants?: boolean;
  includeAgentsPublics?: boolean;
}): string[] {
  const codes: string[] = [CATEGORIE_CODE_CIVIL];
  if (opts.includeAgentsPublics) codes.push(CATEGORIE_CODE_AGENT_PUBLIC);
  if (opts.includeEtudiants) codes.push(CATEGORIE_CODE_ETUDIANT);
  return codes;
}

/**
 * Résout `categorieCodes` côté TS pour les wrappers qui veulent expliciter le
 * default `[C]` au lieu de laisser la RPC retomber sur son propre `COALESCE`.
 *
 * À utiliser UNIQUEMENT pour les wrappers où on veut un default TS-side
 * (`getRppsParSpecialiteDept`, `getRppsByName`). Les wrappers qui passent
 * `?? []` (countRpps, getRppsInRadius, etc.) ont une sémantique différente :
 * `[]` côté TS = "pas de filtre TS-side, la RPC applique son propre default
 * (varie selon RPC)". Ne PAS substituer naïvement les 2 patterns.
 *
 * Retourne un `readonly string[]` : le RPC Supabase sérialise l'array en
 * JSON sans muter l'input, donc pas besoin d'allouer une copie défensive.
 */
function resolveCategorieCodes(codes: readonly string[] | undefined): readonly string[] {
  return codes && codes.length > 0 ? codes : CATEGORIE_CODES_DEFAUT;
}

/** Référence stable de la nomenclature ANS. Alias re-exporté pour la doc. */
export { TRE_R09_URL };

export interface RppsQueryResult {
  count: number;
  truncated: boolean;
  results: RppsResult[];
  query_metadata?: QueryMetadata;
}

export interface CountRppsInput {
  /** Code département (2-3 chars). Omis ou null → comptage France entière. */
  departement?: string | null;
  /** Code profession ANS (ex "10" Médecin, "60" Infirmier, "21" Pharmacien). */
  professionCode?: string | null;
  /** Code savoir_faire (spécialité, ex "SM04" Cardiologie). */
  savoirFaireCode?: string | null;
  /**
   * Codes mode_exercice ANS à inclure. Pour la méthodo DREES "activité régulière",
   * passer ['L','S','M'] (libéral, salarié, mixte). Vide ou omis → pas de filtre.
   */
  modeExerciceCodes?: string[];
  /** Codes catégorie ANS (TRE_R09). Vide ou omis → default ['C','M']. */
  categorieCodes?: string[];
}

export interface CountRppsByCommuneInput {
  /**
   * Code INSEE commune 5 chars. REQUIS. Pour Paris/Marseille/Lyon, les rows
   * RPPS portent le code arrondissement (ex 75108 Paris 8e), pas la commune
   * unique (75056). Pour le total Paris/Lyon/Marseille, utiliser le niveau
   * département via `countRpps({ departement })`.
   */
  codeInsee: string;
  /** Code profession ANS. Default RPC : pas de filtre (compte toutes les professions). */
  professionCode?: string | null;
  /** Code savoir_faire (spécialité). */
  savoirFaireCode?: string | null;
  /** Codes mode_exercice ANS. Vide ou omis → pas de filtre. */
  modeExerciceCodes?: string[];
  /** Codes catégorie ANS. Vide ou omis → default RPC ['C','M']. */
  categorieCodes?: string[];
}

// --- Public query functions ------------------------------------------------

export interface SavoirFaireEntry {
  /** Code savoir_faire ANS (ex 'SM04' Cardiologie ; 'SM02' = Anesthésie-réanimation). */
  code: string;
  /**
   * Libellé clair du savoir_faire. Quand un même `code` a plusieurs libellés
   * upstream (drift référentiel ANS au fil des sync), la matview
   * `rpps_savoir_faire_stats` retient `MAX(savoir_faire_libelle)` —
   * dernier alphabétiquement, PAS le plus fréquent. Stable et déterministe,
   * suffisant pour disambiguation côté LLM (le `code` reste l'identifiant).
   */
  libelle: string;
  /** Nombre de PS portant ce savoir_faire dans le périmètre filtré. */
  count_ps: number;
}

/**
 * Liste les savoir_faire (spécialités) présents en base RPPS, optionnellement
 * filtrés par profession. Tool d'aide LLM (V0.8) : permet de découvrir les
 * codes spécialité (ex 'SM04' Cardiologie) avant de les passer à
 * `densiteProfessionnelsSante` ou aux autres tools de query.
 *
 * Triés par count_ps DESC (spécialités les plus représentées en premier).
 */
export async function listSavoirFaireRpps(
  professionCode?: string | null,
): Promise<SavoirFaireEntry[]> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("lister_savoir_faire_rpps", {
    p_profession_code: professionCode ?? null,
  });
  if (error) throw new Error(formatRpcError("lister_savoir_faire_rpps", error));
  const rows = expectRpcRows<{
    code: string | null;
    libelle: string | null;
    count_ps: number | string | null;
  }>("lister_savoir_faire_rpps", data);
  const out: SavoirFaireEntry[] = [];
  for (const row of rows) {
    if (!row.code) {
      // Invariant SQL violé : la migration filtre déjà `WHERE savoir_faire_code
      // IS NOT NULL`. Un row sans code = drift schéma upstream / RPC remplacée
      // par un mock. NE PAS swallow silencieusement — log pour visibilité.
      console.warn(
        `[france-data-mcp] lister_savoir_faire_rpps: row sans code reçu malgré WHERE IS NOT NULL côté SQL — invariant violé (libelle=${row.libelle ?? "<null>"})`,
      );
      continue;
    }
    // PostgREST sérialise BIGINT parfois en string si > Number.MAX_SAFE_INTEGER.
    // Sur 2.23M PS, les counts par savoir_faire sont au max ~100K → toujours
    // safe en number. Conversion défensive quand même.
    const count = typeof row.count_ps === "number" ? row.count_ps : Number(row.count_ps ?? 0);
    if (!Number.isFinite(count)) {
      console.warn(
        `[france-data-mcp] lister_savoir_faire_rpps: count_ps non parsable pour code=${row.code} (raw=${JSON.stringify(row.count_ps)}) — fallback 0`,
      );
    }
    out.push({
      code: row.code,
      libelle: row.libelle ?? "",
      count_ps: Number.isFinite(count) ? count : 0,
    });
  }
  return out;
}

/**
 * Compte les PS RPPS matching les filtres (RPC `count_rpps` V0.8). Sert de
 * brique pour `densiteProfessionnelsSante` (cross-source RPPS+Melodi).
 *
 * `departement` omis ou null → comptage France entière. La RPC valide le
 * format dept côté Postgres (regex identique aux autres RPCs RPPS).
 */
export async function countRpps(input: CountRppsInput = {}): Promise<number> {
  if (input.departement !== undefined && input.departement !== null) {
    assertValidDept(input.departement);
  }
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("count_rpps", {
    p_dept: input.departement ?? null,
    p_profession_code: input.professionCode ?? null,
    p_savoir_faire_code: input.savoirFaireCode ?? null,
    p_mode_exercice_codes: input.modeExerciceCodes ?? [],
    p_categorie_codes: input.categorieCodes ?? [],
  });
  if (error) throw new Error(formatRpcError("count_rpps", error));
  // PostgREST sérialise un BIGINT en number JS (safe jusqu'à 2^53). La base
  // RPPS ~2.23M lignes — aucun risque de dépassement.
  if (typeof data !== "number") {
    throw new Error(
      `count_rpps returned unexpected type ${typeof data} (dept=${input.departement ?? "FRANCE"}, profession=${input.professionCode ?? "*"}, expected number, got: ${JSON.stringify(data)})`,
    );
  }
  return data;
}

/**
 * Compte les PS RPPS dans une commune INSEE (RPC `count_rpps_by_commune` V0.9).
 * Brique pour `densiteProfessionnelsSante` au niveau commune.
 *
 * Limitation Paris/Marseille/Lyon : les rows portent l'insee arrondissement
 * (75101-75120, 13201-13216, 69381-69389). Le caller qui veut Paris global doit
 * utiliser `countRpps({ departement: "75" })`.
 */
export async function countRppsByCommune(input: CountRppsByCommuneInput): Promise<number> {
  assertValidCodeInsee(input.codeInsee);
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("count_rpps_by_commune", {
    p_code_insee: input.codeInsee,
    p_profession_code: input.professionCode ?? null,
    p_savoir_faire_code: input.savoirFaireCode ?? null,
    p_mode_exercice_codes: input.modeExerciceCodes ?? [],
    p_categorie_codes: input.categorieCodes ?? [],
  });
  if (error) throw new Error(formatRpcError("count_rpps_by_commune", error));
  if (typeof data !== "number") {
    throw new Error(
      `count_rpps_by_commune returned unexpected type ${typeof data} (codeInsee=${input.codeInsee}, profession=${input.professionCode ?? "*"}, expected number, got: ${JSON.stringify(data)})`,
    );
  }
  return data;
}

export async function getRppsInRadius(input: RppsInRadiusInput): Promise<RppsQueryResult> {
  const limit = clampLimit(input.limit);
  validateCoords(input.center.lat, input.center.lon);
  validateRadiusKm(input.radiusKm);

  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("rpps_in_radius", {
    p_lat: input.center.lat,
    p_lon: input.center.lon,
    p_radius_meters: input.radiusKm * 1000,
    p_profession_codes: input.professionCodes ?? [],
    p_savoir_faire_codes: input.savoirFaireCodes ?? [],
    p_mode_exercice_codes: input.modeExerciceCodes ?? [],
    p_categorie_codes: input.categorieCodes ?? [],
    p_limit: limit + 1,
  });

  if (error) throw new Error(formatRpcError("rpps_in_radius", error));
  return buildQueryResult("rpps_in_radius", data, limit, rppsRadiusMetadata());
}

export async function getRppsParSpecialiteDept(
  input: RppsParSpecialiteDeptInput,
): Promise<RppsQueryResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  assertValidDept(input.departement);

  const supabase = getUntypedAnonClient();
  // Le client untyped ne contraint pas les types des params RPC — on peut
  // passer `null` directement pour les filtres optionnels (le RPC PostgreSQL
  // gère `NULL → pas de filtre` via `IS NULL OR ... = ...`).
  // `categorieCodes` vide ou omis → default TS-side = `[C]` (Civil seul).
  // La RPC V0.5.4 a son propre `COALESCE(... , ARRAY['C'])` en défense, on
  // explicite côté TS pour cohérence avec `getRppsByName` + debug facilité.
  const { data, error } = await supabase.rpc("rpps_par_specialite_dept", {
    p_departement: input.departement,
    p_profession_code: input.professionCode ?? null,
    p_savoir_faire_code: input.savoirFaireCode ?? null,
    p_mode_exercice_code: input.modeExerciceCode ?? null,
    p_categorie_codes: resolveCategorieCodes(input.categorieCodes),
    p_limit: limit + 1,
    p_offset: offset,
  });

  if (error) throw new Error(formatRpcError("rpps_par_specialite_dept", error));
  return buildQueryResult("rpps_par_specialite_dept", data, limit, rppsDeptMetadata());
}

/** "Qui travaille dans ce FINESS ?" — lit la colonne indexée `num_finess`. */
export async function getRppsDansEtablissement(
  input: RppsDansEtablissementInput,
): Promise<RppsQueryResult> {
  const limit = clampLimit(input.limit);
  // Defense-in-depth lib : aligné avec `finess-db.ts:getFinessByNumFiness`,
  // utilise la source de vérité partagée `NUM_FINESS_PATTERN` via `assertValidNumFiness`.
  const numFiness = assertValidNumFiness(input.numFiness);

  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("rpps_dans_etablissement", {
    p_num_finess: numFiness,
    p_categorie_codes: input.categorieCodes ?? [],
    p_limit: limit + 1,
  });

  if (error) throw new Error(formatRpcError("rpps_dans_etablissement", error));
  const rows = expectRpcRows<RawRppsCompactRow>("rpps_dans_etablissement", data);
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toCompactResult),
    query_metadata: rppsEtablissementMetadata(),
  };
}

/**
 * Recherche fuzzy par identité (nom, prenom?, departement?). Utilise pg_trgm
 * `similarity()` côté SQL avec index GIN trigram sur `lower(nom)` et
 * `lower(prenom)` (migration `20260511T100000_rpps_search_by_name`). Tri par
 * score décroissant.
 *
 * Comportement edge cases :
 * - `nom` vide ou whitespace → throw `RangeError` (validation côté SQL aussi)
 * - `departement` mal formé → throw via la RPC (ERRCODE 22023)
 * - aucune correspondance → `{ count: 0, results: [] }`
 */
export async function getRppsByName(input: RppsSearchByNameInput): Promise<RppsQueryResult> {
  const nom = input.nom.trim();
  if (nom.length === 0) {
    throw new RangeError(
      "[france-data-mcp] rpps_search_by_name: nom est requis (non vide après trim).",
    );
  }
  const prenom = input.prenom?.trim();
  const limit = clampLimit(input.limit);
  if (input.departement !== undefined) assertValidDept(input.departement);
  // Default `[C]` (Civil seul) cohérent avec `getRppsParSpecialiteDept` — un
  // caller cherchant un PS par nom récupère par défaut les libéraux + salariés
  // privés + hospitaliers contractuels, pas les étudiants ni les agents publics.

  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("rpps_search_by_name", {
    p_nom: nom,
    // RPC accepte NULL pour "pas de filtre prenom". `??` couvre prenom omis
    // (undefined) ET vide après trim (chaîne vide).
    p_prenom: prenom && prenom.length > 0 ? prenom : null,
    p_departement: input.departement ?? null,
    p_categorie_codes: resolveCategorieCodes(input.categorieCodes),
    p_limit: limit + 1,
  });

  if (error) throw new Error(formatRpcError("rpps_search_by_name", error));
  const rows = expectRpcRows<RawRppsSearchRow>("rpps_search_by_name", data);
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toSearchResult),
    query_metadata: rppsSearchByNameMetadata(),
  };
}

/**
 * Lookup individuel par RPPS ID. Renvoie N rows quand un PS multi-sites
 * existe (1 ligne par site). Le caller MCP aplatit en `(rpps_id, sites[])`.
 */
export async function getRppsById(rppsId: string): Promise<RppsLookupResult[]> {
  const trimmed = rppsId.trim();
  if (!RPPS_ID_PATTERN.test(trimmed)) {
    throw new RangeError(
      `[france-data-mcp] rpps_id invalide "${rppsId}" — attendu 11 ou 12 chiffres (IDNPS national, format ANS — préfixe "81" optionnel pour les IDs émis depuis 2020 = 12 chars, sans préfixe = 11 chars).`,
    );
  }
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("rpps_lookup_by_id", {
    p_rpps_id: trimmed,
  });
  if (error) throw new Error(formatRpcError("rpps_lookup_by_id", error));
  const rows = expectRpcRows<RawRppsLookupRow>("rpps_lookup_by_id", data);
  return rows.map(toLookupResult);
}

// --- internals -------------------------------------------------------------

function buildQueryResult(
  rpc: string,
  data: unknown,
  limit: number,
  metadata: QueryMetadata,
): RppsQueryResult {
  const rows = expectRpcRows<RawRppsRow>(rpc, data);
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toResult),
    query_metadata: metadata,
  };
}

interface RawRppsRow {
  id: number;
  rpps_id: string;
  civilite: string | null;
  nom: string;
  prenom: string;
  profession_code: string | null;
  profession_libelle: string | null;
  savoir_faire_code: string | null;
  savoir_faire_libelle: string | null;
  mode_exercice_code: string | null;
  mode_exercice_libelle: string | null;
  categorie_code: string | null;
  categorie_libelle: string | null;
  num_finess: string | null;
  num_finess_ej: string | null;
  siret: string | null;
  raison_sociale: string | null;
  adresse: string | null;
  code_postal: string | null;
  ville: string | null;
  code_departement: string | null;
  code_insee: string | null;
  telephone: string | null;
  geom: GeoJsonPoint | null;
  distance_meters?: number | null;
}

interface RawRppsCompactRow {
  id: number;
  rpps_id: string;
  civilite: string | null;
  nom: string;
  prenom: string;
  profession_code: string | null;
  profession_libelle: string | null;
  savoir_faire_code: string | null;
  savoir_faire_libelle: string | null;
  mode_exercice_code: string | null;
  mode_exercice_libelle: string | null;
  categorie_code: string | null;
  categorie_libelle: string | null;
  num_finess: string | null;
  num_finess_ej: string | null;
  raison_sociale: string | null;
  telephone: string | null;
}

interface RawRppsLookupRow extends RawRppsRow {
  identifiant_pp: string | null;
  siren: string | null;
  email: string | null;
}

interface RawRppsSearchRow extends RawRppsRow {
  /** Score trigram pg_trgm (0..1) — voir migration `20260511T100000_rpps_search_by_name`. */
  match_score: number | null;
}

function toResult(row: RawRppsRow): RppsResult {
  // Si geom est présent mais coordinates malformé (entry undefined), on retombe
  // explicitement sur null plutôt qu'un (0, 0) golfe de Guinée silencieux.
  const lat = row.geom?.coordinates[1];
  const lon = row.geom?.coordinates[0];
  const coords = typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
  return {
    id: row.id,
    rpps_id: row.rpps_id,
    identite: {
      nom: row.nom,
      prenom: row.prenom,
      civilite: row.civilite,
    },
    profession: { code: row.profession_code, libelle: row.profession_libelle },
    savoir_faire: { code: row.savoir_faire_code, libelle: row.savoir_faire_libelle },
    mode_exercice: { code: row.mode_exercice_code, libelle: row.mode_exercice_libelle },
    categorie: { code: row.categorie_code, libelle: row.categorie_libelle },
    structure: {
      num_finess: row.num_finess,
      num_finess_ej: row.num_finess_ej,
      siret: row.siret,
      raison_sociale: row.raison_sociale,
    },
    adresse: {
      voie: row.adresse,
      // CHAR(N) Postgres pad avec espaces — trim systématique pour ne pas
      // leak `"08 "` côté caller (cohérent finess-db.ts / ameli-db.ts).
      code_postal: trimOrNull(row.code_postal),
      ville: row.ville,
      code_departement: trimOrNull(row.code_departement),
      code_insee: trimOrNull(row.code_insee),
    },
    coords,
    distance_km: metersToKm(row.distance_meters),
    telephone: row.telephone,
  };
}

function toCompactResult(row: RawRppsCompactRow): RppsResult {
  return {
    id: row.id,
    rpps_id: row.rpps_id,
    identite: { nom: row.nom, prenom: row.prenom, civilite: row.civilite },
    profession: { code: row.profession_code, libelle: row.profession_libelle },
    savoir_faire: { code: row.savoir_faire_code, libelle: row.savoir_faire_libelle },
    mode_exercice: { code: row.mode_exercice_code, libelle: row.mode_exercice_libelle },
    categorie: { code: row.categorie_code, libelle: row.categorie_libelle },
    structure: {
      num_finess: row.num_finess,
      num_finess_ej: row.num_finess_ej,
      siret: null,
      raison_sociale: row.raison_sociale,
    },
    adresse: {
      voie: null,
      code_postal: null,
      ville: null,
      code_departement: null,
      code_insee: null,
    },
    coords: null,
    distance_km: null,
    telephone: row.telephone,
  };
}

function toLookupResult(row: RawRppsLookupRow): RppsLookupResult {
  // `categorie` est désormais porté par RppsResult (V0.5.1) — hérité via spread.
  return {
    ...toResult(row),
    identifiant_pp: row.identifiant_pp,
    siren: row.siren,
    email: row.email,
  };
}

function toSearchResult(row: RawRppsSearchRow): RppsResult {
  // `match_score` est ajouté uniquement quand la RPC l'a calculé (numeric
  // valide). Si la RPC renvoie `null` (cas dégénéré improbable), on omet le
  // champ plutôt que de leak un `match_score: null` côté caller MCP.
  const base = toResult(row);
  if (typeof row.match_score === "number" && Number.isFinite(row.match_score)) {
    return { ...base, match_score: row.match_score };
  }
  return base;
}
