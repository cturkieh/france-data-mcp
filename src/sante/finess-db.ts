import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { metersToKm } from "../core/numbers.js";
import {
  type QueryMetadata,
  finessByCategorieMetadata,
  finessRadiusMetadata,
} from "../core/query-metadata.js";
import { getAnonClient } from "../storage/supabase.js";
import {
  assertValidNumFiness,
  clampLimit,
  expectRpcRows,
  formatRpcError,
  trimOrNull,
  validateCoords,
  validateRadiusKm,
} from "./db-helpers.js";
import {
  FINESS_FAMILY_CODES,
  type FinessFamille,
  type FinessFamilleQuery,
  finessFamille,
} from "./finess-categories.js";

export type { FinessFamilleQuery } from "./finess-categories.js";

export interface FinessResult {
  num_finess: string;
  raison_sociale: string;
  categorie: { code: string | null; libelle: string | null; famille: FinessFamille };
  adresse: {
    voie: string | null;
    code_postal: string | null;
    ville: string | null;
    code_departement: string | null;
    code_insee: string;
  };
  coords: { lat: number; lon: number } | null;
  distance_km: number | null;
  telephone: string | null;
  email: string | null;
}

export interface InRadiusInput {
  center: { lat: number; lon: number };
  radiusKm: number;
  familles?: FinessFamilleQuery[];
  limit?: number;
}

export interface ByCategorieInput {
  famille: FinessFamilleQuery;
  departement?: string;
  code_insee?: string;
  limit?: number;
}

export interface FinessQueryResult {
  count: number;
  truncated: boolean;
  results: FinessResult[];
  /**
   * Métadonnées sur la précision géo et le type de distance. Surface au
   * caller MCP que les coords proviennent du Lambert93 DREES (~adresse) et
   * que la distance est haversine (pas routière). Inclut un rappel sur la
   * latence DREES (~1-2 mois) pour les structures émergentes.
   *
   * Optionnel : tous les RPCs de prod la peuplent (cf. `getFinessInRadius`/
   * `getFinessByCategorie`) ; cas d'absence réservé aux mocks tests.
   */
  query_metadata?: QueryMetadata;
}

function familiesToCodes(familles: FinessFamilleQuery[] | undefined): string[] {
  if (!familles || familles.length === 0) return [];
  return familles.flatMap((f) => [...FINESS_FAMILY_CODES[f]]);
}

/**
 * Find FINESS establishments within a geographic radius. Spatial query uses
 * PostGIS ST_DWithin on the geography type for accurate kilometers.
 *
 * Implemented via a Postgres RPC (`finess_in_radius`, migration
 * 20260508000004) because supabase-js cannot express ST_DWithin / ST_Distance
 * through its query builder.
 */
export async function getFinessInRadius(input: InRadiusInput): Promise<FinessQueryResult> {
  const limit = clampLimit(input.limit);
  validateCoords(input.center.lat, input.center.lon);
  // Avant V0.4.1, le DB layer n'avait aucune validation de rayon — un caller
  // direct (lib npm, pas le MCP) pouvait passer `radiusKm: 1000` et faire
  // tourner ST_DWithin sur 95K rows pour rien. Le tool layer plafonnait, mais
  // le DB layer doit aussi se protéger : c'est lui le boundary public.
  validateRadiusKm(input.radiusKm);

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_in_radius", {
    p_lat: input.center.lat,
    p_lon: input.center.lon,
    p_radius_meters: input.radiusKm * 1000,
    p_codes: familiesToCodes(input.familles),
    p_limit: limit + 1, // +1 to detect truncation
  });

  if (error) {
    throw new Error(formatRpcError("finess_in_radius", error));
  }
  return buildFinessQueryResult("finess_in_radius", data, limit, finessRadiusMetadata());
}

/**
 * Find FINESS establishments by family (and optional dept / commune filters).
 * No spatial query — pure WHERE on category code list + optional location.
 */
