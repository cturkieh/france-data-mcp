/**
 * FINESS DREES category nomenclature — codes + libellés.
 *
 * Catalogue ~50 codes représentant ~92% du volume FINESS (95K rows total).
 * Le reliquat ~8% tombe en famille `autre` (codes très rares : thermal,
 * lieux de vie expérimentaux, structures atypiques).
 *
 * Source: live FINESS extract on data.gouv.fr. Re-verify against the CSV
 * when adding codes — DREES occasionally rotates labels (les libellés
 * sont copiés à l'identique du CSV pour matcher exactement la nomenclature
 * officielle).
 */

export const FINESS_CATEGORIES = {
  // ─── SANITAIRE — court séjour (MCO + adjacents) ───────────────────────
  "101": "Centre Hospitalier Régional (C.H.R.)",
  "106": "Centre hospitalier",
  "108": "Centre Hospitalier Universitaire (C.H.U.)",
  "114": "Hôpital des armées",
  "115": "Etablissement de Soins du Service de Santé des Armées",
  "128": "Etablissement de Soins Chirurgicaux",
  "129": "Etablissement de Soins Médicaux",
  "131": "Centre de Lutte Contre le Cancer (C.L.C.C.)",
  "355": "Centre Hospitalier (C.H.)",
  "365": "Etablissement de Soins Pluridisciplinaire",

  // ─── SANITAIRE — SSR / SLD / HAD / dialyse ────────────────────────────
  "109": "Etablissement de santé privé autorisé en SSR",
  "362": "Etablissement de Soins Longue Durée (USLD)",
  "127": "Hospitalisation à Domicile (HAD)",
  "141": "Centre de dialyse",
  "146": "Structure d'Alternative à la dialyse en centre",

  // ─── SANITAIRE — psychiatrie ──────────────────────────────────────────
  "292": "Centre Hospitalier Spécialisé lutte Maladies Mentales",
  "156": "Centre Médico-Psychologique (C.M.P.)",
  "161": "Maison de Santé pour Maladies Mentales",
  "425": "Centre d'Accueil Thérapeutique à temps partiel (C.A.T.T.P.)",
  "430": "Centre Postcure Malades Mentaux",

  // ─── AMBULATOIRE / soins de ville ─────────────────────────────────────
  "124": "Centre de Santé",
  "603": "Maison de santé (L.6223-3)",
  "604": "Communautés professionnelles territoriales de santé (CPTS)",

  // ─── PHARMACIE / BIO / IMAGERIE ───────────────────────────────────────
  "611": "Laboratoire de Biologie Médicale",
  "619": "Cabinet d'imagerie médicale",
  "620": "Pharmacie d'Officine",
  "627": "Propharmacie",

  // ─── PERSONNES ÂGÉES — hébergement ────────────────────────────────────
  "500": "Etablissement d'hébergement pour personnes âgées dépendantes (EHPAD)",
  "501": "EHPA percevant des crédits d'assurance maladie",
  "502": "EHPA ne percevant pas des crédits d'assurance maladie",
  "202": "Résidences autonomie",

  // ─── PERSONNES ÂGÉES — accompagnement ─────────────────────────────────
  "207": "Centre de Jour pour Personnes Agées",
  "463": "Centres Locaux Information Coordination P.A. (C.L.I.C.)",

  // ─── DOMICILE (médico-social + soins) ─────────────────────────────────
  "354": "Service de Soins Infirmiers à Domicile (S.S.I.A.D.)",
  "460": "Service d'Aide et d'Accompagnement à Domicile (S.A.A.D.)",
  "209": "Service Polyvalent Aide et Soins à Domicile (S.P.A.S.A.D.)",

  // ─── HANDICAP ENFANTS ─────────────────────────────────────────────────
  "182": "Service d'Éducation Spéciale et de Soins à Domicile (SESSAD)",
  "183": "Institut Médico-Éducatif (I.M.E.)",
  "186": "Institut Thérapeutique Éducatif et Pédagogique (I.T.E.P.)",
  "188": "Etablissement pour Enfants ou Adolescents Polyhandicapés",
  "189": "Centre Médico-Psycho-Pédagogique (C.M.P.P.)",
  "190": "Centre Action Médico-Sociale Précoce (C.A.M.S.P.)",
  "192": "Institut d'éducation motrice",
  "194": "Institut pour Déficients Visuels",
  "195": "Institut pour Déficients Auditifs",
  "196": "Institut d'Education Sensorielle Sourd/Aveugle",

  // ─── HANDICAP ADULTES ─────────────────────────────────────────────────
  "246": "Etablissement et Service d'Aide par le Travail (E.S.A.T.)",
  "247": "Entreprise adaptée",
  "252": "Foyer Hébergement Adultes Handicapés",
  "255": "Maison d'Accueil Spécialisée (M.A.S.)",
  "382": "Foyer de Vie pour Adultes Handicapés",
  "437": "Foyer d'Accueil Médicalisé pour Adultes Handicapés (F.A.M.)",
  "445": "Service d'accompagnement médico-social adultes handicapés (SAMSAH)",
  "446": "Service d'Accompagnement à la Vie Sociale (S.A.V.S.)",
  "448": "Etab. Acc. Médicalisé en tout ou partie personnes handicapées",
  "449": "Etab. Accueil Non Médicalisé pour personnes handicapées",
  "600": "Foyer d'hébergement pour adultes handicapés",

  // ─── ADDICTOLOGIE / accompagnement ────────────────────────────────────
  "165": "Appartement de Coordination Thérapeutique (A.C.T.)",
  "178": "Centre Accueil/Accomp. Réduc. Risq. Usag. Drogues (C.A.A.R.U.D.)",
  "180": "Lits Halte Soins Santé (L.H.S.S.)",
  "197": "Centre soins accompagnement prévention addictologie (C.S.A.P.A.)",
  "412": "Appartement Thérapeutique",

  // ─── ENFANCE / PROTECTION ─────────────────────────────────────────────
  "175": "Foyer de l'Enfance",
  "177": "Maison d'Enfants à Caractère Social (MECS)",
  "295": "Services AEMO et AED",
  "236": "Centre Placement Familial Socio-Educatif (C.P.F.S.E.)",
  "238": "Centre d'Accueil Familial Spécialisé",
  "241": "Foyer d'Action Educative (F.A.E.)",
  "440": "Service Investigation Orientation Educative (S.I.O.E.)",
  "441": "Centre d'Action Educative (C.A.E.)",
  "378": "Etablissement Expérimental Enfance Protégée",

  // ─── PMI / PETITE ENFANCE / SANTÉ SCOLAIRE ────────────────────────────
  "223": "Protection Maternelle et Infantile (P.M.I.)",
  "228": "Centre Planification ou Education Familiale",
  "230": "Etablissement Consultation Protection Infantile",
  "268": "Centre Médico-Scolaire",

  // ─── HÉBERGEMENT SOCIAL ───────────────────────────────────────────────
  "214": "Centre Hébergement & Réinsertion Sociale (C.H.R.S.)",
  "219": "Autre Centre d'Accueil",
  "256": "Foyer Travailleurs Migrants non transformé en Résidence Sociale",
  "257": "Foyer de Jeunes Travailleurs (résidence sociale ou non)",
  "258": "Maisons Relais - Pensions de Famille",
  "259": "Autre Résidence Sociale (hors Maison Relais)",
  "443": "Centre Accueil Demandeurs Asile (C.A.D.A.)",
  "442": "Centre Provisoire Hébergement (C.P.H.)",
  "462": "Lieux de vie",
  "166": "Etablissement d'Accueil Mère-Enfant",

  // ─── PRÉVENTION / SANTÉ PUBLIQUE ──────────────────────────────────────
  "132": "Etablissement de Transfusion Sanguine",
  "142": "Dispensaire Antituberculeux",
  "143": "Centre de Vaccination BCG",
  "266": "Dispensaire Antivénérien",
  "347": "Centre d'Examens de Santé",
  "636": "Centre de soins et de prévention",

  // ─── GROUPEMENTS ──────────────────────────────────────────────────────
  "696": "Groupement de coopération sanitaire de moyens",
  "697": "Groupement de coopération sanitaire — Etablissement de santé",

  // ─── HORS TAXONOMIE (voir DELIBERATELY_AUTRE pour la justification) ───
  "126": "Etablissement Thermal",
  "632": "Structure Dispensatrice à domicile d'Oxygène à usage médical",
  "698": "Autre Etablissement Loi Hospitalière",
} as const satisfies Record<string, string>;

