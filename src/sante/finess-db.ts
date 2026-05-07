import { getAnonClient } from "../storage/supabase.js";
import { type FinessFamille, finessFamille } from "./finess-categories.js";

// Filter type: a strict subset of FinessFamille — we don't expose "autre" as
// a query input because it would require an inverse-match (everything-except)
// which is YAGNI for V0.2. To get "autre" results, omit `familles` entirely
// and post-filter on the client side via result.categorie.famille.
export type FinessFamilleQuery = Exclude<FinessFamille, "autre">;

// Authoritative DREES code lists per family (kept in sync with finessFamille()
// in finess-categories.ts). Centralised here for the query layer to translate
// user-facing family names into DB code lists.
const FAMILLE_QUERY_CODES: Record<FinessFamilleQuery, readonly string[]> = {
  mco: ["108", "355", "354", "295", "365", "106"],
  ssr: ["109"],
  ehpad: ["500", "501", "502"],
};

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

function familiesToCodes(familles: FinessFamilleQuery[] | undefined): string[] {
  if (!familles || familles.length === 0) return [];
  return familles.flatMap((f) => FAMILLE_QUERY_CODES[f]) as string[];
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

  const rows = (data ?? []) as RawFinessRow[];
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;

  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toFinessResult),
  };
}

/**
 * Find FINESS establishments by family (and optional dept / commune filters).
 * No spatial query — pure WHERE on category code list + optional location.
 */
export async function getFinessByCategorie(input: ByCategorieInput): Promise<FinessQueryResult> {
  const limit = clampLimit(input.limit);

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_by_categorie", {
    p_codes: [...FAMILLE_QUERY_CODES[input.famille]],
    p_departement: input.departement ?? (null as unknown as string),
    p_code_insee: input.code_insee ?? (null as unknown as string),
    p_limit: limit + 1,
  });
  if (error) {
    throw new Error(`[france-data-mcp] finess_by_categorie failed: ${error.message}`);
  }

  const rows = (data ?? []) as RawFinessRow[];
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;

  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toFinessResult),
  };
}

// --- internals -------------------------------------------------------------

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
