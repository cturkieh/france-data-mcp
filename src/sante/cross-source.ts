/**
 * Helpers de croisement multi-source (FINESS DREES ↔ SIRENE INSEE ↔ RPPS ANS).
 *
 * Pourquoi : chaque source flagge un site différemment. FINESS DREES a 1-2
 * mois de retard et garde parfois actif un SIRET fermé côté SIRENE. RPPS
 * (mise à jour mensuelle pour la facturation Ameli) reflète plus rapidement
 * les rebrandings post-M&A que la raison sociale FINESS. Les centres de
 * prélèvement non agréés LBM existent côté SIRENE mais sont absents de
 * FINESS par construction (référentiel limité aux LBM agréés).
 *
 * Ce module expose des PRIMITIVES de jointure brutes : confronter les
 * données factuellement, sans interprétation métier ni mapping d'enseignes
 * commerciales. Le caller décide quoi faire des divergences.
 */

import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { getUntypedAnonClient } from "../storage/supabase.js";
import {
  buildFinessAdresseLibelle,
  diceCoefficient,
  normalizeForCompare,
} from "./address-match.js";
import { assertValidNumFiness } from "./db-helpers.js";
import { getFinessByNumFiness } from "./finess-db.js";
import {
  type EtablissementSireneDetail,
  type EtablissementSireneHistorique,
  lookupSiretHistoriqueViaInsee,
  lookupSiretViaInsee,
} from "./insee-sirene.js";
import { type DinumLookupError, type SiretCandidate, resolveSiretsForFiness } from "./siret-resolver.js";

/**
 * Verdict pour `verifier_site_actif`. **V0.7.0 breaking** : on distingue
 * désormais le verdict **site** (le LIEU physique correspondant au FINESS)
 * du verdict **groupe** (l'unité légale parente, le SIREN).
 *
 * Pourquoi : un site peut être fermé alors que son groupe (SIREN) reste
 * actif via d'autres établissements. Avant V0.7.0, on n'avait qu'un verdict
 * global qui retournait "actif" tant qu'au moins un SIRET RPPS-déclaré
 * (typiquement le siège) était actif — masquant les fermetures de site.
 *
 * - `actif` : pour le site, le SIRET physique (= `best_match`) est ACTIF
 *   côté SIRENE/DINUM ; pour le groupe, l'UL est en état administratif `A`.
 * - `ferme` : pour le site, `best_match.actif === false` (= site cessé
 *   côté SIRENE, FINESS DREES probablement en retard 1-2 mois) ; pour le
 *   groupe, UL en état `C`.
 * - `indetermine` : impossible de trancher — soit parce qu'aucun SIRET
 *   candidat n'a un score d'adresse suffisant pour être déclaré
 *   `best_match` (≥ 0.6, cf. `siret-resolver.ts`), soit parce que le SIREN
 *   parent n'a pas pu être résolu côté DINUM (diffusion partielle, panne,
 *   timeout). Le caller doit cross-checker via `etablissement_by_siret`.
 */
export type VerdictSite = "actif" | "ferme" | "indetermine";
export type VerdictGroupe = "actif" | "ferme" | "indetermine";

/**
 * Mappe le tri-état `actif: boolean | null` (DINUM/SIRENE) sur le verdict.
 * `null` = donnée manquante (lookup échoué, SIREN diffusion partielle…) →
 * `indetermine`. Évite la duplication de la logique site vs groupe.
 */
function verdictFromActif(actif: boolean | null): VerdictSite {
  if (actif === true) return "actif";
  if (actif === false) return "ferme";
  return "indetermine";
}

