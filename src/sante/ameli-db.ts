/**
 * Annuaire Santé Ameli — wrappers typés autour des RPCs PostGIS.
 * Symétrique du module `finess-db.ts`. Source : data.gouv `annuaire-sante-ameli`.
 *
 * ⚠️ Article L.1461-2 CSP : la réutilisation des données nominatives doit
 * afficher la mention "Source : Annuaire santé Ameli, Assurance Maladie" et
 * la date de la dernière sync. La mention est portée par les descriptions des
 * tools MCP (`api/tools.ts`) — ce module est le boundary technique, pas le
 * boundary public.
 */

import { getAnonClient } from "../storage/supabase.js";
import { clampLimit, formatRpcError, trimOrNull, validateCoords } from "./db-helpers.js";

export interface AmeliResult {
  id: number;
  identite: {
    nom: string;
    prenom: string;
    civilite: string | null;
    raison_sociale: string | null;
  };
  specialite: { code: string | null; libelle: string | null };
  type_ps: { code: string | null; libelle: string | null };
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
  conventions: {
    secteur_code: string | null;
    secteur_libelle: string | null;
    nature_exercice_code: string | null;
    nature_exercice_libelle: string | null;
    option_tarifaire_code: string | null;
    option_tarifaire_libelle: string | null;
  };
}

export interface AmeliInRadiusInput {
  center: { lat: number; lon: number };
  radiusKm: number;
  /** Codes spécialité Ameli (ex: "01" MG, "03" cardio, etc.) — facultatif. */
  specialiteCodes?: string[];
  /** Codes type PS (ex: "1" médecin, "2" IDE, "3" sage-femme) — facultatif. */
  typePsCodes?: string[];
  limit?: number;
}

export interface AmeliBySpecialiteDeptInput {
  /** Code département (2 chars métropole/Corse, 3 chars DOM). Obligatoire. */
  departement: string;
  /** Code spécialité Ameli — facultatif. */
  specialiteCode?: string;
  /** Code type PS — facultatif. */
  typePsCode?: string;
  limit?: number;
}

export interface AmeliQueryResult {
  count: number;
  truncated: boolean;
  results: AmeliResult[];
}

const MAX_RADIUS_KM = 50;

function validateRadiusKm(radiusKm: number): void {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) {
    throw new RangeError(
      `[france-data-mcp] radiusKm must be in (0, ${MAX_RADIUS_KM}], got ${radiusKm}`,
    );
  }
}

function validateDepartement(dept: string): void {
  // Accepts "01"-"95" (excl "20"), "2A"/"2B", "971"-"978", "984"-"988".
  // Inlined to keep `Error` (not RangeError) for backward-compat with
  // callers and tests that match `/must be a valid INSEE code/`.
  if (dept === "2A" || dept === "2B") return;
  if (/^\d{2}$/.test(dept) && dept !== "20") return;
  if (/^(97[1-8]|98[4-8])$/.test(dept)) return;
  throw new Error(`[france-data-mcp] departement must be a valid INSEE code, got "${dept}"`);
}

/** Find PS within a geographic radius. */
export async function getAmeliInRadius(input: AmeliInRadiusInput): Promise<AmeliQueryResult> {
  const limit = clampLimit(input.limit);
  validateCoords(input.center.lat, input.center.lon);
  validateRadiusKm(input.radiusKm);

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("ameli_in_radius", {
    p_lat: input.center.lat,
    p_lon: input.center.lon,
    p_radius_meters: input.radiusKm * 1000,
    p_specialite_codes: input.specialiteCodes ?? [],
    p_type_ps_codes: input.typePsCodes ?? [],
    p_limit: limit + 1, // +1 to detect truncation
  });

  if (error) throw new Error(formatRpcError("ameli_in_radius", error));
  return buildAmeliQueryResult(data, limit);
}

/** List PS by department (+ optional specialty / type filter). */
export async function getAmeliBySpecialiteDept(
  input: AmeliBySpecialiteDeptInput,
): Promise<AmeliQueryResult> {
  const limit = clampLimit(input.limit);
  validateDepartement(input.departement);

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("ameli_by_specialite_dept", {
    p_departement: input.departement,
    p_specialite_code: input.specialiteCode ?? (null as unknown as string),
    p_type_ps_code: input.typePsCode ?? (null as unknown as string),
    p_limit: limit + 1,
  });

  if (error) throw new Error(formatRpcError("ameli_by_specialite_dept", error));
  return buildAmeliQueryResult(data, limit);
}

// --- internals -------------------------------------------------------------

function buildAmeliQueryResult(data: unknown, limit: number): AmeliQueryResult {
  const rows = (data ?? []) as RawAmeliRow[];
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    count: sliced.length,
    truncated,
    results: sliced.map(toAmeliResult),
  };
}

interface RawAmeliRow {
  id: number;
  nom: string;
  prenom: string;
  civilite: string | null;
  raison_sociale: string | null;
  specialite_code: string | null;
  specialite_libelle: string | null;
  type_ps_code: string | null;
  type_ps_libelle: string | null;
  adresse: string | null;
  code_postal: string | null;
  ville: string | null;
  code_departement: string | null;
  code_insee: string | null;
  secteur_conventionnel_code: string | null;
  secteur_conventionnel_libelle: string | null;
  nature_exercice_code: string | null;
  nature_exercice_libelle: string | null;
  option_tarifaire_code: string | null;
  option_tarifaire_libelle: string | null;
  telephone: string | null;
  geom: { type: "Point"; coordinates: [number, number] } | null;
  distance_meters?: number | null;
}

function toAmeliResult(row: RawAmeliRow): AmeliResult {
  const coords = row.geom
    ? { lat: row.geom.coordinates[1] ?? 0, lon: row.geom.coordinates[0] ?? 0 }
    : null;
  const distance =
    typeof row.distance_meters === "number"
      ? Math.round((row.distance_meters / 1000) * 100) / 100
      : null;
  return {
    id: row.id,
    identite: {
      nom: row.nom,
      prenom: row.prenom,
      civilite: row.civilite,
      raison_sociale: row.raison_sociale,
    },
    specialite: { code: row.specialite_code, libelle: row.specialite_libelle },
    type_ps: { code: row.type_ps_code, libelle: row.type_ps_libelle },
    adresse: {
      voie: row.adresse,
      code_postal: trimOrNull(row.code_postal),
      ville: row.ville,
      code_departement: trimOrNull(row.code_departement),
      code_insee: trimOrNull(row.code_insee),
    },
    coords,
    distance_km: distance,
    telephone: trimOrNull(row.telephone),
    conventions: {
      secteur_code: row.secteur_conventionnel_code,
      secteur_libelle: row.secteur_conventionnel_libelle,
      nature_exercice_code: row.nature_exercice_code,
      nature_exercice_libelle: row.nature_exercice_libelle,
      option_tarifaire_code: row.option_tarifaire_code,
      option_tarifaire_libelle: row.option_tarifaire_libelle,
    },
  };
}
