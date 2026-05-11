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
import { assertValidNumFiness } from "./db-helpers.js";
import { type FinessResult, getFinessByNumFiness } from "./finess-db.js";
import {
  type EtablissementSireneDetail,
  type EtablissementSireneHistorique,
  lookupSiretHistoriqueViaInsee,
  lookupSiretViaInsee,
} from "./insee-sirene.js";

/**
 * Verdict consolidé pour `verifier_site_actif`. Chaque champ traduit un
 * niveau de certitude distinct. Si `num_finess` est absent de FINESS DREES,
 * la fonction retourne directement `lookupNotFound` (pas un verdict).
 *
 * - `actif` : SIRENE renvoie au moins un SIRET candidat avec `actif=true`.
 *   Site considéré ouvert.
 * - `ferme` : tous les SIRET candidats sont `actif=false` ET ≥1 a une
 *   `dateFermeture`. Site considéré fermé — FINESS DREES probablement
 *   en retard (1-2 mois).
 * - `indetermine_pas_de_siret` : aucun SIRET candidat trouvé en base RPPS
 *   pour ce FINESS. Le pivot n'a pas pu être fait — caller doit cross-check
 *   manuellement via SIRENE/recherche-entreprises.
 * - `indetermine_pas_de_cle_insee` : clé `INSEE_SIRENE_API_KEY` non
 *   configurée côté serveur. SIRET candidat existe mais la vérification
 *   SIRENE est impossible.
 * - `indetermine_insee_unreachable` : ≥1 SIRET candidat trouvé mais aucun
 *   lookup SIRENE n'a abouti (5xx, timeout, 404 SIRENE inattendu). API
 *   INSEE indisponible — réessayer.
 * - `indetermine_sirene_partiel` : INSEE a répondu sur ≥1 SIRET mais aucun
 *   n'est ni actif ni n'a de `dateFermeture` (cessation SIRENE incomplète).
 *   Données partielles — vérifier les `insee_error` individuels.
 */
export type VerifierVerdict =
  | "actif"
  | "ferme"
  | "indetermine_pas_de_siret"
  | "indetermine_pas_de_cle_insee"
  | "indetermine_insee_unreachable"
  | "indetermine_sirene_partiel";

