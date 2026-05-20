/**
 * Table de correspondance NAF (nomenclature économique INSEE) ↔ famille FINESS
 * (taxonomie sanitaire/médico-sociale DREES).
 *
 * **Mode "compatible"** : many-to-many. Un NAF peut appartenir à plusieurs
 * familles (ex. `8610Z` couvre MCO + SSR + SLD + HAD + psychiatrie). Une
 * famille peut accepter plusieurs NAF. Il n'existe PAS de bijection officielle
 * entre NAF (INSEE) et catégories FINESS (DREES) — cette table est un
 * mapping best-effort à maintenir, pas une donnée publique trouvée.
 *
 * **Premiers consommateurs** :
 *  - `src/sante/siret-resolver.ts` — fallback géographique Resolver V2 :
 *    quand RPPS ne ramène aucun SIRET exploitable et que DINUM est OK, on
 *    cherche les entreprises au voisinage du FINESS via DINUM `/near_point`
 *    en filtrant sur les NAF compatibles avec la famille du site (gate).
 *
 * **Futurs consommateurs** (chantier `coverage.ts` planifié) :
 *  - `src/sante/coverage.ts` — `finess_sirene_coverage_in_radius` souffre
 *    aujourd'hui d'un matching par adresse SEULE, qui rattache un labo à un
 *    IFSI co-localisé (cas Hôpital Franco-Britannique, 7 entités au 4 rue
 *    Kléber). Le bon fix est d'ajouter un gate d'activité via ce même module.
 *    **NE PAS DUPLIQUER la table — étendre ici.**
 *
 * @see naf-codes.ts pour les libellés NAF.
 * @see finess-categories.ts pour les familles FINESS.
 */

import type { FinessFamille, FinessFamilleQuery } from "./finess-categories.js";
import type { NafCodeSante } from "./naf-codes.js";

/**
 * NAF acceptés (gate "compatible") pour chaque famille FINESS.
 *
 * Le set est volontairement LARGE pour les familles fourre-tout DREES
 * (`hebergement_social`, `handicap_adultes`) et plus STRICT pour les familles
 * mono-NAF nettes (`labo` = `8690B`, `imagerie` = `8622A`, `pharmacie` = `4773Z`).
 *
 * Stratégie : démarrer avec ce mapping calibré sur la nomenclature NAF rév.2 +
 * la documentation DREES, monitorer les ambiguous en prod, élargir/resserrer
 * par famille au fil des cas réels (ex. si trop de faux matchs SSIAD↔aide à
 * domicile, on resserrera `ssiad` à `8690D` seul).
 *
 * Familles à `DELIBERATELY_NO_NAF` ne figurent PAS dans cette table — le
 * fallback est désactivé proprement pour elles (cf. `groupement`).
 */
const NAF_BY_FAMILLE: Record<FinessFamilleQuery, readonly NafCodeSante[]> = {
  // ─── Sanitaire ────────────────────────────────────────────────────────
  mco: ["8610Z"],
  ssr: ["8610Z"],
  sld: ["8610Z"],
  had: ["8610Z"],
  psychiatrie: ["8610Z", "8720A"],
  dialyse: ["8610Z", "8690F"],
  ambulatoire: ["8621Z", "8622A", "8622B", "8622C", "8623Z", "8690F"],

  // ─── Bio / pharma / imagerie ──────────────────────────────────────────
  labo: ["8690B"],
  // Imagerie : 8622A pour les cabinets de radiologie libéraux (radiodiagnostic
  // et radiothérapie au sens INSEE), 8690F pour les centres montés en société
  // de moyens (SCM/SEL) classés dans le fourre-tout santé humaine n.c.a. —
  // sans ce filet, on raterait une part importante des centres d'imagerie en
  // fallback (ajustement Cyril 2026-05-21).
  imagerie: ["8622A", "8690F"],
  pharmacie: ["4773Z"],

  // ─── Pluri-pro ────────────────────────────────────────────────────────
  msp_cpts: ["8621Z", "8622C", "8690F"],

  // ─── Personnes âgées ──────────────────────────────────────────────────
  ehpad: ["8710A", "8730A"],
  residence_autonomie: ["8730A", "8710A"],
  senior_accompagnement: ["8810B"],

  // ─── Domicile ─────────────────────────────────────────────────────────
  ssiad: ["8690D", "8810A"],
  aide_domicile: ["8810A", "8690D"],

  // ─── Handicap ─────────────────────────────────────────────────────────
  handicap_enfants: ["8710B", "8891B", "8899A"],
  handicap_adultes: ["8710C", "8720A", "8730B", "8810B", "8810C"],

  // ─── Addictologie / précarité sanitaire ───────────────────────────────
  addictologie: ["8610Z", "8720B", "8690F"],

  // ─── Enfance / protection ─────────────────────────────────────────────
  enfance_protection: ["8891A", "8899A"],

  // ─── PMI / petite enfance / santé scolaire ────────────────────────────
  pmi: ["8621Z", "8690F"],

  // ─── Hébergement social ───────────────────────────────────────────────
  hebergement_social: ["8720A", "8720B", "8730A", "8730B", "8899B"],

  // ─── Prévention / santé publique ──────────────────────────────────────
  prevention_sante: ["8610Z", "8690F"],

  // ─── Groupements de coopération ───────────────────────────────────────
  // ⚠️ AUCUN NAF : un GCS/GCSMS est une structure juridique transverse, pas
  // une activité économique propre. Listé dans DELIBERATELY_NO_NAF — le
  // fallback géo est désactivé pour cette famille (skip silencieux).
  // CI invariant `groupement is in DELIBERATELY_NO_NAF`.
  groupement: [],
} as const;

