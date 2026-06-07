/**
 * Métrique de couverture FINESS DREES vs SIRENE DINUM dans un rayon géographique.
 *
 * Problème résolu : un caller LLM qui demande « combien de labos privés dans
 * 5 km autour de Charleville » obtient deux chiffres incompatibles :
 * - `etablissements_finess_in_radius` → N sites physiques FINESS (1 ligne = 1 SIRET agréé LBM)
 * - `entreprises_in_radius` → M unités légales DINUM (1 ligne = 1 SIREN, peut contenir 10 SIRET)
 *
 * Ce module expose `getCoverageFinessVsSireneInRadius` qui compare les deux
 * référentiels à périmètre équivalent : **sites physiques FINESS** vs
 * **SIRET physiques DINUM** (et NON les UL). Le champ `methodology` + `caveats[]`
 * documente honnêtement les limites pour respecter la discipline « zéro overclaim ».
 *
 * Algorithme en 6 étapes (V0.13.2 : gate NAF↔familles en couche 1/2 + couche 3) :
 * 0. **Gate NAF↔familles** : si caller ne passe pas `familles`, auto-dérive depuis
 *    le NAF cible via `nafToCompatibleFamilles` (couche 1 — corrige le ratio
 *    par défaut, sinon `finess_sites` mélangerait toutes les familles du rayon).
 *    Si caller passe `familles`, intersection avec les familles compatibles
 *    NAF + caveat sur exclusions (couche 2 — pas de silence muet sur incohérence).
 * 1. FINESS via `getFinessInRadius` (familles = scope dérivé en étape 0)
 * 2. UL DINUM via `reverseGeocode` → département → `searchEntreprises(naf, dept)`
 * 3. Pour chaque UL (cap `maxUnitesLegales`), `getEntrepriseBySiren` → SIRET actifs du NAF cible dans le rayon
 * 4. Matching FINESS↔SIRET par score Dice adresse (≥ 0.7) **+ gate NAF↔famille
 *    sur chaque pair** (couche 3 — défense en profondeur contre co-localisation
 *    type Hôpital Franco-Britannique où IFSI et labo partagent 4 rue Kléber)
 * 5. Construction du résultat avec samples (top 10 par catégorie) + methodology + caveats
 */

import { communeContainingPoint } from "../territoire/communes.js";
import { deptFromCodeInsee } from "../territoire/dept-codes.js";
import { reverseGeocode } from "../territoire/geocode.js";
import {
  buildFinessAdresseLibelle,
  diceCoefficient,
  normalizeForCompare,
} from "./address-match.js";
import { type Etablissement, getEntrepriseBySiren, searchEntreprises } from "./dinum.js";
import type { FinessFamilleQuery } from "./finess-db.js";
import { getFinessInRadius } from "./finess-db.js";
import type { FinessResult } from "./finess-db.js";
import { haversineDistance } from "./finess.js";
import { nafToCompatibleFamilles, normalizeNafCode } from "./naf-finess-mapping.js";
import type { DinumLookupError } from "./siret-resolver.js";

export type { FinessFamilleQuery } from "./finess-db.js";

const ADDRESS_MATCH_THRESHOLD = 0.7;
const SAMPLE_MAX = 10;

export interface CoverageInput {
  center: { lon: number; lat: number };
  radiusKm: number;
  /** Code NAF SIRENE à comparer (ex: "8690B" labos, "4773Z" pharmacies). */
  naf: string;
  /** Familles FINESS à inclure côté DREES (24 valeurs disponibles). */
  familles?: FinessFamilleQuery[];
  /**
   * Cap dur sur le nombre d'UL DINUM dépliées via getEntrepriseBySiren
   * (défaut 10). Au-delà, on stoppe et flagge `truncated_unites_legales: true`.
   * Borne supérieure 25 (= cap DINUM perPage).
   */
  maxUnitesLegales?: number;
}

export interface MatchedSample {
  finess: { num_finess: string; raison_sociale: string; adresse_libelle: string };
  sirene: { siret: string; raison_sociale_ul: string; adresse_libelle: string };
  score_adresse: number;
}

