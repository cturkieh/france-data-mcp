/**
 * Catégories FINESS — décisions produit de la lib + libellés OFFICIELS.
 *
 * Les libellés viennent d'une SOURCE UNIQUE : `finess-categories-labels.ts`,
 * généré depuis la nomenclature TRE_R397 du serveur multi-terminologies ANS
 * (`scripts/ingest/refresh-finess-categories.ts`). C'est la même table que
 * l'ingestion écrit dans `finess.categorie_libelle` — avant le 2026-09-06 ce
 * fichier portait sa propre copie des libellés du CSV DREES de mai 2026 :
 * 32 divergents sur 101 codes (réforme « services autonomie » : `460` → SAA,
 * `209` → SAAS ; `228` → « Centre de Santé Sexuelle »), et `108` étiqueté
 * « C.H.U. » alors que le code désigne un établissement de convalescence.
 *
 * Ce fichier ne porte plus que des DÉCISIONS produit : le rattachement des
 * codes à une famille (`FINESS_FAMILY_CODES`) et les codes laissés en `autre`
 * (`DELIBERATELY_AUTRE`). Les codes exposés (`FinessCategorieCode`,
 * `FINESS_CATEGORIES`) en DÉRIVENT — plus de liste parallèle à synchroniser.
 * Tout code cité ici doit avoir un libellé connu : `CodeConnu` le fait
 * vérifier par le COMPILATEUR, pas par un test.
 */

import { SMT_CATEGORIE_LABELS } from "./finess-categories-labels.js";

/**
 * Codes HORS nomenclature SMT conservés par DÉCISION produit (pas par héritage).
 * Lib-only par construction : la base ne porte que des libellés officiels
 * (`finess-ans-parse.ts` consomme le SMT nu) — un établissement qui arriverait
 * sous ce code aurait `categorie_libelle` NULL en base (compté par
 * `missingLabelCounts`) pendant que la lib sert ce libellé.
 */
export const HORS_NOMENCLATURE_LABELS = {
  // Aucun code d'imagerie n'existe au SMT, mais 619 est le SEUL porteur de la
  // famille `imagerie` : enum public `familles`, gate NAF 8622A/8690F,
  // `activite_hebergee`. 0 établissement en prod (2026-09-06) — lentille vide
  // ASSUMÉE (cf. `api/tools.ts`, « FINESS ne répertorie pas les cabinets
  // d'imagerie »). Un code réapparu au SMT prend son libellé officiel (le SMT
  // prime, ordre du spread ci-dessous) : le test de parité impose alors de le
  // sortir d'ici ET de re-valider sa famille, que rien ne corrige tout seul.
  "619": "Cabinet d'imagerie médicale",
} as const satisfies Record<string, string>;

/** Tout code que la lib connaît (SMT + hors nomenclature) — les clés sont littérales. */
const LABELS = { ...HORS_NOMENCLATURE_LABELS, ...SMT_CATEGORIE_LABELS } as const;
type CodeConnu = keyof typeof LABELS;

/**
 * Libellé officiel d'un code catégorie, pour TOUTE la nomenclature (429 codes),
 * pas seulement les codes exposés — `undefined` pour un code inconnu du SMT.
 * Pour tester l'appartenance au catalogue de la lib, utiliser
 * `isFinessCategorieCode` (un code du SMT hors catalogue a un libellé mais
 * tombe en famille `autre`).
 */
export function libelleCategorieFiness(code: string): string | undefined {
  return (LABELS as Readonly<Record<string, string | undefined>>)[code];
}

/**
 * FINESS family taxonomy. Drives the `familles` filter on the MCP tools.
 *
 * Each family is a precise, query-side tag — callers compose them via the
 * `familles` array. Designed for prospection commerciale santé : labos
 * ciblent MCO/EHPAD/CSI/MSP/CPTS/MAS/FAM/SLD/HAD, équipementiers ciblent
 * EHPAD/résidences autonomie, services à domicile ciblent SAAD/SPASAD/SSIAD…
 */
