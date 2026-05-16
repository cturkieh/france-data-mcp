/**
 * Définition des outils MCP exposés par le serveur france-data-mcp.
 *
 * V0.5 : 17 tools exposés. Territoire + DINUM (live), FINESS (Supabase
 * dump bimestriel, V0.2), Annuaire Santé Ameli (Supabase dump hebdo, V0.4),
 * RPPS / Annuaire Santé ANS (Supabase dump mensuel + fallback FHIR live, V0.5).
 * Les CSV bruts restent disponibles dans la lib pour les usages hors MCP.
 */

import { INCLUDE_FRESHNESS_SCHEMA, withFreshness } from "../src/core/freshness.js";
import {
  type AmeliQueryResult,
  type AmeliResult,
  getAmeliBySpecialiteDept,
  getAmeliInRadius,
  listAmeliSpecialites,
  listAmeliTypesPs,
} from "../src/sante/ameli-db.js";
import { lookupPractitionerByRpps } from "../src/sante/ans-fhir.js";
import { getCdsByFiness, getCdsInRadius } from "../src/sante/cds-db.js";
import { type CoverageInput, getCoverageFinessVsSireneInRadius } from "../src/sante/coverage.js";
import {
  compareAdresseCnamVsFiness,
  compareRaisonSocialeFinessVsRpps,
  historiqueEtablissement,
  reconcilierFinessSirene,
  verifierSiteActif,
} from "../src/sante/cross-source.js";
import { RADIUS_MAX_KM, RADIUS_MIN_KM } from "../src/sante/db-helpers.js";
import {
  MODE_EXERCICE_ACTIVITE_REGULIERE,
  PROFESSION_CODE_MEDECIN,
  densiteEtablissementsSante,
  densiteProfessionnelsSante,
} from "../src/sante/densite.js";
import { FINESS_FAMILY_CODES } from "../src/sante/finess-categories.js";
import {
  type FinessFamilleQuery,
  getFinessByCategorie,
  getFinessByNumFiness,
  getFinessInRadius,
} from "../src/sante/finess-db.js";
import { getEntrepriseBySiren, searchEntreprises } from "../src/sante/index.js";
import { lookupSiretViaInsee } from "../src/sante/insee-sirene.js";
import { inspectSite } from "../src/sante/inspect-site.js";
import { DEFAULT_FAMILLES, panoramaSanteTerritoire } from "../src/sante/panorama.js";
import {
  buildCategorieCodes,
  getRppsById,
  getRppsByName,
  getRppsDansEtablissement,
  getRppsInRadius,
  getRppsParSpecialiteDept,
  listSavoirFaireRpps,
} from "../src/sante/rpps-db.js";
import { RPPS_CGU_NOTICE, RPPS_MODE_EXERCICE, TRE_R09_URL } from "../src/sante/rpps-types.js";
import { getDataFreshness } from "../src/storage/ingest-log.js";
import { deptFromCodeInsee } from "../src/territoire/dept-codes.js";
import {
  geocode,
  getCommuneByCode,
  getPopulationByCommune,
  getPopulationByDept,
  reverseGeocode,
  searchCommunes,
} from "../src/territoire/index.js";
import {
  normalizeAliases,
  requireFinessId,
  requireOneOf,
  requireRppsId,
  requireSiretId,
  requireString,
} from "./_lib/args.js";
import { attachErrorContext } from "./_lib/error-context.js";

/**
 * Diagnostic context anonymisé attaché aux erreurs du tool
 * `professionnels_par_specialite_dept`. Type FERMÉ (pas d'intersection avec
 * `Readonly<Record<string, unknown>>` — l'index signature dominerait et
 * permettrait l'ajout silencieux de champs PII via excess-property holes côté
 * object literal). Toute évolution du contract doit passer par l'édition
 * explicite de ce type, pas par un add-on dans l'objet construit côté catch.
 */
type AmeliQueryErrorContext = {
  readonly tool: "professionnels_par_specialite_dept";
  readonly departement: string;
  readonly has_specialite_filter: boolean;
  readonly has_type_ps_filter: boolean;
  readonly offset: number;
  readonly limit: number;
};

/** Liste des codes mode exercice ANS prête à inclure dans une description tool. */
const RPPS_MODE_EXERCICE_HINT = `Codes mode_exercice ANS : ${RPPS_MODE_EXERCICE.LIBERAL} libéral, ${RPPS_MODE_EXERCICE.SALARIE} salarié, ${RPPS_MODE_EXERCICE.MIXTE} mixte, ${RPPS_MODE_EXERCICE.REMPLACANT} remplaçant, ${RPPS_MODE_EXERCICE.BENEVOLE} bénévole, ${RPPS_MODE_EXERCICE.AUTRE} autre.`;

/**
 * Hint user-facing exposé dans la description des 3 tools RPPS query. Source
 * unique de vérité pour la sémantique des flags catégorie professionnelle ;
 * les LLM lisent cette chaîne au tool-discovery. La base RPPS ne contient
 * QUE des PS actifs (ANS pré-filtre `PS_LibreAcces_Personne_activite` à la
 * source — cf. DSFT v3.1 §5.1.2) ; ces flags discriminent un statut
 * juridique d'enregistrement, pas une activité.
 */
const RPPS_INCLUDE_CATEGORIES_HINT = `Par défaut, ne renvoie que les PS de catégorie Civil (C) — droit privé : libéraux, salariés privés, hospitaliers contractuels, ~97 % de la base. Passer \`include_agents_publics: true\` pour inclure aussi les Agents publics (M) — fonctionnaires d'État + collectivités + militaires SSA, ~0,3 % (PH titulaires, médecins inspecteurs ARS, médecins conseils CNAM, médecins scolaires Éducation nationale, médecins PMI). Passer \`include_etudiants: true\` pour inclure aussi les Étudiants (E) — internes, externes, élèves IDE/SF, ~2,5 %. Source nomenclature : ${TRE_R09_URL}.`;

/** Sous-schéma JSON Schema partagé par les 3 tools RPPS query. */
const RPPS_INCLUDE_CATEGORIES_SCHEMA = {
  include_etudiants: { type: "boolean" },
  include_agents_publics: { type: "boolean" },
} as const;

/**
 * Extrait et valide les coordonnées `lon`/`lat` des arguments d'un tool, en
 * passant par `coerceNumber` (rejette string non-numérique, boolean, etc.).
 * Throw RangeError → -32602 bad_request si l'un des deux est absent ou invalide.
 *
 * Note : N'utilise PAS la sémantique laxiste `Number()` + `Number.isFinite()`
 * de `reverse_geocode` (qui accepte des inputs ouverts) : applicable aux tools
 * où le contrat MCP est strict (in_radius patterns).
 */
function requireLonLatStrict(args: Record<string, unknown>): { lon: number; lat: number } {
  const lon = coerceNumber(args.lon, "lon");
  const lat = coerceNumber(args.lat, "lat");
  if (lon === undefined || lat === undefined) {
    throw new RangeError("lon et lat (number) requis");
  }
  return { lon, lat };
}

/**
 * Traduit les flags MCP `include_etudiants` / `include_agents_publics` en
 * array `categorieCodes` consommable par les 3 RPCs RPPS. Source unique
 * pour garantir la même sémantique sur les 3 handlers.
 *
 * Throw explicite si le legacy `include_inactifs` (V0.5.4) est passé : la
 * sémantique a changé en V0.5.5 (cf. CHANGELOG breaking change). Sans ce
 * throw, un caller cache hit sur l'ancienne tools/list reçoit silencieusement
 * un sous-ensemble (`[C]` au lieu de `[C,M]` historique) — exactement le
 * silent failure que la règle projet interdit.
 */
export function categorieCodesFromArgs(args: Record<string, unknown>): string[] {
  if (args.include_inactifs !== undefined) {
    throw new RangeError(
      "include_inactifs (V0.5.4) a été retiré en V0.5.5 : utiliser include_agents_publics (=true équivalent au comportement V0.5.4 par défaut, ajoute le code 'M' Agent public) et/ou include_etudiants (ajoute le code 'E' Étudiant). Voir CHANGELOG pour le mapping détaillé.",
    );
  }
  return buildCategorieCodes({
    includeEtudiants: coerceBoolean(args.include_etudiants, "include_etudiants") === true,
    includeAgentsPublics:
      coerceBoolean(args.include_agents_publics, "include_agents_publics") === true,
  });
}

/**
 * Type strict des annotations MCP (spec 2025-06-18, §6.2). Restreint aux 5
 * propriétés autorisées par la spec — un `Record<string, boolean>` accepterait
 * silencieusement un typo (`readOnlyhint` au lieu de `readOnlyHint`) qui
 * n'aurait aucun effet côté client. Convention CLAUDE.md "TypeScript strict,
 * jamais `any`" appliquée ici.
 */
export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * Annotations MCP consommées par les clients pour aider l'utilisateur à
 * comprendre quels tools sont safe à invoquer sans confirmation, lesquels
 * peuvent altérer l'état externe, etc.
 *
 * - `readOnlyHint: true` : le tool n'écrit rien (toutes nos sources : FINESS,
 *   Ameli, RPPS, DINUM, INSEE, IGN, geo.api.gouv → reads only).
 * - `destructiveHint: false` : aucun effet destructif (renforcement explicite
 *   du readOnly).
 * - `idempotentHint: true` : mêmes inputs → mêmes outputs (FINESS/Ameli/RPPS
 *   stables entre 2 ingestions cron, DINUM/INSEE/IGN live mais idempotent
 *   à l'échelle d'une session MCP).
 * - `openWorldHint: true` : interactions avec des sources externes au serveur
 *   (la spec MCP cible cette annotation pour distinguer "outils locaux" des
 *   "outils qui consomment des APIs publiques").
 */
const READ_ONLY_IDEMPOTENT_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Variante pour `data_freshness` : sa réponse contient des timestamps de
 * dernière ingestion + `staleness_days` → varie dans le temps même sans
 * input. `idempotentHint: false` signale au client qu'un cache long n'est
 * pas safe. Spread la base pour rendre explicite que seul `idempotentHint`
 * diverge — si la spec MCP évolue, un seul endroit à modifier.
 */
const READ_ONLY_TIME_VARYING_ANNOTATIONS: McpToolAnnotations = {
  ...READ_ONLY_IDEMPOTENT_ANNOTATIONS,
  idempotentHint: false,
};

/**
 * Patterns `outputSchema` réutilisables (spec MCP 2025-06-18 §6.3) déclarés
 * une fois et référencés par les 25 tools. Format JSON Schema standard.
 *
 * Bénéfices : (1) Smithery quality score (+10pt), (2) LLM clients peuvent
 * type-check les réponses sans deviner la shape, (3) auto-documentation
 * pour les humains qui inspectent la spec via `tools/list`.
 *
 * Volontairement loose : on déclare la shape racine + les top-level fields
 * communs, mais on évite un schema strict avec `additionalProperties: false`
 * qui casserait dès qu'on ajoute un champ optionnel (semver freeze
 * silencieux). `LookupResult` reste explicitement open au payload pour rester
 * stable face à l'évolution des types métier.
 */
const LOOKUP_RESULT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "LookupResult discriminé par `found`. true → payload métier à plat (siren, nomComplet, etc.). false → `lookupStatus`/`key`/`message` actionnables. `lookupStatus` est toujours présent runtime (validé par tests).",
  properties: {
    found: { type: "boolean" },
    lookupStatus: {
      type: "string",
      enum: ["found", "not_found", "ambiguous"],
    },
    key: { type: "string", description: "Clé recherchée (SIREN, num_finess, code INSEE, …)." },
    message: {
      type: "string",
      description: "Explication actionnable quand `found=false` (cause probable + remédiation).",
    },
  },
  required: ["found", "lookupStatus"],
};

const QUERY_RESULT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Résultat de query avec metadata. `results` est tronqué à `limit` côté serveur (cf. `truncated` quand applicable).",
  properties: {
    count: {
      type: "number",
      description: "Nombre d'entrées retournées dans `results` (post-troncature).",
    },
    total: {
      type: "number",
      description:
        "Effectif réel avant troncature. Présent sur les tools de nomenclature paginés (lister_*) : `count` = échantillon, `total` = total réel, re-appeler avec un `limit` supérieur si `truncated`.",
    },
    truncated: {
      type: "boolean",
      description:
        "true si le total réel dépasse `limit` (re-paginer via `offset` si supporté, ou augmenter `limit` sur les lister_*). Optional sur les tools de listing exhaustif (lister_*).",
    },
    results: {
      type: "array",
      items: { type: "object" },
      description: "Entrées métier (shape spécifique au tool, cf. description du tool).",
    },
    query_metadata: {
      type: "object",
      description: "Metadata de la query (radius_km, departement, filtres appliqués, …).",
    },
    freshness: {
      type: "object",
      description: "Fraîcheur des sources (présent si `include_freshness: true`).",
    },
  },
  required: ["count", "results"],
};

/**
 * Schema dédié pour `entreprises_in_radius`. L'API DINUM retourne sa shape native
 * `{total, page, perPage, totalPages, entreprises}` (sans normalisation vers le
 * pattern count/results) pour exposer la pagination DINUM telle quelle. Schema
 * dédié plutôt que QUERY_RESULT_OUTPUT_SCHEMA qui ne matche pas.
 */
const DINUM_QUERY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Résultat de recherche DINUM avec pagination native (total, page, perPage, totalPages, entreprises).",
  properties: {
    total: { type: "number", description: "Total d'entreprises matchant la query côté DINUM." },
    page: { type: "number" },
    perPage: { type: "number" },
    totalPages: { type: "number" },
    entreprises: {
      type: "array",
      items: { type: "object" },
      description: "Entreprises retournées (SIREN, nomComplet, NAF, finances, etablissements).",
    },
  },
  required: ["total", "page", "perPage", "totalPages", "entreprises"],
};

/**
 * Schema dédié pour `finess_sirene_coverage_in_radius`. Le tool retourne un
 * audit méthodologique (taux de couverture FINESS vs SIRENE) qui ne rentre
 * dans aucun autre pattern.
 */
const COVERAGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Audit de couverture FINESS vs SIRENE dans un rayon. coverage_ratio = matched / total_finess. Caveats explicites pour cadrer la méthode (FINESS = sites physiques agréés, SIRENE = SIRET actifs au NAF cible).",
  properties: {
    finess_sites: {
      type: "number",
      description: "Nombre de sites FINESS dans le rayon (référentiel DREES).",
    },
    sirene_sirets: {
      type: "number",
      description: "Nombre de SIRET physiques actifs au NAF cible dans le rayon (DINUM/SIRENE).",
    },
    matched_count: { type: "number", description: "Nombre de matchs greedy Dice ≥ 0.7." },
    coverage_ratio: {
      type: ["number", "null"],
      description:
        "matched / finess_sites ∈ [0, 1]. null si `sirene_sirets === 0` (zone rurale + NAF rare → ratio non calculable).",
    },
    finess_only_count: { type: "number" },
    sirene_only_count: { type: "number" },
    matched_samples: { type: "array", items: { type: "object" } },
    finess_only_samples: { type: "array", items: { type: "object" } },
    sirene_only_samples: { type: "array", items: { type: "object" } },
    methodology: {
      type: "string",
      description: "Description LLM-friendly de l'algorithme appliqué.",
    },
    caveats: {
      type: "array",
      items: { type: "string" },
      description: "Limitations méthodologiques explicites (discipline zéro overclaim).",
    },
    truncated_unites_legales: {
      type: "boolean",
      description: "true si le cap `maxUnitesLegales` a été atteint avant énumération complète.",
    },
  },
  required: ["finess_sites", "sirene_sirets", "coverage_ratio", "methodology"],
};

/**
 * Spec MCP 2025-06-18 §6.3 : « The schema MUST be of type 'object' ». Un schema
 * au root `type: "array"` ou `type: ["object", "null"]` viole la spec littérale.
 * Les tools qui retournent `T | null` ou `T[]` n'ont donc volontairement PAS
 * d'outputSchema déclaré :
 *  - `autocomplete_commune` (root array)
 *  - `geocode_adresse` / `reverse_geocode` (peut retourner null)
 * Le forward conditionnel dans `api/mcp.ts` omet la clé absente, conforme.
 */

/**
 * `data_freshness` retourne pour chaque source des champs nullable : si la
 * source n'a jamais été ingérée (1er déploiement), `last_success_at` /
 * `staleness_days` / etc. sont `null`. Le schema déclare `["string", "null"]`
 * / `["number", "null"]` pour matcher fidèlement le runtime (cf.
 * `IngestFreshnessRow` dans `src/storage/ingest-log.ts`).
 */
const DATA_FRESHNESS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "Identifiant source (finess, ameli_ps, rpps)." },
          last_success_at: {
            type: ["string", "null"],
            description:
              "ISO timestamp dernière ingestion OK. null si aucun succès enregistré (1er déploiement).",
          },
          last_success_row_count: { type: ["number", "null"] },
          last_attempt_at: { type: ["string", "null"] },
          last_attempt_status: { type: ["string", "null"] },
          staleness_days: {
            type: ["number", "null"],
            description:
              "null si la source n'a jamais été synchronisée (signal alarmant à propager au caller).",
          },
          cadence_hint: { type: "string" },
        },
        required: ["source"],
      },
    },
  },
  required: ["sources"],
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** Spec MCP 2025-06-18 §6.3 — JSON Schema décrivant la shape du retour. */
  outputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Garde de typage : renvoie la valeur si c'est une string, sinon undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Garde de typage tolérante : accepte un number direct OU une string
 * numérique (`"49.7724"`). Beaucoup de clients MCP sérialisent les nombres
 * comme strings au passage par leur transport JSON-RPC, donc rejeter
 * `typeof !== "number"` strict bloque des callers parfaitement légitimes
 * (audit empirique 2026-05-08 sur le client Claude Code).
 *
 * Renvoie `undefined` pour tout ce qui n'est pas un nombre fini après
 * coercition — booleans, objets, NaN, `Infinity`, strings non-numériques,
 * absent. Confond donc "absent" et "invalide" : préférer `coerceNumber`
 * dans les call-sites qui ont un fallback `?? default`, sinon une saisie
 * erronée (`radius_km: "50 km"`) tomberait silencieusement sur le default.
 */
function asNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Variante stricte de `asNumber` : throw sur input invalide non-absent.
 * Renvoie `undefined` UNIQUEMENT si l'argument est absent (`undefined`/`null`).
 *
 * À utiliser pour tout paramètre qui a un fallback (`?? default`) ou qui
 * forward `undefined` à un wrapper qui défaut. Sans cette discrimination,
 * `asNumber("abc") ?? 5` retourne 5 silencieusement et masque la saisie
 * invalide — silent failure que CLAUDE.md interdit explicitement.
 */
function coerceNumber(v: unknown, paramName: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = asNumber(v);
  if (n === undefined) {
    // RangeError plutôt qu'Error pour cohérence avec les autres validators
    // (clampLimit, validateRadiusKm…). Permet à `api/mcp.ts` de mapper sur
    // JSON-RPC -32602 (Invalid params) au lieu de -32603 (Internal error).
    throw new RangeError(`${paramName} doit être un nombre fini (reçu : ${JSON.stringify(v)})`);
  }
  return n;
}

/**
 * Coercition booléenne tolérante. Mêmes raisons que `asNumber` : les transports
 * MCP peuvent stringifier `true` → `"true"`. Sans ce helper, `dedupe_by_ps:
 * "true"` côté client retourne silencieusement le résultat non-dédupliqué,
 * variante du même silent failure que `asNumber("50 km") ?? 5`.
 *
 * Reconnu : `true`/`false`, `"true"`/`"false"` (insensible casse), `"1"`/`"0"`,
 * `1`/`0`. Tout autre input est rejeté avec throw — pas de fallback silencieux.
 */
function coerceBoolean(v: unknown, paramName: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  // RangeError pour cohérence (cf. coerceNumber) → JSON-RPC -32602.
  throw new RangeError(`${paramName} doit être un booléen (reçu : ${JSON.stringify(v)})`);
}

const NOMENCLATURE_DEFAULT_LIMIT = 50;
const NOMENCLATURE_MAX_LIMIT = 1000;

/**
 * Tronque une liste de nomenclature triée par fréquence décroissante (audit
 * B2 : ces tools renvoyaient 65-95 entrées d'un coup, ~6-10K tokens). Le
 * contrat reste honnête : `count` = taille de l'échantillon renvoyé, `total`
 * = effectif réel, `truncated` = il en reste (re-appeler avec un `limit`
 * supérieur). Jamais de "total" mensonger (convention QueryResult du repo).
 */
function limitNomenclature<T>(
  all: T[],
  rawLimit: unknown,
): { count: number; total: number; truncated: boolean; results: T[] } {
  const requested = coerceNumber(rawLimit, "limit") ?? NOMENCLATURE_DEFAULT_LIMIT;
  if (requested < 1) {
    throw new RangeError(`limit doit être >= 1 (reçu : ${JSON.stringify(rawLimit)})`);
  }
  // Clamp doux (≠ `clampLimit` de db-helpers qui throw sur dépassement) :
  // ici la liste complète tient en mémoire, plafonner à MAX rend juste
  // l'effet "tout" — `total`/`truncated` restent honnêtes, aucun bug masqué.
  const limit = Math.min(Math.floor(requested), NOMENCLATURE_MAX_LIMIT);
  const results = all.slice(0, limit);
  return {
    count: results.length,
    total: all.length,
    truncated: results.length < all.length,
    results,
  };
}

const NOMENCLATURE_LIMIT_SCHEMA = {
  type: "number" as const,
  description: `Nombre max de résultats (défaut ${NOMENCLATURE_DEFAULT_LIMIT}, max ${NOMENCLATURE_MAX_LIMIT}). Triés par fréquence décroissante. La réponse expose \`total\` (effectif réel) et \`truncated\` — re-appeler avec un \`limit\` supérieur pour la liste complète.`,
};

/**
 * Familles FINESS exposées en input. Dérivé directement des clés de
 * `FINESS_FAMILY_CODES` pour avoir une seule source de vérité — ajouter une
 * famille là-bas l'expose automatiquement ici.
 */
const FINESS_FAMILLE_INPUTS = Object.keys(FINESS_FAMILY_CODES) as readonly FinessFamilleQuery[];

/** Liste des familles formatée pour les descriptions des tools MCP. */
const FAMILLES_LIST = FINESS_FAMILLE_INPUTS.join(", ");

/**
 * Note partagée (audit B6) : le dump FINESS DREES abrège les libellés longs
 * (~38 car. max). Limitation amont, pas une troncature de notre pipeline
 * (colonne DB `TEXT` illimitée). Injectée dans les descriptions des tools
 * FINESS exposant `raison_sociale`.
 */
const FINESS_RS_TRUNCATION_NOTE =
  "Note : `raison_sociale` provient du dump DREES qui abrège les libellés longs (~38 car. max, ex 'CERBALLIANCE HA' pour 'CERBALLIANCE HAZEBROUCK'). Pour le nom légal complet, cross-check via SIREN/SIRET (entreprise_by_siren / etablissement_by_siret).";

/** Garde de typage : valide qu'une string est une famille FINESS queryable. */
function asFinessFamille(v: unknown): FinessFamilleQuery | undefined {
  if (typeof v !== "string") return undefined;
  return (FINESS_FAMILLE_INPUTS as readonly string[]).includes(v)
    ? (v as FinessFamilleQuery)
    : undefined;
}

/** Parse + valide un tableau de familles FINESS. Throw si une valeur est invalide. */
function parseFamilles(v: unknown): FinessFamilleQuery[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    // RangeError partout dans les validators de tools → JSON-RPC -32602
    // (faute caller). Sans cette typage, ces inputs invalides tombaient en
    // -32603 internal_error + capture Sentry parasite (cf. FRANCE-DATA-MCP-2).
    throw new RangeError(
      `familles doit être un tableau (reçu ${typeof v}). Valeurs autorisées : ${FINESS_FAMILLE_INPUTS.join(", ")}.`,
    );
  }
  const parsed: FinessFamilleQuery[] = [];
  for (const item of v) {
    const f = asFinessFamille(item);
    if (!f) {
      throw new RangeError(
        `famille FINESS invalide : "${String(item)}". Valeurs autorisées : ${FINESS_FAMILLE_INPUTS.join(", ")}.`,
      );
    }
    parsed.push(f);
  }
  return parsed;
}

/**
 * Parse un tableau de strings depuis l'input MCP. Throw si l'argument n'est
 * pas un tableau, contient une chaîne vide, ou un élément non-string.
 * Renvoie `undefined` si l'argument est absent OU si le tableau est vide
 * — les deux signifient sémantiquement "pas de filtre", donc on les
 * normalise au même output pour éviter qu'un tableau vide accidentel
 * (`["foo"].filter(predicateThatRejectsAll) → []`) ne devienne un filtre
 * silencieusement vide côté SQL.
 */
function parseStringArray(v: unknown, paramName: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new RangeError(`${paramName} doit être un tableau de strings (reçu ${typeof v}).`);
  }
  if (v.length === 0) return undefined;
  for (const item of v) {
    if (typeof item !== "string") {
      throw new RangeError(
        `${paramName}: chaque élément doit être une string (reçu ${typeof item} dans le tableau).`,
      );
    }
    if (item === "") {
      throw new RangeError(
        `${paramName}: la chaîne vide n'est pas autorisée — passer le tableau sans cet élément ou omettre le paramètre pour ne pas filtrer.`,
      );
    }
  }
  return v as string[];
}

/**
 * Mention CGU obligatoire pour la réutilisation des données Annuaire Santé
 * Ameli (art. L.1461-2 CSP). Affichée dans la description de chaque tool
 * Ameli pour que tout caller MCP la voie avant d'invoquer.
 *
 * `AMELI_SCOPE_WARNING` cadre le périmètre exact de la source amont. Le piège
 * récurrent (audit Charleville 2026-05-08) : un caller voit "Annuaire Santé
 * Ameli" et croit à un répertoire exhaustif des PS — alors que c'est UNIQUEMENT
 * les libéraux conventionnés. Les hospitaliers salariés, biologistes médicaux
 * salariés en LBM, anatomopathologistes hospitaliers, médecins du travail et
 * médecine légale en sont absents par construction. Pour un référentiel tous
 * statuts, il faut RPPS / Annuaire Santé ANS (esante.gouv.fr) — non couvert
 * par ce serveur en v0.4.
 */
const AMELI_CGU =
  "Source : Annuaire santé Ameli (Assurance Maladie), MAJ hebdomadaire. " +
  "Réutilisation soumise à l'art. L.1461-2 CSP — citer la source et la date de sync.";

const AMELI_SCOPE_WARNING =
  "PÉRIMÈTRE : libéraux conventionnés UNIQUEMENT. " +
  "HORS PÉRIMÈTRE : médecins exclusivement hospitaliers/salariés, " +
  "biologistes médicaux salariés en LBM, anatomopathologistes hospitaliers, " +
  "médecins du travail, médecine légale. " +
  "Pour effectifs tous statuts, voir Annuaire Santé ANS (RPPS, esante.gouv.fr) — non couvert par ce serveur.";

/**
 * Aide à la sélection des codes type_ps Ameli, intégrée à toutes les
 * descriptions de tools de prospection. Volontairement courte pour ne pas
 * bloater le token budget côté caller : la nomenclature exhaustive vit dans
 * les tools `lister_specialites_ameli` et `lister_types_ps_ameli`.
 *
 * Le code "2" est intentionnellement décrit comme "fourre-tout" — c'est le
 * piège récurrent (audit Charleville 2026-05-09). Sans cette précision, un
 * caller filtrant `type_ps_codes=["2"]` pour cibler les IDE récupère en
 * réalité IDE + kinés + sages-femmes + podologues + orthophonistes + IPA,
 * soit ~2x les volumes attendus.
 */
const AMELI_TYPE_PS_HELP =
  "Codes type_ps Ameli présents en base (3) : '1' médecins, '2' auxiliaires médicaux (fourre-tout : IDE, kinés, sages-femmes, podologues, orthophonistes, orthoptistes, IPA), '5' chirurgiens-dentistes.";

