/**
 * Mapping des codes NAF utiles pour l'analyse santé / médico-social.
 *
 * Source : nomenclature NAF rév.2 INSEE (2008).
 * Liste non exhaustive — focus sur les activités santé pertinentes pour
 * l'intelligence territoriale (implantation, prospection, audit).
 */

export const NAF_SANTE = {
  // Hôpitaux et cliniques
  "8610Z": "Activités hospitalières",

  // Pratique médicale et dentaire
  "8621Z": "Activités de médecine générale",
  "8622A": "Activités de radiodiagnostic et de radiothérapie",
  "8622B": "Activités chirurgicales",
  "8622C": "Autres activités des médecins spécialistes",
  "8623Z": "Pratique dentaire",

  // Autres activités de santé
  "8690A": "Ambulances",
  "8690B": "Laboratoires d'analyses médicales",
  "8690C": "Centres de collecte et banques d'organes",
  "8690D": "Activités des infirmiers et des sages-femmes",
  "8690E":
    "Activités des professionnels de la rééducation, de l'appareillage et des pédicures-podologues",
  "8690F": "Activités de santé humaine non classées ailleurs",

  // Hébergement médico-social
  "8710A": "Hébergement médicalisé pour personnes âgées",
  "8710B": "Hébergement médicalisé pour enfants handicapés",
  "8710C": "Hébergement médicalisé pour adultes handicapés et autre hébergement médicalisé",
  "8720A": "Hébergement social pour handicapés mentaux et malades mentaux",
  "8720B": "Hébergement social pour toxicomanes",
  "8730A": "Hébergement social pour personnes âgées",
  "8730B": "Hébergement social pour handicapés physiques",

  // Action sociale sans hébergement
  "8810A": "Aide à domicile",
  "8810B": "Accueil ou accompagnement sans hébergement d'adultes handicapés ou de personnes âgées",
  "8810C": "Aide par le travail",
  "8891A": "Accueil de jeunes enfants",
  "8891B": "Accueil ou accompagnement sans hébergement d'enfants handicapés",
  "8899A": "Autre accueil ou accompagnement sans hébergement d'enfants et d'adolescents",
  "8899B": "Action sociale sans hébergement n.c.a.",

  // Pharmacies et commerce de matériel médical
  "4773Z": "Commerce de détail de produits pharmaceutiques en magasin spécialisé",
  "4774Z": "Commerce de détail d'articles médicaux et orthopédiques en magasin spécialisé",
} as const satisfies Record<string, string>;

export type NafCodeSante = keyof typeof NAF_SANTE;

/**
 * Codes NAF correspondant aux laboratoires de biologie médicale et activités proches.
 */
export const NAF_LABOS = ["8690B"] as const satisfies readonly NafCodeSante[];

/**
 * Codes NAF correspondant aux pharmacies d'officine.
 */
export const NAF_PHARMACIES = ["4773Z"] as const satisfies readonly NafCodeSante[];

/**
 * Codes NAF correspondant aux EHPAD et hébergement médicalisé pour personnes âgées.
 */
export const NAF_EHPAD = ["8710A", "8730A"] as const satisfies readonly NafCodeSante[];

/**
 * Codes NAF correspondant à la médecine de ville (généralistes + spécialistes).
 */
export const NAF_MEDECINE_VILLE = [
  "8621Z",
  "8622A",
  "8622B",
  "8622C",
] as const satisfies readonly NafCodeSante[];

/**
 * Renvoie le libellé d'un code NAF santé, ou undefined si non répertorié.
 */
export function libelleNaf(code: string): string | undefined {
  return (NAF_SANTE as Record<string, string>)[code];
}
