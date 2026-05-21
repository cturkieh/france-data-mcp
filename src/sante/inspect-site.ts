/**
 * `inspect_site(num_finess)` — vue 360 d'un établissement santé en 1 call MCP (V0.10).
 *
 * Pendant naturel de `panorama_sante_territoire` (côté territoire) appliqué au
 * site. Réduit la latence et la friction LLM en parallélisant 3 sous-appels
 * (verdict actif/fermé via SIRENE, professionnels rattachés, historique
 * périodes administratives) en une seule requête.
 *
 * **Composition pure** : ce module appelle uniquement les briques existantes
 * (`verifierSiteActif`, `getRppsDansEtablissement`, `historiqueEtablissement`).
 * Aucun nouveau RPC, aucune logique métier dupliquée. Conséquence : le pivot
 * RPPS→DINUM est exécuté DEUX fois (une dans verifier, une dans historique).
 * Comme les 3 sous-appels tournent en `Promise.all`, ces 2 cascades DINUM
 * sont parallèles : l'impact dominant n'est PAS la latence (le 2e lookup ne
 * s'ajoute pas au temps mur) mais la **charge API DINUM doublée** (2× appels
 * pour 1 inspect_site → consomme 2× le budget rate-limit DINUM côté lib).
 * Optimisation future via factorisation `_loadSiteContext` dans
 * `cross-source.ts` (post-V0.10.0, si le volume d'usage stresse le rate-limit).
 *
 * Contrat caller : `LookupResult` — même shape que `verifierSiteActif` /
 * `historiqueEtablissement` pour cohérence (num_finess introuvable = même
 * branche `not_found`, message identique).
 */

import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import {
  type HistoriqueEtablissementResult,
  type SiteContext,
  historiqueEtablissement,
  verifierSiteActif,
} from "./cross-source.js";
import { assertValidNumFiness } from "./db-helpers.js";
import { getFinessByNumFiness } from "./finess-db.js";
import { getRppsDansEtablissement } from "./rpps-db.js";
import type { RppsResult } from "./rpps-db.js";
import { type DinumLookupError, resolveSiretsForFiness } from "./siret-resolver.js";
import { SOURCE_LABELS } from "./sources.js";

export interface InspectSiteInput {
  /** Numéro FINESS 9 chars. REQUIS. */
  numFiness: string;
  /**
   * Nombre max de professionnels renvoyés dans `professionnels.sample`.
   * `professionnels.count` = taille du sample (≤ cette borne), PAS le total
   * de PS du site (cf. JSDoc de `count`). Défaut 10. Borné [1, 50] pour
   * éviter de gonfler la réponse MCP (les LLMs exploitent rarement plus de
   * 10-20 PS pour un site).
   */
  rppsLimit?: number;
  /**
   * Inclure les timelines SIRENE détaillées dans `historique.siret_timelines`
   * (défaut `true`). `false` = payload allégé (~7K tokens en moins, audit
   * B2/lot3) : `historique` ne porte qu'un `resume` (counts) + un pointeur
   * vers `historique_etablissement` pour le détail. Le sous-appel reste
   * exécuté (le `status`/`available` en dépend) — seul le payload est réduit.
   */
  historiqueDetail?: boolean;
}

const RPPS_LIMIT_DEFAULT = 10;
const RPPS_LIMIT_MIN = 1;
const RPPS_LIMIT_MAX = 50;

export interface InspectSiteFinessSummary {
  raison_sociale: string;
  adresse: { voie: string | null; code_postal: string | null; ville: string | null };
  /** Champ propre à FINESS DREES (peut diverger du téléphone SIRENE). */
  telephone: string | null;
}

export interface InspectSiteStatutSection {
  /** `actif` / `ferme` / `indetermine` au niveau du SITE physique (best_match). */
  verdict_site: "actif" | "ferme" | "indetermine";
  /** Idem au niveau du GROUPE (UL parente du SIREN best_match). */
  verdict_groupe: "actif" | "ferme" | "indetermine";
  /** SIRET physique le plus probable (score adresse ≥ 0.6) — `null` si aucun match. */
  best_match_siret: string | null;
  /** Score Sørensen-Dice 0..1 du best_match — `null` si aucun match. */
  best_match_score_adresse: number | null;
  /** SIREN explorés via DINUM (1 dans 99 % des cas). */
  sirens_explored: string[];
  /** Nombre total de SIRET candidats identifiés (RPPS + DINUM dédupliqués). */
  candidates_count: number;
  /** Texte LLM-friendly : explique les verdicts + oriente vers `etablissement_by_siret` / `historique_etablissement`. */
  explication: string;
  /** Diagnostic SIREN-level si DINUM a partiellement échoué. Vide en succès complet. */
  dinum_errors: DinumLookupError[];
}