export interface VerifierSiteActifResult {
  num_finess: string;
  finess: {
    raison_sociale: string;
    adresse: {
      voie: string | null;
      code_postal: string | null;
      ville: string | null;
    };
    /** Champ propre à FINESS DREES — pour confronter à SIRENE côté caller. */
    telephone: string | null;
  };
  /**
   * Tous les SIRET candidats identifiés via la cascade RPPS → DINUM, triés
   * par `score_adresse` décroissant. Inclut le SIRET du siège RPPS-déclaré
   * ET les SIRET DINUM qui matchent l'adresse FINESS (= SIRET physique du
   * site, y compris fermés). Cf. `siret-resolver.ts`.
   */
  candidates: SiretCandidate[];
  /**
   * Meilleur match adresse FINESS↔SIRENE (score_adresse ≥ 0.6). `null` quand
   * aucun candidat ne matche l'adresse FINESS — typique des structures
   * émergentes (DREES en retard) ou des SIREN diffusion partielle.
   */
  best_match: SiretCandidate | null;
  /** Liste des SIREN explorés via DINUM (1 dans 99% des cas). */
  sirens_explored: string[];
  /**
   * Diagnostic par SIREN qui a échoué côté DINUM (`rejected` / `not_found` /
   * `ambiguous`). Permet au caller de distinguer "vraiment pas de site"
   * (DINUM OK + 0 match) de "DINUM en panne" (`status: rejected`).
   * Vide quand tous les lookups DINUM ont réussi.
   */
  dinum_errors: DinumLookupError[];
  /** Verdict niveau SITE — basé sur `best_match.actif`. */
  verdict_site: VerdictSite;
  /**
   * Verdict niveau GROUPE (UL parente) — basé sur l'état admin DINUM du
   * SIREN du `best_match` (ou du premier SIREN exploré si pas de best_match).
   */
  verdict_groupe: VerdictGroupe;
  /**
   * Message actionnable pour le caller LLM. Explique les 2 verdicts et
   * oriente vers les tools complémentaires (ex: `etablissement_by_siret`
   * pour creuser un SIRET ambigu, `historique_etablissement` pour la timeline).
   */
  explication: string;
}

/**
 * Croise FINESS (raison sociale + adresse + tél de la DREES) avec SIRENE
 * (état administratif réel) en élargissant le pivot RPPS via DINUM. **V0.7.0**
 * remplace l'ancien pivot RPPS-only par une cascade RPPS → DINUM avec scoring
 * d'adresse, ce qui permet de capter les **SIRET fermés** (post-déménagement,
 * post-M&A) qui n'apparaissent plus dans la table RPPS (logique : aucun PS
 * actif ne déclare un SIRET fermé).
 *
 * Retourne un `LookupResult` parce que `num_finess` peut être absent — même
 * shape que `getFinessByNumFiness` pour cohérence du contrat caller.
 *
 * Coût : 1 RPC FINESS + 1 SELECT RPPS + N appels DINUM (N = nombre de SIREN
 * distincts, typiquement 1). Pas d'appel INSEE direct ici — DINUM gère son
 * propre fallback INSEE V3.11 en interne pour les SIREN diffusion partielle.
 */
export async function verifierSiteActif(
  numFiness: string,
): Promise<LookupResult<VerifierSiteActifResult>> {
  const trimmed = assertValidNumFiness(numFiness);
  const finess = await getFinessByNumFiness(trimmed);
  if (!finess.found) {
    return lookupNotFound(
      trimmed,
      `num_finess "${trimmed}" introuvable dans FINESS DREES. Causes : numéro inexistant, structure émergente (CPTS/MSP récentes — DREES retard 1-2 mois), ou fermeture récente non encore propagée. Cross-check ARS / Service Public.`,
    );
  }

  const resolution = await resolveSiretsForFiness(trimmed, finess);

  const verdictSite: VerdictSite = verdictFromActif(resolution.best_match?.actif ?? null);
  // SIREN du best_match (SIRET physique) prioritaire ; sinon le premier
  // SIREN exploré pour rester informatif quand aucun candidat n'a matché.
  const sirenForGroupe =
    resolution.best_match?.siret.slice(0, 9) ?? resolution.sirens_explored[0];
  const verdictGroupe: VerdictGroupe = verdictFromActif(
    sirenForGroupe ? (resolution.sirens_actif[sirenForGroupe] ?? null) : null,
  );

  return lookupFound<VerifierSiteActifResult>({
    num_finess: trimmed,
    finess: extractFinessSummary(finess),
    candidates: resolution.candidates,
    best_match: resolution.best_match,
    sirens_explored: resolution.sirens_explored,
    dinum_errors: resolution.dinum_errors,
    verdict_site: verdictSite,
    verdict_groupe: verdictGroupe,
    explication: buildVerifierExplication(resolution, verdictSite, verdictGroupe),
  });
}