/**
 * Avertissement anti-collision (audit B3) : les nomenclatures Ameli
 * (`specialite_code`, `type_ps_code`) et ANS/RPPS (`profession_code`,
 * `savoir_faire_code`) sont DISTINCTES et partagent des valeurs numériques
 * homographes (ex: le code `10` = Neurochirurgien côté Ameli, mais = Médecin
 * côté ANS). Un code Ameli passé à un paramètre ANS ne lève pas d'erreur — il
 * filtre dans le vide silencieusement. Injecté dans toute description de tool
 * RPPS prenant un code en paramètre.
 */
const NOMENCLATURE_COLLISION_WARNING =
  "ATTENTION nomenclatures : les codes ANS (`profession_code`, `savoir_faire_code`) sont une nomenclature DISTINCTE des codes Ameli (`specialite_code`, `type_ps_code`) — un même nombre désigne des choses différentes (ex: '10' = Médecin côté ANS, Neurochirurgien côté Ameli). Ne JAMAIS passer un code Ameli à un paramètre ANS : le filtre renverrait vide sans erreur. Découvrir les codes ANS via `lister_specialites_medicales`.";

/**
 * Extrait le code département d'un code commune INSEE.
 * Alias historique conservé pour la compat des callers — la logique vit
 * dans `src/territoire/dept-codes.ts` (consolidation V0.4).
 */
export const deptFromCommune = deptFromCodeInsee;

/**
 * Site d'exercice d'un PS dédupliqué — sous-ensemble par-site de `AmeliResult`.
 * `Pick` lie le shape à la source canonique : ajouter un champ par-site dans
 * `AmeliResult` (ex: `horaires_ouverture`) propagera ici via compile-error,
 * pas via silencieux drop. Plus robuste qu'une duplication manuelle.
 */
type AmeliPsSite = Pick<
  AmeliResult,
  "id" | "adresse" | "coords" | "distance_km" | "telephone" | "conventions"
>;

/** Praticien dédupliqué — identité partagée + tableau des sites d'exercice. */
type AmeliPsDedup = Pick<AmeliResult, "identite" | "specialite" | "type_ps"> & {
  sites: AmeliPsSite[];
};

/**
 * Sortie du dédupe Ameli. Champ `count` = nombre de **praticiens distincts**
 * (≠ raw `count` qui compte les **entrées** Ameli, une par site).
 *
 * `rawCount` propage le décompte amont AVANT regroupement pour qu'un caller
 * paginant en mode dédupe puisse calculer correctement le `nextOffset` :
 * `nextOffset = previousOffset + rawCount` (PAS `+ count` qui sous-estime
 * et fait sauter des entrées sur les pages suivantes).
 *
 * `warning` est posé si la dédup tourne sur un résultat tronqué : le même PS
 * peut occuper deux pages, et apparaîtra alors comme deux praticiens distincts
 * — la dédup est partielle. Pattern aligné sur `entreprises_in_radius`
 * `fallback.warning` qui surface honnêtement les limites côté caller.
 */
type AmeliDedupedResult = {
  count: number;
  rawCount: number;
  truncated: boolean;
  results: AmeliPsDedup[];
  warning?: string;
};

const DEDUPE_TRUNCATED_WARNING =
  "Dédup partielle : appliquée sur un résultat tronqué amont. " +
  "Un même praticien à cheval sur deux pages apparaîtra comme deux entrées distinctes. " +
  "Re-paginer (offset + rawCount) jusqu'à truncated=false avant de cumuler les counts uniques.";

/**
 * Regroupe les entrées Ameli par praticien (clé : nom + prenom + civilite +
 * specialite_code + type_ps_code). Les sites multiples du même PS sont listés
 * dans `sites[]` (chacun avec sa propre `adresse.raison_sociale`) au lieu
 * d'occuper N entrées séparées.
 *
 * `raison_sociale` est volontairement EXCLU de la clé : c'est un attribut de
 * site (la structure d'exercice), pas d'identité — un PS exerçant sous deux
 * raisons sociales est UNE personne sur deux sites, pas deux personnes. Elle
 * voyage dans `adresse` donc chaque entrée de `sites[]` conserve la sienne.
 *
 * Pourquoi cette clé : (nom, prenom) seuls collisionnent (3 "DUPONT JEAN" en
 * France). Ajouter civilité + spécialité + type PS réduit à un taux de
 * collision négligeable. La source publique n'expose pas RPPS/ADELI (commentaire
 * de la migration `20260508000016`), donc on ne peut pas faire mieux côté
 * serveur ; un caller voulant une dédup parfaite doit cross-référencer avec
 * un autre référentiel (ANS RPPS).
 */
function dedupeAmeliByPs(result: AmeliQueryResult): AmeliDedupedResult {
  const grouped = new Map<string, AmeliPsDedup>();
  // Iteration order = input order, which is already sorted by distance/name
  // upstream — preserve it to keep the output deterministic.
  for (const row of result.results) {
    // JSON.stringify plutôt que `[...].join("|")` : un libellé peut contenir
    // un pipe qui collisionnerait sinon avec un praticien différent
    // post-split. Garantit l'unicité de la clé sans séparateur fragile, et
    // distingue null (JSON `null`) d'une chaîne vide.
    const key = JSON.stringify([
      row.identite.nom,
      row.identite.prenom,
      row.identite.civilite,
      row.specialite.code,
      row.type_ps.code,
    ]);
    const { identite, specialite, type_ps, ...site } = row;
    const existing = grouped.get(key);
    if (existing) {
      existing.sites.push(site);
    } else {
      grouped.set(key, { identite, specialite, type_ps, sites: [site] });
    }
  }
  const results = Array.from(grouped.values());
  const out: AmeliDedupedResult = {
    count: results.length,
    rawCount: result.count,
    truncated: result.truncated,
    results,
  };
  if (result.truncated) out.warning = DEDUPE_TRUNCATED_WARNING;
  return out;
}

