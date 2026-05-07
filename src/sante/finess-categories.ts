/**
 * Catégories FINESS les plus utiles pour l'analyse territoriale santé.
 *
 * Liste non exhaustive (FINESS contient ~150 catégories EJ + EG). Focus sur
 * celles qui ont du sens pour de l'intelligence d'implantation, de la
 * cartographie de réseau de soins et de la prospection médico-sociale.
 *
 * Source : nomenclature FINESS publiée par la DREES.
 */

export const FINESS_CATEGORIES = {
  "108": "Centre Hospitalier Universitaire (CHU)",
  "355": "Centre Hospitalier (CH)",
  "365": "Centre de Lutte Contre le Cancer (CLCC)",
  "362": "Centre Hospitalier Spécialisé en psychiatrie",
  "292": "Centre Hospitalier Spécialisé (CHS)",
  "106": "Hôpital local",
  "109": "Établissement de Soins de Suite et de Réadaptation (SSR)",
  "120": "Hôpital de jour",
  "122": "Centre de cure médicale",
  "124": "Centre de Santé",
  "295": "Établissement Public de Santé",
  "354": "Hôpital privé",
  "500": "EHPAD (Établissement Hébergeant des Personnes Âgées Dépendantes)",
  "501": "Maison de retraite",
  "502": "Logement-foyer",
  "600": "Foyer d'hébergement pour adultes handicapés",
  "603": "Maison de Santé Pluriprofessionnelle (MSP)",
  "604": "Communauté Professionnelle Territoriale de Santé (CPTS)",
  "611": "Laboratoire d'analyses de biologie médicale",
  "619": "Cabinet d'imagerie médicale",
  "620": "Pharmacie d'Officine",
  "697": "Groupement de Coopération Sanitaire (GCS)",
  "698": "Groupement de Coopération Sociale et Médico-Sociale",
} as const satisfies Record<string, string>;

export type FinessCategorieCode = keyof typeof FINESS_CATEGORIES;

export const FINESS_HOPITAUX = [
  "108",
  "355",
  "362",
  "292",
  "106",
  "354",
  "295",
] as const satisfies readonly FinessCategorieCode[];

export const FINESS_LABOS = ["611"] as const satisfies readonly FinessCategorieCode[];

export const FINESS_PHARMACIES = ["620"] as const satisfies readonly FinessCategorieCode[];

export const FINESS_EHPAD = ["500", "501", "502"] as const satisfies readonly FinessCategorieCode[];

export const FINESS_MSP_CPTS = ["603", "604"] as const satisfies readonly FinessCategorieCode[];

export function libelleCategorieFiness(code: string): string | undefined {
  return (FINESS_CATEGORIES as Record<string, string>)[code];
}

export type FinessFamille = "mco" | "ssr" | "ehpad" | "autre";

// Family classification of FINESS DREES category codes (see FINESS_CATEGORIES above
// for the 3-digit code reference).
//
//   MCO   = Médecine-Chirurgie-Obstétrique (court séjour). Acute-care hospitals.
//   SSR   = Soins de Suite et Réadaptation. Follow-up / rehabilitation establishments.
//   EHPAD = Établissements pour personnes âgées dépendantes + adjacent senior housing.
//
// Anything outside these three families falls back to "autre" for V0.2 scope.
// Future scopes (psychiatry, ambulatoire, labo, pharmacie, ...) will be added as
// distinct family values when their consumer use cases are confirmed.

// MCO: deliberately diverges from FINESS_HOPITAUX (line 39) on two points:
//   - excludes 292 (CHS) and 362 (CH spé psychiatrie) — psychiatry is its own
//     planned family, NOT acute-care MCO.
//   - includes 365 (CLCC = Centre de Lutte Contre le Cancer), which DREES treats
//     as acute-care oncology, but FINESS_HOPITAUX (a more "hospitals in general"
//     bucket) does not list.
// Do NOT replace this Set with `new Set(FINESS_HOPITAUX)` — the lists are
// intentionally different.
const MCO_CODES = new Set<string>([
  "108", // CHU
  "355", // CH
  "354", // Hôpital privé
  "295", // Établissement Public de Santé
  "365", // Centre de Lutte Contre le Cancer
  "106", // Hôpital local
]);

// SSR: deliberately conservative for V0.2 — only the unambiguous "109" code.
// Code 122 (Centre de cure médicale) overlaps DREES SSR semantically but is
// classification-ambiguous; left in DELIBERATELY_AUTRE below until product
// scope clarifies.
const SSR_CODES = new Set<string>([
  "109", // SSR
]);

// EHPAD: derived from the existing FINESS_EHPAD constant to keep a single
// source of truth. Adding a code to FINESS_EHPAD automatically updates the
// family classification.
const EHPAD_CODES = new Set<string>(FINESS_EHPAD);

/**
 * Codes present in FINESS_CATEGORIES that are deliberately classified as "autre"
 * for V0.2 scope. Powers the invariant test that fails when a new code is added
 * to FINESS_CATEGORIES without an explicit family decision — preventing silent
 * classification regressions on DREES nomenclature updates.
 *
 * @internal Exported solely for the invariant test in finess-categories.test.ts.
 *           Do not import from runtime code — couple to `finessFamille()` instead.
 */
export const DELIBERATELY_AUTRE = new Set<string>([
  "292", // CHS                      → psychiatrie (out of V0.2 scope)
  "362", // CH spé psychiatrie       → psychiatrie
  "120", // Hôpital de jour          → ambiguous (MCO vs autre)
  "122", // Centre de cure médicale  → DREES classification ambiguous (cure ≈ SSR but not always)
  "124", // Centre de Santé          → ambulatoire (planned family)
  "603", // MSP                      → ambulatoire (re-exported as FINESS_MSP_CPTS)
  "604", // CPTS                     → ambulatoire
  "611", // Laboratoire              → labo (re-exported as FINESS_LABOS, planned family)
  "619", // Cabinet d'imagerie       → imagerie (planned family)
  "620", // Pharmacie                → pharmacie (re-exported as FINESS_PHARMACIES)
  "697", // GCS                      → groupement de coopération
  "698", // GCSMS                    → groupement
  "600", // Foyer handicapés         → médico-social handicap (≠ EHPAD)
]);

/**
 * Classify a FINESS category code into a family for query-side filtering.
 *
 * Inputs are normalized first: `null`, `undefined`, empty string, and
 * whitespace-only strings all resolve to "autre". Non-empty inputs are trimmed
 * before matching against the family Sets, tolerating whitespace artefacts
 * occasionally present in DREES dumps (e.g. `" 108 "` → "mco").
 *
 * Note: empty/whitespace inputs are upstream-parsing-bug suspects (column
 * shift, header mismatch) but this classifier intentionally has no telemetry
 * hook — surfacing the empty-rate is the ingest layer's responsibility.
 */
export function finessFamille(code: string | null | undefined): FinessFamille {
  const trimmed = code?.trim();
  if (!trimmed) return "autre";
  if (MCO_CODES.has(trimmed)) return "mco";
  if (SSR_CODES.has(trimmed)) return "ssr";
  if (EHPAD_CODES.has(trimmed)) return "ehpad";
  return "autre";
}
