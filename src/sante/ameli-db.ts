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

import { metersToKm } from "../core/numbers.js";
import {
  type PerResultGeoPrecision,
  type QueryMetadata,
  ameliDeptMetadata,
  ameliRadiusMetadata,
} from "../core/query-metadata.js";
import { getAnonClient } from "../storage/supabase.js";
import { assertValidDept } from "../territoire/dept-codes.js";
import {
  AMELI_TYPE_PS_QUERYABLE,
  clarifySecteurLibelle,
  clarifyTypePsLibelle,
} from "./ameli-nomenclature.js";
import {
  buildListQueryResult,
  clampLimit,
  clampOffset,
  expectRpcRows,
  formatRpcError,
  trimOrNull,
  validateCoords,
  validateRadiusKm,
} from "./db-helpers.js";

export interface AmeliResult {
  id: number;
  identite: {
    nom: string;
    prenom: string;
    civilite: string | null;
  };
  specialite: { code: string | null; libelle: string | null };
  type_ps: { code: string | null; libelle: string | null };
  adresse: {
    voie: string | null;
    code_postal: string | null;
    ville: string | null;
    code_departement: string | null;
    code_insee: string | null;
    /**
     * Raison sociale de la STRUCTURE d'exercice à cette adresse — attribut de
     * site, pas de personne (un PS exerçant sur 2 sites a 2 raisons sociales).
     * Sous `adresse` (et non `identite`) pour que le regroupement par identité
     * (`dedupe_by_ps`) conserve la raison sociale propre à chaque site.
     */
    raison_sociale: string | null;
  };
  coords: { lat: number; lon: number } | null;
  distance_km: number | null;
  /** Présent quand `coords` est non-null. Voir {@link PerResultGeoPrecision}. */
  geo_precision?: PerResultGeoPrecision;
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
  /**
   * Décalage de pagination (≥ 0, défaut 0). Permet d'énumérer un département
   * à fort effectif (ex: Paris IDE > 1000) en re-paginant tant que
   * `truncated=true`.
   */
  offset?: number;
}

export interface AmeliQueryResult {
  count: number;
  truncated: boolean;
  results: AmeliResult[];
  /**
   * Métadonnées sur la précision géo et le type de distance. Surface au
   * caller MCP que les coords sont au centroïde commune (~3 km, pas
   * adresse) et que la distance est haversine (pas routière).
   *
   * Optionnel pour ne pas alourdir les call-sites de mock côté tests —
   * les RPCs de prod (cf. `getAmeliInRadius`/`getAmeliBySpecialiteDept`)
   * la peuplent toujours, c'est l'unique source d'absence du champ.
   */
  query_metadata?: QueryMetadata;
}

/** Une spécialité présente dans la nomenclature Ameli, avec son count en base. */
export interface AmeliSpecialiteEntry {
  /** Code spécialité Ameli (ex : "01" MG, "24" Infirmier, "26" Kiné). */
  code: string;
  /** Libellé natif Ameli — peut être partagé par plusieurs codes (ex : "Médecin généraliste" pour 01/22/23). */
  libelle: string;
  /**
   * Libellé désambiguïsé : identique à `libelle` quand le libellé est unique,
   * suffixé `" (code {code}, {count_compact})"` quand ≥ 2 codes le partagent.
   * Calculé côté SQL via window function — robuste aux MAJ Ameli (data-driven).
   */
  libelle_clarifie: string;
  /** Type de PS auquel cette spécialité est rattachée. */
  type_ps_code: string;
  /** Libellé natif Ameli du type_ps (peut être ambigu, cf. clarifyTypePsLibelle). */
  type_ps_libelle: string;
  /** Nombre d'entrées en base pour ce couple (specialite, type_ps). */
  count: number;
  /** True ssi au moins 2 codes spécialité partagent le même `libelle`. */
  is_libelle_partage: boolean;
}

/**
 * Description d'un `type_ps_code` enrichie de la liste des spécialités
 * effectivement regroupées dessous (résout l'ambiguïté du libellé natif).
 *
 * Distinct du type statique `AmeliTypePsEntry` exposé par
 * `ameli-nomenclature.ts` : ce dernier sert pour les helpers de clarification
 * sans toucher la base ; celui-ci est le shape retourné par le RPC live.
 */
export interface AmeliTypePsListEntry {
  /** Code natif Ameli (1, 2, 5 — codes 3 et 4 filtrés à l'ingestion). */
  code: string;
  /**
   * Libellé natif Ameli, tel qu'il apparaît dans le CSV upstream. Conservé
   * pour traçabilité — c'est ce que renvoient aussi les autres tools.
   */
  libelle_source: string;
  /**
   * Libellé clarifié quand le source est ambigu (cas du code "2"). Si la
   * source matche notre référence, on applique le clarifié ; sinon on
   * garde la source pour rester honnête (drift detection).
   */
  libelle_clarifie: string;
  /** Total d'entrées sous ce type_ps. */
  count: number;
  /**
   * Liste des spécialités effectivement présentes sous ce type_ps, avec
   * leur count individuel. Cas du code "2" : exposera Infirmier, Kiné,
   * Orthophoniste, Pédicure-podologue, Sage-femme, Orthoptiste, IPA.
   */
  specialites_presentes: Array<{
    code: string;
    libelle: string;
    count: number;
  }>;
}

