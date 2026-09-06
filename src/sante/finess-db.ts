import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { metersToKm } from "../core/numbers.js";
import {
  type PerResultGeoPrecision,
  type QueryMetadata,
  finessByCategorieMetadata,
  finessRadiusMetadata,
} from "../core/query-metadata.js";
import { createWarnOnce } from "../core/warn-once.js";
import { getAnonClient, getUntypedAnonClient } from "../storage/supabase.js";
import { assertValidCodeInsee, assertValidDept } from "../territoire/dept-codes.js";
import {
  assertValidNumFiness,
  buildListQueryResult,
  clampLimit,
  expectRpcRows,
  expectSingleRow,
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
import { GEOM_SOURCES, isFinessGeomSource } from "./finess-geom-source.js";

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
  /**
   * Précision du point, présent UNIQUEMENT quand `coords` l'est (même contrat
   * qu'Ameli/RPPS). Toujours `adresse` côté FINESS : point WGS84 natif ANS,
   * point BAN accepté par précision (rue/lieu-dit/bâtiment) ou hérité de l'un
   * des deux — jamais un centroïde commune (doctrine 20260905T210000 : le cron
   * RPPS recopie ce point en tier précis). Dérivé de `finess.geom_source`
   * (migration 20260906T160000) ; l'origine fine reste interne.
   */
  geo_precision?: Extract<PerResultGeoPrecision, "adresse">;
  /**
   * SIRET déclaré par l'ANS pour cet établissement (`informationsGeneralesEGE
   * .siret`, 14 chiffres) — FAIT BRUT, jamais vérifié contre SIRENE ici (un
   * SIRET ANS peut être fermé). Présent sur ~87 % des EGE (2026-09-06). Le
   * resolver SIRET (`siret-resolver.ts`) le prend comme candidat et le
   * confronte à DINUM ; `reconcilier_finess_sirene` / `verifier_site_actif`
   * exposent le verdict.
   */
  siret_ans: string | null;
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
   * caller MCP que les coords sont le point de l'établissement (ANS/BAN,
   * précision adresse) et que la distance est haversine (pas routière).
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

export interface CountFinessInput {
  /** Famille FINESS (mappe vers les codes catégorie via FINESS_FAMILY_CODES). */
  famille: FinessFamilleQuery;
  /** Code département (2-3 chars). Omis ou null → comptage France entière. */
  departement?: string | null;
}

/**
 * Compte les établissements FINESS d'une famille (RPC `count_finess` V0.8).
 * Sert de brique pour `densiteEtablissementsSante`.
 *
 * `departement` omis ou null → comptage France entière. La famille est
 * obligatoire (la RPC throw si codes vides — compter "tous établissements"
 * mélangerait labos, hôpitaux, EHPAD et n'aurait pas de sens).
 */
export async function countFiness(input: CountFinessInput): Promise<number> {
  // Validation TS avant network roundtrip — sinon dept malformé part en
  // parallèle (Promise.all densite.ts) et la RPC répond ERRCODE 22023 wrappé
  // en -32603 internal_error côté MCP au lieu d'un -32602 invalid_params propre.
  // Mirror exact du contrat de countRpps.
  if (input.departement !== undefined && input.departement !== null) {
    assertValidDept(input.departement);
  }
  const codes = [...FINESS_FAMILY_CODES[input.famille]];
  // Untyped client : la RPC count_finess (V0.8) n'est pas encore dans les
  // types Supabase générés (regen via `pnpm db:types` après apply prod).
  // Pattern aligné sur countRpps qui utilise aussi getUntypedAnonClient.
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("count_finess", {
    p_dept: input.departement ?? null,
    p_categorie_codes: codes,
  });
  if (error) throw new Error(formatRpcError("count_finess", error));
  if (typeof data !== "number") {
    throw new Error(
      `count_finess returned unexpected type ${typeof data} (famille=${input.famille}, dept=${input.departement ?? "FRANCE"}, expected number, got: ${JSON.stringify(data)})`,
    );
  }
  return data;
}

export interface CountFinessByCommuneInput {
  /** Famille FINESS (mappe vers les codes catégorie via FINESS_FAMILY_CODES). */
  famille: FinessFamilleQuery;
  /** Code INSEE commune (5 chars exact, format CHAR(5) côté Postgres). */
  codeInsee: string;
}