/**
 * Texte LLM-friendly qui décrit les 2 verdicts ensemble. Objectif : que le
 * caller comprenne en une lecture la nuance site vs groupe, et sache vers
 * quel tool aller pour creuser (étoilement vers `etablissement_by_siret`,
 * `historique_etablissement`, ou `entreprise_by_siren` selon le cas).
 */
function buildVerifierExplication(
  resolution: Awaited<ReturnType<typeof resolveSiretsForFiness>>,
  verdictSite: VerdictSite,
  verdictGroupe: VerdictGroupe,
): string {
  const best = resolution.best_match;
  // Suffix DINUM ajouté à toutes les branches : utile même quand le verdict
  // est confirmé (signal de résolution non complète, peut justifier un retry).
  const dinumDiagSuffix = formatDinumDiag(resolution.dinum_errors);
  if (verdictSite === "actif" && best) {
    return `Site actif côté SIRENE/DINUM : SIRET ${best.siret} (score adresse ${best.score_adresse?.toFixed(2)}) marqué actif. Groupe (SIREN ${best.siret.slice(0, 9)}) : ${verdictGroupe}.${dinumDiagSuffix}`;
  }
  if (verdictSite === "ferme" && best) {
    return `Site fermé côté SIRENE/DINUM : SIRET ${best.siret} (score adresse ${best.score_adresse?.toFixed(2)}) marqué inactif (date_creation: ${best.date_creation ?? "?"}). FINESS DREES probablement en retard sur la fermeture (latence 1-2 mois). Groupe (SIREN ${best.siret.slice(0, 9)}) : ${verdictGroupe}. Pour la timeline complète : historique_etablissement(num_finess).${dinumDiagSuffix}`;
  }
  if (resolution.candidates.length === 0) {
    return `Aucun SIRET candidat trouvé via RPPS pour ce FINESS — pivot impossible. Cross-check manuel : entreprises_in_radius autour de l'adresse FINESS, ou recherche directe sur recherche-entreprises.api.gouv.fr.${dinumDiagSuffix}`;
  }
  // best_match null mais candidats RPPS présents → l'adresse RPPS-déclarée ne
  // matche pas l'adresse FINESS (cas typique : le PS a déclaré le SIRET du
  // siège, distant du site). Le caller peut investiguer manuellement.
  const sirenCandidates = resolution.sirens_explored.join(", ");
  return `Indéterminé : ${resolution.candidates.length} SIRET candidat(s) côté RPPS mais aucun ne matche l'adresse FINESS (score adresse < 0.6). SIREN exploré(s) : ${sirenCandidates}. Groupe : ${verdictGroupe}.${dinumDiagSuffix} Cross-check manuel via etablissement_by_siret sur les candidats.`;
}

/**
 * Format LLM-friendly d'une liste d'erreurs DINUM. Retourne `""` quand vide
 * (no-op safe en concat suffix). Inclut le `status` discriminé pour que le
 * caller sache si retry (rejected) ou abandon (not_found) ou alerter
 * (ambiguous = régression API).
 */
function formatDinumDiag(errors: DinumLookupError[]): string {
  if (errors.length === 0) return "";
  return ` ⚠ DINUM erreurs : ${errors.map((e) => `${e.siren} (${e.status}: ${e.message})`).join(" | ")}.`;
}

function extractFinessSummary(
  found: Extract<Awaited<ReturnType<typeof getFinessByNumFiness>>, { found: true }>,
): VerifierSiteActifResult["finess"] {
  return {
    raison_sociale: found.raison_sociale,
    adresse: {
      voie: found.adresse.voie,
      code_postal: found.adresse.code_postal,
      ville: found.adresse.ville,
    },
    telephone: found.telephone,
  };
}

// === Comparaison raison sociale FINESS vs RPPS ==============================

