/**
 * Types et nomenclatures RPPS / Annuaire Santé ANS.
 *
 * Sources :
 * - Fichier `ps-libreacces-personne-activite.txt` (data.gouv) — 50 colonnes
 *   pipe-delimited. La doc canonique des nomenclatures (codes professions,
 *   savoir-faire, mode exercice) vit côté ANS sur :
 *   https://annuaire.sante.fr/web/site-pro/extractions-publiques
 *
 * Granularité : une LIGNE du CSV = un (PS, structure d'exercice). Un PS qui
 * exerce sur N sites a N lignes. Le serveur expose les rows brutes ; le caller
 * (ou un futur tool composite) regroupe par `rpps_id` si besoin.
 */

/** GeoJSON Point — shape retournée par `ST_AsGeoJSON(geom)::jsonb`. */
export interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number];
}

/**
 * Codes mode d'exercice ANS (extrait de la nomenclature canonique).
 * Documenté ici pour clarté du caller MCP qui veut filtrer par statut.
 *
 * Source : nomenclature de structure ANS, fichier `nomenclature-mode-exercice`.
 */
export const RPPS_MODE_EXERCICE = {
  LIBERAL: "L",
  SALARIE: "S",
  MIXTE: "M",
  REMPLACANT: "R",
  AUTRE: "A",
  BENEVOLE: "B",
} as const;

/**
 * Codes profession ANS (TRE_R94). Source unique pour éviter le drift entre
 * `densite.ts`, `panorama.ts` et descriptions tools. Étendre cette liste à
 * chaque profession activement consommée par un module — éviter de hardcoder
 * un code inline.
 */
export const RPPS_PROFESSION = {
  MEDECIN: "10",
  PHARMACIEN: "21",
  INFIRMIER: "60",
} as const;

/**
 * Codes savoir_faire (spécialités) ANS canoniques — pour éviter les drift
 * SM02/SM04 chopés en V0.8/V0.9. ATTENTION historique :
 *   - SM02 = Anesthésie-réanimation (PAS Cardiologie)
 *   - SM04 = Cardiologie et maladies vasculaires
 *   - SM15 = Dermatologie et vénéréologie (PAS SM26)
 *   - SM26 = Qualifié en Médecine Générale (PAS la dermato — bug B4)
 *
 * Source : extraction RPPS / Annuaire Santé ANS, vérifiée sur dump prod le
 * 2026-05-15 via `lister_nomenclature` (referentiel: rpps_savoir_faire, profession_code='10').
 * Étendre uniquement avec des codes vérifiés sur dump prod.
 */
export const RPPS_SAVOIR_FAIRE = {
  ANESTHESIE_REANIMATION: "SM02",
  CARDIOLOGIE: "SM04",
  DERMATO_VENEREOLOGIE: "SM15",
  MEDECINE_GENERALE: "SM26",
} as const;

/**
 * URL de référence ANS pour les nomenclatures publiques. Mention obligatoire
 * en CGU des datasets data.gouv : « Source : Annuaire Santé, ANS — Licence
 * Ouverte v2.0 ».
 */
export const RPPS_CGU_NOTICE =
  "Source : Annuaire Santé, Agence du Numérique en Santé (ANS) — Licence Ouverte v2.0";

/**
 * URL canonique de la table de référence ANS TRE_R09 (catégorie professionnelle).
 * Source unique citée par la JSDoc des constantes `CATEGORIE_CODE_*`, par le
 * hint MCP `RPPS_INCLUDE_CATEGORIES_HINT` et par la doc publique. Évite la
 * dérive multi-sites quand l'ANS publie une nouvelle URL.
 */
export const TRE_R09_URL = "https://mos.esante.gouv.fr/NOS/TRE_R09-CategorieProfessionnelle/";