export async function getFinessByCategorie(input: ByCategorieInput): Promise<FinessQueryResult> {
  const limit = clampLimit(input.limit);

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_by_categorie", {
    p_codes: [...FINESS_FAMILY_CODES[input.famille]],
    p_departement: input.departement ?? (null as unknown as string),
    p_code_insee: input.code_insee ?? (null as unknown as string),
    p_limit: limit + 1,
  });
  if (error) {
    throw new Error(formatRpcError("finess_by_categorie", error));
  }
  return buildFinessQueryResult("finess_by_categorie", data, limit, finessByCategorieMetadata());
}

/**
 * Fetch a single FINESS establishment by its 9-digit FINESS number.
 *
 * Retourne un `LookupResult` discriminé par `found`. Si le numéro n'existe
 * pas dans le dump FINESS DREES (numéro mal formé, fermeture récente non
 * encore propagée, frais d'établissement émergent — la base DREES a 1-2 mois
 * de retard sur le terrain), la fonction renvoie un objet `{ found: false,
 * lookupStatus: "not_found", message }` au lieu d'un `null` silencieux.
 * Pattern aligné sur `getEntrepriseBySiren` et `getCommuneByCode`
 * (cf. `src/core/lookup-result.ts`).
 */
export async function getFinessByNumFiness(numFiness: string): Promise<LookupResult<FinessResult>> {
  const trimmed = assertValidNumFiness(numFiness);
  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_by_num_finess", {
    p_num_finess: trimmed,
  });
  if (error) {
    throw new Error(formatRpcError("finess_by_num_finess", error));
  }
  const rows = expectRpcRows<RawFinessRow>("finess_by_num_finess", data);
  if (rows.length > 1) {
    // The RPC has a `LIMIT 1` clause, but defense-in-depth: if a deploy
    // glitch removed it, or if the table somehow had duplicate num_finess
    // (PK is enforced by `finess_staging` but rename-swap relies on
    // discipline), surface the violation loud instead of silently picking
    // the first row.
    console.warn(
      `[france-data-mcp] finess_by_num_finess(${numFiness}): RPC returned ${rows.length} rows (expected ≤ 1) — picking the first. Investigate finess table for duplicate num_finess.`,
    );
  }
  const first = rows[0];
  if (!first) {
    return lookupNotFound(
      numFiness,
      `Numéro FINESS "${numFiness}" introuvable dans la base DREES (dernière sync bimestrielle). Causes possibles : numéro inexistant, structure très récente non encore propagée par DREES (latence ~1-2 mois), erreur de saisie. Pour structures émergentes (CPTS, MSP récentes), cross-check avec ARS régionale ou Service Public.`,
    );
  }
  return lookupFound(toFinessResult(first));
}

// --- internals -------------------------------------------------------------

function buildFinessQueryResult(
  rpc: string,
  data: unknown,
  limit: number,
  metadata: QueryMetadata,
): FinessQueryResult {
  const rows = expectRpcRows<RawFinessRow>(rpc, data);
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toFinessResult),
    query_metadata: metadata,
  };
}

interface RawFinessRow {
  num_finess: string;
  raison_sociale: string;
  categorie_code: string | null;
  categorie_libelle: string | null;
  voie: string | null;
  code_postal: string | null;
  code_departement: string | null;
  code_insee: string;
  ville: string | null;
  telephone: string | null;
  email: string | null;
  geom: { type: "Point"; coordinates: [number, number] } | null;
  distance_meters?: number; // present only on RPC result
}

function toFinessResult(row: RawFinessRow): FinessResult {
  const coords = row.geom
    ? { lat: row.geom.coordinates[1] ?? 0, lon: row.geom.coordinates[0] ?? 0 }
    : null;
  return {
    num_finess: row.num_finess,
    raison_sociale: row.raison_sociale,
    categorie: {
      code: row.categorie_code,
      libelle: row.categorie_libelle,
      famille: finessFamille(row.categorie_code),
    },
    adresse: {
      voie: row.voie,
      code_postal: trimOrNull(row.code_postal),
      ville: row.ville,
      code_departement: trimOrNull(row.code_departement),
      code_insee: row.code_insee.trim(),
    },
    coords,
    distance_km: metersToKm(row.distance_meters),
    telephone: trimOrNull(row.telephone),
    email: row.email,
  };
}