export type FinessFamille =
  // Sanitaire
  | "mco"
  | "ssr"
  | "sld"
  | "had"
  | "psychiatrie"
  | "dialyse"
  | "ambulatoire"
  // Bio / pharma / imagerie
  | "labo"
  | "imagerie"
  | "pharmacie"
  // Maisons + communautés professionnelles
  | "msp_cpts"
  // Personnes âgées
  | "ehpad"
  | "residence_autonomie"
  | "senior_accompagnement"
  // Domicile
  | "ssiad"
  | "aide_domicile"
  // Handicap
  | "handicap_enfants"
  | "handicap_adultes"
  // Addictologie + précarité sanitaire
  | "addictologie"
  // Enfance / protection / PMI
  | "enfance_protection"
  | "pmi"
  // Hébergement social
  | "hebergement_social"
  // Prévention / santé publique
  | "prevention_sante"
  // Groupements de coopération
  | "groupement"
  // Catch-all
  | "autre";

/**
 * Family classification of FINESS category codes (TRE_R397).
 *
 * `autre` is the catch-all : codes in FINESS_CATEGORIES that don't fit any
 * specific family (ex. thermal). To get "everything else", omit the family
 * filter and post-filter via `result.categorie.famille`.
 *
 * The `query` subtype excludes "autre" — the MCP tools accept this set for
 * the `familles` parameter.
 */
export type FinessFamilleQuery = Exclude<FinessFamille, "autre">;

/**
 * Codes par famille — SOURCE des codes exposés. `satisfies readonly CodeConnu[]`
 * sur chaque famille : un code sans libellé connu ne compile pas (l'invariant
 * central du catalogue vit dans le type, pas dans un test).
 */
export const FINESS_FAMILY_CODES = {
  // Sanitaire — court séjour
  mco: ["101", "106", "114", "115", "128", "129", "131", "355", "365"],
  // 108 = « Etablissement de Convalescence et de Repos » (TRE_R397), pas un
  // CHU comme l'ancien catalogue le disait — 0 établissement en prod (2026-09-06).
  ssr: ["108", "109"],
  sld: ["362"],
  had: ["127"],
  psychiatrie: ["292", "156", "161", "425", "430"],
  dialyse: ["141", "146"],
  ambulatoire: ["124"],
  // Bio / pharma / imagerie
  labo: ["610", "611", "612"],
  imagerie: ["619"],
  pharmacie: ["620", "627", "628", "629"],
  // Pluri-pro
  msp_cpts: ["603", "604"],
  // Personnes âgées
  ehpad: ["500", "501", "502"],
  residence_autonomie: ["202"],
  senior_accompagnement: ["207", "463"],
  // Domicile
  ssiad: ["354"],
  aide_domicile: ["460", "209"],
  // Handicap
  handicap_enfants: ["182", "183", "186", "188", "189", "190", "192", "194", "195", "196"],
  handicap_adultes: ["246", "247", "252", "255", "382", "437", "445", "446", "448", "449"],
  // Addictologie + précarité sanitaire
  addictologie: ["165", "178", "180", "197", "412"],
  // Enfance / protection
  enfance_protection: ["175", "177", "236", "238", "241", "295", "378", "440", "441"],
  // PMI / petite enfance
  pmi: ["223", "228", "230", "268"],
  // Hébergement social
  hebergement_social: ["166", "214", "219", "256", "257", "258", "259", "442", "443", "462"],
  // Prévention / santé publique
  prevention_sante: ["132", "142", "143", "266", "347", "636"],
  // Groupements
  groupement: ["695", "696", "697"],
} as const satisfies Record<FinessFamilleQuery, readonly CodeConnu[]>;

/**
 * Codes intentionally left in "autre" — checked by the invariant test so a
 * code without a family decision fails CI loudly.
 *
 * @internal Test-only export. Runtime code uses `finessFamille()`.
 */