/**
 * Compte les établissements FINESS d'une famille dans une commune INSEE
 * (RPC `count_finess_by_commune`, V0.20 — jumeau de `countRppsByCommune` V0.9).
 *
 * Brique pour `densiteEtablissementsSante` au niveau commune. La RPC valide
 * elle-même le format `code_insee` + garde-fou table vide (ERRCODE P0002 si
 * un swap ingest cassé a vidé `finess` — refus de retourner 0 silencieusement,
 * cf. lessons learned V0.8.1).
 *
 * Limitation Paris/Marseille/Lyon : les FINESS portent l'INSEE arrondissement
 * (75101-75120, 13201-13216, 69381-69389). Caller doit `assertNotPlmCommune`
 * AVANT cet appel pour rejet préemptif (cf. densite.ts).
 */
export async function countFinessByCommune(input: CountFinessByCommuneInput): Promise<number> {
  // Validation TS avant roundtrip — sinon code_insee malformé part en parallèle
  // (Promise.all densite.ts) et la RPC répond ERRCODE 22023 wrappé en -32603
  // au lieu d'un -32602 propre. Mirror exact du contrat de countRppsByCommune.
  assertValidCodeInsee(input.codeInsee);
  const codes = [...FINESS_FAMILY_CODES[input.famille]];
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("count_finess_by_commune", {
    p_code_insee: input.codeInsee,
    p_categorie_codes: codes,
  });
  if (error) throw new Error(formatRpcError("count_finess_by_commune", error));
  if (typeof data !== "number") {
    throw new Error(
      `count_finess_by_commune returned unexpected type ${typeof data} (famille=${input.famille}, codeInsee=${input.codeInsee}, expected number, got: ${JSON.stringify(data)})`,
    );
  }
  return data;
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
  // Depuis 20260906T170000 la RPC caste ses paramètres en CHAR(n) (index
  // utilisable) — un cast TRONQUE en silence une valeur trop longue
  // (`751011` → `75101`, 1er arrondissement). Le DB layer est le boundary
  // public : mêmes gardes que `countFiness` / `countFinessByCommune`.
  if (input.departement !== undefined) assertValidDept(input.departement);
  if (input.code_insee !== undefined) assertValidCodeInsee(input.code_insee);

  // Untyped client : les types Supabase générés exigent `string` pour
  // `p_departement`/`p_code_insee` alors que la RPC accepte `null` (= "pas de
  // filtre"). Sans untyped, on tombait sur `null as unknown as string` overkill.
  // Pattern aligné sur `countFiness` et tous les wrappers `rpps-db.ts`.
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("finess_by_categorie", {
    p_codes: [...FINESS_FAMILY_CODES[input.famille]],
    p_departement: input.departement ?? null,
    p_code_insee: input.code_insee ?? null,
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
 * Retourne un `LookupResult` discriminé par `found`. Si le numéro n'est pas
 * un établissement EN SERVICE du flux ANS (numéro mal formé, fermé, trop
 * récent), la fonction renvoie un objet `{ found: false,
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
  // Defense-in-depth via `expectSingleRow` : la RPC a `LIMIT 1`, mais un
  // deploy glitch qui le retirait ou un swap qui laissait des doublons
  // doit surfacer LOUD (warn console.warn), pas silently picker la
  // première row. Source unique du pattern dans `db-helpers.ts`.
  const rows = expectRpcRows<RawFinessRow>("finess_by_num_finess", data);
  const first = expectSingleRow(
    "finess_by_num_finess",
    rows,
    numFiness,
    "Investigate finess table for duplicate num_finess.",
  );
  if (!first) {
    return lookupNotFound(
      numFiness,
      `Numéro FINESS "${numFiness}" introuvable parmi les établissements EN SERVICE du flux FINESS ANS (quotidien, ingéré le 1ᵉʳ et le 15). Causes possibles : numéro inexistant, établissement fermé (les fermés ne sont pas servis), structure très récente pas encore dans le flux, erreur de saisie. Pour structures émergentes (CPTS, MSP récentes), cross-check avec ARS régionale ou Service Public.`,
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
  // Dégradation VISIBLE au contrat, pas seulement au log : si la RPC ne
  // renvoie pas la colonne de provenance, `geo_precision: "adresse"` n'est
  // garanti que par la contrainte SQL, et le caller doit le savoir (Ameli
  // dégrade son étiquette ; ici l'étiquette reste juste, la note dit pourquoi).
  const lacking = Array.isArray(data)
    ? (data as RawFinessRow[]).filter(lacksProvenanceColumn).length
    : 0;
  const meta =
    lacking > 0
      ? {
          ...metadata,
          notes: [
            ...metadata.notes,
            `${lacking} établissement(s) servi(s) sans colonne de provenance du point (RPC antérieure à 20260906T160000 ou drift) — geo_precision "adresse" garanti par la contrainte de la table, pas par la ligne.`,
          ],
        }
      : metadata;
  return buildListQueryResult<RawFinessRow, FinessResult, QueryMetadata>(
    rpc,
    data,
    limit,
    meta,
    toFinessResult,
  );
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
  /** CHAR(14) ou null — RPC ≥ 20260906T160000 ; `undefined` = RPC antérieure. */
  siret?: string | null;
  /** Vocabulaire `GEOM_SOURCES` ou null (sans point) — RPC ≥ 20260906T160000 ; `undefined` = RPC antérieure. */
  geom_source?: string | null;
}

const provenanceMissingWarn = createWarnOnce();

/** Test-only — réarme le warn 1-shot « point sans provenance » (`core/warn-once`). */
export const _resetFinessGeoPrecisionMissingWarning = provenanceMissingWarn.reset;

/** Ligne géolocalisée dont la RPC n'a pas renvoyé la colonne `geom_source` (clé ABSENTE). */
function lacksProvenanceColumn(row: RawFinessRow): boolean {
  return row.geom !== null && row.geom_source === undefined;
}

/**
 * Garde de contrat sur la provenance d'un point SERVI (appelée seulement
 * quand `coords` est présent). Trois issues, alignées sur les jumelles :
 *  - valeur du vocabulaire fermé (`GEOM_SOURCES`) : rien à faire, le point
 *    est à l'adresse par construction (contrainte CHECK + doctrine « jamais
 *    de centroïde dans finess.geom ») → `geo_precision: "adresse"` au site
 *    d'appel ;
 *  - clé ABSENTE (`undefined`) : RPC antérieure à 20260906T160000 (fenêtre de
 *    déploiement) — warn 1-shot + note dans `query_metadata` (le caller voit
 *    la dégradation, pas seulement le log), on sert `adresse` (c'est ce que
 *    la contrainte garantit pour tout point en base) ;
 *  - `null` AVEC un point, ou valeur INCONNUE : états impossibles par la
 *    contrainte `geom ⇔ geom_source` / le CHECK → throw, comme
 *    `rpps-db.ts:assertGeoPrecision`. Les servir en `adresse` serait mentir
 *    vers le haut (un futur `commune_centroid` passé par une migration sans
 *    mise à jour de la lib doit casser LOUD).
 */
function assertFinessPointProvenance(row: RawFinessRow): void {
  const source = row.geom_source;
  if (source === undefined) {
    provenanceMissingWarn.warn(
      `[france-data-mcp][finess-db] RPC returned geolocated rows without a geom_source column (first: num_finess=${row.num_finess}) — RPC pre-20260906T160000 OR contract drift; geo_precision still reported as "adresse" (guaranteed by the finess CHECK), noted in query_metadata`,
    );
    return;
  }
  if (source === null || !isFinessGeomSource(source)) {
    throw new Error(
      `[france-data-mcp] finess RPC contract violation — geom_source=${JSON.stringify(source)} sur un point servi (num_finess=${row.num_finess}) ; attendu une valeur de {${Object.values(GEOM_SOURCES).join(", ")}} (contrainte geom ⇔ geom_source + CHECK). Migration drift ?`,
    );
  }
}

function toFinessResult(row: RawFinessRow): FinessResult {
  // Aligné sur `rpps-db.ts:toResult` : si `geom` est présent mais `coordinates`
  // malformé (entry undefined ou non-number), on retombe explicitement sur null
  // plutôt qu'un (0,0) Golfe-de-Guinée silencieux qui masquerait un drift schéma.
  const lat = row.geom?.coordinates[1];
  const lon = row.geom?.coordinates[0];
  const coords = typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
  // Un point servi porte toujours la précision `adresse` (doctrine « jamais de
  // centroïde dans finess.geom ») ; la garde vérifie que la base le dit aussi.
  if (coords) assertFinessPointProvenance(row);
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
    ...(coords ? { geo_precision: "adresse" as const } : {}),
    siret_ans: trimOrNull(row.siret),
    telephone: trimOrNull(row.telephone),
    email: row.email,
  };
}
