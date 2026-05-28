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
  type PerResultGeoPrecision,
  type QueryMetadata,
  refineRppsGeoPrecisionLabel,
  rppsDeptMetadata,
  rppsEtablissementMetadata,
  rppsRadiusMetadata,
  rppsSearchByNameMetadata,
} from "../core/query-metadata.js";
import { getUntypedAnonClient } from "../storage/supabase.js";
import { assertValidCodeInsee, assertValidDept } from "../territoire/dept-codes.js";
import {
  PG_STATEMENT_TIMEOUT,
  RPPS_ID_PATTERN,
  assertValidNumFiness,
  buildListQueryResult,
  clampLimit,
  clampOffset,
  expectRpcRows,
  formatRpcError,
  trimOrNull,
  validateCoords,
  validatePreciseOnly,
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
  /** Présent quand `coords` est non-null. Voir {@link PerResultGeoPrecision}. */
  geo_precision?: PerResultGeoPrecision;
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
  /**
   * V0.12.0 — si true, court-circuite entièrement la CTE centroïde commune
   * (`geom_source='commune_centroid'`) côté RPC. Seuls les PS géolocalisés
   * précisément (`geo_precision: "adresse"` BAN ou `"etablissement_finess"`
   * FINESS) sont retournés, triés par `distance_km` exacte au m près.
   *
   * Trade-off : ~31,5 % des PS RPPS (V0.12.0, ratio courant) sont invisibles
   * en mode `preciseOnly=true`. Cas d'usage : rayons courts (<3 km),
   * classement intra-commune fiable, "médecins à <500 m d'une adresse".
   *
   * Défaut false (mode hybride V0.11.0 — précise + centroïde résiduelle).
   */
  preciseOnly?: boolean;
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
 * À utiliser pour les wrappers qui veulent expliciter le default TS-side
 * (`getRppsParSpecialiteDept`, `getRppsByName`, `densiteProfessionnelsSante`)
 * — garantit un default canonique unique vs laisser la RPC retomber sur son
 * propre `COALESCE` (qui varie selon RPC : `rpps_categorie_match` = `C`+`M`).
 * Les wrappers qui passent `?? []` (countRpps brut, getRppsInRadius) ont une
 * sémantique différente : `[]` = "pas de filtre TS-side". Ne PAS substituer
 * naïvement les 2 patterns.
 *
 * Retourne un `readonly string[]` : le RPC Supabase sérialise l'array en
 * JSON sans muter l'input, donc pas besoin d'allouer une copie défensive.
 */
export function resolveCategorieCodes(codes: readonly string[] | undefined): readonly string[] {
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

export interface AssertKnownRppsCodesInput {
  /** Code profession ANS fourni par le caller (null/absent → non validé). */
  professionCode?: string | null;
  /** Code savoir_faire ANS fourni par le caller (null/absent → non validé). */
  savoirFaireCode?: string | null;
}

/**
 * Garde-fou nomenclature ANS (dette #1) : valide `professionCode` /
 * `savoirFaireCode` contre la nomenclature RPPS réellement présente en base
 * (matview `rpps_count_stats`, non filtrée = source réelle de `count_rpps`,
 * via RPC `rpps_nomenclature_exists`).
 *
 * Pourquoi : sans ce garde-fou, un code inexistant ou un code Ameli
 * homographe (`specialite_code`/`type_ps_code` — nomenclature DISTINCTE)
 * passé à un paramètre ANS fait retourner `countPs=0` → densité 0 →
 * faux « désert médical » plausible et INDISTINGUABLE d'un vrai zéro. La
 * description MCP (audit B3) prévient le LLM mais ne protège pas un caller
 * programmatique npm. Asymétrie corrigée : `densiteProfessionnelsSante`
 * throw déjà si la population est introuvable, jamais si le code est inconnu.
 *
 * `RangeError` → mappe JSON-RPC `-32602 Invalid params` au boundary MCP.
 * No-op (zéro I/O) si aucun code fourni : le happy-path défaut (médecin,
 * pas de spécialité) n'est pas pénalisé d'un aller-retour RPC.
 *
 * Garde-fou matview ENTIÈREMENT vide géré côté SQL (renvoie `known=true`
 * plutôt que de bloquer un code valide) — la table `rpps` réellement vide
 * est attrapée en aval par `count_rpps*` (RAISE P0002). LIMITE : une matview
 * STALE / à demi rafraîchie (non vide, code manquant) n'est PAS couverte ici
 * NI par P0002 — c'est la responsabilité du refresh post-swap + audit trail
 * ingest (refresh raté → run `failed`/`partial`, jamais noop silencieux).
 */
export async function assertKnownRppsCodes(input: AssertKnownRppsCodesInput): Promise<void> {
  const professionCode = input.professionCode ?? null;
  const savoirFaireCode = input.savoirFaireCode ?? null;
  if (professionCode === null && savoirFaireCode === null) return;

  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("rpps_nomenclature_exists", {
    p_profession_code: professionCode,
    p_savoir_faire_code: savoirFaireCode,
  });
  if (error) throw new Error(formatRpcError("rpps_nomenclature_exists", error));
  const rows = expectRpcRows<{ profession_known: boolean; savoir_faire_known: boolean }>(
    "rpps_nomenclature_exists",
    data,
  );
  const row = rows[0];
  if (!row) {
    // La RPC retourne TOUJOURS exactement 1 ligne. 0 ligne = RPC remplacée /
    // mockée incorrectement / drift schéma — fail loud, ne pas swallow (sinon
    // le garde-fou serait silencieusement désactivé, pire que pas de garde-fou).
    throw new Error("rpps_nomenclature_exists n'a retourné aucune ligne (invariant RPC violé)");
  }
  const unknown: string[] = [];
  if (professionCode !== null && !row.profession_known) {
    unknown.push(`profession_code '${professionCode}'`);
  }
  if (savoirFaireCode !== null && !row.savoir_faire_known) {
    unknown.push(`savoir_faire_code '${savoirFaireCode}'`);
  }
  if (unknown.length > 0) {
    throw new RangeError(
      `Code(s) ANS inconnu(s) dans la nomenclature RPPS : ${unknown.join(", ")}. Rappel : les codes Ameli (specialite_code / type_ps_code) sont une nomenclature DISTINCTE des codes ANS (profession_code / savoir_faire_code) — un même nombre y désigne des choses différentes. Découvrir les codes ANS valides via le tool lister_nomenclature (referentiel: rpps_savoir_faire) ou la nomenclature publique ANS (https://annuaire.sante.fr/web/site-pro/extractions-publiques).`,
    );
  }
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
  // V0.12.0 — garde lib publique (npm consumers hors MCP) : cf.
  // `validatePreciseOnly` (db-helpers) pour le rationale du silent failure.
  validatePreciseOnly(input.preciseOnly, "getRppsInRadius");

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
    // V0.12.0 — explicite false (pas undefined silencieux qui laisserait la
    // valeur DEFAULT de la fonction PG faire foi). Le test unit verrouille
    // la propagation : un caller npm passant `{ preciseOnly: true }` DOIT
    // recevoir 100% de précis ; un caller historique sans le flag DOIT
    // recevoir le mode hybride V0.11.0 inchangé.
    p_precise_only: input.preciseOnly === true,
  });

  if (error) throw new Error(formatRpcError("rpps_in_radius", error));
  const result = buildQueryResult(
    "rpps_in_radius",
    data,
    limit,
    rppsRadiusMetadata(input.radiusKm),
  );
  // V0.13.0 Fix #4 — raffine l'étiquette globale `geo_precision` selon la
  // distribution effective des `geo_precision` par-PS. Sans ce raffinage,
  // un caller LLM lisait toujours `centroide_commune_ans_mixte` même quand
  // 100 % des résultats étaient en `adresse` / `etablissement_finess` (sous-
  // estimation pessimiste de la qualité — bug rapporté par Claude.ai test).
  //
  // `refineRppsGeoPrecisionLabel` est une factory pure (V0.13 /simplify quality) :
  // on doit RÉASSIGNER son retour pour propager le raffinage. Si aucun
  // raffinage applicable (mixte / 0 row / unknown), elle retourne `baseMeta`
  // tel quel — coût zéro.
  if (result.query_metadata) {
    result.query_metadata = refineRppsGeoPrecisionLabel(result.results, result.query_metadata);
  }
  // V0.12.0 — note metadata explicite quand precise_only=true ET 0 résultat :
  // distingue (a) zone désertique légitime de (b) régression GiST partielle
  // (cf. CLAUDE.md gotcha rpps-in-radius-57014-partial-gist-decouple). Sans
  // ce signal, un caller LLM ne peut pas suggérer au user « essaie le mode
  // hybride » (qui inclurait les PS centroïde commune dans la zone).
  if (input.preciseOnly === true && result.count === 0 && result.query_metadata) {
    result.query_metadata.notes.push(
      "precise_only=true et 0 résultat dans le rayon : il peut exister des PS au centroïde commune dans la zone (geom_source='commune_centroid' exclus de la branche précise). Relancer avec precise_only=false (mode hybride) pour les inclure, ou élargir radius_km.",
    );
  }
  return result;
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
  return buildListQueryResult<RawRppsCompactRow, RppsResult, QueryMetadata>(
    "rpps_dans_etablissement",
    data,
    limit,
    rppsEtablissementMetadata(),
    toCompactResult,
  );
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

  if (error) {
    // 57014 = statement timeout Postgres. Malgré le cap candidats + timeout
    // 10s côté RPC (migration 20260516T030000), un nom ultra-commun sans
    // aucun filtre peut rester trop large. Le mapper en RangeError →
    // JSON-RPC -32602 (faute caller actionnable) plutôt qu'un -32603 opaque
    // ("panne serveur") : le LLM appelant doit affiner, pas réessayer.
    if (error.code === PG_STATEMENT_TIMEOUT) {
      // Logguer AVANT de transformer en RangeError : le cap candidats + 10s
      // rendent "recherche trop large" probable, mais un 57014 peut aussi
      // venir d'une charge DB réelle (pool saturé, lock, lag replica). Sans
      // ce log, cette panne serait invisible (présentée au caller comme
      // "affine ta recherche") et non grep-able en observabilité.
      console.warn(
        `[france-data-mcp] rpps_search_by_name: 57014 timeout nom="${nom}" dept=${input.departement ?? "<none>"} — présumé recherche trop large ; si récurrent sur des noms RARES, suspecter une charge DB.`,
      );
      throw new RangeError(
        `[france-data-mcp] rpps_search_by_name: recherche trop large pour "${nom}" (nom très commun). Affiner avec departement= ou prenom= pour cibler.`,
      );
    }
    throw new Error(formatRpcError("rpps_search_by_name", error));
  }
  return buildListQueryResult<RawRppsSearchRow, RppsResult, QueryMetadata>(
    "rpps_search_by_name",
    data,
    limit,
    rppsSearchByNameMetadata(),
    toSearchResult,
  );
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
  return buildListQueryResult<RawRppsRow, RppsResult, QueryMetadata>(
    rpc,
    data,
    limit,
    metadata,
    toResult,
  );
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
  /**
   * Précision géo retournée par la RPC (V0.12.0+). Présent sur :
   * - `rpps_in_radius` (V0.11.0 — déjà émis depuis migration 20260516T050000)
   * - `rpps_par_specialite_dept`, `rpps_search_by_name`, `rpps_lookup_by_id`
   *   (V0.12.0 — migrations 20260520T11/12/13)
   *
   * Absent / null → mapping `toResult` omet le champ public `geo_precision`
   * (pas de hardcode silencieux "centroide_commune" qui masquerait une
   * régression DB ou un mock incomplet ; cohérent avec `coords: null`).
   *
   * Réutilise `PerResultGeoPrecision` pour éviter une 2e source de vérité
   * du union des 3 valeurs (ajouter une 4e précision → 1 seul site à patcher).
   */
  geo_precision?: PerResultGeoPrecision | null;
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
    // V0.12.0 — contrat `RawRppsRow.geo_precision` documenté l.670 ; throw
    // bruyant si valeur hors set canonique (drift RPC = contract violation),
    // warn si invariant amont violé (precision sans coords).
    ...(coords && row.geo_precision ? assertGeoPrecision(row) : warnIfAnomalous(row, coords)),
    telephone: row.telephone,
  };
}