export type InspectSiteHistoriqueSection =
  | {
      available: true;
      status: HistoriqueEtablissementResult["status"];
      siret_timelines: HistoriqueEtablissementResult["siret_timelines"];
    }
  | {
      /** Variante allégée (`historiqueDetail: false`) : counts au lieu des
       * timelines complètes. `siret_timelines` volontairement absent. */
      available: true;
      detail_omitted: true;
      status: HistoriqueEtablissementResult["status"];
      /**
       * `sirets_en_erreur` : nb de SIRET dont le lookup SIRENE a échoué
       * (`sirene: null`). Sans lui, `periodes_total: 0` serait ambigu entre
       * "0 période réelle" et "SIRENE injoignable" — le détail par SIRET
       * (`sirene_error`) n'étant exposé qu'en mode `historiqueDetail: true`.
       */
      resume: { sirets: number; periodes_total: number; sirets_en_erreur: number };
      note: string;
    }
  | {
      /**
       * `available: false` quand FINESS existe mais aucun SIRET candidat
       * (RPPS vide + pas de match DINUM). Le `message` reprend celui de
       * `historiqueEtablissement` pour cohérence des contrats LLM.
       */
      available: false;
      message: string;
    };

export interface InspectSiteResult {
  num_finess: string;
  finess: InspectSiteFinessSummary;
  statut_site: InspectSiteStatutSection;
  professionnels: {
    /**
     * Nombre de PS DANS le sample (= `sample.length`, borné par `rppsLimit`).
     * CE N'EST PAS le total de PS rattachés au site : `rpps_dans_etablissement`
     * ne renvoie pas de COUNT(*) global (convention QueryResult du repo —
     * idem ameli/finess/rpps). Si `truncated` est true, le site a STRICTEMENT
     * PLUS de PS que ce `count` ; pour un dénombrement exact, augmenter
     * `rppsLimit` ou appeler `rpps_dans_etablissement` directement.
     */
    count: number;
    /** True si le site a plus de PS rattachés que les `count` du sample. */
    truncated: boolean;
    /** Sample limité à `rppsLimit` (défaut 10). Tri RPC par défaut. */
    sample: RppsResult[];
  };
  historique: InspectSiteHistoriqueSection;
  sources: {
    etablissement: typeof SOURCE_LABELS.finess;
    statut: string;
    professionnels: typeof SOURCE_LABELS.rpps;
    historique: typeof SOURCE_LABELS.insee_sirene;
  };
}

/**
 * Projette le lookup `historiqueEtablissement` en section `historique`.
 * `detail=false` → variante allégée (counts au lieu des timelines SIRENE
 * complètes, ~7K tokens en moins).
 */
function buildHistoriqueSection(
  lookup: Awaited<ReturnType<typeof historiqueEtablissement>>,
  detail: boolean,
): InspectSiteHistoriqueSection {
  if (!lookup.found) {
    return { available: false, message: lookup.message };
  }
  if (detail) {
    return {
      available: true,
      status: lookup.status,
      siret_timelines: lookup.siret_timelines,
    };
  }
  const periodesTotal = lookup.siret_timelines.reduce(
    (acc, t) => acc + (t.sirene?.periodes.length ?? 0),
    0,
  );
  const siretsEnErreur = lookup.siret_timelines.filter((t) => t.sirene === null).length;
  return {
    available: true,
    detail_omitted: true,
    status: lookup.status,
    resume: {
      sirets: lookup.siret_timelines.length,
      periodes_total: periodesTotal,
      sirets_en_erreur: siretsEnErreur,
    },
    note: "Timelines SIRENE détaillées omises (historique_detail=false) — appeler historique_etablissement pour le détail par SIRET (dont sirene_error).",
  };
}

/**
 * Agrège la vue 360 d'un site santé en 1 call. **V0.13.0** : factorise la
 * cascade RPPS→DINUM (`SiteContext`) au lieu de l'exécuter en doublon dans
 * `verifierSiteActif` + `historiqueEtablissement` — économie d'1 RPC FINESS
 * et de 1× la charge rate-limit DINUM par invocation (~600 ms gratuits côté
 * budget API publique). Parallélise ensuite les 3 sous-appels via `Promise.all`.
 *
 * **Comportement échec** : `LookupResult.notFound` si le `num_finess` n'existe
 * pas dans FINESS DREES. Pas de fallback partiel : si l'un des 3 sous-appels
 * fail (DINUM down, INSEE timeout), l'exception remonte. Le caller MCP retentera ;
 * ne pas masquer une panne derrière un panorama incomplet (cf. lessons V0.8.1).
 *
 * **Limitations** :
 * - `professionnels.sample` ne filtre pas par catégorie — le LLM peut affiner
 *   via `rpps_dans_etablissement` direct si besoin.
 */
