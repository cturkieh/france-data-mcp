/**
 * Centres de Santé (CDS) — wrappers typés autour des RPCs PostGIS Supabase.
 * Symétrique des modules `finess-db.ts` / `ameli-db.ts`.
 *
 * Source : Annuaire santé Ameli (CNAM) section CDS, ingéré via
 * `scripts/ingest/cds.ts` (cron lundi 06:00 UTC). Volume ~3K CDS uniques.
 *
 * ⚠️ Article L.1461-2 CSP : la mention obligatoire "Source : Annuaire santé
 * Ameli, Assurance Maladie" + date de la dernière sync est portée par les
 * descriptions des tools MCP (`api/tools.ts`) — ce module est le boundary
 * technique, pas le boundary public.
 *
 * Différenciateur métier vs FINESS catégorie 124 : carte_vitale, apcv,
 * spécialités exercées sur place. PAS d'horaires/tarifs/secteur 1/2 (retirés
 * par CNAM post-2025).
 */

import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { metersToKm } from "../core/numbers.js";
import { type QueryMetadata, cdsRadiusMetadata } from "../core/query-metadata.js";
import { getUntypedAnonClient } from "../storage/supabase.js";
import {
  assertValidNumFiness,
  buildListQueryResult,
  clampLimit,
  expectRpcRows,
  formatRpcError,
  trimOrNull,
  validateCoords,
  validateRadiusKm,
} from "./db-helpers.js";

/**
 * Codes type d'établissement CDS (Annexe B nomenclature CNAM). Source de
 * vérité unique — évite les strings brutes "124"/"125" éparpillées (un typo
 * "142" ne serait pas détecté). `STANDARD` (124) est le cas courant ;
 * `DENTAIRE` (125) est déprécié CNAM (en voie d'extinction, conservé pour
 * rétro-compat tant que le CSV l'expose).
 */
export const CDS_TYPE_ETAB = {
  STANDARD: "124",
  DENTAIRE: "125",
} as const;

export interface CdsResult {
  /** Numéro FINESS = clé naturelle. Pivot direct vers FINESS DREES. */
  etab_finess: string;
  raison_sociale: string;
  /** Donnée métier différenciante CNAM. */
  accepte_carte_vitale: boolean;
  accepte_apcv: boolean;
  /**
   * Spécialités exercées sur place. `codes[i]` ↔ `libelles[i]` (alignés à
   * l'ingestion par tri stable). Source : Annexe A nomenclature CNAM (~70 codes).
   */
  specialites: { codes: string[]; libelles: string[] };
  /**
   * `124` = CDS standard, `125` = CDS dentaire (déprécié CNAM, en voie
   * d'extinction). Le caller peut normaliser 125 → 124 si pertinent.
   */
  type_etab: { code: string; libelle: string };
  adresse: {
    voie: string | null;
    complement_voie: string | null;
    lieu_dit: string | null;
    code_postal: string;
    ville: string;
    code_departement: string;
    code_insee: string | null;
  };
  coords: { lat: number; lon: number } | null;
  distance_km: number | null;
  telephone: string | null;
}

export interface CdsInRadiusInput {
  center: { lat: number; lon: number };
  radiusKm: number;
  /**
   * Codes spécialité Ameli (Annexe A). Match `&&` array overlap (any-of) :
   * retourne les CDS qui exercent AU MOINS UNE des spécialités demandées.
   * Vide → pas de filtre spécialité.
   */
  specialiteCodes?: string[];
  /**
   * Filtre carte Vitale. `true` = retourne uniquement les CDS qui acceptent
   * la carte Vitale, `false` = uniquement ceux qui ne l'acceptent pas,
   * `undefined` = pas de filtre. (la quasi-totalité accepte CV en pratique,
   * filtre surtout utile en `false` pour audits.)
   */
  accepteCarteVitale?: boolean;
  /**
   * Codes type établissement Annexe B : `124` (CDS standard), `125` (CDS
   * dentaire déprécié). Vide → tous types.
   */
  typeEtabCodes?: string[];
  limit?: number;
}

export interface CdsQueryResult {
  count: number;
  truncated: boolean;
  results: CdsResult[];
  query_metadata?: QueryMetadata;
}

/**
 * Recherche les CDS dans un rayon géographique. Retourne `count` + `results`
 * triés par distance croissante. `truncated` = true si la base contient
 * plus de résultats que `limit` (ré-appeler avec un radius plus petit
 * ou un filtre plus strict pour explorer).
 *
 * Coords centroïde commune (~3 km) — adapté à l'analyse zone, PAS au
 * géocodage adresse précis. Pour la précision adresse, pivoter via
 * `etablissement_by_finess` avec `etab_finess`.
 */
