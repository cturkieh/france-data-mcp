/**
 * Nomenclature Annuaire Santé Ameli — codes type_ps et codes spécialité.
 *
 * Source : extraction live du CSV `annuaire-sante-ameli` (data.gouv.fr,
 * resource `432983b9-2e6f-473a-b35a-20403c300a5f`, 549 K rows).
 *
 * Pourquoi ce module : la nomenclature Ameli est piégeuse côté caller MCP.
 * Le libellé natif du `type_ps_code = "2"` dans le CSV est
 * `"Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…)"`,
 * libellé fourre-tout qui mentionne les chirurgiens-dentistes alors qu'ils
 * ont leur propre code (`5 = "Dentistes"`). Sans clarification, un caller
 * lit "type_ps=2 → chirurgien-dentiste" et choisit le mauvais filtre.
 *
 * Ce module fournit deux services :
 *   1. `clarifyTypePsLibelle(code, sourceLibelle)` — renvoie un libellé clair,
 *      basé sur ce qui est réellement présent en base.
 *   2. `AMELI_SPECIALITES_FREQUENTES` — quelques codes spécialité courants
 *      pour prospection (MG, IDE, kiné, podologue, sage-femme, dentiste…),
 *      à utiliser dans les exemples de doc tool. Pas exhaustif — le tool
 *      `lister_specialites_ameli()` donne la nomenclature complète live.
 *
 * Périmètre stocké en base : `type_ps_code ∈ {1, 2, 5}`. Les codes 3 et 4
 * sont filtrés à l'ingestion (cf. `scripts/ingest/ameli.ts`, règle de
 * séparation Ameli ↔ FINESS — cf. mémoire `project_france_data_mcp_v04.md`).
 */

/**
 * Statut de présence en base d'un code type_ps.
 * - `in_db` : entrées effectivement stockées et requêtables.
 * - `filtered_at_ingest` : code présent dans le CSV Ameli mais skip à
 *   l'ingestion (personne morale, pris en charge par FINESS).
 */
export type AmeliTypePsPresence = "in_db" | "filtered_at_ingest";

export interface AmeliTypePsEntry {
  /** Code natif Ameli. */
  code: string;
  /**
   * Libellé tel qu'il apparaît littéralement dans le CSV Ameli.
   * Conservé pour traçabilité — c'est ce que renvoie l'API DB historiquement.
   */
  libelleSource: string;
  /**
   * Libellé clarifié (résout l'ambiguïté du libellé source pour le code "2").
   * Identique à `libelleSource` quand celui-ci est déjà clair.
   */
  libelleClarified: string;
  /** Spécialités regroupées sous ce type_ps (extrait des données réelles). */
  specialitesIncluses: readonly string[];
  presence: AmeliTypePsPresence;
}

/**
 * Nomenclature complète Ameli des `type_ps_code`. La source est le CSV
 * officiel — vérifié sur 549 K lignes le 2026-05-09.
 *
 * `1` et `2` couvrent ~90% du volume. `5` couvre les chirurgiens-dentistes.
 * `3` et `4` ne sont jamais présents en base (filtre `type_ps in (1,2,5)`
 * appliqué à l'ingestion — cf. `scripts/ingest/ameli.ts`).
 */
export const AMELI_TYPE_PS_NOMENCLATURE: Record<string, AmeliTypePsEntry> = {
  "1": {
    code: "1",
    libelleSource: "Médecins généralistes et spécialistes",
    libelleClarified: "Médecins généralistes et spécialistes",
    specialitesIncluses: [
      "01 (MG)",
      "03 (cardio)",
      "05 (dermato)",
      "06 (radio)",
      "07 (gynéco-obst.)",
      "12 (pédiatre)",
      "15 (ophtalmo)",
      "32 (neurologue)",
      "33 (psychiatre)",
      "34 (gériatre)",
      "etc.",
    ],
    presence: "in_db",
  },
  "2": {
    code: "2",
    libelleSource: "Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…)",
    libelleClarified:
      "Auxiliaires médicaux (IDE, kinés, sages-femmes, podologues, orthophonistes, orthoptistes, IPA…)",
    specialitesIncluses: [
      "21 (sage-femme)",
      "24 (IDE)",
      "26 (kiné)",
      "27 (pédicure-podologue)",
      "28 (orthophoniste)",
      "29 (orthoptiste)",
      "86 (IPA)",
    ],
    presence: "in_db",
  },
  "3": {
    code: "3",
    libelleSource: "Laboratoires",
    libelleClarified: "Laboratoires (personnes morales — voir FINESS catégorie 611)",
    specialitesIncluses: ["30, 39, 40"],
    presence: "filtered_at_ingest",
  },
  "4": {
    code: "4",
    libelleSource:
      "Non conventionnés (pharmacies, fournisseurs de matériel et transporteurs sanitaires…)",
    libelleClarified:
      "Non conventionnés / personnes morales (pharmacies, transport, matériel — voir FINESS et SIRENE)",
    specialitesIncluses: [
      "50/51 (pharmacien)",
      "55 (transport sanitaire)",
      "60-68 (matériel, optique, prothèses)",
    ],
    presence: "filtered_at_ingest",
  },
  "5": {
    code: "5",
    libelleSource: "Dentistes",
    libelleClarified: "Chirurgiens-dentistes (et orthodontistes — code spécialité 36)",
    specialitesIncluses: ["19 (chirurgien-dentiste)", "36 (orthodontiste)", "53/54 (variantes)"],
    presence: "in_db",
  },
} as const;