export async function inspectSite(
  input: InspectSiteInput,
): Promise<LookupResult<InspectSiteResult>> {
  const trimmed = assertValidNumFiness(input.numFiness);
  const rppsLimit = clampRppsLimit(input.rppsLimit);

  // === V0.13 factorisation cascade (FINESS + RPPS→DINUM résolu une fois) =====
  //
  // Pré-charge en parallèle de la query RPPS (qui ne dépend ni de FINESS ni
  // de DINUM). Si FINESS n'existe pas → bail-out canonique sans avoir
  // déclenché de cascade DINUM inutile. Sinon → résolution unique passée aux
  // 2 sous-appels via `SiteContext`.
  const [finessLookup, rpps] = await Promise.all([
    getFinessByNumFiness(trimmed),
    getRppsDansEtablissement({ numFiness: trimmed, limit: rppsLimit }),
  ]);

  if (!finessLookup.found) {
    // Désync inter-référentiels : FINESS DREES absent mais PS RPPS rattachés
    // (cas typique des structures émergentes — DREES 1-2 mois de retard sur
    // RPPS mensuel). Logger plutôt que de masquer derrière `not_found`.
    if (rpps.count > 0) {
      console.warn(
        `[france-data-mcp] inspect_site(${trimmed}): FINESS DREES not_found mais ${rpps.count}+ PS RPPS rattachés — désync référentiels (FINESS probablement en retard sur RPPS).`,
      );
    }
    return lookupNotFound(trimmed, finessLookup.message);
  }

  // Cascade unique RPPS → DINUM (+ fallback géo V0.13 si éligible).
  const resolution = await resolveSiretsForFiness(trimmed, finessLookup);
  const context: SiteContext = { finess: finessLookup, resolution };

  const [verifierLookup, historiqueLookup] = await Promise.all([
    verifierSiteActif(trimmed, context),
    historiqueEtablissement(trimmed, context),
  ]);

  // V0.13 : la désync FINESS-absent / PS-RPPS-présents a été déplacée en
  // amont (avant la cascade) pour ne pas gaspiller un appel DINUM dans ce
  // cas. Ici, `verifierLookup` est garanti `found: true` car on lui a passé
  // un `context` avec `finess.found === true`. Le narrowing TS reste utile
  // mais comme invariant fail-loud, pas comme branche métier.
  if (!verifierLookup.found) {
    throw new Error(
      `inspect_site: invariant violation — verifierSiteActif a retourné not_found avec un context.finess.found===true (num_finess=${trimmed}). Régression contractuelle à investiguer.`,
    );
  }

  // `historique` peut être `not_found` alors que `verifier` est `found`.
  // GARANTIE (vérifiée sur `historiqueEtablissement`) : ce `not_found` ne
  // survient QUE pour "FINESS existe mais 0 SIRET candidat (RPPS vide +
  // DINUM 0 match)". Une vraie panne DINUM/INSEE NE produit PAS `not_found`
  // — elle throw (remonte via le Promise.all) ou retourne `found:true` avec
  // un `status` dégradé. Donc `available: false` n'est jamais un masquage de
  // panne ; c'est une absence réelle de candidat. On l'encapsule pour ne pas
  // perdre le signal au lieu d'écraser silencieusement.
  const historique: InspectSiteHistoriqueSection = buildHistoriqueSection(
    historiqueLookup,
    input.historiqueDetail !== false,
  );

  return lookupFound<InspectSiteResult>({
    num_finess: trimmed,
    finess: verifierLookup.finess,
    statut_site: {
      verdict_site: verifierLookup.verdict_site,
      verdict_groupe: verifierLookup.verdict_groupe,
      best_match_siret: verifierLookup.best_match?.siret ?? null,
      best_match_score_adresse: verifierLookup.best_match?.score_adresse ?? null,
      sirens_explored: verifierLookup.sirens_explored,
      candidates_count: verifierLookup.candidates.length,
      explication: verifierLookup.explication,
      dinum_errors: verifierLookup.dinum_errors,
    },
    professionnels: {
      count: rpps.count,
      truncated: rpps.truncated,
      sample: rpps.results,
    },
    historique,
    sources: {
      etablissement: SOURCE_LABELS.finess,
      statut: `${SOURCE_LABELS.dinum} + ${SOURCE_LABELS.insee_sirene}`,
      professionnels: SOURCE_LABELS.rpps,
      historique: SOURCE_LABELS.insee_sirene,
    },
  });
}

function clampRppsLimit(raw: number | undefined): number {
  if (raw === undefined) return RPPS_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < RPPS_LIMIT_MIN || raw > RPPS_LIMIT_MAX) {
    throw new RangeError(
      `inspect_site: rppsLimit doit être un entier entre ${RPPS_LIMIT_MIN} et ${RPPS_LIMIT_MAX} (reçu ${raw})`,
    );
  }
  return raw;
}