export type FinessCategorieCode = keyof typeof FINESS_CATEGORIES;

export function libelleCategorieFiness(code: string): string | undefined {
  return (FINESS_CATEGORIES as Record<string, string>)[code];
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
 * Family classification of FINESS DREES category codes.
 *
 * `autre` is the catch-all : codes in FINESS_CATEGORIES that don't fit any
 * specific family (ex. thermal). To get "everything else", omit the family
 * filter and post-filter via `result.categorie.famille`.
 *
 * The `query` subtype excludes "autre" — the MCP tools accept this set for
 * the `familles` parameter.
 */
export type FinessFamilleQuery = Exclude<FinessFamille, "autre">;

export const FINESS_FAMILY_CODES: Record<FinessFamilleQuery, readonly string[]> = {
  // Sanitaire — court séjour
  mco: ["101", "106", "108", "114", "115", "128", "129", "131", "355", "365"],
  ssr: ["109"],
  sld: ["362"],
  had: ["127"],
  psychiatrie: ["292", "156", "161", "425", "430"],
  dialyse: ["141", "146"],
  ambulatoire: ["124"],
  // Bio / pharma / imagerie
  labo: ["611"],
  imagerie: ["619"],
  pharmacie: ["620", "627"],
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
  handicap_adultes: ["246", "247", "252", "255", "382", "437", "445", "446", "448", "449", "600"],
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
  groupement: ["696", "697"],
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
  "126", // Etablissement Thermal — pas de famille santé/médico-social pertinente
  "632", // Oxygénothérapie à domicile = PSAD (prestataire de santé à domicile,
  // dispositif médical), pas une aide à domicile au sens SAAD/SPASAD.
  // Volume marginal (<1%), pas de famille dédiée pour 1 code.
  "698", // "Autre Etablissement Loi Hospitalière" — fourre-tout DREES
  // hospitalier, pas un groupement (≠ GCS/GCSMS). Mieux vaut autre.
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