export interface RaisonSocialeDiff {
  num_finess: string;
  finess_raison_sociale: string;
  /**
   * Raison(s) sociale(s) déclarée(s) côté RPPS (DISTINCT sur la colonne
   * `raison_sociale` de la table rpps pour ce `num_finess`). Plusieurs
   * entrées possibles quand des PS ont déclaré le site avec des libellés
   * différents (M&A en cours, frappes hétérogènes).
   */
  rpps_raisons_sociales: string[];
  /**
   * Statut brut de la comparaison (pas d'interprétation métier — c'est une
   * primitive de réconciliation, pas un verdict commercial).
   *
   * - `exact_match` : FINESS et au moins une RPPS sont strictement égaux
   *   (après normalisation lowercase + trim + collapse whitespace).
   * - `divergent_after_normalization` : aucune RPPS ne matche FINESS après
   *   normalisation — vraie divergence (ex: FINESS "DIAGNOVIE" vs RPPS
   *   "BIOGROUP NORD" sur un site racheté).
   * - `rpps_absent` : aucune RPPS n'a déclaré ce FINESS (pivot impossible).
   *
   * Si le `num_finess` est absent de FINESS DREES, la fonction retourne
   * `lookupNotFound` (et non un `statut` dédié) — cohérent avec les autres
   * helpers cross-source.
   */
  statut: "exact_match" | "divergent_after_normalization" | "rpps_absent";
}

/**
 * Compare la raison sociale FINESS DREES vs RPPS / Annuaire Santé ANS pour
 * un même `num_finess`. Primitive brute SANS interprétation métier — le
 * caller décide quoi faire de la divergence. Le tool ne dit pas qui a
 * racheté qui : ça repose sur de la connaissance propriétaire d'enseignes.
 */
export async function compareRaisonSocialeFinessVsRpps(
  numFiness: string,
): Promise<LookupResult<RaisonSocialeDiff>> {
  const trimmed = assertValidNumFiness(numFiness);
  const finess = await getFinessByNumFiness(trimmed);
  if (!finess.found) {
    return lookupNotFound(
      trimmed,
      `num_finess "${trimmed}" introuvable dans FINESS DREES — comparaison impossible.`,
    );
  }

  const rppsLibelles = await getDistinctRaisonsSocialesFromRpps(trimmed);
  if (rppsLibelles.length === 0) {
    return lookupFound<RaisonSocialeDiff>({
      num_finess: trimmed,
      finess_raison_sociale: finess.raison_sociale,
      rpps_raisons_sociales: [],
      statut: "rpps_absent",
    });
  }

  const finessNorm = normalizeForCompare(finess.raison_sociale);
  const hasExact = rppsLibelles.some((r) => normalizeForCompare(r) === finessNorm);
  return lookupFound<RaisonSocialeDiff>({
    num_finess: trimmed,
    finess_raison_sociale: finess.raison_sociale,
    rpps_raisons_sociales: rppsLibelles,
    statut: hasExact ? "exact_match" : "divergent_after_normalization",
  });
}

/**
 * Récupère l'historique complet (toutes les périodes administratives) de
 * tous les SIRET candidats déclarés côté RPPS pour un FINESS donné. Permet
 * de tracer les ouvertures/fermetures successives — utile pour détecter une
 * fermeture SIRENE non encore propagée côté FINESS ou reconstruire
 * l'historique des rebrandings d'enseignes.
 */
export interface HistoriqueEtablissementResult {
  num_finess: string;
  finess: {
    raison_sociale: string;
    adresse: { voie: string | null; code_postal: string | null; ville: string | null };
  };
  /**
   * 1 entrée par SIRET candidat. La timeline SIRENE est dans
   * `periodes` (ordre chronologique croissant).
   */
  siret_timelines: Array<{
    siret: string;
    sirene: EtablissementSireneHistorique | null;
    sirene_error?: string;
  }>;
  /**
   * Diagnostic SIREN-level depuis le resolver (DINUM rejected / not_found /
   * ambiguous). Distinct des `sirene_error` SIRET-level dans `siret_timelines`.
   * Vide quand tous les lookups DINUM ont réussi.
   */
  dinum_errors: DinumLookupError[];
  /**
   * État global de la récupération :
   * - `success` : ≥ 1 timeline SIRENE a une donnée
   * - `partial` : certaines timelines OK, d'autres en erreur
   * - `all_sirene_failed` : toutes les timelines sont en `sirene_error` ET
   *   au moins une est une vraie panne (5xx, timeout, network) → retry justifié.
   * - `all_sirene_not_found` : toutes les timelines sont en `sirene_error`
   *   mais TOUTES sont des `not_found` SIRENE → SIRET candidats légitimement
   *   absents, retry inutile. Cross-check FINESS / numéro mal formé.
   */
  status: "success" | "partial" | "all_sirene_failed" | "all_sirene_not_found";
}