// `validateDepartement` consolidé V0.4.3 : utilise `assertValidDept` partagé
// (cf. `src/territoire/dept-codes.ts`) — single source of truth avec FINESS et
// commune-index. Throw RangeError pour cohérence avec les autres validators
// DB layer (`validateCoords`, `validateRadiusKm`).

/**
 * Garde de typage : un caller passant `type_ps_codes=["3"]` (laboratoires,
 * filtré à l'ingestion) recevait silencieusement un résultat vide. On lève
 * un RangeError clair pour orienter vers la bonne dimension de filtre.
 *
 * Pas de validation côté `specialite_codes` : ~88 codes vivants en base, la
 * nomenclature live est exposée par `lister_specialites_ameli` — laisser
 * le SQL `= ANY(...)` retourner naturellement vide pour les codes invalides.
 */
function validateTypePsCodes(codes: readonly string[] | undefined): void {
  if (!codes || codes.length === 0) return;
  for (const code of codes) {
    if (!AMELI_TYPE_PS_QUERYABLE.includes(code)) {
      throw new RangeError(
        `[france-data-mcp] type_ps_code "${code}" n'est pas filtrable (présents en base : ${AMELI_TYPE_PS_QUERYABLE.join(", ")}). Codes "3" (laboratoires) et "4" (non-conventionnés) sont filtrés à l'ingestion — voir FINESS pour ces personnes morales.`,
      );
    }
  }
}

/** Find PS within a geographic radius. */
export async function getAmeliInRadius(input: AmeliInRadiusInput): Promise<AmeliQueryResult> {
  const limit = clampLimit(input.limit);
  validateCoords(input.center.lat, input.center.lon);
  validateRadiusKm(input.radiusKm);
  validateTypePsCodes(input.typePsCodes);

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
  return buildAmeliQueryResult("ameli_in_radius", data, limit, ameliRadiusMetadata(input.radiusKm));
}

/** List PS by department (+ optional specialty / type filter, optional offset). */
export async function getAmeliBySpecialiteDept(
  input: AmeliBySpecialiteDeptInput,
): Promise<AmeliQueryResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  assertValidDept(input.departement);
  validateTypePsCodes(input.typePsCode ? [input.typePsCode] : undefined);

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("ameli_by_specialite_dept", {
    p_departement: input.departement,
    p_specialite_code: input.specialiteCode ?? (null as unknown as string),
    p_type_ps_code: input.typePsCode ?? (null as unknown as string),
    p_limit: limit + 1,
    p_offset: offset,
  });

  if (error) throw new Error(formatRpcError("ameli_by_specialite_dept", error));
  return buildAmeliQueryResult("ameli_by_specialite_dept", data, limit, ameliDeptMetadata());
}

// --- internals -------------------------------------------------------------

function buildAmeliQueryResult(
  rpc: string,
  data: unknown,
  limit: number,
  metadata: QueryMetadata,
): AmeliQueryResult {
  return buildListQueryResult<RawAmeliRow, AmeliResult, QueryMetadata>(
    rpc,
    data,
    limit,
    metadata,
    toAmeliResult,
  );
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
  // Aligné sur `rpps-db.ts:toResult` et `finess-db.ts:toFinessResult` (V0.9.2) :
  // si `geom` est présent mais `coordinates` malformé (entry undefined ou
  // non-number), on retombe explicitement sur null plutôt qu'un (0,0)
  // Golfe-de-Guinée silencieux qui masquerait un drift schéma.
  const lat = row.geom?.coordinates[1];
  const lon = row.geom?.coordinates[0];
  const coords = typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
  const distance = metersToKm(row.distance_meters);
  return {
    id: row.id,
    identite: {
      nom: row.nom,
      prenom: row.prenom,
      civilite: row.civilite,
    },
    specialite: { code: row.specialite_code, libelle: row.specialite_libelle },
    type_ps: { code: row.type_ps_code, libelle: row.type_ps_libelle },
    adresse: {
      voie: row.adresse,
      code_postal: trimOrNull(row.code_postal),
      ville: row.ville,
      code_departement: trimOrNull(row.code_departement),
      code_insee: trimOrNull(row.code_insee),
      raison_sociale: row.raison_sociale,
    },
    coords,
    distance_km: distance,
    ...(coords ? { geo_precision: "centroide_commune" as const } : {}),
    telephone: trimOrNull(row.telephone),
    conventions: {
      secteur_code: row.secteur_conventionnel_code,
      secteur_libelle: clarifySecteurLibelle(
        row.secteur_conventionnel_code,
        row.secteur_conventionnel_libelle,
      ),
      nature_exercice_code: row.nature_exercice_code,
      nature_exercice_libelle: row.nature_exercice_libelle,
      option_tarifaire_code: row.option_tarifaire_code,
      option_tarifaire_libelle: row.option_tarifaire_libelle,
    },
  };
}