export const DELIBERATELY_AUTRE_CODES = [
  "126", // Etablissement Thermal — pas de famille santé/médico-social pertinente
  "632", // Oxygénothérapie à domicile = PSAD (prestataire de santé à domicile,
  // dispositif médical), pas une aide à domicile au sens SAAD/SPASAD.
  // Volume marginal (<1%), pas de famille dédiée pour 1 code.
  "698", // "Autre Etablissement Loi Hospitalière" — fourre-tout DREES
  // hospitalier, pas un groupement (≠ GCS/GCSMS). Mieux vaut autre.
] as const satisfies readonly CodeConnu[];
export const DELIBERATELY_AUTRE: ReadonlySet<string> = new Set(DELIBERATELY_AUTRE_CODES);

/** Codes exposés par la lib = union des familles + `autre` délibéré (≈ 92 % du volume FINESS). */
export const FINESS_CATEGORY_CODES = [
  ...Object.values(FINESS_FAMILY_CODES).flat(),
  ...DELIBERATELY_AUTRE_CODES,
] as const;

export type FinessCategorieCode = (typeof FINESS_CATEGORY_CODES)[number];

/**
 * code → libellé officiel pour les codes exposés. Dérivé, jamais saisi ; pas
 * de repli possible : chaque code est un `CodeConnu` (vérifié à la compilation).
 * Valeurs typées `string` (plus des littéraux comme avant le 2026-09-06) :
 * un rafraîchissement SMT ne doit pas être un breaking de type.
 */
export const FINESS_CATEGORIES = Object.fromEntries(
  FINESS_CATEGORY_CODES.map((code) => [code, LABELS[code]]),
) as Readonly<Record<FinessCategorieCode, string>>;

const CODES_EXPOSES: ReadonlySet<string> = new Set(FINESS_CATEGORY_CODES);

/** Appartenance au catalogue de la lib (≠ « a un libellé » : le SMT est plus large). */
export function isFinessCategorieCode(code: string): code is FinessCategorieCode {
  return CODES_EXPOSES.has(code);
}

const FAMILY_BY_CODE: ReadonlyMap<string, FinessFamilleQuery> = new Map<string, FinessFamilleQuery>(
  (Object.keys(FINESS_FAMILY_CODES) as FinessFamilleQuery[]).flatMap((fam) =>
    FINESS_FAMILY_CODES[fam].map((code) => [code, fam] as const),
  ),
);

/**
 * Classify a FINESS category code into a family for query-side filtering.
 *
 * Inputs are normalized first: `null`, `undefined`, empty string, and
 * whitespace-only strings all resolve to "autre". Non-empty inputs are trimmed
 * before matching, tolerating whitespace artefacts occasionally present in
 * DREES dumps (e.g. `" 108 "` → "ssr").
 */
export function finessFamille(code: string | null | undefined): FinessFamille {
  const trimmed = code?.trim();
  if (!trimmed) return "autre";
  return FAMILY_BY_CODE.get(trimmed) ?? "autre";
}

// ──────────────────────────────────────────────────────────────────────────
// Stable convenience exports — used by lib consumers, kept for back-compat.
// ──────────────────────────────────────────────────────────────────────────

/**
 * All hospital-grade categories (MCO acute-care + SSR + SLD + HAD + psy).
 * Use FINESS_FAMILY_CODES.mco for strict acute-care only.
 */
export const FINESS_HOPITAUX = [
  ...FINESS_FAMILY_CODES.mco,
  ...FINESS_FAMILY_CODES.ssr,
  ...FINESS_FAMILY_CODES.sld,
  ...FINESS_FAMILY_CODES.had,
  ...FINESS_FAMILY_CODES.psychiatrie,
] as const;

export const FINESS_LABOS = FINESS_FAMILY_CODES.labo;
export const FINESS_PHARMACIES = FINESS_FAMILY_CODES.pharmacie;
export const FINESS_EHPAD = FINESS_FAMILY_CODES.ehpad;
export const FINESS_MSP_CPTS = FINESS_FAMILY_CODES.msp_cpts;