export async function historiqueEtablissement(
  numFiness: string,
): Promise<LookupResult<HistoriqueEtablissementResult>> {
  const trimmed = assertValidNumFiness(numFiness);
  const finess = await getFinessByNumFiness(trimmed);
  if (!finess.found) {
    return lookupNotFound(
      trimmed,
      `num_finess "${trimmed}" introuvable dans FINESS DREES. Cross-check ARS / Service Public.`,
    );
  }

  const resolution = await resolveSiretsForFiness(trimmed, finess);
  if (resolution.candidates.length === 0) {
    return lookupNotFound(
      trimmed,
      `FINESS ${trimmed} trouvé mais aucun SIRET candidat (RPPS vide + pas de match DINUM). Cross-check via entreprises_in_radius autour de l'adresse FINESS.`,
    );
  }

  // INSEE est nécessaire ici (pas DINUM) car seul `lookupSiretHistoriqueViaInsee`
  // retourne `periodesEtablissement[]` (timeline actif↔fermé) ; DINUM ne donne
  // que l'état courant. Parallélisation pour gain p99 latency / N ≤ 5 SIRETs.
  const candidateSirets = resolution.candidates.map((c) => c.siret);
  const settled = await Promise.allSettled(
    candidateSirets.map((siret) => lookupSiretHistoriqueViaInsee(siret)),
  );
  const timelines: HistoriqueEtablissementResult["siret_timelines"] = [];
  for (let i = 0; i < candidateSirets.length; i++) {
    const siret = candidateSirets[i] as string;
    const outcome = settled[i] as PromiseSettledResult<
      Awaited<ReturnType<typeof lookupSiretHistoriqueViaInsee>>
    >;
    if (outcome.status === "rejected") {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.error(
        `[france-data-mcp] historique_etablissement: INSEE lookup failed for siret=${siret}: ${msg}`,
      );
      timelines.push({ siret, sirene: null, sirene_error: msg });
      continue;
    }
    const result = outcome.value;
    if (result.found) {
      timelines.push({ siret, sirene: result });
    } else {
      timelines.push({ siret, sirene: null, sirene_error: result.message });
    }
  }

  const status = classifyTimelineStatus(timelines);

  return lookupFound<HistoriqueEtablissementResult>({
    num_finess: trimmed,
    finess: {
      raison_sociale: finess.raison_sociale,
      adresse: {
        voie: finess.adresse.voie,
        code_postal: finess.adresse.code_postal,
        ville: finess.adresse.ville,
      },
    },
    siret_timelines: timelines,
    dinum_errors: resolution.dinum_errors,
    status,
  });
}

/**
 * Classifie l'état global d'une liste de timelines. `all_sirene_failed`
 * (panne, retry justifié) est distinct de `all_sirene_not_found` (SIRET
 * réellement absent SIRENE, retry inutile) — le second se reconnaît au
 * libellé `introuvable` dans `sirene_error` (cohérent avec le message
 * généré par `lookupSiretHistoriqueViaInsee` sur 404).
 */
function classifyTimelineStatus(
  timelines: HistoriqueEtablissementResult["siret_timelines"],
): HistoriqueEtablissementResult["status"] {
  if (timelines.length === 0) return "all_sirene_failed";
  const okCount = timelines.filter((t) => t.sirene !== null).length;
  if (okCount === timelines.length) return "success";
  if (okCount > 0) return "partial";
  const allNotFound = timelines.every((t) => (t.sirene_error ?? "").includes("introuvable"));
  return allNotFound ? "all_sirene_not_found" : "all_sirene_failed";
}

/**
 * Classifie l'état d'une réconciliation. Logique alignée sur
 * `classifyTimelineStatus` mais sur la dichotomie `candidates` / `skipped` :
 * - 0 candidat + tous skipped en `introuvable` → `all_sirene_not_found`
 * - 0 candidat + ≥ 1 skip non-not_found → `all_sirene_failed` (panne)
 */
