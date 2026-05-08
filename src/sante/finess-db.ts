import { getAnonClient } from "../storage/supabase.js";
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
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(
      `[france-data-mcp] limit must be between 1 and ${MAX_LIMIT}, got ${limit}`,
    );
  }
  return limit;
}

function validateCoords(lat: number, lon: number): void {
  // PostGIS accepts any number, so a caller swapping lat/lon (e.g. lat=2.6,
  // lon=49.7) silently returns 0 results — indistinguishable from "no FINESS
  // here". Validate the WGS84 bounds so the failure is loud.
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`[france-data-mcp] lat must be in [-90, 90], got ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`[france-data-mcp] lon must be in [-180, 180], got ${lon}`);
  }
}

function familiesToCodes(familles: FinessFamilleQuery[] | undefined): string[] {
  if (!familles || familles.length === 0) return [];
  return familles.flatMap((f) => [...FINESS_FAMILY_CODES[f]]);
}

/**
 * Format a Supabase RPC error into a single string preserving the postgres
 * code, hint, and details — losing those fields turned a "permission denied"
 * incident in v0.2.0 into a 30-minute investigation. SFH review caught the
 * regression. Always include `error.code` so the operator can grep PgError
 * tables (PGRST205 / 42703 / etc.) directly.
 */
function formatRpcError(
  rpc: string,
  error: { code?: string; message: string; hint?: string; details?: string },
): string {
  const code = error.code ? ` (${error.code})` : "";
  const hint = error.hint ? ` — hint: ${error.hint}` : "";
  const details = error.details ? ` — details: ${error.details}` : "";
  return `[france-data-mcp] ${rpc}${code}: ${error.message}${details}${hint}`;
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
  return buildFinessQueryResult(data, limit);
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
  return buildFinessQueryResult(data, limit);
}

/**
 * Fetch a single FINESS establishment by its 9-digit FINESS number.
 * Returns null if not found. The audit (B3) flagged the absence of this
 * lookup — the radius/categorie tools couldn't be paired with a "give me
 * the full record" call.
 */
export async function getFinessByNumFiness(numFiness: string): Promise<FinessResult | null> {
  if (!/^\d{9}$/.test(numFiness)) {
    throw new Error(`[france-data-mcp] num_finess must be 9 digits, got "${numFiness}"`);
  }
  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_by_num_finess", {
    p_num_finess: numFiness,
  });
  if (error) {
    throw new Error(formatRpcError("finess_by_num_finess", error));
  }
  const rows = (data ?? []) as RawFinessRow[];
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
  return first ? toFinessResult(first) : null;
}

// --- internals -------------------------------------------------------------

function buildFinessQueryResult(data: unknown, limit: number): FinessQueryResult {
  const rows = (data ?? []) as RawFinessRow[];
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toFinessResult),
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

/**
 * Trim CHAR-padded fields. Postgres CHAR(N) right-pads with spaces, so a
 * dept "08" stored as CHAR(3) comes back as "08 ". Tools/clients shouldn't
 * have to special-case the padding — strip it once at the boundary.
 */
function trimOrNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
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
    distance_km:
      typeof row.distance_meters === "number"
        ? Math.round((row.distance_meters / 1000) * 100) / 100
        : null,
    telephone: trimOrNull(row.telephone),
    email: row.email,
  };
}