// --- Nomenclature listings -------------------------------------------------

interface RawSpecialiteRow {
  code: string | null;
  libelle: string | null;
  /**
   * Optionnel pour rester rétro-compatible avec un RPC pas encore migré : on
   * tombe alors sur `libelle` brut côté mapping.
   */
  libelle_clarifie?: string | null;
  type_ps_code: string | null;
  type_ps_libelle: string | null;
  count: number | string | null;
  /** True ssi ≥ 2 codes partagent le même `libelle`. */
  is_libelle_partage?: boolean | null;
}

interface RawSpecialiteAggInTypePs {
  code: string | null;
  libelle: string | null;
  count: number | string | null;
}

interface RawTypePsRow {
  code: string | null;
  libelle_source: string | null;
  count: number | string | null;
  specialites_presentes: RawSpecialiteAggInTypePs[] | null;
}

/**
 * Coerce un count remonté par PostgREST. Les BIGINT sont sérialisés en string
 * par défaut côté supabase-js — un parseInt brut donnerait `NaN` silencieux
 * sur `null`, ce qu'on refuse par discipline (cf. règles silent-failure).
 */
function coerceCount(raw: number | string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Liste les spécialités Ameli effectivement présentes en base, avec leur
 * count et le `type_ps_code` associé. Triées par fréquence décroissante.
 *
 * Plus utile qu'un dictionnaire hardcodé : reflète automatiquement les
 * évolutions du CSV upstream (nouveau code spécialité ajouté par Ameli)
 * sans nécessiter de release. Le caller MCP peut découvrir la nomenclature
 * à la volée et choisir le bon `specialite_code` pour ses filtres.
 */
export async function listAmeliSpecialites(): Promise<AmeliSpecialiteEntry[]> {
  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("ameli_lister_specialites");
  if (error) throw new Error(formatRpcError("ameli_lister_specialites", error));
  const rows = expectRpcRows<RawSpecialiteRow>("ameli_lister_specialites", data);
  const out: AmeliSpecialiteEntry[] = [];
  for (const row of rows) {
    if (!row.code || !row.type_ps_code) continue;
    const libelle = row.libelle ?? "";
    out.push({
      code: row.code,
      libelle,
      // Fallback sur `libelle` si le RPC n'est pas encore migré (colonne
      // absente) ou si la valeur est null. Garantit toujours une string.
      libelle_clarifie: row.libelle_clarifie ?? libelle,
      type_ps_code: row.type_ps_code,
      type_ps_libelle: row.type_ps_libelle ?? "",
      count: coerceCount(row.count),
      // Strict `=== true` : null/undefined/0/string traités comme false.
      is_libelle_partage: row.is_libelle_partage === true,
    });
  }
  return out;
}

/**
 * Liste les `type_ps_code` Ameli présents en base avec, pour chacun, la liste
 * des spécialités effectivement regroupées dessous. Résout empiriquement
 * l'ambiguïté du libellé natif Ameli pour le code "2" (fourre-tout qui
 * mentionne "chirurgien-dentiste" alors que les dentistes ont le code 5).
 *
 * Le libellé clarifié n'est appliqué que si le libellé source matche notre
 * référence (`AMELI_TYPE_PS_NOMENCLATURE`) — sinon on garde la source pour
 * détecter un drift Ameli sans corrompre la donnée.
 */
export async function listAmeliTypesPs(): Promise<AmeliTypePsListEntry[]> {
  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("ameli_lister_types_ps");
  if (error) throw new Error(formatRpcError("ameli_lister_types_ps", error));
  const rows = expectRpcRows<RawTypePsRow>("ameli_lister_types_ps", data);
  const out: AmeliTypePsListEntry[] = [];
  for (const row of rows) {
    if (!row.code) continue;
    const source = row.libelle_source ?? "";
    const clarified = clarifyTypePsLibelle(row.code, source) ?? source;
    const specialites = (row.specialites_presentes ?? [])
      .filter((s): s is RawSpecialiteAggInTypePs & { code: string } => Boolean(s?.code))
      .map((s) => ({
        code: s.code,
        libelle: s.libelle ?? "",
        count: coerceCount(s.count),
      }));
    out.push({
      code: row.code,
      libelle_source: source,
      libelle_clarifie: clarified,
      count: coerceCount(row.count),
      specialites_presentes: specialites,
    });
  }
  return out;
}