export interface SiretVerification {
  siret: string;
  /** Source de la candidature `siret` : `rpps_db` = enrichissement post-INSERT. */
  source: "rpps_db";
  /** Résultat SIRENE INSEE V3.11. `null` si lookup non tenté ou échoué. */
  insee: EtablissementSireneDetail | null;
  /** Présent quand le lookup INSEE a échoué (timeout, 5xx, payload incohérent). */
  insee_error?: string;
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
   * SIRET candidats trouvés via la table `rpps` (colonne enrichie au moment
   * de l'ingest RPPS — JOIN sur `num_finess`). Peut être vide si aucun PS
   * RPPS n'a déclaré ce FINESS comme site d'exercice.
   */
  siret_candidates: SiretVerification[];
  verdict: VerifierVerdict;
  /**
   * Message actionnable pour le caller LLM. Explique le verdict et oriente
   * vers les tools complémentaires (ex: `etablissement_by_siret` pour cross-check).
   */
  explication: string;
}

/**
 * Croise FINESS (raison sociale + adresse + tél de la DREES) avec SIRENE
 * (état administratif réel) via le pivot RPPS (qui expose `siret` à côté de
 * `num_finess`). Détecte les fermetures SIRENE non flaggées par FINESS.
 *
 * Retourne un `LookupResult` parce que `num_finess` peut être absent — même
 * shape que `getFinessByNumFiness` pour cohérence du contrat caller.
 *
 * Coût : 1 RPC + 1 DB query SELECT DISTINCT + N appels INSEE (rate-limited
 * 30/min, en pratique N ≤ 3 sites par FINESS → coût négligeable).
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

  const candidateSirets = await getDistinctSiretsForFiness(trimmed);

  // Cas 1 : aucun SIRET candidat → indéterminé (pas de pivot possible).
  if (candidateSirets.length === 0) {
    return lookupFound<VerifierSiteActifResult>({
      num_finess: trimmed,
      finess: extractFinessSummary(finess),
      siret_candidates: [],
      verdict: "indetermine_pas_de_siret",
      explication: `Aucun SIRET RPPS rattaché à ce FINESS — pivot SIRENE impossible automatiquement. Cross-check manuel : entreprises_in_radius autour de l'adresse FINESS, ou recherche directe sur recherche-entreprises.api.gouv.fr.`,
    });
  }

  // Cas 2 : SIRET candidats → on lookup chaque SIRET via INSEE en parallèle.
  // `Promise.allSettled` plutôt que séquentiel : INSEE rate-limit 30/min mais
  // N ≤ 5 SIRETs en pratique, donc 0 risque de saturer. Gain : p99 latency / N.
  // Rate limit côté serveur géré par fetchJson (retry-after sur 429).
  const settled = await Promise.allSettled(
    candidateSirets.map((siret) => lookupSiretViaInsee(siret)),
  );
  const verifications: SiretVerification[] = [];
  let anyInseeUnauthorized = false;
  for (let i = 0; i < candidateSirets.length; i++) {
    const siret = candidateSirets[i] as string;
    const outcome = settled[i] as PromiseSettledResult<
      Awaited<ReturnType<typeof lookupSiretViaInsee>>
    >;
    if (outcome.status === "rejected") {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.error(
        `[france-data-mcp] verifier_site_actif: INSEE lookup failed for siret=${siret}: ${msg}`,
      );
      verifications.push({ siret, source: "rpps_db", insee: null, insee_error: msg });
      continue;
    }
    const result = outcome.value;
    if (result.found) {
      verifications.push({ siret, source: "rpps_db", insee: result });
    } else {
      // not_found peut être : SIRET introuvable SIRENE (rare) OU clé INSEE
      // absente. La distinction est dans `message` — on garde la trace mais
      // on flagge le manque de clé pour le verdict global.
      const isMissingKey = result.message.includes("INSEE_SIRENE_API_KEY");
      if (isMissingKey) anyInseeUnauthorized = true;
      verifications.push({
        siret,
        source: "rpps_db",
        insee: null,
        insee_error: result.message,
      });
    }
  }

  // Cas 3 : clé INSEE manquante → on ne peut pas trancher.
  if (anyInseeUnauthorized) {
    return lookupFound<VerifierSiteActifResult>({
      num_finess: trimmed,
      finess: extractFinessSummary(finess),
      siret_candidates: verifications,
      verdict: "indetermine_pas_de_cle_insee",
      explication: `${candidateSirets.length} SIRET candidat(s) trouvé(s) côté RPPS, mais la clé INSEE_SIRENE_API_KEY n'est pas configurée côté serveur — vérification SIRENE impossible. Configurer la clé sur api.insee.fr pour activer.`,
    });
  }

  // Cas 4 : tous les SIRET candidats ont reçu une réponse SIRENE. On consolide.
  const inseeFound = verifications.filter((v): v is SiretVerification & {
    insee: EtablissementSireneDetail;
  } => v.insee !== null);
  const anyActif = inseeFound.some((v) => v.insee.actif === true);
  const anyHasDateFermeture = inseeFound.some((v) => v.insee.dateFermeture !== null);

  let verdict: VerifierVerdict;
  let explication: string;
  if (anyActif) {
    verdict = "actif";
    const activeSirets = inseeFound.filter((v) => v.insee.actif).map((v) => v.siret);
    explication = `Au moins un SIRET candidat est actif côté SIRENE INSEE (${activeSirets.join(", ")}). Site considéré ouvert.`;
  } else if (anyHasDateFermeture) {
    verdict = "ferme";
    const dates = inseeFound
      .filter((v) => v.insee.dateFermeture !== null)
      .map((v) => `${v.siret}@${v.insee.dateFermeture}`)
      .join(", ");
    explication = `Tous les SIRET candidats sont fermés côté SIRENE INSEE (${dates}). Site considéré fermé — FINESS DREES probablement en retard sur la fermeture (latence 1-2 mois).`;
  } else if (inseeFound.length === 0) {
    // Aucun lookup INSEE n'a réussi : on ne peut PAS conclure "pas de SIRET"
    // (les SIRET candidats existent côté RPPS, c'est SIRENE qui n'a rien
    // donné d'exploitable — 5xx, timeout, 404 SIRET inattendu, etc.).
    verdict = "indetermine_insee_unreachable";
    const errors = verifications.map((v) => v.insee_error ?? "unknown").join(" | ");
    explication = `${candidateSirets.length} SIRET candidat(s) trouvé(s) côté RPPS mais aucun lookup SIRENE n'a abouti (${errors}). API INSEE probablement indisponible ou SIRET inconnus de SIRENE — réessayer dans quelques minutes.`;
  } else {
    // INSEE a répondu mais aucun SIRET n'est ni actif ni n'a de dateFermeture
    // (cessation sans date côté SIRENE). Verdict dédié pour ne pas masquer la
    // présence de SIRET candidats derrière le label "pas_de_siret".
    verdict = "indetermine_sirene_partiel";
    explication = `${candidateSirets.length} SIRET candidat(s) mais aucun statut SIRENE exploitable (ni actif ni dateFermeture). Données SIRENE partielles — vérifier les insee_error individuels.`;
  }

  return lookupFound<VerifierSiteActifResult>({
    num_finess: trimmed,
    finess: extractFinessSummary(finess),
    siret_candidates: verifications,
    verdict,
    explication,
  });
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

  const candidateSirets = await getDistinctSiretsForFiness(trimmed);
  if (candidateSirets.length === 0) {
    return lookupNotFound(
      trimmed,
      `FINESS ${trimmed} trouvé mais aucun SIRET candidat côté RPPS — pivot SIRENE impossible automatiquement. Cross-check via entreprises_in_radius autour de l'adresse FINESS.`,
    );
  }

  // Parallélisation des lookups INSEE : N ≤ 5 SIRETs typiquement → gain p99
  // latency / N sans risque de saturer la limite INSEE 30 req/min.
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
  });
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
   * SIRET qui ont été déclarés côté RPPS mais qu'on n'a pas pu réconcilier
   * (lookup SIRENE rejected ou retourné not_found). Présent pour que le
   * caller distingue "0 SIRET candidat trouvé" (LookupNotFound) de
   * "N SIRET candidats mais tous rejetés par SIRENE" (`candidates: []` +
   * `skipped: [...]`).
   */
  skipped: Array<{ siret: string; reason: string }>;
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

