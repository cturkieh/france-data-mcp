/**
 * RPPS / Annuaire Santé ANS — wrappers typés autour des RPCs PostGIS.
 *
 * Source : data.gouv `annuaire-sante-extractions-...-rpps`, Licence Ouverte v2.0.
 * La mention obligatoire (ANS / Licence Ouverte v2.0) est portée par les
 * descriptions des tools MCP (`api/tools.ts`). Ce module est le boundary
 * technique, pas le boundary public.
 *
 * Diffère d'Ameli sur 3 points :
 * - couverture : libéraux + salariés + retraités (vs Ameli libéraux conventionnés)
 * - identifiant stable : `rpps_id` (IDNPS national) → lookup individuel + dédup
 * - pivot structure : `num_finess` exposé en colonne → croisement avec FINESS
 */

import { metersToKm } from "../core/numbers.js";
import {
  type QueryMetadata,
  rppsDeptMetadata,
  rppsEtablissementMetadata,
  rppsRadiusMetadata,
} from "../core/query-metadata.js";
import { getUntypedAnonClient } from "../storage/supabase.js";
import { assertValidDept } from "../territoire/dept-codes.js";
import {
  clampLimit,
  clampOffset,
  expectRpcRows,
  formatRpcError,
  trimOrNull,
  validateCoords,
  validateRadiusKm,
} from "./db-helpers.js";
import type { GeoJsonPoint } from "./rpps-types.js";

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
  /**
   * Catégorie professionnelle ANS — distingue actifs (Civil C, Militaire M)
   * de Retraité (R) / Étudiant (E) / Suspendu (S) / Décédé (D). Le filtre
   * default des RPCs masque les inactifs sauf si `include_inactifs:true`.
   */
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
   * Codes catégorie professionnelle ANS. Vide ou omis → filtre default actifs
   * (`C` Civil + `M` Militaire + `IS NULL`). Sinon → filtre exact ANY. Pour
   * « tous les statuts » passer la liste exhaustive `CATEGORIE_CODES_TOUS_STATUTS`.
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

/**
 * Liste exhaustive des codes catégorie ANS (actifs + inactifs). Sert de
 * sentinelle pour les callers MCP qui veulent désactiver le filtre default
 * (`include_inactifs: true`). Le RPC SQL applique son default actifs quand
 * `cardinality(p_categorie_codes) = 0`, donc passer cette liste exhaustive
 * est sémantiquement équivalent à « pas de filtre ».
 */
export const CATEGORIE_CODES_TOUS_STATUTS = ["C", "M", "R", "E", "S", "D"];

export interface RppsQueryResult {
  count: number;
  truncated: boolean;
  results: RppsResult[];
  query_metadata?: QueryMetadata;
}

// --- Public query functions ------------------------------------------------

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
  const { data, error } = await supabase.rpc("rpps_par_specialite_dept", {
    p_departement: input.departement,
    p_profession_code: input.professionCode ?? null,
    p_savoir_faire_code: input.savoirFaireCode ?? null,
    p_mode_exercice_code: input.modeExerciceCode ?? null,
    p_categorie_codes: input.categorieCodes ?? [],
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
  const numFiness = input.numFiness.trim();
  if (!/^\d{9}$/.test(numFiness)) {
    throw new RangeError(
      `[france-data-mcp] num_finess invalide "${input.numFiness}" — attendu 9 chiffres (FINESS site).`,
    );
  }

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
 * Lookup individuel par RPPS ID. Renvoie N rows quand un PS multi-sites
 * existe (1 ligne par site). Le caller MCP aplatit en `(rpps_id, sites[])`.
 */
export async function getRppsById(rppsId: string): Promise<RppsLookupResult[]> {
  const trimmed = rppsId.trim();
  if (!/^\d{11}$/.test(trimmed)) {
    throw new RangeError(
      `[france-data-mcp] rpps_id invalide "${rppsId}" — attendu 11 chiffres (IDNPS).`,
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