/**
 * V0.12.0 — branche d'omission : signale (warn, pas throw) l'invariant violé
 * « la RPC émet une précision géo sur un PS sans coordonnées exploitables ».
 * Retourne `{}` pour le spread (= omission propre). Sans ce warn, l'anomalie
 * amont serait mangée sans signal observabilité — règle CLAUDE.md projet :
 * zéro catch silencieux côté lib `src/`.
 *
 * Pourquoi recevoir `coords` (déjà calculé) et pas juste `row.geom` : un
 * `row.geom` présent mais aux `coordinates` malformés produit aussi
 * `coords=null` et la même anomalie ; on warn sur le RÉSULTAT visible
 * (`coords=null`), pas sur la cause syntaxique. Couvre les 2 cas avec un
 * seul check.
 */
function warnIfAnomalous(
  row: RawRppsRow,
  coords: { lat: number; lon: number } | null,
): Record<string, never> {
  if (row.geo_precision && !coords) {
    console.warn(
      `[france-data-mcp] rpps row id=${row.id} rpps_id=${row.rpps_id} a geo_precision="${row.geo_precision}" mais coords=null (geom=${row.geom === null ? "null" : "malformé"}) — anomalie contrat RPC (un PS sans coords exploitables ne devrait pas porter de précision géo). Champ public omis.`,
    );
  }
  return {};
}