export const TOOLS: McpTool[] = [
  {
    name: "autocomplete_commune",
    description:
      "Recherche de communes françaises par nom, code postal ou code INSEE. Idéal pour autocomplétion. Source : geo.api.gouv.fr (DINUM/Etalab).\n\nUn (au moins) parmi `nom`, `codePostal`, `code` est requis. Alias acceptés : `q`/`query`/`search` → `nom`, `codepostal`/`postal_code` → `codePostal`, `code_insee`/`insee` → `code`.",
    inputSchema: {
      type: "object",
      properties: {
        nom: {
          type: "string",
          description: 'Recherche par nom (autocomplétion). Ex: "Villeneuve d\'Ascq", "Lyon".',
        },
        codePostal: { type: "string", description: 'Code postal exact (5 chiffres). Ex: "59650".' },
        code: { type: "string", description: 'Code INSEE exact (5 caractères). Ex: "59009".' },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-30, défaut 10).",
          default: 10,
        },
        boostPopulation: {
          type: "boolean",
          description:
            "Trier par population décroissante. Recommandé pour les noms ambigus (ex: 'Charleville').",
          default: true,
        },
      },
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        q: "nom",
        query: "nom",
        search: "nom",
        codepostal: "codePostal",
        postal_code: "codePostal",
        code_insee: "code",
        insee: "code",
      });
      requireOneOf(args, ["nom", "codePostal", "code"], { nom: "Lyon" });
      const opts: Parameters<typeof searchCommunes>[0] = {
        boostPopulation: args.boostPopulation !== false,
      };
      const nom = asString(args.nom);
      const codePostal = asString(args.codePostal);
      const code = asString(args.code);
      const limit = coerceNumber(args.limit, "limit");
      if (nom) opts.nom = nom;
      if (codePostal) opts.codePostal = codePostal;
      if (code) opts.code = code;
      if (limit !== undefined) opts.limit = limit;
      return searchCommunes(opts);
    },
  },
  {
    name: "get_commune_by_code",
    description:
      "Récupère une commune par son code INSEE. Retourne un objet `LookupResult` discriminé par `found`. `found: true` → champs commune à plat (nom, codesPostaux, centre…). `found: false` → `{ found: false, key, lookupStatus: 'not_found', message }` orientant vers `autocomplete_commune` pour disambiguer.\n\nAlias acceptés : `code_insee`/`codeInsee`/`insee` → `code`.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            'Code INSEE 5 caractères. Ex: "75056" Paris, "59009" Villeneuve-d\'Ascq, "2A004" Ajaccio.',
        },
      },
      required: ["code"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        code_insee: "code",
        codeInsee: "code",
        insee: "code",
      });
      const code = requireString(args, "code", { code: "75056" });
      return getCommuneByCode(code);
    },
  },
  {
    name: "geocode_adresse",
    description:
      "Géocode une adresse française en coordonnées GPS. Source : IGN Géoplateforme (data.geopf.fr). Précision au numéro de rue.\n\nLe champ `score` (0-1) qualifie la fiabilité du match : >= 0.8 fiable, < 0.5 = match douteux (souvent un fallback rue/commune sans rapport avec l'adresse demandée). Le champ booléen `confidence_low` vaut `true` dans ce cas : ne PAS utiliser `point` pour une décision quand `confidence_low: true`. Le champ `type` indique aussi la granularité (housenumber > street > locality > municipality).",
    inputSchema: {
      type: "object",
      properties: {
        adresse: { type: "string", description: "Adresse complète à géocoder." },
        codePostal: {
          type: "string",
          description: "Optionnel — limiter le résultat à un code postal pour désambiguïser.",
        },
        codeCommune: {
          type: "string",
          description: "Optionnel — limiter au code INSEE de commune.",
        },
      },
      required: ["adresse"],
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const adresse = asString(args.adresse);
      if (!adresse) throw new RangeError("adresse (string) requise");
      const opts: Parameters<typeof geocode>[1] = {};
      const codePostal = asString(args.codePostal);
      const codeCommune = asString(args.codeCommune);
      if (codePostal) opts.codePostal = codePostal;
      if (codeCommune) opts.codeCommune = codeCommune;
      return geocode(adresse, opts);
    },
  },
  {
    name: "reverse_geocode",
    description:
      "Géocodage inverse : à partir de coordonnées GPS, retrouve l'adresse la plus proche. Source : IGN Géoplateforme. Couverture France métropolitaine + DOM uniquement : des coordonnées hors zone (ex. New York) ou en pleine mer renvoient `null` (pas une erreur — c'est l'absence de résultat, pas une panne).",
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude (WGS84)." },
        lat: { type: "number", description: "Latitude (WGS84)." },
      },
      required: ["lon", "lat"],
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const lon = Number(args.lon);
      const lat = Number(args.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new RangeError("lon et lat (number) requis");
      }
      return reverseGeocode({ lon, lat });
    },
  },
  {
    name: "population_par_commune",
    description:
      "Population municipale (PMUN), population comptée à part (PCAP) et population totale (PTOT) d'une commune française par son code INSEE (5 caractères). Source : INSEE Melodi (DS_POPULATIONS_REFERENCE). PMUN est la base légale officielle utilisée pour les indicateurs DREES (densité médicale, etc.). Retourne un `LookupResult` discriminé par `found`. Si la commune a fusionné ou changé de code, `found: false` avec orientation vers `autocomplete_commune`.\n\nAlias acceptés : `code_insee`/`codeInsee`/`insee` → `code`.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            'Code INSEE de la commune (5 caractères). Ex: "75056" Paris, "13055" Marseille, "59009" Villeneuve-d\'Ascq, "2A004" Ajaccio. INSEE n\'expose PAS la population des arrondissements PLM (75101-75120, 13201-13216, 69381-69389) : utiliser la commune-mère (75056/13055/69123).',
        },
      },
      required: ["code"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        code_insee: "code",
        codeInsee: "code",
        insee: "code",
      });
      const code = requireString(args, "code", { code: "59009" });
      return getPopulationByCommune(code);
    },
  },
  {
    name: "population_par_departement",
    description:
      "Population municipale (PMUN), comptée à part (PCAP) et totale (PTOT) d'un département français par son code INSEE (2-3 caractères). Source : INSEE Melodi (DS_POPULATIONS_REFERENCE). PMUN recommandée pour calculs de densité (méthodo DREES). Supporte la Corse (2A, 2B) et les DOM 971-974 ; Mayotte (976) est ABSENTE de DS_POPULATIONS_REFERENCE INSEE Melodi → retour `lookupNotFound` (pas une erreur).\n\nAlias acceptés : `code_dept`/`dept`/`departement`/`code_departement` → `code`.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            'Code INSEE du département (2-3 caractères). Ex: "75" Paris, "59" Nord, "13" Bouches-du-Rhône, "2A" Corse-du-Sud, "971" Guadeloupe.',
        },
      },
      required: ["code"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        code_dept: "code",
        dept: "code",
        departement: "code",
        code_departement: "code",
      });
      const code = requireString(args, "code", { code: "59" });
      return getPopulationByDept(code);
    },
  },
  {
    name: "entreprises_in_radius",
    description:
      "Recherche d'entreprises françaises avec filtres NAF, code postal, département ou rayon géographique. Couvre tous secteurs (santé via NAF 8690B, 4773Z, 8710A, 8621Z, etc.). Source : DINUM Recherche Entreprises (SIRENE + RNE). Renvoie CA, dirigeants, tranches d'effectif et dates de création.\n\nDeux modes EXCLUSIFs (endpoints DINUM distincts) : (1) proximité — `lat`+`lon`+`radiusKm` (optionnellement + `naf`), résolu nativement via `/near_point` ; (2) administratif — `q` (texte libre) et/ou `naf` + `codePostal`/`departement`, via `/search`. La recherche de proximité ne supporte PAS `q` ni `codePostal`/`departement` (combinaison rejetée avec une erreur explicite : choisir un seul mode). `radiusKm` borné à 50 km.",
    inputSchema: {
      type: "object",
      properties: {
        naf: {
          type: "string",
          description:
            "Code NAF principal (ex: '8690B' = labos, '4773Z' = pharmacies, '8710A' = EHPAD, '8621Z' = MG).",
        },
        q: {
          type: "string",
          description: "Recherche textuelle libre (raison sociale, dirigeant…).",
        },
        lon: { type: "number", description: "Longitude du centre du cercle de recherche." },
        lat: { type: "number", description: "Latitude du centre du cercle de recherche." },
        radiusKm: { type: "number", description: "Rayon en km (1-50)." },
        codePostal: { type: "string", description: "Filtre alternatif : code postal exact." },
        departement: { type: "string", description: "Filtre alternatif : code département." },
        perPage: {
          type: "number",
          description: "Résultats par page (1-25, défaut 10).",
          default: 10,
        },
        page: { type: "number", description: "Page (1-indexed).", default: 1 },
      },
    },
    outputSchema: DINUM_QUERY_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const naf = asString(args.naf);
      const q = asString(args.q);
      const codePostal = asString(args.codePostal);
      const departement = asString(args.departement);
      // coerceNumber (vs asNumber) : un caller passant `radiusKm: "50 km"`
      // tomberait silencieusement sur "pas de filtre géo" au lieu de signaler
      // la saisie. Même silent-failure shape que le bug Charleville sur
      // `professionnels_in_radius` corrigé en V0.4.1 — propagé ici par cohérence.
      const perPage = coerceNumber(args.perPage, "perPage");
      const page = coerceNumber(args.page, "page");
      const lon = coerceNumber(args.lon, "lon");
      const lat = coerceNumber(args.lat, "lat");
      const radiusKm = coerceNumber(args.radiusKm, "radiusKm");
      const hasCoords = lon !== undefined && lat !== undefined && radiusKm !== undefined;

      const opts: Parameters<typeof searchEntreprises>[0] = {};
      if (naf) opts.naf = naf;
      if (q) opts.q = q;
      if (codePostal) opts.codePostal = codePostal;
      if (departement) opts.departement = departement;
      if (perPage !== undefined) opts.perPage = perPage;
      if (page !== undefined) opts.page = page;
      if (hasCoords) {
        opts.center = { lon, lat };
        opts.radiusKm = radiusKm;
      }
      return searchEntreprises(opts);
    },
  },
  {
    name: "entreprise_by_siren",
    description:
      "Récupère le détail d'une entreprise française par son SIREN (9 chiffres) : raison sociale, NAF, finances historiques, dirigeants, établissements. Source : DINUM Recherche Entreprises.\n\n**Format de retour** : objet `LookupResult` discriminé par `found`.\n- `found: true` → l'entreprise est retournée à plat (champs `siren`, `nomComplet`, `etablissements`, `enrichmentStatus`, …)\n- `found: false` → `{ found: false, key, lookupStatus: 'not_found' | 'ambiguous', message }`. `not_found` : SIREN non indexé par DINUM (souvent diffusion partielle INSEE — l'entreprise peut quand même exister dans SIRENE). `ambiguous` : régression API à signaler.\n\n⚠️ Quand `found: true`, la liste `etablissements` peut être tronquée. Le champ `nombreEtablissements` (compté SIRENE) reflète le total réel. **Lire `enrichmentStatus`** pour savoir si la liste est complète :\n- `success` : `etablissements` contient tous les sites\n- `partial` : sites manquants (multi-département ou NAF différent du siège) — voir `enrichmentWarning`\n- `failed` : l'enrichissement a échoué (rate limit, panne API) — seul le siège est listé\n- `not_attempted` : entreprise monosite ou data SIRENE manquante\n\nPour énumération exhaustive multi-département, utiliser `entreprises_in_radius` par zone géographique. Coût : 1 ou 2 appels API DINUM par invocation (rate limit ~1 req/s effectif).",
    inputSchema: {
      type: "object",
      properties: {
        siren: { type: "string", description: "SIREN exact, 9 chiffres." },
      },
      required: ["siren"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      if (typeof args.siren !== "string") throw new RangeError("siren (string) requis");
      return getEntrepriseBySiren(args.siren);
    },
  },
  {
    name: "data_freshness",
    description:
      "Retourne la fraîcheur des dumps de données ingérés côté serveur : FINESS DREES (bimestriel), Annuaire Santé Ameli (hebdomadaire), RPPS / Annuaire Santé ANS (mensuel), Centres de Santé CNAM (hebdomadaire). Pour chaque source : `last_success_at` ISO timestamp, `last_success_row_count`, `last_attempt_at`, `last_attempt_status`, `staleness_days` (jours depuis la dernière ingestion réussie), `cadence_hint` (cadence attendue côté éditeur).\n\nUsage typique : avant un audit territorial ou une analyse temporelle, le caller appelle ce tool pour savoir si les données sont à jour. Une `staleness_days > 90` côté FINESS = alerte (dernier sync DREES manqué), `> 14` côté Ameli = alerte (job hebdo cassé), `> 45` côté RPPS = alerte (job mensuel cassé), `> 14` côté CDS = alerte (job hebdo cassé).\n\nLes sources LIVE (DINUM Recherche Entreprises, INSEE SIRENE V3.11, ANS FHIR live) ne sont PAS listées ici puisqu'elles n'ont pas de cycle d'ingestion — leur fraîcheur est celle des API amont (live, ~secondes).\n\nCache serveur : 5 minutes. Coût : 1 SELECT sur `ingest_log` au pire (sinon hit cache).",
    inputSchema: {
      type: "object",
      properties: {},
      // Tool sans paramètre : schema strict explicite (les clients LLM en
      // strict-mode rejettent un `properties:{}` ambigu sans cette borne).
      additionalProperties: false,
    },
    outputSchema: DATA_FRESHNESS_OUTPUT_SCHEMA,
    annotations: READ_ONLY_TIME_VARYING_ANNOTATIONS,
    handler: async () => {
      const rows = await getDataFreshness();
      return { sources: rows };
    },
  },
  {
    name: "compare_raison_sociale_finess_vs_rpps",
    description:
      "Compare la raison sociale FINESS DREES vs RPPS / Annuaire Santé ANS pour un même num_finess. Primitive brute SANS interprétation métier — retourne juste les deux libellés + un statut de comparaison. Le caller décide quoi faire de la divergence.\n\nUtilité : RPPS reflète souvent plus rapidement les rebrandings post-M&A que FINESS DREES (ex: un site racheté reste 'DIAGNOVIE' chez DREES alors qu'il est déjà 'BIOGROUP NORD' chez l'ANS). Ce tool expose la divergence factuelle ; il NE DIT PAS qui a racheté qui (ça repose sur de la connaissance d'enseignes commerciales non publique).\n\n**Statut renvoyé** (champ `statut` présent uniquement sur la branche `found: true`) :\n- `exact_match` : FINESS et ≥1 RPPS sont strictement égaux après normalisation\n- `divergent_after_normalization` : aucune RPPS ne matche FINESS — vraie divergence\n- `rpps_absent` : aucune RPPS n'a déclaré ce FINESS (pivot impossible)\n\nFormat : objet `LookupResult` discriminé par `found`. Quand `num_finess` est absent de FINESS DREES, le tool retourne `{found: false, lookupStatus: 'not_found', message, ...}` — il n'y a PAS de champ `statut` dans ce cas.",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: { type: "string", description: "Numéro FINESS exact (9 chiffres)." },
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      return compareRaisonSocialeFinessVsRpps(numFiness);
    },
  },
  {
    name: "compare_adresse_cnam_vs_finess",
    description:
      "Compare l'adresse d'un centre de santé côté CNAM (Annuaire santé Ameli) vs FINESS DREES pour un même num_finess. Primitive brute SANS interprétation métier — retourne les deux adresses, un `score_dice` (0..1, informatif ; `null` si non comparable car `finess_absent`) et un `statut`. Le caller décide quoi faire de la divergence.\n\nUtilité : signaler un déménagement propagé par une source mais pas (encore) par l'autre (ex: CNAM '5 RUE DE L'ARQUEBUSE AUTUN' vs FINESS '15 BD BERNARD GIBERSTEIN AUTUN' pour le même FINESS). Équivalent côté centre de santé de `compare_raison_sociale_finess_vs_rpps`.\n\n**Statut** (présent uniquement sur `found: true`) :\n- `match` : adresses strictement égales après normalisation\n- `match_after_abbreviation_normalization` : égales après expansion des abréviations de voie FR (R/RUE, BD/BOULEVARD, AV/AVENUE…) — MÊME adresse, simple abréviation DREES vs CNAM, PAS un déménagement\n- `divergent_after_normalization` : adresses réellement différentes (déménagement non synchronisé entre sources)\n- `finess_absent` : le CDS existe côté CNAM mais le num_finess est absent de FINESS DREES (latence sync bimensuelle)\n\nFormat : objet `LookupResult` discriminé par `found`. Si le num_finess n'est PAS un centre de santé CNAM, le tool retourne `{found: false, lookupStatus: 'not_found', message}` (utiliser `etablissement_by_finess` pour un établissement non-CDS).",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: { type: "string", description: "Numéro FINESS exact (9 chiffres)." },
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      return compareAdresseCnamVsFiness(numFiness);
    },
  },
  {
    name: "historique_etablissement",
    description:
      "Reconstitue la timeline complète d'un établissement de santé (ouvertures, fermetures, changements de NAF/enseigne) en croisant FINESS DREES ↔ resolver SIRET (RPPS + DINUM) ↔ SIRENE INSEE V3.11. Lit les `periodesEtablissement` complètes pour chaque SIRET candidat.\n\n**V0.7.0** : SIRET candidats élargis via le resolver — inclut désormais les SIRET fermés du SIREN parent qui matchent l'adresse FINESS (invisibles côté RPPS seul). Permet de tracer la fermeture exacte d'un site même quand FINESS le liste encore actif.\n\nUsage typique :\n- Tracer l'historique d'un site après une fusion-acquisition\n- Identifier la date de fermeture exacte d'un SIRET encore listé actif côté FINESS\n- Comprendre une cascade de rebrandings via les changements de `enseigne1Etablissement` au fil des périodes\n\nFormat : objet `LookupResult`. Quand `found: true`, retourne `finess` (vue DREES synthétique) + `siret_timelines` (1 entrée par SIRET candidat avec `periodes` chronologiques).\n\nCoût : 1 RPC FINESS + 1 SELECT rpps + N appels DINUM + N appels INSEE en parallèle (N ≤ 5 typiquement). Pas de cache.",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: { type: "string", description: "Numéro FINESS exact (9 chiffres)." },
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      return historiqueEtablissement(numFiness);
    },
  },
  {
    name: "reconcilier_finess_sirene",
    description:
      "Croise FINESS DREES ↔ SIRENE INSEE V3.11 et calcule un score de cohérence (Sørensen-Dice sur bigrammes) pour chaque SIRET candidat. Utile pour confirmer/infirmer un appariement num_finess ↔ SIRET avant prospection ou cross-check qualité.\n\nLogique :\n1. Récupère FINESS (raison sociale + adresse libellée)\n2. Récupère SIRET candidats via la table RPPS\n3. Pour chaque SIRET, lookup SIRENE puis calcule 3 sous-scores :\n   - `nom` : Dice sur raison sociale (FINESS vs SIRENE.uniteLegale)\n   - `adresse` : Dice sur adresse complète\n   - `telephone` : binaire 0/1 (toujours 0 actuellement : SIRENE n'expose pas le tel)\n4. Score global = pondération (nom 0.5, adresse 0.4, tel 0.1)\n5. Verdict brut : `match` (≥0.8) / `partial` (0.5..0.8) / `mismatch` (<0.5)\n\nAlgorithme PUBLIC (Sørensen-Dice est dans la littérature depuis 1948). Aucune valeur ajoutée Unilabs ici — c'est une primitive ouverte. La connaissance propriétaire (mapping enseignes ↔ SELAS) reste côté Geo Intel.\n\nFormat : objet `LookupResult`. Quand `found: true`, retourne `{ num_finess, candidates, skipped }` :\n- `candidates` : tableau trié par `score_global` décroissant (meilleur match en premier)\n- `skipped` : SIRET candidats qu'on n'a PAS pu réconcilier (lookup SIRENE rejected ou not_found) avec la `reason`. Permet au caller de distinguer 'aucun SIRET candidat trouvé' (`found: false` LookupResult.not_found) de 'N SIRETs candidats mais tous rejetés par SIRENE' (`candidates: []` + `skipped: [...]`).",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: { type: "string", description: "Numéro FINESS exact (9 chiffres)." },
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      return reconcilierFinessSirene(numFiness);
    },
  },
  {
    name: "verifier_site_actif",
    description:
      "Vérifie si un établissement de santé FINESS est encore en activité en croisant FINESS DREES ↔ RPPS (pivot SIRET) ↔ DINUM (liste complète des SIRET du SIREN, incluant les fermés). Détecte les SIRET fermés encore listés actifs côté FINESS (DREES a 1-2 mois de retard).\n\n**V0.7.0 — breaking** : pivot SIRET élargi. Avant V0.7.0, on ne testait que les SIRET RPPS-déclarés (= SIRET du siège employeur typiquement) → on ratait le SIRET physique fermé du site. Désormais, le resolver récupère TOUS les SIRET du SIREN via DINUM puis fuzzy-matche leur adresse contre FINESS — ce qui capte aussi les SIRET fermés invisibles côté RPPS.\n\nLogique :\n1. Lookup FINESS pour récupérer raison sociale + adresse + téléphone DREES\n2. Récupération des SIRET candidats via le resolver (RPPS + DINUM avec scoring d'adresse Dice)\n3. `best_match` = SIRET avec le meilleur score d'adresse ≥ 0.6 (= site physique)\n4. **2 verdicts distincts** :\n  - `verdict_site` (`actif` / `ferme` / `indetermine`) : basé sur `best_match.actif`. C'est le verdict qui compte pour un audit territorial.\n  - `verdict_groupe` (`actif` / `ferme` / `indetermine`) : basé sur l'état admin de l'UL parente (champ `actif` DINUM). Une UL active peut très bien avoir un site fermé.\n\n**Format de retour** : objet `LookupResult` discriminé par `found`. Quand `found: true`, le payload contient `finess` (vue DREES), `candidates` (liste enrichie tri score), `best_match`, `sirens_explored`, `verdict_site`, `verdict_groupe`, `explication`. Quand `num_finess` est absent de FINESS DREES, le tool retourne `{found: false, lookupStatus: 'not_found', message, ...}`.\n\nCoût : 1 RPC FINESS + 1 SELECT rpps + N appels DINUM (N = nombre de SIREN distincts, typiquement 1). DINUM gère son propre fallback INSEE V3.11 pour les SIREN diffusion partielle.",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: { type: "string", description: "Numéro FINESS exact (9 chiffres)." },
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      return verifierSiteActif(numFiness);
    },
  },
  {
    name: "etablissement_by_siret",
    description:
      "Récupère le détail d'un établissement par son SIRET (14 chiffres) via l'API SIRENE INSEE V3.11 : raison sociale de l'unité légale, enseigne commerciale, NAF de l'établissement, dates de création/fermeture, statut administratif actif/fermé, adresse complète, tranche d'effectif. Source : SIRENE INSEE V3.11 (api.insee.fr).\n\n**Format de retour** : objet `LookupResult` discriminé par `found`.\n- `found: true` → établissement à plat (`siret`, `siren`, `actif`, `dateFermeture`, `enseigne`, `adresse`, …)\n- `found: false` → `{ found: false, key, lookupStatus: 'not_found', message }`. Cas typiques : clé `INSEE_SIRENE_API_KEY` non configurée côté serveur (message explicite), SIRET inexistant SIRENE, diffusion partielle INSEE.\n\n⚠️ Différence avec `entreprise_by_siren` : ce tool renvoie UN établissement précis (un site), alors que `entreprise_by_siren` renvoie l'unité légale + sa liste d'établissements. Pour détecter un SIRET fermé encore listé actif côté FINESS, lire `actif: false` + `dateFermeture`.\n\n**Pas de coords** : l'endpoint INSEE `/siret/<siret>` ne renvoie pas les coordonnées GPS. Pour géolocaliser, croiser avec `geocode_adresse` côté caller ou utiliser `entreprises_in_radius`.\n\nRate limit INSEE : 30 req/min (retry-after géré côté serveur).",
    inputSchema: {
      type: "object",
      properties: {
        siret: { type: "string", description: "SIRET exact, 14 chiffres." },
      },
      required: ["siret"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const trimmed = requireSiretId(args);
      return lookupSiretViaInsee(trimmed);
    },
  },
  {
    name: "etablissements_finess_in_radius",
    description: `Recherche d'établissements de santé FINESS dans un rayon géographique (PostGIS ST_DWithin). Filtrable par familles. 24 valeurs disponibles : ${FAMILLES_LIST}. Source : FINESS / DREES (dump CSV ingéré localement). Note : champ \`email\` toujours \`null\` (non exposé par FINESS public). ${FINESS_RS_TRUNCATION_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84)." },
        lat: { type: "number", description: "Latitude du centre (WGS84)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: RADIUS_MIN_KM,
          maximum: RADIUS_MAX_KM,
          default: 5,
        },
        familles: {
          type: "array",
          description:
            "Familles FINESS à inclure (24 valeurs disponibles, voir enum). Si omis, toutes catégories.",
          items: { type: "string", enum: [...FINESS_FAMILLE_INPUTS] },
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["lon", "lat"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const { lon, lat } = requireLonLatStrict(args);
      const radiusKm = coerceNumber(args.radius_km, "radius_km") ?? 5;
      // Bornes radius validées au DB layer (validateRadiusKm dans
      // finess-db.ts/ameli-db.ts via db-helpers) — source unique.
      const familles = parseFamilles(args.familles);
      const limit = coerceNumber(args.limit, "limit");
      const input: Parameters<typeof getFinessInRadius>[0] = {
        center: { lon, lat },
        radiusKm,
      };
      if (familles) input.familles = familles;
      if (limit !== undefined) input.limit = limit;
      return withFreshness(await getFinessInRadius(input), args.include_freshness, ["finess"]);
    },
  },
  {
    name: "etablissements_finess_by_categorie",
    description: `Liste des établissements FINESS par famille, avec filtre département ou commune optionnel. Pas de rayon — pour énumération exhaustive d'une zone administrative. 24 familles disponibles : ${FAMILLES_LIST}. Source : FINESS / DREES. Note : champ \`email\` toujours \`null\` (non exposé par FINESS public). ${FINESS_RS_TRUNCATION_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        categorie: {
          type: "string",
          description: "Famille FINESS recherchée (24 valeurs disponibles, voir enum).",
          enum: [...FINESS_FAMILLE_INPUTS],
        },
        departement: {
          type: "string",
          description:
            "Code département INSEE (ex: '75', '2A', '2B', '971'). Métropole 2 caractères (Corse '2A'/'2B', pas '20'), DOM/TOM 3 caractères. Optionnel.",
        },
        code_insee: {
          type: "string",
          description: "Code INSEE de commune (5 caractères). Optionnel.",
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["categorie"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const famille = asFinessFamille(args.categorie);
      if (!famille) {
        throw new RangeError(`categorie (string) requis : ${FINESS_FAMILLE_INPUTS.join(", ")}.`);
      }
      const departement = asString(args.departement);
      const codeInsee = asString(args.code_insee);
      const limit = coerceNumber(args.limit, "limit");
      const input: Parameters<typeof getFinessByCategorie>[0] = { famille };
      if (departement) input.departement = departement;
      if (codeInsee) input.code_insee = codeInsee;
      if (limit !== undefined) input.limit = limit;
      return withFreshness(await getFinessByCategorie(input), args.include_freshness, ["finess"]);
    },
  },
  {
    name: "etablissement_by_finess",
    description: `Récupère le détail complet d'un établissement de santé par son numéro FINESS (9 chiffres) : raison sociale, catégorie + famille, adresse complète (voie + CP + ville + code INSEE + département), coordonnées GPS, téléphone. Retourne un objet \`LookupResult\` discriminé par \`found\`. \`found: true\` → champs FINESS à plat. \`found: false\` → \`{ found: false, key, lookupStatus: 'not_found', message }\`. Le référentiel DREES a 1-2 mois de retard sur le terrain : pour des structures émergentes (CPTS récentes, MSP en agrément), cross-check ARS / Service Public. Source : FINESS / DREES. Note : champ \`email\` toujours \`null\` (non exposé par FINESS public). ${FINESS_RS_TRUNCATION_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        num_finess: {
          type: "string",
          description: "Numéro FINESS exact (9 chiffres).",
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      const result = await getFinessByNumFiness(numFiness);
      // LookupResult discriminé par `found`. On n'injecte la freshness que sur
      // les payloads `found: true` (le not_found est par construction sans
      // metadata métier — l'injecter ferait du bruit pour le caller).
      if (!result.found) return result;
      return withFreshness(result, args.include_freshness, ["finess"]);
    },
  },
  {
    name: "centres_sante_in_radius",
    description:
      "Recherche des Centres de Santé (CDS) dans un rayon géographique (PostGIS ST_DWithin). Source : Annuaire santé Ameli, Assurance Maladie (mention obligatoire L.1461-2 CSP — sync hebdomadaire CNAM). Différenciateur métier vs `etablissements_finess_in_radius` filtré famille=124 : expose **carte_vitale**, **APCV**, **spécialités exercées sur place** (Annexe A nomenclature CNAM, ~70 codes).\n\nCDS = structures de soins ambulatoires non lucratives encadrées L.6323-1 CSP (associations, mutuelles, communes, hôpitaux). Volume ~3K en France. Filtres :\n- `specialite_codes` : array Annexe A (ex: ['01'] médecine générale, ['53'] dentaire). Match any-of — retourne les CDS qui exercent AU MOINS UNE des spécialités demandées.\n- `accepte_carte_vitale` : true / false / omis. Quasi-totalité accepte CV en pratique → filtre surtout utile en `false` pour audits.\n- `type_etab_codes` : ['124'] CDS standard, ['125'] CDS dentaire (deprecated CNAM, en voie d'extinction).\n\nCoords = centroïde commune (~3 km moyenne) — pour précision adresse, pivoter via `etab_finess` retourné avec `etablissement_by_finess`. PAS d'horaires/tarifs/secteur 1/2 (retirés du nouvel annuaire CNAM post-2025).\n\nAlias acceptés : `radius`/`radius_meters` → `radius_km`, `latitude`/`longitude` → `lat`/`lon`.",
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84). Ex: 2.317 (Paris)." },
        lat: { type: "number", description: "Latitude du centre (WGS84). Ex: 48.872 (Paris)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: RADIUS_MIN_KM,
          maximum: RADIUS_MAX_KM,
          default: 5,
        },
        specialite_codes: {
          type: "array",
          items: { type: "string" },
          description:
            "Codes spécialité CNAM Annexe A (ex: ['01'] médecine générale, ['53'] chirurgien-dentiste). Match any-of. Vide = pas de filtre spécialité.",
        },
        accepte_carte_vitale: {
          type: "boolean",
          description:
            "Filtre par acceptation carte Vitale. true = uniquement CDS qui acceptent CV, false = uniquement ceux qui ne l'acceptent pas. Omis = pas de filtre.",
        },
        type_etab_codes: {
          type: "array",
          items: { type: "string" },
          description:
            "Codes type établissement Annexe B : ['124'] CDS standard (défaut implicite), ['125'] CDS dentaire deprecated. Vide = tous types.",
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["lon", "lat"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        radius: "radius_km",
        radius_meters: "radius_km",
        latitude: "lat",
        longitude: "lon",
      });
      const { lon, lat } = requireLonLatStrict(args);
      const radiusKm = coerceNumber(args.radius_km, "radius_km") ?? 5;
      const limit = coerceNumber(args.limit, "limit");
      const input: Parameters<typeof getCdsInRadius>[0] = {
        center: { lon, lat },
        radiusKm,
      };
      if (Array.isArray(args.specialite_codes) && args.specialite_codes.length > 0) {
        input.specialiteCodes = args.specialite_codes.filter(
          (s): s is string => typeof s === "string",
        );
      }
      if (typeof args.accepte_carte_vitale === "boolean") {
        input.accepteCarteVitale = args.accepte_carte_vitale;
      }
      if (Array.isArray(args.type_etab_codes) && args.type_etab_codes.length > 0) {
        input.typeEtabCodes = args.type_etab_codes.filter(
          (s): s is string => typeof s === "string",
        );
      }
      if (limit !== undefined) input.limit = limit;
      return withFreshness(await getCdsInRadius(input), args.include_freshness, ["cds"]);
    },
  },
  {
    name: "centres_sante_by_finess",
    description:
      "Récupère le détail d'un Centre de Santé (CDS) par son numéro FINESS. Différenciateur métier vs `etablissement_by_finess` : expose **carte_vitale**, **APCV**, et **spécialités exercées sur place** (Annexe A CNAM). Retourne un `LookupResult` discriminé par `found`.\n\n`found: true` → payload CDS complet (raison sociale, accepte_carte_vitale/apcv, specialites.codes/libelles alignés, type_etab 124/125, adresse, coords centroïde commune, telephone). `found: false` → `{found: false, key, lookupStatus: 'not_found', message}` quand le numéro FINESS pointe vers une structure non-CDS (hôpital, EHPAD, labo) ou un CDS très récent (CNAM latence ~1 sem).\n\nSource : Annuaire santé Ameli, Assurance Maladie (sync hebdomadaire CNAM, mention obligatoire L.1461-2 CSP). Pour les structures non-CDS, utiliser `etablissement_by_finess`.\n\nAlias acceptés : `numFiness`/`finess`/`etab_finess` → `num_finess`.",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: {
          type: "string",
          description: "Numéro FINESS exact 9 chiffres. Ex: '750000123'.",
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        numFiness: "num_finess",
        finess: "num_finess",
        etab_finess: "num_finess",
      });
      const numFiness = requireFinessId(args);
      const result = await getCdsByFiness(numFiness);
      // Symétrie avec etablissement_by_finess : pas de freshness sur le
      // not_found (payload sans metadata métier — bruit pour le caller).
      if (!result.found) return result;
      return withFreshness(result, args.include_freshness, ["cds"]);
    },
  },
  {
    name: "professionnels_in_radius",
    description: `Recherche de professionnels de santé libéraux conventionnés dans un rayon géographique. Précision géo : centroïde commune (~3 km en moyenne — adapté à l'analyse de densité, pas au géocodage adresse). ${AMELI_TYPE_PS_HELP} Pour cibler une profession précise (ex: IDE seuls, kinés seuls, podologues seuls), passer par \`specialite_codes\` plutôt que \`type_ps_codes\` qui ratisse plus large. Liste exhaustive des codes spécialité disponibles via le tool \`lister_specialites_ameli\`. Multi-sites : par défaut un PS exerçant sur N adresses apparaît N fois — utiliser \`dedupe_by_ps=true\` pour regrouper par praticien et lister les sites en sous-objet. Distance retournée en km vol d'oiseau (haversine PostGIS) — pour distance routière, croiser avec un service externe (OSRM, ORS). Chaque PS géolocalisé porte \`geo_precision: "centroide_commune"\` : \`coords\` et \`distance_km\` sont au centroïde commune, donc tous les PS d'une même commune ont la MÊME \`distance_km\` — ne pas l'utiliser pour classer/choisir un PS individuel, uniquement comme filtre de zone. ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84)." },
        lat: { type: "number", description: "Latitude du centre (WGS84)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: RADIUS_MIN_KM,
          maximum: RADIUS_MAX_KM,
          default: 5,
        },
        specialite_codes: {
          type: "array",
          description:
            "Liste de codes spécialité Ameli (ex: ['01'] MG, ['03'] cardio). Si omis, toutes spécialités.",
          items: { type: "string" },
        },
        type_ps_codes: {
          type: "array",
          description:
            "Liste de codes type PS Ameli (3 valeurs présentes en base : '1' médecins, '2' auxiliaires médicaux fourre-tout — IDE/kinés/sages-femmes/podologues/orthophonistes/orthoptistes/IPA, '5' chirurgiens-dentistes). Pour cibler une seule profession, préférer `specialite_codes`. Si omis, tous types.",
          items: { type: "string" },
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100). Appliqué AVANT déduplication.",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        dedupe_by_ps: {
          type: "boolean",
          description:
            "Regrouper les entrées par praticien (nom + prénom + code spécialité) et lister chaque adresse d'exercice dans `sites[]`. Défaut false (comportement V0.4 historique : un PS multi-sites = N entrées).",
          default: false,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["lon", "lat"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const { lon, lat } = requireLonLatStrict(args);
      const radiusKm = coerceNumber(args.radius_km, "radius_km") ?? 5;
      // Bornes radius validées au DB layer (cf. ameli-db.ts) — source unique.
      const specialiteCodes = parseStringArray(args.specialite_codes, "specialite_codes");
      const typePsCodes = parseStringArray(args.type_ps_codes, "type_ps_codes");
      const limit = coerceNumber(args.limit, "limit");
      const dedupe = coerceBoolean(args.dedupe_by_ps, "dedupe_by_ps") === true;
      const input: Parameters<typeof getAmeliInRadius>[0] = {
        center: { lon, lat },
        radiusKm,
      };
      if (specialiteCodes) input.specialiteCodes = specialiteCodes;
      if (typePsCodes) input.typePsCodes = typePsCodes;
      if (limit !== undefined) input.limit = limit;
      const result = await getAmeliInRadius(input);
      return withFreshness(dedupe ? dedupeAmeliByPs(result) : result, args.include_freshness, [
        "ameli_ps",
      ]);
    },
  },
  {
    name: "professionnels_par_specialite_dept",
    description: `Liste des professionnels de santé libéraux conventionnés d'un département, avec filtres optionnels par spécialité ou type de PS. Pour énumération administrative — pas de rayon. ${AMELI_TYPE_PS_HELP} Pour cibler une profession précise (ex: IDE seuls), passer par \`specialite_code\` plutôt que \`type_ps_code\` qui ratisse plus large. Liste exhaustive des codes spécialité disponibles via le tool \`lister_specialites_ameli\`. Pagination : utiliser \`offset\` pour récupérer les pages suivantes quand \`truncated=true\`. Multi-sites : utiliser \`dedupe_by_ps=true\` pour regrouper par praticien. ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        departement: {
          type: "string",
          description:
            "Code département INSEE : 2 caractères métropole/Corse ('01'-'95', '2A'/'2B'), 3 caractères DOM ('971'-'978').",
        },
        specialite_code: {
          type: "string",
          description:
            "Code spécialité Ameli (ex: '01' MG, '24' IDE, '26' kiné, '03' cardio). Optionnel. Liste complète via `lister_specialites_ameli`.",
        },
        type_ps_code: {
          type: "string",
          description:
            "Code type PS Ameli ('1' médecins, '2' auxiliaires médicaux, '5' chirurgiens-dentistes). Optionnel — préférer `specialite_code` pour un ciblage précis. Liste complète via `lister_types_ps_ameli`.",
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100). Appliqué AVANT déduplication.",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        offset: {
          type: "number",
          description:
            "Décalage de pagination (≥ 0, défaut 0). Combiner avec `limit` pour énumérer un département à fort effectif. Re-paginer tant que `truncated=true`.",
          minimum: 0,
          default: 0,
        },
        dedupe_by_ps: {
          type: "boolean",
          description:
            "Regrouper les entrées par praticien (nom + prénom + code spécialité) et lister chaque adresse d'exercice dans `sites[]`. Défaut false.",
          default: false,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["departement"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const departement = asString(args.departement);
      if (!departement) throw new RangeError("departement (string) requis");
      const specialiteCode = asString(args.specialite_code);
      const typePsCode = asString(args.type_ps_code);
      const limit = coerceNumber(args.limit, "limit");
      const offset = coerceNumber(args.offset, "offset");
      const dedupe = coerceBoolean(args.dedupe_by_ps, "dedupe_by_ps") === true;
      const input: Parameters<typeof getAmeliBySpecialiteDept>[0] = { departement };
      if (specialiteCode) input.specialiteCode = specialiteCode;
      if (typePsCode) input.typePsCode = typePsCode;
      if (limit !== undefined) input.limit = limit;
      if (offset !== undefined) input.offset = offset;
      try {
        const result = await getAmeliBySpecialiteDept(input);
        return withFreshness(dedupe ? dedupeAmeliByPs(result) : result, args.include_freshness, [
          "ameli_ps",
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[france-data-mcp] ameli_query_failed: ${message}`);
        // V0.9.4 — diagnostic anonymisé pour Sentry FRANCE-DATA-MCP-3 (timeout
        // 57014). `has_*_filter` reflète l'application EFFECTIVE du filtre
        // (truthy check `if (specialiteCode) input.specialiteCode = …` plus
        // haut — `""` n'est PAS un filtre actif), sinon le scope Sentry
        // mentirait sur le pattern qui timeout.
        const queryContext: AmeliQueryErrorContext = {
          tool: "professionnels_par_specialite_dept",
          departement,
          has_specialite_filter: Boolean(specialiteCode),
          has_type_ps_filter: Boolean(typePsCode),
          offset: offset ?? 0,
          limit: limit ?? 100,
        };
        attachErrorContext(err, queryContext);
        throw err;
      }
    },
  },
  {
    name: "lister_specialites_ameli",
    description: `Liste les codes spécialité Ameli effectivement présents en base, avec leur libellé natif, leur \`type_ps_code\` de rattachement et leur count. Triés par fréquence décroissante. Utile pour découvrir la nomenclature avant de filtrer un \`professionnels_in_radius\` ou \`professionnels_par_specialite_dept\`. Le champ \`libelle_clarifie\` désambigüise les libellés partagés par plusieurs codes (ex: "Médecin généraliste" regroupe les codes 01/22/23, "Chirurgien-dentiste" 19/53/54, "Psychiatre" 33/75, "Gynécologue / Obstétricien" 07/70/77/79). Format quand partagé : \`'{libelle} (code {code}, {count_compact})'\` (ex: "Médecin généraliste (code 01, 55K)"). Sinon identique à \`libelle\`. \`is_libelle_partage: true\` quand au moins 2 codes utilisent le même libellé — utiliser ce flag côté caller pour décider d'afficher le code à l'utilisateur. Paginé : \`limit\` (défaut ${NOMENCLATURE_DEFAULT_LIMIT}), la réponse expose \`total\` et \`truncated\`. ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        limit: NOMENCLATURE_LIMIT_SCHEMA,
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const specialites = await listAmeliSpecialites();
      return withFreshness(limitNomenclature(specialites, args.limit), args.include_freshness, [
        "ameli_ps",
      ]);
    },
  },
  {
    name: "lister_types_ps_ameli",
    description: `Liste les codes \`type_ps\` Ameli présents en base, avec leur libellé natif (\`libelle_source\`), un libellé clarifié (\`libelle_clarifie\`) résolvant l'ambiguïté du code "2" fourre-tout, leur count total, et \`specialites_presentes\` (la liste effective des spécialités regroupées sous chaque type_ps avec leurs counts). Pas de dictionnaire inventé : la clarification est dérivée de la donnée live à chaque appel. Payload léger possible via \`include_specialites: false\` (remplace le sous-tableau par \`nb_specialites\`). ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        limit: NOMENCLATURE_LIMIT_SCHEMA,
        include_specialites: {
          type: "boolean",
          description:
            "Inclure le sous-tableau `specialites_presentes` détaillé par type_ps (défaut true). Passer `false` pour un payload léger : `specialites_presentes` est remplacé par `nb_specialites` (compteur), ~6K tokens économisés.",
          default: true,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const typesPs = await listAmeliTypesPs();
      // Branches séparées (pas de ternaire) : chaque appel à limitNomenclature
      // a un type concret, sinon TS unifie sur AmeliTypePsListEntry[] et
      // rejette la projection allégée.
      if (coerceBoolean(args.include_specialites, "include_specialites") === false) {
        const light = typesPs.map(({ specialites_presentes, ...rest }) => ({
          ...rest,
          nb_specialites: specialites_presentes.length,
        }));
        return withFreshness(limitNomenclature(light, args.limit), args.include_freshness, [
          "ameli_ps",
        ]);
      }
      return withFreshness(limitNomenclature(typesPs, args.limit), args.include_freshness, [
        "ameli_ps",
      ]);
    },
  },
  // --- V0.5 — RPPS / Annuaire Santé ANS (libéraux + salariés + ID stable) ---
  {
    name: "professionnels_rpps_in_radius",
    description: `Recherche de professionnels de santé dans un rayon via le RPPS (Annuaire Santé ANS). À la différence de \`professionnels_in_radius\` (Ameli, libéraux conventionnés uniquement), cette recherche couvre **tous les PS** : libéraux, salariés (hospitaliers, salariés en cabinet), mixtes, remplaçants. Filtres : \`profession_codes\` (nomenclature ANS — ex: 10 Médecin, 60 Infirmier), \`savoir_faire_codes\` (spécialité fine DES/DESC), \`mode_exercice_codes\`. ${RPPS_MODE_EXERCICE_HINT} ${RPPS_INCLUDE_CATEGORIES_HINT} Coords au centroïde commune (~3 km moyenne) — pour précision adresse, croiser \`num_finess\` retourné avec \`etablissement_by_finess\`. Chaque PS géolocalisé porte \`geo_precision: "centroide_commune"\` : tous les PS d'une même commune ont la MÊME \`distance_km\` — ne pas l'utiliser pour classer/choisir un PS individuel, uniquement comme filtre de zone. Le filtrage rayon est résolu à la granularité **commune** (une commune est incluse si son centroïde représentatif est dans le rayon), cohérent avec la précision centroïde ci-dessus ; tri par distance commune croissante. Si la commune la plus proche contient plus de \`limit\` PS correspondants, le résultat est intégralement puisé dans cette commune (les communes plus lointaines sont évincées du même \`limit\`) : augmenter \`limit\` ou resserrer les filtres pour couvrir plusieurs communes. ${NOMENCLATURE_COLLISION_WARNING} ${RPPS_CGU_NOTICE}`,
    inputSchema: {
      type: "object",
      properties: {
        center: {
          type: "object",
          description: "Centre du cercle de recherche (coordonnées WGS84).",
          properties: {
            lat: { type: "number", description: "Latitude (WGS84)." },
            lon: { type: "number", description: "Longitude (WGS84)." },
          },
          required: ["lat", "lon"],
        },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50).",
          minimum: RADIUS_MIN_KM,
          maximum: RADIUS_MAX_KM,
        },
        profession_codes: {
          type: "array",
          description:
            "Codes profession ANS (ex: ['10'] Médecin, ['60'] Infirmier). Si omis, toutes professions.",
          items: { type: "string" },
        },
        savoir_faire_codes: {
          type: "array",
          description:
            "Codes savoir-faire ANS (spécialités fines DES/DESC). Si omis, tous savoir-faire.",
          items: { type: "string" },
        },
        mode_exercice_codes: {
          type: "array",
          description:
            "Codes mode d'exercice ANS (libéral / salarié / mixte). Si omis, tous modes.",
          items: { type: "string" },
        },
        ...RPPS_INCLUDE_CATEGORIES_SCHEMA,
        limit: {
          type: "number",
          description: "Nombre max de résultats retournés (défaut serveur 100).",
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["center", "radius_km"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const center = args.center as { lat: number; lon: number } | undefined;
      if (!center) throw new RangeError("center {lat, lon} requis");
      const radiusKm = coerceNumber(args.radius_km, "radius_km");
      if (radiusKm === undefined) throw new RangeError("radius_km (number) requis");
      const limit = coerceNumber(args.limit, "limit");
      const professionCodes = parseStringArray(args.profession_codes, "profession_codes");
      const savoirFaireCodes = parseStringArray(args.savoir_faire_codes, "savoir_faire_codes");
      const modeExerciceCodes = parseStringArray(args.mode_exercice_codes, "mode_exercice_codes");
      const input: Parameters<typeof getRppsInRadius>[0] = { center, radiusKm };
      if (professionCodes) input.professionCodes = professionCodes;
      if (savoirFaireCodes) input.savoirFaireCodes = savoirFaireCodes;
      if (modeExerciceCodes) input.modeExerciceCodes = modeExerciceCodes;
      input.categorieCodes = categorieCodesFromArgs(args);
      if (limit !== undefined) input.limit = limit;
      return withFreshness(await getRppsInRadius(input), args.include_freshness, ["rpps"]);
    },
  },
  {
    name: "professionnels_rpps_par_dept",
    description: `Listing départemental de PS via RPPS (libéraux + salariés). Filtres optionnels : \`profession_code\`, \`savoir_faire_code\`, \`mode_exercice_code\`. Re-paginer via \`offset\` tant que \`truncated=true\`. Préférer \`professionnels_par_specialite_dept\` (Ameli) pour les libéraux conventionnés ; cet outil sert à compter ou lister les salariés / l'effectif total. ${RPPS_INCLUDE_CATEGORIES_HINT} ${NOMENCLATURE_COLLISION_WARNING} ${RPPS_CGU_NOTICE}`,
    inputSchema: {
      type: "object",
      properties: {
        departement: {
          type: "string",
          description:
            "Code département INSEE (ex: '75', '2A', '2B', '971'). Métropole 2 caractères (Corse '2A'/'2B', pas '20'), DOM/TOM 3 caractères.",
        },
        profession_code: {
          type: "string",
          description: "Code profession ANS (ex: '10' Médecin, '60' Infirmier). Optionnel.",
        },
        savoir_faire_code: {
          type: "string",
          description: "Code savoir-faire ANS (spécialité fine DES/DESC). Optionnel.",
        },
        mode_exercice_code: {
          type: "string",
          description: "Code mode d'exercice ANS (libéral / salarié / mixte). Optionnel.",
        },
        ...RPPS_INCLUDE_CATEGORIES_SCHEMA,
        limit: {
          type: "number",
          description: "Nombre max de résultats par page (défaut serveur 100).",
        },
        offset: {
          type: "number",
          description: "Offset pour pagination (défaut 0). Re-paginer tant que `truncated=true`.",
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["departement"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const departement = asString(args.departement);
      if (!departement) throw new RangeError("departement (string) requis");
      const professionCode = asString(args.profession_code);
      const savoirFaireCode = asString(args.savoir_faire_code);
      const modeExerciceCode = asString(args.mode_exercice_code);
      const limit = coerceNumber(args.limit, "limit");
      const offset = coerceNumber(args.offset, "offset");
      const input: Parameters<typeof getRppsParSpecialiteDept>[0] = { departement };
      if (professionCode) input.professionCode = professionCode;
      if (savoirFaireCode) input.savoirFaireCode = savoirFaireCode;
      if (modeExerciceCode) input.modeExerciceCode = modeExerciceCode;
      input.categorieCodes = categorieCodesFromArgs(args);
      if (limit !== undefined) input.limit = limit;
      if (offset !== undefined) input.offset = offset;
      return withFreshness(await getRppsParSpecialiteDept(input), args.include_freshness, ["rpps"]);
    },
  },
  {
    name: "rpps_dans_etablissement",
    description: `Liste les professionnels de santé rattachés à un établissement FINESS (par numéro FINESS site, 9 chiffres). C'est le pivot RPPS↔FINESS — répond à "qui travaille dans ce labo / hôpital / clinique ?". Le \`mode_exercice\` distingue les libéraux exerçant sur place (vacations) des salariés. Couverture : RPPS expose ce lien quand le PS l'a déclaré ; salariés CH/CHU/cliniques bien couverts. ${RPPS_INCLUDE_CATEGORIES_HINT} ${RPPS_CGU_NOTICE}`,
    inputSchema: {
      type: "object",
      properties: {
        num_finess: { type: "string", pattern: "^\\d{9}$" },
        ...RPPS_INCLUDE_CATEGORIES_SCHEMA,
        limit: { type: "number" },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["num_finess"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const numFiness = requireFinessId(args);
      const limit = coerceNumber(args.limit, "limit");
      const input: Parameters<typeof getRppsDansEtablissement>[0] = { numFiness };
      input.categorieCodes = categorieCodesFromArgs(args);
      if (limit !== undefined) input.limit = limit;
      return withFreshness(await getRppsDansEtablissement(input), args.include_freshness, ["rpps"]);
    },
  },
  {
    name: "densite_professionnels_sante",
    description: `Densité de professionnels de santé pour 100 000 habitants, au niveau **département** (\`code_dept\`) OU **commune** (\`code_insee\`, V0.9). Exactement un des deux requis. Méthodo DREES par défaut : médecins (\`profession_code='${PROFESSION_CODE_MEDECIN}'\`) en activité régulière (libéral + salarié + mixte, codes mode_exercice ${MODE_EXERCICE_ACTIVITE_REGULIERE.join(", ")}), hors étudiants. Croise RPPS (count) et INSEE Melodi (population municipale PMUN, recensement 2023).\n\nUsages : densité de cardiologues / dermatologues / infirmiers libéraux / pharmaciens / sages-femmes par dept ou commune. Pour une spécialité médicale, passer \`savoir_faire_code\` (ex 'SM04' Cardiologie — code 'SM02' est Anesthésie-réanimation, pas Cardiologie). Pour une autre profession que médecin, passer \`profession_code\` (60 infirmier, 21 pharmacien, etc.). Pour libéraux seuls, passer \`mode_exercice_codes: ['L']\`.\n\nParis/Marseille/Lyon : la densité par \`code_insee\` est INDISPONIBLE (les praticiens RPPS sont rattachés aux arrondissements alors qu'INSEE n'expose la population qu'à la commune entière) — passer un code commune-mère (75056) ou arrondissement (75108) lève une RangeError explicite. Utiliser \`code_dept\` (75, 13, 69) pour la densité ville entière.\n\n\`compare_national: true\` ajoute la densité France entière (DOM inclus) et l'écart en % (positif = sur-doté vs France, négatif = sous-doté). Coût : 1 RPC count_rpps supplémentaire + 1 appel Melodi (cacheable).\n\nAlias acceptés : \`dept\`/\`departement\` → \`code_dept\`, \`codeInsee\`/\`insee\` → \`code_insee\`.\n\nNe renvoie AUCUNE interprétation métier (pas de seuil "désert médical" automatique). Le caller applique sa grille.\n\n${RPPS_INCLUDE_CATEGORIES_HINT}\n\n${NOMENCLATURE_COLLISION_WARNING}\n\n${RPPS_CGU_NOTICE}`,
    inputSchema: {
      type: "object",
      properties: {
        code_dept: {
          type: "string",
          description:
            'Code INSEE du département 2-3 caractères. Ex: "75" Paris, "59" Nord, "2A" Corse-du-Sud, "971" Guadeloupe. Exclusif avec code_insee.',
        },
        code_insee: {
          type: "string",
          description:
            'Code INSEE de la commune 5 caractères (V0.9). Ex: "59009" Villeneuve-d\'Ascq, "33063" Bordeaux, "2A004" Ajaccio. Paris/Lyon/Marseille NON supporté au niveau commune (densité indisponible — voir description) : utiliser code_dept. Exclusif avec code_dept.',
        },
        profession_code: {
          type: "string",
          description: `Code profession ANS (TRE_R94). Default '${PROFESSION_CODE_MEDECIN}' (Médecin). Ex : '60' Infirmier, '21' Pharmacien, '50' Sage-femme, '40' Chirurgien-dentiste, '70' Masseur-kinésithérapeute.`,
        },
        savoir_faire_code: {
          type: "string",
          description:
            "Code spécialité (savoir_faire). Pertinent surtout pour profession_code=10 (médecin). Ex : 'SM04' Cardiologie, 'SM15' Dermatologie et vénéréologie, 'SM02' Anesthésie-réanimation, 'SM26' Médecine générale. Voir lister_specialites_medicales pour la liste exhaustive.",
        },
        mode_exercice_codes: {
          type: "array",
          items: { type: "string" },
          description: `Codes mode_exercice ANS à inclure. Default ['L','S','M'] (libéral + salarié + mixte = activité régulière DREES). Passer ['L'] pour libéraux seuls. ${RPPS_MODE_EXERCICE_HINT}`,
        },
        compare_national: {
          type: "boolean",
          description:
            "Ajoute le calcul France entière + écart relatif en % (recommandé pour qualifier 'sous-doté'/'sur-doté').",
          default: false,
        },
        ...RPPS_INCLUDE_CATEGORIES_SCHEMA,
      },
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        dept: "code_dept",
        departement: "code_dept",
        codeInsee: "code_insee",
        insee: "code_insee",
      });
      requireOneOf(args, ["code_dept", "code_insee"], { code_dept: "59" });
      const codeDept = asString(args.code_dept);
      const codeInsee = asString(args.code_insee);
      // Le check XOR (les deux fournis) est délégué à `resolveZone` côté lib
      // (densite.ts) pour garder une source unique de wording d'erreur. Le
      // boundary MCP cast `RangeError` en JSON-RPC -32602.
      const input: Parameters<typeof densiteProfessionnelsSante>[0] = {
        categorieCodes: categorieCodesFromArgs(args),
      };
      if (codeDept) input.departement = codeDept;
      if (codeInsee) input.codeInsee = codeInsee;
      const professionCode = asString(args.profession_code);
      if (professionCode) input.professionCode = professionCode;
      const savoirFaireCode = asString(args.savoir_faire_code);
      if (savoirFaireCode) input.savoirFaireCode = savoirFaireCode;
      if (Array.isArray(args.mode_exercice_codes)) {
        const filtered = args.mode_exercice_codes.filter((v): v is string => typeof v === "string");
        if (filtered.length === 0) {
          console.warn(
            `[france-data-mcp] densite_professionnels_sante: mode_exercice_codes vide reçu — interprété comme 'pas de filtre' (tous statuts), pas la méthodo DREES par défaut`,
          );
          input.modeExerciceCodes = null;
        } else {
          input.modeExerciceCodes = filtered;
        }
      }
      const compareNational = coerceBoolean(args.compare_national, "compare_national");
      if (compareNational === true) input.compareNational = true;
      return densiteProfessionnelsSante(input);
    },
  },
  {
    name: "densite_etablissements_sante",
    description:
      "Densité d'établissements de santé pour 100 000 habitants dans un département, par famille FINESS. Croise FINESS DREES (count) et INSEE Melodi (population municipale PMUN, recensement 2023).\n\nFamilles disponibles : `labo` (laboratoires de biologie médicale), `pharmacie`, `ehpad`, `mco` (court séjour médecine/chirurgie/obstétrique), `ssr` (soins de suite), `psychiatrie`, `dialyse`, `imagerie`, `had` (hospitalisation à domicile), `msp_cpts` (maisons de santé + CPTS), `handicap_enfants`, `handicap_adultes`, `addictologie`, `pmi`, `prevention_sante`, etc. Famille obligatoire — sans filtre, le ratio mélangerait labos / hôpitaux / EHPAD et n'aurait pas de sens.\n\n`compare_national: true` ajoute la densité France entière (DOM inclus) + écart en %. Coût : 1 RPC count_finess + 1 appel Melodi (cacheable).\n\nAlias acceptés : `dept`/`departement` → `code_dept`.",
    inputSchema: {
      type: "object",
      properties: {
        code_dept: {
          type: "string",
          description:
            'Code INSEE du département 2-3 caractères. Ex: "75" Paris, "59" Nord, "2A" Corse-du-Sud, "971" Guadeloupe.',
        },
        famille: {
          type: "string",
          description:
            "Famille FINESS à compter (labo, pharmacie, ehpad, mco, ssr, psychiatrie, dialyse, imagerie, had, msp_cpts, handicap_enfants, handicap_adultes, addictologie, pmi, prevention_sante, etc.).",
        },
        compare_national: {
          type: "boolean",
          description:
            "Ajoute le calcul France entière + écart relatif en % (recommandé pour 'sous-doté'/'sur-doté').",
          default: false,
        },
      },
      required: ["code_dept", "famille"],
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        dept: "code_dept",
        departement: "code_dept",
      });
      const codeDept = requireString(args, "code_dept", {
        code_dept: "59",
        famille: "labo",
      });
      const famille = asFinessFamille(args.famille);
      if (!famille) {
        throw new RangeError(`famille requise et valide — valeurs : ${FAMILLES_LIST}`);
      }
      const input: Parameters<typeof densiteEtablissementsSante>[0] = {
        departement: codeDept,
        famille,
      };
      const compareNational = coerceBoolean(args.compare_national, "compare_national");
      if (compareNational === true) input.compareNational = true;
      return densiteEtablissementsSante(input);
    },
  },
  {
    name: "panorama_sante_territoire",
    description: `Panorama santé d'une commune française en 1 appel (V0.9). Agrège en parallèle : population (INSEE Melodi), densités médecins + infirmiers + pharmaciens avec comparaison nationale (méthodo DREES), et nombre d'établissements FINESS par famille (default ${JSON.stringify(DEFAULT_FAMILLES)}).\n\nRemplace 7-10 appels MCP individuels par 1 seul. Ne renvoie AUCUNE interprétation métier (pas de qualification automatique 'désert médical') — le caller LLM applique sa grille.\n\n**Granularité mixte** : les densités professionnels et la population sont calculées au niveau **commune** ; le décompte FINESS est agrégé au niveau **département** dérivé du code INSEE (limitation V0.9 — pas de RPC count_finess_by_commune encore). Le champ \`niveauEtablissements\` du résultat indique \`"departement"\` (succès), \`"indisponible"\` (dept indérivable, ex code DOM tronqué) — utiliser cette information pour ne pas confondre ratios commune et dept.\n\nParis/Marseille/Lyon NON supporté : le panorama par commune dépend de la densité par commune, indisponible pour ces villes (INSEE n'expose la population qu'à la commune entière, les praticiens RPPS aux arrondissements). Un code PLM (commune-mère 75056 ou arrondissement) lève une RangeError. Pour ces villes, interroger les tools individuels au niveau \`code_dept\` (75/69/13).\n\nAlias acceptés : \`codeInsee\`/\`insee\`/\`code\` → \`code_insee\`.\n\nSources : RPPS / Annuaire Santé ANS (mensuel), FINESS DREES (bimensuel), INSEE Melodi (PMUN 2023).`,
    inputSchema: {
      type: "object",
      properties: {
        code_insee: {
          type: "string",
          description:
            'Code INSEE de la commune 5 caractères. Ex: "59009" Villeneuve-d\'Ascq, "33063" Bordeaux, "2A004" Ajaccio. Paris/Lyon/Marseille NON supporté (voir description).',
        },
        finess_familles: {
          type: "array",
          items: { type: "string" },
          description: `Familles FINESS à inclure dans le décompte établissements. Default ${JSON.stringify(DEFAULT_FAMILLES)}. Passer [] pour omettre le décompte FINESS (renvoie uniquement population + densités PS).`,
        },
      },
      required: ["code_insee"],
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        codeInsee: "code_insee",
        insee: "code_insee",
        code: "code_insee",
      });
      const codeInsee = requireString(args, "code_insee", { code_insee: "59009" });
      const input: Parameters<typeof panoramaSanteTerritoire>[0] = { codeInsee };
      // Cohérence avec les autres tools FINESS : `parseFamilles` throw
      // RangeError sur famille invalide au lieu de filtrer silencieusement
      // (fix /review V0.9 — anti-pattern "zéro catch silencieux").
      const familles = parseFamilles(args.finess_familles);
      if (familles !== undefined) input.finessFamilles = familles;
      return panoramaSanteTerritoire(input);
    },
  },
  {
    name: "inspect_site",
    description:
      "Vue 360 d'un établissement de santé en 1 appel (V0.10). Pendant naturel de `panorama_sante_territoire` côté **site** : agrège en parallèle (a) identification FINESS DREES (raison sociale, adresse, téléphone), (b) statut administratif SIRENE via le resolver SIRET (verdicts site + groupe, best_match, SIREN explorés, dinum_errors, explication LLM-friendly), (c) professionnels rattachés via num_finess (sample borné + flag `truncated` si le site a plus de PS — PAS un count total), (d) historique INSEE (timeline périodes administratives par SIRET candidat).\n\nRemplace 3 appels MCP individuels (`verifier_site_actif` + `rpps_dans_etablissement` + `historique_etablissement`) par 1 seul. Utile pour : prospection (qualifier un site avant outreach), audit territorial (cross-check rapide d'un FINESS suspect), enrichissement CRM en batch.\n\n**Format de retour** : objet `LookupResult`. Quand `found: true`, payload avec 4 sections (finess, statut_site, professionnels, historique). La section `historique` peut être `available: false` quand le FINESS existe mais qu'aucun SIRET candidat n'a été identifié (RPPS vide + DINUM 0 match) — dans ce cas le `message` reprend celui de `historique_etablissement`. Quand `num_finess` est absent de FINESS DREES, retourne `{found: false, lookupStatus: 'not_found', message}`.\n\nCoût : 3 sous-appels parallèles. Cache PostgreSQL absorbe la duplication FINESS-RPC ; le pivot RPPS→DINUM est exécuté en double (verifier + historique partagent la cascade), surcoût p95 ≤ 600 ms — acceptable pour un agrégateur. Pour les besoins ciblés (juste le verdict, juste l'historique), préférer les tools individuels. Payload lourd (~7K tokens) : passer `historique_detail: false` pour un retour allégé (résumé au lieu des timelines SIRENE complètes) en usage batch.\n\nAlias acceptés : `numFiness`/`finess`/`id` → `num_finess`.",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: {
          type: "string",
          description: "Numéro FINESS exact 9 chiffres. Ex: '590048997'.",
        },
        rpps_limit: {
          type: "integer",
          description:
            "Nombre max de PS dans `professionnels.sample`. `professionnels.count` = taille du sample (≤ cette borne), pas le total du site ; `truncated: true` signale qu'il y a davantage de PS. Borné [1, 50]. Défaut 10.",
        },
        historique_detail: {
          type: "boolean",
          description:
            "Inclure les timelines SIRENE détaillées dans `historique.siret_timelines` (défaut true). `false` = payload allégé (~7K tokens en moins) : `historique` ne porte qu'un `resume` (counts) + un pointeur vers `historique_etablissement`.",
          default: true,
        },
      },
      required: ["num_finess"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (rawArgs) => {
      const args = normalizeAliases(rawArgs, {
        numFiness: "num_finess",
        finess: "num_finess",
        id: "num_finess",
      });
      const numFiness = requireFinessId(args);
      const input: Parameters<typeof inspectSite>[0] = { numFiness };
      // `coerceNumber` (et non `Number()`) pour un message d'erreur fidèle à
      // la valeur reçue (`Number("abc")` → NaN masquerait l'input réel) et
      // l'homogénéité avec tous les autres tools numériques du fichier. Le
      // clamp [1,50] + RangeError reste délégué à `inspectSite` (boundary lib,
      // source unique des bornes). `coerceNumber` retourne undefined si absent.
      const rppsLimit = coerceNumber(args.rpps_limit, "rpps_limit");
      if (rppsLimit !== undefined) input.rppsLimit = rppsLimit;
      const historiqueDetail = coerceBoolean(args.historique_detail, "historique_detail");
      if (historiqueDetail !== undefined) input.historiqueDetail = historiqueDetail;
      return inspectSite(input);
    },
  },
  {
    name: "lister_specialites_medicales",
    description: `Liste les spécialités médicales (savoir_faire RPPS) avec leur libellé et le nombre de PS qui les portent. Tool d'aide à la découverte pour le LLM : avant d'appeler densite_professionnels_sante ou professionnels_rpps_par_dept avec un \`savoir_faire_code\` précis (ex 'SM04' Cardiologie), utiliser ce tool pour obtenir la liste exhaustive.\n\nFiltre par défaut : profession_code='${PROFESSION_CODE_MEDECIN}' (Médecin) — retourne donc les spécialités médicales (cardiologie, dermato, gynéco, etc.). Passer \`profession_code\` pour énumérer les spécialités d'une autre profession (ex '60' Infirmier → spécialités IDE), ou \`null\` pour tous savoir_faire confondus.\n\nRésultats triés par count_ps DESC (spécialités les plus représentées en premier). Paginé : \`limit\` (défaut ${NOMENCLATURE_DEFAULT_LIMIT}), la réponse expose \`total\` et \`truncated\`. Source : RPPS / Annuaire Santé ANS (Supabase dump mensuel).`,
    inputSchema: {
      type: "object",
      properties: {
        profession_code: {
          type: "string",
          description: `Code profession ANS (TRE_R94). Default '${PROFESSION_CODE_MEDECIN}' (Médecin). Passer une string vide ou 'null' pour énumérer tous savoir_faire toutes professions confondues.`,
        },
        limit: NOMENCLATURE_LIMIT_SCHEMA,
      },
    },
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      // Sentinel "null" (string) pour désactiver le filtre — JSON-RPC ne peut
      // pas véhiculer un null dans un champ schema "string". asString rejette
      // les types invalides (number/boolean/null/undefined → undefined).
      const raw = asString(args.profession_code);
      let professionCode: string | null;
      if (raw === "null") {
        professionCode = null;
      } else if (raw && raw.length > 0) {
        professionCode = raw;
      } else {
        professionCode = PROFESSION_CODE_MEDECIN;
      }
      const results = await listSavoirFaireRpps(professionCode);
      return { profession_code: professionCode, ...limitNomenclature(results, args.limit) };
    },
  },
  {
    name: "rpps_search_by_name",
    description: `Recherche fuzzy de professionnels de santé par identité (nom + prénom optionnel + département optionnel). Utilise un matching trigram (pg_trgm) tolérant aux accents, typos et variations d'orthographe. Tri par pertinence décroissante. Source : RPPS / Annuaire Santé ANS (Supabase dump mensuel).\n\nUsage typique : "trouve-moi le Dr Martin à Paris" (nom obligatoire, prénom et département facultatifs pour affiner). Sans département, recherche nationale : des homonymes exacts (ex. plusieurs « Pierre Martin ») obtiennent TOUS le même \`match_score\` ~1.0 — il ne les départage pas. Pour désambiguïser, filtrer par \`departement\` (ou affiner avec \`prénom\`). \`truncated: true\` signifie que d'autres résultats existent : restreindre la requête plutôt que parcourir.\n\n**Format de retour** : objet \`{ count, truncated, results, query_metadata }\` aligné sur les autres tools RPPS de listing. Chaque résultat porte un champ \`match_score\` ∈ [0..1] (score trigram pg_trgm). Un score < 0.5 indique souvent une homonymie partielle à confirmer côté caller.\n\n${RPPS_INCLUDE_CATEGORIES_HINT}\n\n${RPPS_CGU_NOTICE}`,
    inputSchema: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Nom de famille (obligatoire, non vide)." },
        prenom: {
          type: "string",
          description: "Prénom (optionnel — affine le score si fourni).",
        },
        departement: {
          type: "string",
          description:
            "Code département INSEE (ex: '75', '2A', '2B', '971'). Métropole 2 caractères (Corse '2A'/'2B', pas '20'), DOM/COM 3 caractères. Optionnel.",
        },
        ...RPPS_INCLUDE_CATEGORIES_SCHEMA,
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["nom"],
    },
    outputSchema: QUERY_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const nom = asString(args.nom)?.trim();
      if (!nom) throw new RangeError("nom (string non vide) requis");
      const prenom = asString(args.prenom)?.trim();
      const departement = asString(args.departement);
      const limit = coerceNumber(args.limit, "limit");
      const input: Parameters<typeof getRppsByName>[0] = { nom };
      if (prenom) input.prenom = prenom;
      if (departement) input.departement = departement;
      input.categorieCodes = categorieCodesFromArgs(args);
      if (limit !== undefined) input.limit = limit;
      return withFreshness(await getRppsByName(input), args.include_freshness, ["rpps"]);
    },
  },
  {
    name: "professionnel_by_rpps",
    description: `Fiche d'un professionnel de santé par identifiant national (rpps_id / IDNPS, 11 ou 12 chiffres — IDNPS modernes émis depuis 2020 ont un préfixe "81" qui les fait à 12 chars, anciens IDs sans préfixe à 11 chars). Renvoie N entrées quand le PS exerce sur plusieurs sites (1 row par site). Si non trouvé en base locale (ingestion mensuelle, J-30 max), tente automatiquement un fallback live sur l'API FHIR ANS (\`gateway.api.esante.gouv.fr/fhir/v2\`) — fraîcheur quotidienne, gratuit (clé \`ESANTE-API-KEY\` issue de portal.api.esante.gouv.fr requise côté serveur). Le champ \`source\` distingue \`db\` (base locale) de \`ans_fhir\` (fallback live). \`include_freshness\` n'affecte que les retours \`source: "db"\` (FHIR ANS étant live). ${RPPS_CGU_NOTICE}`,
    inputSchema: {
      type: "object",
      properties: {
        rpps_id: { type: "string", pattern: "^\\s*\\d{11,12}\\s*$" },
        include_freshness: INCLUDE_FRESHNESS_SCHEMA,
      },
      required: ["rpps_id"],
    },
    outputSchema: LOOKUP_RESULT_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const rppsId = requireRppsId(args);
      const sites = await getRppsById(rppsId);
      if (sites.length > 0) {
        // V0.7.5 : `lookupStatus` ajouté manuellement (le tool a des champs
        // custom `source`/`fhir`/`ans_fhir_status` incompatibles avec `lookupFound`
        // generic helper). Respecte `LOOKUP_RESULT_OUTPUT_SCHEMA` requis pour
        // que les clients MCP stricts valident la réponse.
        return withFreshness(
          {
            found: true,
            lookupStatus: "found" as const,
            source: "db",
            rpps_id: rppsId,
            count: sites.length,
            sites,
          },
          args.include_freshness,
          ["rpps"],
        );
      }
      // Fallback live — ne renvoie QU'un summary identité (pas les sites). Le
      // FHIR retourne un Practitioner sans les PractitionerRole (qui portent
      // les rattachements site) ; pour la richesse complète, faire un suivi
      // par appels FHIR PractitionerRole. V0.5 expose juste l'existence + nom.
      const fhir = await lookupPractitionerByRpps(rppsId);
      if (fhir.found) {
        return {
          found: true,
          lookupStatus: "found" as const,
          source: "ans_fhir",
          rpps_id: rppsId,
          fhir: fhir.practitioner,
          message:
            "Trouvé via fallback FHIR ANS live ; aucun site rattaché en base locale (snapshot mensuel J-30). Pour la liste des structures d'exercice live, requêter PractitionerRole côté ANS.",
        };
      }
      // V0.7.0 : on propage le `status` discriminé du fallback pour distinguer
      // PS réellement absent (`not_found` → cross-check format / annuaire) de
      // panne ANS (`api_error` → retry justifié) de config manquante (`no_key`).
      return {
        found: false,
        lookupStatus: "not_found" as const,
        key: rppsId,
        rpps_id: rppsId,
        source: "ans_fhir_lookup",
        ans_fhir_status: fhir.status,
        message:
          fhir.status === "api_error"
            ? `rpps_id absent en base locale ET fallback FHIR ANS a échoué : ${fhir.message}`
            : fhir.status === "no_key"
              ? `rpps_id absent en base locale (snapshot mensuel J-30). ${fhir.message}`
              : fhir.status === "invalid_format"
                ? fhir.message
                : "rpps_id introuvable en base locale ET via fallback FHIR ANS. Vérifier le format (11 ou 12 chiffres) ou consulter annuaire.sante.fr.",
      };
    },
  },
  {
    name: "finess_sirene_coverage_in_radius",
    description:
      "Compare la couverture du référentiel FINESS DREES (sites physiques agréés LBM/pharmacie/etc.) " +
      "au référentiel SIRENE DINUM (SIRET physiques actifs au NAF cible) dans un rayon géographique. " +
      "Métrique : ratio sites FINESS / SIRET SIRENE. Utile pour détecter une sur-déclaration FINESS " +
      "(sites encore listés mais SIRET fermés) ou une sous-déclaration DREES (sites SIRENE non agréés FINESS). " +
      "Inclut une méthodologie explicite + caveats. " +
      "Source : FINESS DREES + DINUM Recherche Entreprises + SIRENE INSEE.",
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude WGS84 du centre de la zone." },
        lat: { type: "number", description: "Latitude WGS84 du centre de la zone." },
        radius_km: {
          type: "number",
          minimum: 0.1,
          maximum: 50,
          default: 5,
          description: "Rayon de la zone en km (0.1-50, défaut 5).",
        },
        naf: {
          type: "string",
          description:
            "Code NAF SIRENE à comparer (ex: '8690B' labos d'analyses médicales, '4773Z' pharmacies, '8621Z' médecine générale).",
        },
        familles: {
          type: "array",
          items: { type: "string", enum: [...FINESS_FAMILLE_INPUTS] },
          description: `Familles FINESS à inclure côté DREES (défaut : toutes). Valeurs : ${FAMILLES_LIST}.`,
        },
        max_unites_legales: {
          type: "number",
          minimum: 1,
          maximum: 25,
          default: 10,
          description:
            "Nombre maximum d'unités légales DINUM à déplier (1-25, défaut 10). Au-delà : truncated_unites_legales=true.",
        },
      },
      required: ["lon", "lat", "naf"],
    },
    outputSchema: COVERAGE_OUTPUT_SCHEMA,
    annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
    handler: async (args) => {
      const lon = coerceNumber(args.lon, "lon");
      const lat = coerceNumber(args.lat, "lat");
      if (lon === undefined) throw new RangeError("lon (number) requis");
      if (lat === undefined) throw new RangeError("lat (number) requis");
      const naf = asString(args.naf);
      if (!naf) throw new RangeError("naf (string) requis");
      const radiusKm = coerceNumber(args.radius_km, "radius_km") ?? 5;
      const maxUnitesLegales = coerceNumber(args.max_unites_legales, "max_unites_legales") ?? 10;
      const familles = parseFamilles(args.familles);
      const input: CoverageInput = {
        center: { lon, lat },
        radiusKm,
        naf,
        maxUnitesLegales,
      };
      if (familles) input.familles = familles;
      return getCoverageFinessVsSireneInRadius(input);
    },
  },
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