/**
 * Familles FINESS pour lesquelles aucun NAF n'est mappable proprement. Le
 * fallback géographique est désactivé pour ces familles — on préfère renvoyer
 * le résultat V0.7 inchangé plutôt qu'un mauvais match (verrouille la décision
 * Q3 du cadrage Resolver V2 : skip silencieux > faux positif).
 *
 * Test fixture #4 du chantier (FINESS catégorie 696/697 GCS) garde-fou
 * comportemental : le fallback ne DOIT PAS s'activer pour ces familles.
 *
 * Parallèle conceptuel à `DELIBERATELY_AUTRE` dans `finess-categories.ts` :
 * forcer une décision explicite au lieu d'un comportement par défaut silencieux.
 */
export const DELIBERATELY_NO_NAF: ReadonlySet<FinessFamilleQuery> = new Set<FinessFamilleQuery>([
  "groupement",
]);

/**
 * Codes NAF compatibles avec une famille FINESS. Retourne un tableau vide si
 * la famille est `autre` (catch-all FINESS) ou listée dans `DELIBERATELY_NO_NAF`.
 *
 * Le caller (resolver) interprète un retour vide comme "fallback impossible
 * pour cette famille — abandonner proprement, pas tenter sans filtre NAF".
 *
 * @example
 * ```ts
 * nafsForFamille("labo")        // → ["8690B"]
 * nafsForFamille("groupement")  // → []
 * nafsForFamille("autre")       // → []
 * ```
 */
export function nafsForFamille(famille: FinessFamille): readonly NafCodeSante[] {
  if (famille === "autre") return [];
  if (DELIBERATELY_NO_NAF.has(famille)) return [];
  return NAF_BY_FAMILLE[famille] ?? [];
}

/**
 * Vérifie si un NAF est compatible avec une famille FINESS donnée. Sert de
 * gate d'activité lors de la désambiguïsation du fallback géographique : un
 * candidat SIRET dont le NAF n'est pas compatible avec la famille du FINESS
 * source est éliminé (pas de pondération, pas de second chance).
 *
 * Normalise le NAF en entrée (point parfois présent dans les retours SIRENE,
 * ex. `"86.90B"` → `"8690B"`) pour matcher le format des `naf-codes.ts`.
 *
 * @example
 * ```ts
 * isNafCompatibleWithFamille("8690B", "labo")      // → true  (LBM)
 * isNafCompatibleWithFamille("8542Z", "labo")      // → false (école — Franco-Britannique gate)
 * isNafCompatibleWithFamille("8690B", "groupement") // → false (DELIBERATELY_NO_NAF)
 * ```
 */
export function isNafCompatibleWithFamille(
  naf: string | null | undefined,
  famille: FinessFamille,
): boolean {
  if (!naf) return false;
  const compatibles = nafsForFamille(famille);
  if (compatibles.length === 0) return false;
  const normalized = naf.replace(/\./g, "").toUpperCase().trim();
  return (compatibles as readonly string[]).includes(normalized);
}

/**
 * Export interne de la table pour tests d'invariant + introspection. Les
 * consommateurs métier doivent passer par `nafsForFamille` / `isNafCompatibleWithFamille`.
 *
 * @internal Test-only export.
 */
export const _NAF_BY_FAMILLE_INTERNAL = NAF_BY_FAMILLE;