/**
 * V0.12.0 — Garde runtime au mapping `toResult` : valide la valeur émise par
 * la RPC contre le set canonique de `PerResultGeoPrecision`. Le typage TS
 * `RawRppsRow.geo_precision?: PerResultGeoPrecision | null` est effacé au
 * runtime — sans cette assertion, une future RPC introduisant `'iris'` ou
 * une faute de frappe passerait silencieusement au client MCP (qui ne saurait
 * pas mapper sur ses 3 narrations connues). Cohérent avec la discipline
 * `expectRpcRows` (db-helpers) : un drift RPC = contract violation, jamais
 * silencieux. Le garde-fou parité SQL (`rpps-geo-precision-mapping-parity`)
 * ferme la porte côté migrations, ce check ferme côté lib npm contre une
 * panne déployée hors guard.
 *
 * Branche jumelle `warnIfAnomalous` (ci-dessus) gère le cas inverse (précision
 * sans coords exploitables) — invariant amont observable également, mais warn
 * plutôt que throw (le champ public sera omis cohérent avec coords:null).
 */
function assertGeoPrecision(row: RawRppsRow): { geo_precision: PerResultGeoPrecision } {
  const value = row.geo_precision;
  if (value !== "adresse" && value !== "etablissement_finess" && value !== "centroide_commune") {
    throw new Error(
      `[france-data-mcp] rpps RPC contract violation — geo_precision="${String(value)}" hors set canonique {adresse, etablissement_finess, centroide_commune} (id=${row.id}, rpps_id=${row.rpps_id}). Migration drift ?`,
    );
  }
  return { geo_precision: value };
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