function classifyReconciliationStatus(
  candidatesCount: number,
  skipped: ReconciliationResult["skipped"],
): ReconciliationResult["status"] {
  if (candidatesCount > 0) return skipped.length === 0 ? "success" : "partial";
  if (skipped.length === 0) return "all_sirene_failed";
  const allNotFound = skipped.every((s) => s.reason.includes("introuvable"));
  return allNotFound ? "all_sirene_not_found" : "all_sirene_failed";
}

export interface ReconciliationScore {
  /** Score de similarité (0..1) sur la raison sociale (Sørensen-Dice trigram). */
  nom: number;
  /** Score sur l'adresse libellée complète (idem). */
  adresse: number;
  /**
   * Score téléphone : `1` si égalité après normalisation E.164 simplifiée
   * (remove non-digit), `0` sinon. Granularité binaire car les téléphones
   * sont soit le même numéro soit un autre — un Dice sur "0320051500" vs
   * "0361088418" donnerait un score artificiellement élevé.
   */
  telephone: number;
}

export interface ReconciliationCandidate {
  /** SIRET candidat sur lequel la réconciliation a été calculée. */
  siret: string;
  finess: { raison_sociale: string; adresse_libelle: string; telephone: string | null };
  sirene: {
    raison_sociale: string;
    enseigne: string | null;
    adresse_libelle: string;
    telephone: null; // SIRENE n'expose pas le tel — explicite pour ne pas mentir
  };
  scores: ReconciliationScore;
  /**
   * Score global = moyenne pondérée (nom 0.5, adresse 0.4, tel 0.1).
   * Pondération empirique : la raison sociale est l'identifiant le plus
   * stable, l'adresse pèse car les CSV FINESS ont parfois des typos, le tel
   * est rarement renseigné côté SIRENE (poids faible).
   */
  score_global: number;
  /**
   * Verdict brut sur le score global (pas d'interprétation métier) :
   * - `match` : ≥ 0.8 → forte cohérence FINESS/SIRENE
   * - `partial` : 0.5..0.8 → cohérence partielle (typo ? M&A ? à confirmer)
   * - `mismatch` : < 0.5 → grosse divergence
   */
  verdict: "match" | "partial" | "mismatch";
}

export interface ReconciliationResult {
  num_finess: string;
  /** Candidats triés par score_global décroissant (meilleur match en premier). */
  candidates: ReconciliationCandidate[];
  /**
   * SIRET candidats qu'on n'a pas pu réconcilier (lookup SIRENE rejected ou
   * retourné not_found). Présent pour que le caller distingue "0 SIRET
   * candidat trouvé" (LookupNotFound) de "N SIRET candidats mais tous
   * rejetés par SIRENE" (`candidates: []` + `skipped: [...]`).
   */
  skipped: Array<{ siret: string; reason: string }>;
  /**
   * Diagnostic SIREN-level depuis le resolver (DINUM rejected / not_found /
   * ambiguous). Distinct de `skipped` (SIRET-level INSEE).
   */
  dinum_errors: DinumLookupError[];
  /**
   * État global :
   * - `success` : tous les candidats réconciliés sans skip
   * - `partial` : certains réconciliés, d'autres skipped
   * - `all_sirene_failed` : 0 candidat réconcilié ET au moins un skip est
   *   une vraie panne (5xx, timeout, network) → retry justifié.
   * - `all_sirene_not_found` : 0 candidat réconcilié mais TOUS les skips sont
   *   des `not_found` SIRENE → SIRET candidats légitimement absents, retry inutile.
   */
  status: "success" | "partial" | "all_sirene_failed" | "all_sirene_not_found";
}