export interface FinessOnlySample {
  num_finess: string;
  raison_sociale: string;
  adresse_libelle: string;
}

export interface SireneOnlySample {
  siret: string;
  raison_sociale_ul: string;
  adresse_libelle: string;
}

/**
 * Statut typé pour permettre au caller LLM de router proprement sans parser
 * les caveats textuels. Le caveat reste exposé en parallèle pour lecture humaine.
 *
 *  - `computed` : calcul nominal (peut retourner finess_sites=0 sur rayon vide,
 *    mais le périmètre lui-même est valide — c'est une absence d'établissements,
 *    pas une incohérence d'input).
 *  - `scope_empty_unknown_naf` : `naf` non mappé vers une famille FINESS connue.
 *    finess_sites=0 par court-circuit — corriger le NAF ou compléter naf-finess-mapping.
 *  - `scope_empty_familles_incompatible` : caller a passé `familles` mais toutes
 *    incompatibles avec le `naf` cible. finess_sites=0 par court-circuit —
 *    réviser le couple naf/familles ou omettre `familles` pour auto-derive.
 */
export type CoverageStatus =
  | "computed"
  | "scope_empty_unknown_naf"
  | "scope_empty_familles_incompatible";

export interface CoverageResult {
  // Décomptes bruts
  /** FINESS dans le rayon (sites physiques). */
  finess_sites: number;
  /** SIRET physiques DINUM dans le rayon (post-Haversine sur etablissement.point). */
  sirene_sirets: number;
  // Intersections (approximatives)
  /** FINESS qui ne trouvent aucun SIRET DINUM avec adresse Dice ≥ 0.7 (best-effort). */
  finess_only_count: number;
  /** SIRET DINUM qui ne matchent aucun FINESS dans le rayon (best-effort). */
  sirene_only_count: number;
  /** Couples FINESS↔SIRET avec adresse Dice ≥ 0.7. */
  matched_count: number;
  /**
   * finess_sites / sirene_sirets, ou null si sirene_sirets===0.
   * 1.0 = parité parfaite, > 1 = sur-déclaration FINESS, < 1 = sous-déclaration DREES.
   */
  coverage_ratio: number | null;
  // Listes (cap top 10 par catégorie)
  matched_samples: MatchedSample[];
  finess_only_samples: FinessOnlySample[];
  sirene_only_samples: SireneOnlySample[];
  // Métadonnées de transparence
  /** Explication LLM-friendly de la méthodologie. */
  methodology: string;
  /** Limites identifiées. */
  caveats: string[];
  // Diagnostic
  /**
   * true si on a stoppé à maxUnitesLegales OU si searchEntreprises (DINUM) a
   * retourné un total supérieur au nombre d'UL efectivement listées (troncature
   * upstream silencieuse côté API DINUM). Le décompte sirene_sirets est alors
   * sous-estimé dans les deux cas.
   */
  truncated_unites_legales: boolean;
  /**
   * Estimation du total d'UL listées côté DINUM pour le NAF/département
   * (champ `total` de la réponse searchEntreprises). `null` si l'API DINUM
   * n'a pas retourné ce total. Permet au caller de jauger l'ampleur de la
   * troncature quand truncated_unites_legales=true.
   */
  total_unites_legales_estime: number | null;
  /** Erreurs lookup DINUM par SIREN. */
  dinum_errors: DinumLookupError[];
  /**
   * Trace de la couche 1 du gate NAF↔familles (V0.13.2) : familles dérivées
   * automatiquement du `naf` cible quand le caller n'a pas passé `familles`
   * explicitement. `null` si le caller a fourni `familles` (choix conservé).
   * Permet au caller LLM de comprendre pourquoi le scope FINESS est restreint.
   *
   * @example `naf=8690B` sans `familles` → `["labo"]`.
   * @example `naf=8610Z` sans `familles` → multi-familles hospitalières.
   * @example caller passe `familles=["labo"]` → `null`.
   */
  familles_auto_derivees: FinessFamilleQuery[] | null;
  /**
   * Trace de la couche 2 du gate NAF↔familles (V0.13.2) : familles passées par
   * le caller mais incompatibles avec le `naf` cible, donc exclues du périmètre
   * FINESS. Absent (ou tableau vide) si tout est cohérent OU si caller n'a pas
   * passé `familles`.
   *
   * @example `naf=8690B, familles=["labo","enfance_protection"]` → `["enfance_protection"]`.
   */
  familles_excluees_naf?: FinessFamilleQuery[];
  /**
   * Statut typé du calcul (toujours présent, défaut `"computed"`). Permet au
   * caller LLM de router sans parser les `caveats[]`. Le caveat reste exposé
   * en parallèle pour lecture humaine. Voir `CoverageStatus` pour la sémantique.
   */
  coverage_status: CoverageStatus;
}

