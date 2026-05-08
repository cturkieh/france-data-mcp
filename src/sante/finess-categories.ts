/**
 * FINESS DREES category nomenclature — codes + libellés.
 *
 * Non-exhaustive (FINESS has ~150 EJ + EG categories) — we carry the codes
 * that drive the family classifier plus those needed for hospital / lab /
 * EHPAD / pharmacie / MSP coverage.
 *
 * Source: live FINESS extract on data.gouv.fr. Re-verify against the CSV
 * when adding codes — DREES occasionally rotates labels.
 */

export const FINESS_CATEGORIES = {
  // Acute-care hospitals (MCO + adjacent)
  "101": "Centre Hospitalier Régional (C.H.R.)",
  "106": "Centre hospitalier",
  "108": "Centre Hospitalier Universitaire (C.H.U.)",
  "114": "Hôpital des armées",
  "115": "Etablissement de Soins du Service de Santé des Armées",
  "128": "Etablissement de Soins Chirurgicaux",
  "129": "Etablissement de Soins Médicaux",
  "131": "Centre de Lutte Contre le Cancer (CLCC)",
  "355": "Centre Hospitalier (C.H.)",
  "365": "Etablissement de Soins Pluridisciplinaire",
  // Psychiatry — out of MCO scope (own family in V0.3)
  "292": "Centre Hospitalier Spécialisé en lutte contre les maladies mentales",
  "362": "Centre Hospitalier Spécialisé (CHS) en psychiatrie",
  "156": "Centre Médico-Psychologique (C.M.P.)",
  "161": "Maison de Santé pour Maladies Mentales",
  // SSR
  "109": "Etablissement de santé privé autorisé en SSR",
  // Ambulatoire / soins de proximité
  "122": "Etablissement Soins Obstétriques Chirurgico-Gynécologiques",
  "124": "Centre de Santé",
  "127": "Hospitalisation à Domicile (HAD)",
  "141": "Centre de dialyse",
  "146": "Structure d'Alternative à la dialyse en centre",
  // Médico-social / domicile (NOT MCO)
  "295": "Services AEMO et AED",
  "354": "Service de Soins Infirmiers à Domicile (SSIAD)",
  "182": "Service d'Éducation Spéciale et de Soins à Domicile (SESSAD)",
  // EHPAD + senior housing
  "500": "Etablissement d'hébergement pour personnes âgées dépendantes (EHPAD)",
  "501": "EHPA percevant des crédits d'assurance maladie",
  "502": "EHPA ne percevant pas de crédits d'assurance maladie",
  // Médico-social handicap
  "183": "Institut Médico-Éducatif (I.M.E.)",
  "186": "Institut Thérapeutique Éducatif et Pédagogique (I.T.E.P.)",
  "188": "Etablissement pour Enfants ou Adolescents Polyhandicapés",
  "189": "Centre Médico-Psycho-Pédagogique (C.M.P.P.)",
  "190": "Centre Action Médico-Sociale Précoce (C.A.M.S.P.)",
  "192": "Institut d'éducation motrice",
  "194": "Institut pour Déficients Visuels",
  "195": "Institut pour Déficients Auditifs",
  "196": "Institut d'Education Sensorielle Sourd/Aveugle",
  "600": "Foyer d'hébergement pour adultes handicapés",
  // Addictologie / accompagnement
  "165": "Appartement de Coordination Thérapeutique (A.C.T.)",
  "178": "Centre Accueil/Accomp. Réduc. Risq. Usag. Drogues (CAARUD)",
  "180": "Lits Halte Soins Santé (L.H.S.S.)",
  "197": "Centre soins accompagnement prévention addictologie (CSAPA)",
  // Ambulatoire pluriprofessionnel
  "603": "Maison de Santé Pluriprofessionnelle (MSP)",
  "604": "Communauté Professionnelle Territoriale de Santé (CPTS)",
  // Bio / pharma / imagerie
  "611": "Laboratoire d'analyses de biologie médicale",
  "619": "Cabinet d'imagerie médicale",
  "620": "Pharmacie d'Officine",
  // Coopération
  "697": "Groupement de Coopération Sanitaire (GCS)",
  "698": "Groupement de Coopération Sociale et Médico-Sociale (GCSMS)",
  // Autres
  "126": "Etablissement Thermal",
  "132": "Etablissement de Transfusion Sanguine",
  "142": "Dispensaire Antituberculeux",
  "143": "Centre de Vaccination BCG",
} as const satisfies Record<string, string>;

export type FinessCategorieCode = keyof typeof FINESS_CATEGORIES;

export function libelleCategorieFiness(code: string): string | undefined {
  return (FINESS_CATEGORIES as Record<string, string>)[code];
}

/**
 * FINESS family taxonomy. Drives the `familles` filter on the MCP tools.
 *
 * V0.2 covered only `mco | ssr | ehpad | autre`. The audit (post-v0.2.0)
 * called for splitting the medico-social and ambulatory categories out of
 * `mco` (which had wrongly absorbed SSIAD/AEMO via mis-labelled codes), and
 * surfacing pharmacie / MSP-CPTS / labos / SSIAD / SESSAD-IME / addictologie
 * as first-class filters. Each family is a precise, query-side tag — callers
 * can compose them via the `familles` array.
 */
