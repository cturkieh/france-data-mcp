/**
 * Résolution des SIRET candidats pour un `num_finess` donné.
 *
 * Pourquoi : la table RPPS stocke généralement le SIRET du **siège employeur**
 * déclaré par le PS, pas le SIRET physique du **site d'exercice**. Conséquence
 * sur les sites fermés post-déménagement ou post-M&A : aucun PS actif ne
 * déclare le SIRET fermé, donc le pivot RPPS classique le rate.
 *
 * Exemple reproductible : FINESS 590048997 (LABORATOIRE SECONDAIRE DIAGNOVIE
 * BD BIZET, fermé côté SIRENE depuis 2024-02-16). RPPS ne ramène que le SIRET
 * 50781594200333 (siège actuel Rue des Fusillés). Le vrai SIRET du site
 * (50781594200218 Bd Bizet, fermé) est invisible.
 *
 * Stratégie cascade implémentée :
 *
 * 1. **RPPS** (`getDistinctSiretsForFiness`) → SIRET déclarés par les PS pour
 *    ce FINESS. Source primaire : c'est ce qui est typé/normalisé/datable.
 *
 * 2. **DINUM** (`getEntrepriseBySiren`) → pour chaque SIREN distinct dérivé
 *    des SIRET RPPS, on liste TOUS les `etablissements[]` du SIREN (actifs ET
 *    fermés). DINUM est le bon canal car : (a) déjà rate-limited + caché côté
 *    serveur, (b) retourne directement les coords + actif + dateCreation,
 *    (c) couvre la diffusion partielle INSEE via fallback SIRENE V3.11.
 *
 * 3. **Scoring d'adresse** : Sørensen-Dice bigrammes entre l'adresse FINESS
 *    (libellée) et l'adresse DINUM de chaque établissement. Top scores ≥ 0.6
 *    = SIRET physiques candidats.
 *
 * Le module ne décide PAS du verdict métier (actif/fermé du site) — il
 * retourne une liste enrichie ordonnée par score. Le caller (cross-source.ts)
 * applique sa propre logique (best_match → actif → verdict_site, etc.).
 *
 * Coût : 1 SELECT RPPS + N appels DINUM (N = nombre de SIREN distincts,
 * typiquement 1, rarement 2-3). DINUM gère son propre cache + rate limit.
 */

import { buildFinessAdresseLibelle, diceCoefficient, normalizeForCompare } from "./address-match.js";
import { getEntrepriseBySiren } from "./dinum.js";
import type { FinessResult } from "./finess-db.js";
import { getUntypedAnonClient } from "../storage/supabase.js";

/**
 * Origine d'un SIRET candidat. Un même SIRET peut cumuler plusieurs sources
 * (ex : RPPS le liste + DINUM le retrouve avec une adresse qui matche FINESS).
 *
 * - `rpps` : SIRET déclaré par ≥ 1 PS dans la table `rpps` pour ce FINESS.
 *   Garantie d'une déclaration métier — mais reflète le SIRET employeur, pas
 *   nécessairement le SIRET du site physique.
 * - `dinum_address_match` : SIRET listé par DINUM dans les `etablissements`
 *   du SIREN parent, dont l'adresse SIRENE matche (Dice ≥ 0.6) celle déclarée
 *   par FINESS. Permet de capter les SIRET fermés invisibles côté RPPS.
 */
export type SiretCandidateSource = "rpps" | "dinum_address_match";

/**
 * Diagnostic d'un lookup DINUM qui n'a pas pu enrichir un SIREN.
 * - `rejected` : exception réseau / 5xx pendant le lookup. Retry justifié.
 * - `not_found` : SIREN absent DINUM ET fallback INSEE V3.11 négatif. Définitif.
 * - `ambiguous` : DINUM a renvoyé N résultats full-text sans match exact —
 *   régression API DINUM probable, à surveiller.
 */
export type DinumLookupError = {
  siren: string;
  message: string;
  status: "rejected" | "not_found" | "ambiguous";
};

export interface SiretCandidate {
  siret: string;
  /** Toutes les sources qui ont mentionné ce SIRET (dédupliquées). */
  sources: SiretCandidateSource[];
  /**
   * Score Sørensen-Dice 0..1 entre l'adresse FINESS et l'adresse SIRENE/DINUM
   * de cet établissement. `null` si pas d'adresse exploitable côté DINUM
   * (cas où le SIRET vient uniquement de RPPS et le SIREN n'a pas pu être
   * résolu côté DINUM). 1 = match parfait, ≥ 0.7 = même adresse avec
   * variations de saisie, < 0.5 = adresses distinctes.
   */
  score_adresse: number | null;
  /**
   * État administratif SIRENE de l'établissement (champ DINUM `actif`).
   * `null` quand le SIRET vient uniquement de RPPS et n'a pas été cross-vérifié.
   */
  actif: boolean | null;
  /** Adresse libellée (depuis DINUM). `null` si origine RPPS pure. */
  adresse_libelle: string | null;
  /** Date de création (depuis DINUM). `null` si origine RPPS pure. */
  date_creation: string | null;
}