/**
 * Codes type_ps présents en base et donc filtrables via les tools MCP.
 * Construit à partir de la nomenclature pour rester en sync automatiquement.
 */
export const AMELI_TYPE_PS_QUERYABLE: readonly string[] = Object.values(AMELI_TYPE_PS_NOMENCLATURE)
  .filter((entry) => entry.presence === "in_db")
  .map((entry) => entry.code);

/**
 * Spécialités fréquentes en prospection commerciale santé. Pas exhaustif —
 * la nomenclature complète comporte 88+ codes (vérifié sur le CSV 2026-05-09).
 * Pour la liste live, utiliser le tool MCP `lister_specialites_ameli()`.
 */
export const AMELI_SPECIALITES_FREQUENTES = [
  { code: "01", libelle: "Médecin généraliste", typePs: "1" },
  { code: "03", libelle: "Cardiologue", typePs: "1" },
  { code: "05", libelle: "Dermatologue et vénérologue", typePs: "1" },
  { code: "07", libelle: "Gynécologue / Obstétricien", typePs: "1" },
  { code: "12", libelle: "Pédiatre", typePs: "1" },
  { code: "15", libelle: "Ophtalmologiste", typePs: "1" },
  { code: "19", libelle: "Chirurgien-dentiste", typePs: "5" },
  { code: "21", libelle: "Sage-femme", typePs: "2" },
  { code: "24", libelle: "Infirmier", typePs: "2" },
  { code: "26", libelle: "Masseur-kinésithérapeute", typePs: "2" },
  { code: "27", libelle: "Pédicure-podologue", typePs: "2" },
  { code: "28", libelle: "Orthophoniste", typePs: "2" },
  { code: "29", libelle: "Orthoptiste", typePs: "2" },
  { code: "33", libelle: "Psychiatre", typePs: "1" },
  { code: "34", libelle: "Gériatre", typePs: "1" },
  { code: "86", libelle: "Infirmier en pratique avancée", typePs: "2" },
] as const;

/**
 * Renvoie un libellé clarifié pour un `type_ps_code`. Utilisé par les tools
 * MCP de listage et par la documentation. Si le code n'est pas dans la
 * nomenclature ou si le libellé source diffère (drift CSV Ameli), on préfère
 * la source pour ne jamais inventer de donnée.
 */
export function clarifyTypePsLibelle(
  code: string | null | undefined,
  sourceLibelle: string | null | undefined,
): string | null {
  if (!code) return sourceLibelle ?? null;
  const entry = AMELI_TYPE_PS_NOMENCLATURE[code];
  if (!entry) return sourceLibelle ?? null;
  // Drift detection : si le CSV upstream change le libellé, on garde la
  // source pour rester honnête. Le libellé clarifié n'est appliqué que
  // quand la source matche notre référence.
  if (sourceLibelle && sourceLibelle !== entry.libelleSource) return sourceLibelle;
  return entry.libelleClarified;
}

/**
 * Nomenclature secteur conventionnel CNAM (Annuaire santé Ameli).
 *
 * Le CSV CNAM porte le code ET un libellé, mais le libellé regroupe le code
 * "3" (Secteur 2 + droit permanent à dépassement) sous le même intitulé
 * "Secteur 2" que le code "2" — factuellement trompeur pour l'utilisateur
 * (le S2+DP autorise des dépassements permanents, info tarifaire sensible).
 * Le CODE (3) reste discriminant ; on clarifie le libellé restitué SANS
 * réécrire la donnée source (même discipline que `clarifyTypePsLibelle` :
 * drift detection — si le libellé CNAM diverge de notre référence, on garde
 * la source pour ne jamais inventer). Seul le code "3" est ambigu côté CNAM ;
 * "1"/"2" sont déjà exacts et traités en identité pour homogénéité.
 */
const AMELI_SECTEUR_NOMENCLATURE: Record<string, { source: string; clarified: string }> = {
  "1": { source: "Secteur 1", clarified: "Secteur 1" },
  "2": { source: "Secteur 2", clarified: "Secteur 2" },
  "3": {
    source: "Secteur 2",
    clarified: "Secteur 2 + droit permanent à dépassement (S2+DP)",
  },
};

/**
 * Clarifie le libellé secteur conventionnel à partir du code CNAM. Renvoie le
 * libellé source inchangé si le code est inconnu ou si la source a drifté
 * (honnêteté > clarification). Voir {@link AMELI_SECTEUR_NOMENCLATURE}.
 */
export function clarifySecteurLibelle(
  code: string | null | undefined,
  sourceLibelle: string | null | undefined,
): string | null {
  if (!code) return sourceLibelle ?? null;
  const entry = AMELI_SECTEUR_NOMENCLATURE[code];
  if (!entry) return sourceLibelle ?? null;
  if (sourceLibelle && sourceLibelle !== entry.source) return sourceLibelle;
  return entry.clarified;
}