export async function reconcilierFinessSirene(
  numFiness: string,
): Promise<LookupResult<ReconciliationResult>> {
  const trimmed = assertValidNumFiness(numFiness);
  const finess = await getFinessByNumFiness(trimmed);
  if (!finess.found) {
    return lookupNotFound(
      trimmed,
      `num_finess "${trimmed}" introuvable dans FINESS DREES.`,
    );
  }

  // Le resolver fournit la liste élargie de SIRET candidats (RPPS + DINUM
  // match adresse) avec leur score adresse déjà calculé. Ici on lui demande
  // d'enrichir avec le score nom — qui exige un lookup INSEE pour récupérer
  // `raisonSocialeUniteLegale`.
  const resolution = await resolveSiretsForFiness(trimmed, finess);
  if (resolution.candidates.length === 0) {
    return lookupNotFound(
      trimmed,
      `Aucun SIRET candidat trouvé (RPPS vide + pas de match DINUM) pour FINESS ${trimmed} — réconciliation impossible automatiquement.`,
    );
  }

  const candidateSirets = resolution.candidates.map((c) => c.siret);
  const finessAdresseLibelle = buildFinessAdresseLibelle(finess);
  // Parallélisation des lookups INSEE : voir verifierSiteActif pour rationale.
  const settled = await Promise.allSettled(
    candidateSirets.map((siret) => lookupSiretViaInsee(siret)),
  );
  const candidates: ReconciliationCandidate[] = [];
  const skipped: ReconciliationResult["skipped"] = [];
  for (let i = 0; i < candidateSirets.length; i++) {
    const siret = candidateSirets[i] as string;
    const outcome = settled[i] as PromiseSettledResult<
      Awaited<ReturnType<typeof lookupSiretViaInsee>>
    >;
    if (outcome.status === "rejected") {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.error(
        `[france-data-mcp] reconcilier_finess_sirene: INSEE failed for siret=${siret}: ${msg}`,
      );
      skipped.push({ siret, reason: msg });
      continue;
    }
    if (!outcome.value.found) {
      console.warn(
        `[france-data-mcp] reconcilier_finess_sirene: SIRET ${siret} not_found SIRENE: ${outcome.value.message}`,
      );
      skipped.push({ siret, reason: outcome.value.message });
      continue;
    }
    const sirene: EtablissementSireneDetail = outcome.value;

    const scoreNom = diceCoefficient(
      normalizeForCompare(finess.raison_sociale),
      normalizeForCompare(sirene.raisonSocialeUniteLegale),
    );
    const scoreAdresse = diceCoefficient(
      normalizeForCompare(finessAdresseLibelle),
      normalizeForCompare(sirene.adresse.libelle),
    );
    // SIRENE n'expose pas le téléphone via /siret — le score reste 0 sauf si
    // un jour on intègre une 2e source (Pages Jaunes, Google Places). Pour
    // l'instant : binaire FINESS-only → 0 car comparaison impossible.
    const scoreTel = 0;
    const scoreGlobal = scoreNom * 0.5 + scoreAdresse * 0.4 + scoreTel * 0.1;
    let verdict: ReconciliationCandidate["verdict"];
    if (scoreGlobal >= 0.8) verdict = "match";
    else if (scoreGlobal >= 0.5) verdict = "partial";
    else verdict = "mismatch";

    candidates.push({
      siret,
      finess: {
        raison_sociale: finess.raison_sociale,
        adresse_libelle: finessAdresseLibelle,
        telephone: finess.telephone,
      },
      sirene: {
        raison_sociale: sirene.raisonSocialeUniteLegale,
        enseigne: sirene.enseigne,
        adresse_libelle: sirene.adresse.libelle,
        telephone: null,
      },
      scores: { nom: scoreNom, adresse: scoreAdresse, telephone: scoreTel },
      score_global: Number(scoreGlobal.toFixed(3)),
      verdict,
    });
  }

  candidates.sort((a, b) => b.score_global - a.score_global);
  const status = classifyReconciliationStatus(candidates.length, skipped);
  return lookupFound<ReconciliationResult>({
    num_finess: trimmed,
    candidates,
    skipped,
    dinum_errors: resolution.dinum_errors,
    status,
  });
}

// === internals ===============================================================

// Helpers de normalisation, de scoring Dice et de libellé d'adresse FINESS
// sont importés de `address-match.ts` (partagés avec `siret-resolver.ts`).

async function getDistinctRaisonsSocialesFromRpps(numFiness: string): Promise<string[]> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase
    .from("rpps")
    .select("raison_sociale")
    .eq("num_finess", numFiness)
    .not("raison_sociale", "is", null);
  if (error) {
    throw new Error(
      `rpps.raison_sociale lookup for num_finess=${numFiness} failed: ${error.message}`,
    );
  }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ raison_sociale: string | null }>) {
    const r = row.raison_sociale?.trim();
    if (r) seen.add(r);
  }
  return [...seen];
}