export interface SiretResolution {
  /**
   * Tous les SIRET candidats, triés par `score_adresse` décroissant
   * (les `null` en fin). Inclut RPPS + DINUM dédupliqués.
   */
  candidates: SiretCandidate[];
  /**
   * Meilleur match adresse FINESS↔SIRENE. `null` si aucun candidat n'atteint
   * le seuil `BEST_MATCH_THRESHOLD` (0.6) — typique quand RPPS ne ramène que
   * le siège distant ET que DINUM n'a pas d'établissement à l'adresse FINESS.
   */
  best_match: SiretCandidate | null;
  /**
   * Liste des SIREN explorés via DINUM (1 SIREN dans 99% des cas, plusieurs
   * possible si différents PS exercent dans différents groupes). Vide si RPPS
   * n'a remonté aucun SIRET.
   */
  sirens_explored: string[];
  /**
   * État administratif (champ `actif` de l'unité légale côté DINUM/INSEE) par
   * SIREN exploré. `true` = UL active. `false` = UL cessée. `null` = SIREN
   * non résolu (DINUM erreur, not_found, ou diffusion partielle sans fallback).
   * Permet au caller de calculer un `verdict_groupe` distinct du `verdict_site`.
   */
  sirens_actif: Record<string, boolean | null>;
  /** Diagnostic par SIREN qui a échoué côté DINUM. Vide quand tout est OK. */
  dinum_errors: DinumLookupError[];
}

/** Seuil au-dessus duquel un score d'adresse Dice est considéré comme un match physique du site. */
const BEST_MATCH_THRESHOLD = 0.6;

/**
 * Résout la liste enrichie des SIRET candidats pour un `num_finess`. Le caller
 * fournit le `FinessResult` déjà chargé (économie d'1 RPC) — c'est lui qui
 * détient l'adresse FINESS contre laquelle scorer.
 */
export async function resolveSiretsForFiness(
  numFiness: string,
  finess: FinessResult,
): Promise<SiretResolution> {
  const rppsSirets = await getDistinctSiretsForFinessFromRpps(numFiness);
  if (rppsSirets.length === 0) {
    return {
      candidates: [],
      best_match: null,
      sirens_explored: [],
      sirens_actif: {},
      dinum_errors: [],
    };
  }

  // Dérive les SIREN distincts depuis les SIRET RPPS (9 premiers chars).
  // Set pour dédupliquer : un SIREN peut avoir plusieurs SIRET RPPS-déclarés.
  const sirensDistincts = [...new Set(rppsSirets.map((s) => s.slice(0, 9)))];

  // Parallélise les lookups DINUM — coût borné (1-3 SIREN en pratique). DINUM
  // gère son propre rate limit interne, et chaque lookup est caché côté serveur
  // (via la couche `fetchJson` retry+cache). Promise.allSettled pour qu'un
  // échec sur un SIREN n'invalide pas les autres.
  const dinumResults = await Promise.allSettled(
    sirensDistincts.map(async (siren) => ({ siren, lookup: await getEntrepriseBySiren(siren) })),
  );

  // FINESS-side address normalized once : invariant pour toute la résolution.
  // Sans hoist, la même chaîne serait re-normalisée O(N×M) fois (N SIREN, M
  // établissements DINUM par SIREN). Pas critique en latency mais évite le
  // gaspillage trivial.
  const finessAddrNorm = normalizeForCompare(buildFinessAdresseLibelle(finess));
  const candidates = new Map<string, SiretCandidate>();
  const dinumErrors: SiretResolution["dinum_errors"] = [];
  const sirensActif: Record<string, boolean | null> = Object.fromEntries(
    sirensDistincts.map((s) => [s, null]),
  );

  for (const siret of rppsSirets) {
    candidates.set(siret, {
      siret,
      sources: ["rpps"],
      score_adresse: null,
      actif: null,
      adresse_libelle: null,
      date_creation: null,
    });
  }

  for (let i = 0; i < dinumResults.length; i++) {
    const sirenResolved = sirensDistincts[i] as string;
    const settled = dinumResults[i] as PromiseSettledResult<{
      siren: string;
      lookup: Awaited<ReturnType<typeof getEntrepriseBySiren>>;
    }>;
    if (settled.status === "rejected") {
      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      console.error(
        `[france-data-mcp] siret-resolver: DINUM lookup rejected for siren=${sirenResolved}: ${msg}`,
      );
      dinumErrors.push({ siren: sirenResolved, message: msg, status: "rejected" });
      continue;
    }
    const { siren, lookup } = settled.value;
    if (!lookup.found) {
      // Distinguer `not_found` (SIREN absent SIRENE / diffusion partielle sans
      // fallback INSEE) de `ambiguous` (full-text DINUM = 5 résultats sans
      // match exact, régression possible API). Le caller LLM doit voir cette
      // nuance pour décider : retry, cross-check manuel, ou ignorer.
      console.warn(
        `[france-data-mcp] siret-resolver: DINUM lookup status=${lookup.lookupStatus} for siren=${siren}: ${lookup.message}`,
      );
      dinumErrors.push({ siren, message: lookup.message, status: lookup.lookupStatus });
      continue;
    }
    sirensActif[siren] = lookup.actif;
    for (const etab of lookup.etablissements) {
      mergeOrInsertDinumCandidate(candidates, etab, finessAddrNorm);
    }
  }

  const sorted = [...candidates.values()].sort(compareByScoreDesc);
  const top = sorted[0];
  const bestMatch =
    top && top.score_adresse !== null && top.score_adresse >= BEST_MATCH_THRESHOLD
      ? top
      : null;

  return {
    candidates: sorted,
    best_match: bestMatch,
    sirens_explored: sirensDistincts,
    sirens_actif: sirensActif,
    dinum_errors: dinumErrors,
  };
}