export async function getCdsInRadius(input: CdsInRadiusInput): Promise<CdsQueryResult> {
  const limit = clampLimit(input.limit);
  validateCoords(input.center.lat, input.center.lon);
  validateRadiusKm(input.radiusKm);

  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("centres_sante_in_radius", {
    p_lat: input.center.lat,
    p_lon: input.center.lon,
    p_radius_meters: input.radiusKm * 1000,
    p_specialite_codes: input.specialiteCodes ?? [],
    // PostgreSQL accepte NULL via `null as unknown as boolean` (pattern aligné
    // sur ameli-db.ts pour les TEXT nullables côté RPC).
    p_accepte_carte_vitale: input.accepteCarteVitale ?? (null as unknown as boolean),
    p_type_etab_codes: input.typeEtabCodes ?? [],
    p_limit: limit + 1, // +1 pour détecter truncation
  });

  if (error) throw new Error(formatRpcError("centres_sante_in_radius", error));
  return buildListQueryResult<RawCdsRow, CdsResult, QueryMetadata>(
    "centres_sante_in_radius",
    data,
    limit,
    cdsRadiusMetadata(input.radiusKm),
    toCdsResult,
  );
}

/**
 * Lookup d'un CDS par son `etab_finess`. Retourne un `LookupResult` discriminé
 * (pattern aligné sur `getFinessByNumFiness` / `getEntrepriseBySiren`).
 *
 * `not_found` typique : etab_finess inexistant côté CNAM (cible une structure
 * non-CDS, ex: hôpital, EHPAD), ou CDS très récent (CNAM latence ~1 sem).
 */
export async function getCdsByFiness(numFiness: string): Promise<LookupResult<CdsResult>> {
  const trimmed = assertValidNumFiness(numFiness);
  // getUntypedAnonClient car le RPC `centres_sante_by_finess` (V0.10) n'est
  // pas dans la `Database` typée tant que `pnpm db:types` n'a pas été
  // regénéré post-migration. Pattern aligné sur countFiness/countRpps.
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("centres_sante_by_finess", {
    p_etab_finess: trimmed,
  });

  if (error) throw new Error(formatRpcError("centres_sante_by_finess", error));
  const rows = expectRpcRows<RawCdsRow>("centres_sante_by_finess", data);
  if (rows.length > 1) {
    // PK enforced côté table mais defense-in-depth (cf. lesson finess-db.ts) :
    // si un swap glitch ramène 2 rows, surface la violation au lieu de
    // silently picker la première.
    console.warn(
      `[france-data-mcp] centres_sante_by_finess(${trimmed}): RPC returned ${rows.length} rows (expected ≤ 1) — picking first. Investigate centres_sante PK integrity.`,
    );
  }
  const first = rows[0];
  if (!first) {
    return lookupNotFound(
      trimmed,
      `etab_finess "${trimmed}" introuvable dans la base CDS (Annuaire santé Ameli, dernière sync hebdomadaire). Causes possibles : numéro FINESS pointe vers une structure non-CDS (hôpital, EHPAD, labo — utiliser etablissement_by_finess), CDS très récent non encore propagé par CNAM (latence ~1 semaine), ou erreur de saisie.`,
    );
  }
  return lookupFound(toCdsResult(first));
}

// --- internals -------------------------------------------------------------

interface RawCdsRow {
  etab_finess: string;
  etab_raison_sociale: string;
  accepte_carte_vitale: boolean;
  accepte_apcv: boolean;
  specialites_codes: string[] | null;
  specialites_libelles: string[] | null;
  type_etab_code: string;
  type_etab_libelle: string;
  telephone: string | null;
  voie: string | null;
  complement_voie: string | null;
  lieu_dit: string | null;
  code_postal: string;
  ville: string;
  code_departement: string;
  code_insee: string | null;
  geom: { type: "Point"; coordinates: [number, number] } | null;
  distance_meters?: number | null;
}

/** Mappe une row PostgREST brute vers le shape métier `CdsResult`. */
function toCdsResult(row: RawCdsRow): CdsResult {
  // Aligné sur rpps-db.ts / finess-db.ts : geom malformé → null explicite
  // (pas de (0,0) Golfe-de-Guinée silencieux).
  const lat = row.geom?.coordinates[1];
  const lon = row.geom?.coordinates[0];
  const coords = typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
  const distance = metersToKm(row.distance_meters);
  return {
    etab_finess: row.etab_finess.trim(),
    raison_sociale: row.etab_raison_sociale,
    accepte_carte_vitale: row.accepte_carte_vitale,
    accepte_apcv: row.accepte_apcv,
    specialites: {
      codes: row.specialites_codes ?? [],
      libelles: row.specialites_libelles ?? [],
    },
    type_etab: { code: row.type_etab_code, libelle: row.type_etab_libelle },
    adresse: {
      voie: row.voie,
      complement_voie: row.complement_voie,
      lieu_dit: row.lieu_dit,
      // code_postal / code_departement = CHAR(N) NOT NULL en base : jamais
      // null, mais le type CHAR pad-droite avec des espaces → `.trim()`
      // direct (pas `trimOrNull(...) ?? row.x` qui réinjecterait la valeur
      // paddée non trimmée dans le seul cas où le trim servirait).
      code_postal: row.code_postal.trim(),
      ville: row.ville,
      code_departement: row.code_departement.trim(),
      code_insee: trimOrNull(row.code_insee),
    },
    coords,
    distance_km: distance,
    telephone: trimOrNull(row.telephone),
  };
}