export type FinessFamille =
  | "mco"
  | "ssr"
  | "ehpad"
  | "psychiatrie"
  | "ambulatoire"
  | "ssiad"
  | "had"
  | "handicap_enfants"
  | "handicap_adultes"
  | "addictologie"
  | "msp_cpts"
  | "labo"
  | "imagerie"
  | "pharmacie"
  | "autre";

/**
 * Family classification of FINESS DREES category codes.
 *
 *   mco              = Médecine-Chirurgie-Obstétrique (acute-care hospitals).
 *   ssr              = Soins de Suite et Réadaptation.
 *   ehpad            = EHPAD + adjacent senior housing (EHPA).
 *   psychiatrie      = CHS, CMP, structures psychiatriques.
 *   ambulatoire      = HAD, dialyse, soins ambulatoires de proximité.
 *   ssiad            = Services Soins Infirmiers à Domicile (code 354).
 *   had              = Hospitalisation à Domicile (code 127).
 *   handicap_enfants = IME, ITEP, SESSAD, CMPP, CAMSP, IES…
 *   handicap_adultes = Foyer d'hébergement adultes handicapés.
 *   addictologie     = CSAPA, CAARUD, ACT, LHSS.
 *   msp_cpts         = Maisons de Santé Pluri / Communautés Professionnelles.
 *   labo             = Laboratoires de biologie médicale.
 *   imagerie         = Cabinets d'imagerie médicale.
 *   pharmacie        = Officines.
 *
 * `autre` is the catch-all for codes that exist in FINESS_CATEGORIES but don't
 * map cleanly to any of the above (groupements de coopération, AEMO/AED hors
 * scope santé, divers). Callers wanting "everything else" omit the family
 * filter and post-filter via `result.categorie.famille`.
 *
 * The `query` subtype excludes "autre" — this is what the MCP tools accept
 * for the `familles` parameter.
 */
export type FinessFamilleQuery = Exclude<FinessFamille, "autre">;

export const FINESS_FAMILY_CODES: Record<FinessFamilleQuery, readonly string[]> = {
  // Acute-care: CHR/CH/CHU, military hospitals, surgical/medical units, CLCC.
  // 354 (SSIAD) and 295 (AEMO/AED) explicitly EXCLUDED — audit B2 bis fix.
  mco: ["101", "106", "108", "114", "115", "128", "129", "131", "355", "365"],
  ssr: ["109"],
  ehpad: ["500", "501", "502"],
  psychiatrie: ["292", "362", "156", "161"],
  ambulatoire: ["124", "141", "146"],
  ssiad: ["354"],
  had: ["127"],
  handicap_enfants: ["182", "183", "186", "188", "189", "190", "192", "194", "195", "196"],
  handicap_adultes: ["600"],
  addictologie: ["165", "178", "180", "197"],
  msp_cpts: ["603", "604"],
  labo: ["611"],
  imagerie: ["619"],
  pharmacie: ["620"],
} as const;

const FAMILY_BY_CODE: ReadonlyMap<string, FinessFamilleQuery> = new Map<string, FinessFamilleQuery>(
  (Object.keys(FINESS_FAMILY_CODES) as FinessFamilleQuery[]).flatMap((fam) =>
    FINESS_FAMILY_CODES[fam].map((code) => [code, fam] as const),
  ),
);

/**
 * Codes intentionally left in "autre" — checked by the invariant test so a
 * new FINESS_CATEGORIES entry without a family decision fails CI loudly.
 *
 * @internal Test-only export. Runtime code uses `finessFamille()`.
 */
export const DELIBERATELY_AUTRE = new Set<string>([
  "122", // Soins Obstétriques Chir.-Gyn. → ambiguous, often part of MCO unit
  "126", // Etablissement Thermal
  "132", // Transfusion Sanguine
  "142", // Dispensaire Antituberculeux
  "143", // Vaccination BCG
  "295", // Services AEMO et AED → protection enfance, hors scope santé
  "697", // GCS — groupement de coopération
  "698", // GCSMS — groupement
]);

/**
 * Classify a FINESS category code into a family for query-side filtering.
 *
 * Inputs are normalized first: `null`, `undefined`, empty string, and
 * whitespace-only strings all resolve to "autre". Non-empty inputs are trimmed
 * before matching, tolerating whitespace artefacts occasionally present in
 * DREES dumps (e.g. `" 108 "` → "mco").
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
 * All hospital-grade categories (MCO acute-care + psychiatry).
 *
 * NOTE: the v0.2.0 version of this constant included 354 and 295, which
 * are actually SSIAD (medico-social, home-care) and AEMO/AED (child
 * protection) — NOT hospitals. Those have been removed. If a downstream
 * caller depended on the old set for lab/SSIAD lookups, switch to the
 * dedicated `FINESS_FAMILY_CODES.ssiad` / `FINESS_FAMILY_CODES.labo`.
 */
export const FINESS_HOPITAUX = [
  ...FINESS_FAMILY_CODES.mco,
  ...FINESS_FAMILY_CODES.psychiatrie,
] as const;

export const FINESS_LABOS = FINESS_FAMILY_CODES.labo;
export const FINESS_PHARMACIES = FINESS_FAMILY_CODES.pharmacie;
export const FINESS_EHPAD = FINESS_FAMILY_CODES.ehpad;
export const FINESS_MSP_CPTS = FINESS_FAMILY_CODES.msp_cpts;
