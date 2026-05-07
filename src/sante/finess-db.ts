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
    throw new Error(`[france-data-mcp] finess_in_radius RPC failed: ${error.message}`);
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
    throw new Error(`[france-data-mcp] finess_by_categorie failed: ${error.message}`);
  }
  return buildFinessQueryResult(data, limit);
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
      code_postal: row.code_postal,
      ville: row.ville,
      code_insee: row.code_insee,
    },
    coords,
    distance_km:
      typeof row.distance_meters === "number"
        ? Math.round((row.distance_meters / 1000) * 100) / 100
        : null,
    telephone: row.telephone,
    email: row.email,
  };
}