  const candidateSirets = await getDistinctSiretsForFiness(trimmed);
  if (candidateSirets.length === 0) {
    return lookupNotFound(
      trimmed,
      `Aucun SIRET candidat trouvé côté RPPS pour FINESS ${trimmed} — réconciliation impossible automatiquement.`,
    );
  }

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
  return lookupFound<ReconciliationResult>({ num_finess: trimmed, candidates, skipped });
}

// === internals ===============================================================

/** Normalise pour comparaison textuelle : lowercase + trim + collapse whitespace. */
function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildFinessAdresseLibelle(f: FinessResult): string {
  return [f.adresse.voie, f.adresse.code_postal, f.adresse.ville]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ");
}

/**
 * Coefficient de Sørensen-Dice sur les bigrammes — robuste aux typos / ordre
 * mots / accents pour des libellés courts (raisons sociales, adresses). Plus
 * approprié qu'une similarity trigram côté SQL : on n'a pas besoin d'index
 * ici, juste d'un nombre 0..1 par paire. Implémentation 20 lignes, dépendance
 * externe non justifiée.
 *
 * Pour chaînes < 2 chars : égalité stricte (Dice classique = 0 pour les
 * unigrammes seuls, ce qui sous-évalue les match exacts courts type "CH").
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  let totalB = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    totalB++;
    const inA = bigramsA.get(bg);
    if (inA !== undefined && inA > 0) {
      intersection++;
      bigramsA.set(bg, inA - 1);
    }
  }
  const totalA = a.length - 1;
  if (totalA + totalB === 0) return 0;
  return (2 * intersection) / (totalA + totalB);
}

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

/**
 * Lit la table `rpps` pour récupérer la liste DISTINCT des SIRET déclarés
 * sur ce `num_finess`. Filtre les sentinelles `'finess_unmatched'` que
 * l'ingestion RPPS écrit quand un PS déclare un SIRET non rattachable à un
 * FINESS connu — sans ce filtre, le résultat contiendrait des SIRET
 * inexistants côté SIRENE.
 */
async function getDistinctSiretsForFiness(numFiness: string): Promise<string[]> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase
    .from("rpps")
    .select("siret")
    .eq("num_finess", numFiness)
    .not("siret", "is", null);
  if (error) {
    throw new Error(`rpps.siret lookup for num_finess=${numFiness} failed: ${error.message}`);
  }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ siret: string | null }>) {
    const s = row.siret?.trim();
    if (!s) continue;
    // Sentinelle attendue : un PS dont le SIRET n'a pas pu être rattaché à un
    // FINESS pendant l'ingestion. À ignorer silencieusement.
    if (s === "finess_unmatched") continue;
    if (!/^\d{14}$/.test(s)) {
      // Donnée corrompue inattendue (régression d'ingest, troncature CSV…).
      // On loggue pour qu'un futur bug d'écriture en base soit détectable
      // dans les logs Vercel structurés (V0.5.7).
      console.warn(
        `[france-data-mcp] getDistinctSiretsForFiness: SIRET malformé ignoré pour num_finess=${numFiness}: ${JSON.stringify(s)}`,
      );
      continue;
    }
    seen.add(s);
  }
  return [...seen];
}