/**
 * Calcule la métrique de couverture FINESS DREES vs SIRENE DINUM dans un rayon.
 */
export async function getCoverageFinessVsSireneInRadius(
  input: CoverageInput,
): Promise<CoverageResult> {
  const { center, radiusKm, naf, familles, maxUnitesLegales = 10 } = input;
  const cappedMaxUl = Math.min(Math.max(1, maxUnitesLegales), 25);

  // ── Étape 0 : Gate NAF↔familles ─────────────────────────────────────────────
  // Couche 1 (auto-derive) — Neuilly « 200 sites tous types » vs « 12 labos » :
  //   si caller n'a pas passé `familles`, on dérive du NAF cible sinon le
  //   `finess_sites` mélangerait toutes les familles co-localisées dans le rayon.
  // Couche 2 (intersection) : si caller a passé `familles`, on garde l'inter-
  //   section avec les familles compatibles NAF + caveat sur les exclues.
  // Le `nafCompatiblesSet` construit ici est aussi le gate de la couche 3
  //   (matching) en aval — un seul Set par requête sert les trois couches.
  const nafCompatibles = nafToCompatibleFamilles(naf);
  const nafCompatiblesSet = new Set<string>(nafCompatibles);
  const callerFamilles = familles && familles.length > 0 ? familles : null;
  const scopeFamilles = callerFamilles
    ? callerFamilles.filter((f) => nafCompatiblesSet.has(f))
    : [...nafCompatibles];
  const famillesExcluees = callerFamilles
    ? callerFamilles.filter((f) => !nafCompatiblesSet.has(f))
    : [];
  const famillesAutoDerivees: FinessFamilleQuery[] | null = callerFamilles
    ? null
    : [...nafCompatibles];

  const scopeCaveats: string[] = [];
  if (famillesExcluees.length > 0) {
    scopeCaveats.push(
      `Famille(s) ${famillesExcluees.join(", ")} passée(s) en input mais incompatible(s) avec le NAF ${naf} — exclue(s) du périmètre FINESS (cf. naf-finess-mapping). Couverture calculée sur scope=[${scopeFamilles.join(", ") || "(vide)"}].`,
    );
  }

  // Court-circuit : aucune famille FINESS compatible avec le NAF — appeler
  // getFinessInRadius / DINUM serait coûteux pour un ratio dénué de sens.
  if (scopeFamilles.length === 0) {
    const status: CoverageStatus = callerFamilles
      ? "scope_empty_familles_incompatible"
      : "scope_empty_unknown_naf";
    if (status === "scope_empty_unknown_naf") {
      // Qualifier le warn pour triage ops : typo de format (caller bug) vs NAF
      // valide-mais-hors-périmètre-santé (mapping à compléter).
      const qualifier = /^\d{4}[A-Z]$/.test(normalizeNafCode(naf))
        ? "NAF format valide, hors périmètre santé OU mapping à compléter"
        : "format invalide, attendu NNNNL (4 chiffres + 1 lettre)";
      console.warn(
        `[france-data-mcp] coverage: NAF ${naf} non mappé vers une famille FINESS (${qualifier}). finess_sites=0 par court-circuit.`,
      );
    }
    const reasonCaveat = callerFamilles
      ? `Aucune des familles passées (${callerFamilles.join(", ")}) n'est compatible avec le NAF ${naf}. finess_sites=0 — réviser le couple naf/familles ou omettre familles= pour auto-derive.`
      : `Le NAF ${naf} n'est pas mappé vers une famille FINESS connue (naf-finess-mapping.ts). finess_sites=0 — vérifier le code NAF ou compléter le mapping.`;
    return buildEmptyCoverageResult({
      naf,
      radiusKm,
      cappedMaxUl,
      famillesAutoDerivees,
      famillesExcluees,
      coverage_status: status,
      extraCaveats: [reasonCaveat, ...scopeCaveats],
    });
  }

  // ── Étape 1 : FINESS dans le rayon ──────────────────────────────────────────
  const finessQueryResult = await getFinessInRadius({
    center: { lat: center.lat, lon: center.lon },
    radiusKm,
    familles: scopeFamilles,
  });
  // Pre-filter par le gate NAF↔famille : garantit que `finess_sites`,
  // `finess_only_samples` et le ratio ne reflètent QUE des FINESS dont la
  // famille est compatible avec le NAF cible. Sans ce filtre, un FINESS hors
  // scope (catégorie ambiguë, ou régression du restrict côté getFinessInRadius)
  // contribuerait à `finess_only_count` comme une fausse sous-déclaration DREES
  // (cas Hôpital Franco-Britannique : l'IFSI co-localisé serait compté).
  // Le gate étant en amont, il n'a plus besoin d'être répété pair-par-pair
  // dans la boucle de matching.
  const finessRowsRaw = finessQueryResult.results;
  const finessResults: FinessResult[] = finessRowsRaw.filter((f) =>
    nafCompatiblesSet.has(f.categorie.famille),
  );
  // Observability ops : un drop > 0 signale que `getFinessInRadius` a renvoyé
  // des familles hors `scopeFamilles` malgré le restrict — régression du RPC
  // ou catégorie FINESS ambiguë. Cas attendu en prod : 0 drop.
  const droppedNafIncompatible = finessRowsRaw.length - finessResults.length;
  if (droppedNafIncompatible > 0) {
    console.warn(
      `[france-data-mcp] coverage: ${droppedNafIncompatible} FINESS row(s) ramenée(s) par getFinessInRadius mais hors scope NAF ${naf} — filtre défensif appliqué. Possible régression du restrict_familles côté RPC.`,
    );
  }

  // ── Étape 2 : UL DINUM via reverseGeocode → département ────────────────────
  let reverse: Awaited<ReturnType<typeof reverseGeocode>>;
  try {
    reverse = await reverseGeocode(center);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[france-data-mcp] coverage: reverseGeocode failed for lon=${center.lon} lat=${center.lat}: ${msg}`,
    );
    throw new Error(
      `finess_sirene_coverage_in_radius: reverseGeocode IGN a échoué (${msg}). Vérifier les coordonnées ou réessayer plus tard.`,
    );
  }

  // Même angle mort que `dynamique_immobiliere` : un point sans adresse proche
  // (site industriel isolé / littoral — ex. Orano La Hague) → reverseGeocode
  // d'ADRESSE sans codeCommune, alors que le point appartient à une commune.
  // Fallback frontières (point-dans-polygone) pour retrouver la commune → dept.
  // Seul un point réellement en mer / hors France reste sans commune (→ RangeError).
  let codeCommune = reverse?.codeCommune ?? "";
  if (!codeCommune) {
    const byBoundary = await communeContainingPoint(center);
    if (byBoundary) codeCommune = byBoundary.codeCommune;
  }

  const dept = deptFromCodeInsee(codeCommune);
  if (!dept) {
    throw new RangeError(
      `finess_sirene_coverage_in_radius: impossible de déduire le département du point lon=${center.lon} lat=${center.lat} (ni par reverseGeocode adresse, ni par frontières communales — codeCommune="${codeCommune || "absent"}", point en mer / hors France ?). Fournir les coordonnées dans une zone administrative française valide.`,
    );
  }

  const searchResult = await searchEntreprises({
    naf,
    departement: dept,
    perPage: 25,
    page: 1,
    onlyActive: false,
  });

  const allUl = searchResult.entreprises;
  // Troncature locale : on ne déplie que cappedMaxUl UL.
  // Troncature upstream : DINUM retourne total > entreprises.length quand il y a
  // plus d'UL dans le département que le perPage=25 de la 1re page. Les deux cas
  // sous-estiment sirene_sirets et doivent lever le flag.
  const truncatedLocal = allUl.length > cappedMaxUl;
  const truncatedUpstream = searchResult.total > allUl.length;
  const truncatedUl = truncatedLocal || truncatedUpstream;
  const totalUlEstime: number | null = searchResult.total ?? null;
  const ulToProcess = truncatedLocal ? allUl.slice(0, cappedMaxUl) : allUl;

  // ── Étape 3 : SIRET physiques via getEntrepriseBySiren (cap maxUnitesLegales) ─
  const dinumErrors: DinumLookupError[] = [];
  const siretInRadius: Array<{ siret: string; adresse: string; raison_sociale_ul: string }> = [];
  const radiusMeters = radiusKm * 1000;

  // Carry the SIREN inside each promise so settled results keep their siren
  // even on rejection (no risk of index drift, no fallback `unknown_idx_N`).
  const ulSettled = await Promise.allSettled(
    ulToProcess.map(async (ul) => ({
      siren: ul.siren,
      lookup: await getEntrepriseBySiren(ul.siren),
    })),
  );

  for (let i = 0; i < ulSettled.length; i++) {
    const outcome = ulSettled[i];
    if (!outcome) continue;
    // Lire le SIREN depuis outcome.value quand fulfilled (cohérent avec le
    // commentaire "carry SIREN inside the promise") ; fallback sur l'index
    // uniquement pour les rejections où outcome.value n'existe pas.
    const siren =
      outcome.status === "fulfilled" ? outcome.value.siren : (ulToProcess[i]?.siren ?? "unknown");

    if (outcome.status === "rejected") {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.error(
        `[france-data-mcp] coverage: getEntrepriseBySiren rejected for siren=${siren}: ${msg}`,
      );
      dinumErrors.push({ siren, message: msg, status: "rejected" });
      continue;
    }

    const { lookup } = outcome.value;
    if (!lookup.found) {
      console.warn(
        `[france-data-mcp] coverage: getEntrepriseBySiren not_found for siren=${siren}: ${lookup.message}`,
      );
      dinumErrors.push({
        siren,
        message: lookup.message,
        status: lookup.lookupStatus === "ambiguous" ? "ambiguous" : "not_found",
      });
      continue;
    }

    for (const etab of lookup.etablissements) {
      if (!etab.actif) continue;
      if (!etabMatchesNaf(etab, naf)) continue;
      if (!etab.point) continue;
      if (haversineDistance(center, etab.point) > radiusMeters) continue;

      siretInRadius.push({
        siret: etab.siret,
        adresse: etab.adresse ?? "",
        raison_sociale_ul: lookup.nomComplet,
      });
    }
  }

  // ── Étape 4 : Matching greedy best-first FINESS ↔ SIRET ────────────────────
  // Normalisations hoistées hors de la double boucle : O(N + M) au lieu de
  // O(N×M) appels normalizeForCompare.
  // Le filtrage famille↔NAF est déjà appliqué en amont (pre-filter étape 1) :
  // tous les `finessResults` ici sont garantis compatibles avec le NAF cible,
  // pas besoin de regater pair-par-pair.
  type ScoredPair = { finessIdx: number; siretIdx: number; score: number };
  const finessAddrNorms = finessResults.map((f) =>
    normalizeForCompare(buildFinessAdresseLibelle(f)),
  );
  const siretAddrNorms = siretInRadius.map((s) => normalizeForCompare(s.adresse));
  const scoredPairs: ScoredPair[] = [];

  for (let fi = 0; fi < finessResults.length; fi++) {
    const fAddrNorm = finessAddrNorms[fi] as string;
    for (let si = 0; si < siretInRadius.length; si++) {
      const sAddrNorm = siretAddrNorms[si] as string;
      const score = diceCoefficient(fAddrNorm, sAddrNorm);
      if (score >= ADDRESS_MATCH_THRESHOLD) {
        scoredPairs.push({ finessIdx: fi, siretIdx: si, score });
      }
    }
  }

  scoredPairs.sort((a, b) => b.score - a.score);

  const matchedFiness = new Set<number>();
  const matchedSiret = new Set<number>();
  const matchedPairs: ScoredPair[] = [];
  for (const pair of scoredPairs) {
    if (matchedFiness.has(pair.finessIdx)) continue;
    if (matchedSiret.has(pair.siretIdx)) continue;
    matchedFiness.add(pair.finessIdx);
    matchedSiret.add(pair.siretIdx);
    matchedPairs.push(pair);
  }

  // ── Étape 5 : Construction du résultat ──────────────────────────────────────
  const finess_sites = finessResults.length;
  const sirene_sirets = siretInRadius.length;
  const matched_count = matchedPairs.length;
  const finess_only_count = finess_sites - matched_count;
  const sirene_only_count = sirene_sirets - matched_count;
  const coverage_ratio = sirene_sirets > 0 ? finess_sites / sirene_sirets : null;

  type SiretInRadius = (typeof siretInRadius)[number];
  const matched_samples: MatchedSample[] = matchedPairs.slice(0, SAMPLE_MAX).map((p) => {
    const f = finessResults[p.finessIdx] as FinessResult;
    const s = siretInRadius[p.siretIdx] as SiretInRadius;
    return {
      finess: {
        num_finess: f.num_finess,
        raison_sociale: f.raison_sociale,
        adresse_libelle: buildFinessAdresseLibelle(f),
      },
      sirene: {
        siret: s.siret,
        raison_sociale_ul: s.raison_sociale_ul,
        adresse_libelle: s.adresse,
      },
      score_adresse: Number(p.score.toFixed(3)),
    };
  });

  const finess_only_samples: FinessOnlySample[] = finessResults
    .filter((_, idx) => !matchedFiness.has(idx))
    .slice(0, SAMPLE_MAX)
    .map((f) => ({
      num_finess: f.num_finess,
      raison_sociale: f.raison_sociale,
      adresse_libelle: buildFinessAdresseLibelle(f),
    }));

  const sirene_only_samples: SireneOnlySample[] = siretInRadius
    .filter((_, idx) => !matchedSiret.has(idx))
    .slice(0, SAMPLE_MAX)
    .map((s) => ({
      siret: s.siret,
      raison_sociale_ul: s.raison_sociale_ul,
      adresse_libelle: s.adresse,
    }));

  const nProcessed = ulToProcess.length;
  const methodology = buildMethodology(naf, radiusKm, cappedMaxUl);
  const baseCaveats = buildCaveats(
    truncatedUl,
    cappedMaxUl,
    nProcessed,
    totalUlEstime,
    dinumErrors,
  );
  // scopeCaveats (intersection partielle V0.13.2) en tête : c'est l'info la
  // plus structurante pour interpréter le ratio — doit être lue avant les
  // caveats généraux DREES/DINUM.
  const caveats = [...scopeCaveats, ...baseCaveats];

  const result: CoverageResult = {
    finess_sites,
    sirene_sirets,
    finess_only_count,
    sirene_only_count,
    matched_count,
    coverage_ratio,
    matched_samples,
    finess_only_samples,
    sirene_only_samples,
    methodology,
    caveats,
    truncated_unites_legales: truncatedUl,
    total_unites_legales_estime: totalUlEstime,
    dinum_errors: dinumErrors,
    familles_auto_derivees: famillesAutoDerivees,
    coverage_status: "computed",
  };
  if (famillesExcluees.length > 0) {
    result.familles_excluees_naf = famillesExcluees;
  }
  return result;
}

/**
 * Vérifie si un établissement DINUM correspond au code NAF cible. Normalise
 * les deux formats possibles ("8690B" et "86.90B") avant comparaison. Retourne
 * `false` si l'établissement n'a pas de NAF propre (on ne fait PAS de fallback
 * sur le NAF de l'UL — ce serait optimiste et générerait des faux positifs).
 */
function etabMatchesNaf(etab: Etablissement, targetNaf: string): boolean {
  if (!etab.naf) return false;
  return normalizeNafCode(etab.naf) === normalizeNafCode(targetNaf);
}

/**
 * Construit un `CoverageResult` à 0 pour les chemins de court-circuit (scope
 * FINESS vide). Factorise les 16 champs du shape pour éviter qu'un futur ajout
 * à `CoverageResult` ne soit oublié dans le path court-circuit (drift risk).
 */
function buildEmptyCoverageResult(args: {
  naf: string;
  radiusKm: number;
  cappedMaxUl: number;
  famillesAutoDerivees: FinessFamilleQuery[] | null;
  famillesExcluees: FinessFamilleQuery[];
  coverage_status: CoverageStatus;
  extraCaveats: string[];
}): CoverageResult {
  const result: CoverageResult = {
    finess_sites: 0,
    sirene_sirets: 0,
    finess_only_count: 0,
    sirene_only_count: 0,
    matched_count: 0,
    coverage_ratio: null,
    matched_samples: [],
    finess_only_samples: [],
    sirene_only_samples: [],
    methodology: buildMethodology(args.naf, args.radiusKm, args.cappedMaxUl),
    caveats: [...args.extraCaveats, ...buildCaveats(false, args.cappedMaxUl, 0, null, [])],
    truncated_unites_legales: false,
    total_unites_legales_estime: null,
    dinum_errors: [],
    familles_auto_derivees: args.famillesAutoDerivees,
    coverage_status: args.coverage_status,
  };
  if (args.famillesExcluees.length > 0) {
    result.familles_excluees_naf = args.famillesExcluees;
  }
  return result;
}

function buildMethodology(naf: string, radiusKm: number, maxUl: number): string {
  return `Compare le nombre de sites physiques FINESS (référentiel DREES, agrément LBM/pharmacie/etc.) au nombre de SIRET physiques DINUM/SIRENE actifs avec le NAF cible (${naf}) dans le rayon de ${radiusKm} km. Les correspondances FINESS↔SIRET sont établies par similarité d'adresse Dice (≥ ${ADDRESS_MATCH_THRESHOLD}). Le ratio coverage_ratio reflète à quel point la DREES capte les sites SIRENE existants (1.0 = parité parfaite, > 1 = sur-déclaration FINESS, < 1 = sous-déclaration DREES vs SIRENE). DINUM évalué via reverseGeocode → département → filtre Haversine sur les SIRET physiques (cap ${maxUl} UL).`;
}

function buildCaveats(
  truncatedUl: boolean,
  maxUl: number,
  nProcessed: number,
  totalEstime: number | null,
  dinumErrors: DinumLookupError[],
): string[] {
  const caveats: string[] = [
    "DREES a 1-2 mois de retard sur le terrain : les sites récemment ouverts peuvent manquer côté FINESS.",
    "DINUM ne ramène que les 25 premières UL du département (limite API). Si truncated_unites_legales=true, le décompte SIRENE est sous-estimé.",
    `Le matching par adresse Dice ≥ ${ADDRESS_MATCH_THRESHOLD} peut produire des faux positifs sur des sites voisins (ex: 2 labos même bâtiment) et faux négatifs sur des typos.`,
    "Les SIRET fermés sont exclus du décompte SIRENE — un FINESS encore listé sur un SIRET fermé contribuera au finess_only_count.",
  ];
  if (truncatedUl) {
    // Utiliser le total DINUM estimé quand disponible pour que le caveat soit
    // précis (ex: "25 traitées sur 100 listées") plutôt que vague ("25+").
    const totalLabel = totalEstime !== null ? String(totalEstime) : `${maxUl}+`;
    caveats.push(
      `Seules ${nProcessed} UL DINUM traitées sur ${totalLabel} listées dans le département (limite API DINUM 25 par page). Le décompte sirene_sirets est probablement sous-estimé.`,
    );
  }
  if (dinumErrors.length > 0) {
    caveats.push(
      `${dinumErrors.length} SIREN n'a/ont pas pu être résolu(s) côté DINUM — voir dinum_errors. Le décompte sirene_sirets exclut leurs SIRET, le ratio peut être biaisé.`,
    );
  }
  return caveats;
}