/** Tri primaire : score décroissant ; les `null` en queue (donnée incomplète). */
function compareByScoreDesc(a: SiretCandidate, b: SiretCandidate): number {
  const sa = a.score_adresse;
  const sb = b.score_adresse;
  if (sa === null && sb === null) return 0;
  if (sa === null) return 1;
  if (sb === null) return -1;
  return sb - sa;
}

/**
 * Merge un établissement DINUM dans la map des candidats. Trois branches :
 *
 * 1. SIRET déjà seedé via RPPS → enrichit les champs DINUM. Ajoute
 *    `dinum_address_match` aux sources UNIQUEMENT si l'adresse matche réellement,
 *    sinon le SIRET du siège RPPS (qui partage le SIREN mais pas l'adresse)
 *    serait toujours flaggé en double source — trompeur pour le caller.
 * 2. SIRET nouveau ET adresse matche → insère un nouveau candidat. C'est le
 *    cas typique du SIRET fermé invisible côté RPPS.
 * 3. SIRET nouveau ET adresse ne matche pas → bruit (autre site du SIREN sans
 *    lien avec le FINESS). Ignoré.
 */
function mergeOrInsertDinumCandidate(
  candidates: Map<string, SiretCandidate>,
  etab: { siret: string; adresse?: string; actif: boolean; dateCreation?: string },
  finessAddrNorm: string,
): void {
  const adresse = etab.adresse?.trim() || null;
  const score = adresse
    ? diceCoefficient(finessAddrNorm, normalizeForCompare(adresse))
    : null;
  const existing = candidates.get(etab.siret);
  if (existing) {
    existing.adresse_libelle = adresse;
    existing.actif = etab.actif;
    existing.date_creation = etab.dateCreation ?? null;
    existing.score_adresse = score;
    if (score !== null && score >= BEST_MATCH_THRESHOLD && !existing.sources.includes("dinum_address_match")) {
      existing.sources.push("dinum_address_match");
    }
    return;
  }
  if (score !== null && score >= BEST_MATCH_THRESHOLD) {
    candidates.set(etab.siret, {
      siret: etab.siret,
      sources: ["dinum_address_match"],
      score_adresse: score,
      actif: etab.actif,
      adresse_libelle: adresse,
      date_creation: etab.dateCreation ?? null,
    });
  }
}

/**
 * Récupère la liste DISTINCT des SIRET déclarés côté RPPS pour ce `num_finess`.
 * Filtre les sentinelles `'finess_unmatched'` et les SIRET malformés (régression
 * ingest hypothétique).
 */
async function getDistinctSiretsForFinessFromRpps(numFiness: string): Promise<string[]> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase
    .from("rpps")
    .select("siret")
    .eq("num_finess", numFiness)
    .not("siret", "is", null);
  if (error) {
    throw new Error(
      `siret-resolver: rpps.siret lookup for num_finess=${numFiness} failed: ${error.message}`,
    );
  }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ siret: string | null }>) {
    const s = row.siret?.trim();
    if (!s) continue;
    if (s === "finess_unmatched") continue;
    if (!/^\d{14}$/.test(s)) {
      console.warn(
        `[france-data-mcp] siret-resolver: SIRET malformé ignoré pour num_finess=${numFiness}: ${JSON.stringify(s)}`,
      );
      continue;
    }
    seen.add(s);
  }
  return [...seen];
}
