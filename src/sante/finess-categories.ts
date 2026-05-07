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

export type FinessFamille = "mco" | "ehpad" | "ssr" | "autre";

// Source: ANS FINESS code catalogue. Numerical ranges per family.
// MCO (Médecine-Chirurgie-Obstétrique): 4100-4199
// SSR (Soins de Suite et Réadaptation): 4200-4299
// EHPAD: 500-599
// Anything else maps to "autre" — caller can drill into categorie_libelle if needed.
export function finessFamille(code: string | null | undefined): FinessFamille {
  if (!code) return "autre";
  const n = Number.parseInt(code, 10);
  if (Number.isNaN(n)) return "autre";
  if (n >= 4100 && n <= 4199) return "mco";
  if (n >= 4200 && n <= 4299) return "ssr";
  if (n >= 500 && n <= 599) return "ehpad";
  return "autre";
}
