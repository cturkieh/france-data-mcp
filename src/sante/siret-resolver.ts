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

import { haversineMeters } from "../core/geo-distance.js";
import type { Coordinates } from "../core/types.js";
import { getUntypedAnonClient } from "../storage/supabase.js";
import {
  buildFinessAdresseLibelle,
  diceCoefficient,
  normalizeForCompare,
} from "./address-match.js";
import { type Etablissement, getEntrepriseBySiren, searchEntreprises } from "./dinum.js";
import type { FinessResult } from "./finess-db.js";
import { lookupSiretsBySirenViaInsee } from "./insee-sirene.js";
import { isNafCompatibleWithFamille, nafsForFamille } from "./naf-finess-mapping.js";

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
 * - `config_missing` : clé d'API absente (ex: `INSEE_SIRENE_API_KEY` non définie).
 *   Distingué de `not_found` car ce n'est pas une absence de donnée côté SIRENE
 *   mais un problème de configuration serveur. Le caller peut filtrer ces entrées
 *   pour ne pas les comptabiliser comme "SIREN absent SIRENE".
 * - `enrichment_failed` : DINUM a répondu mais l'enrichissement multi-sites
 *   (second appel) a échoué (`enrichmentStatus: "failed"`). Le siège seul est
 *   listé alors que `nombreEtablissements > 1`. Distinct de `rejected` (premier
 *   appel KO) car le caller peut retry uniquement le second appel. Retry justifié.
 */
export type DinumLookupError = {
  siren: string;
  message: string;
  status: "rejected" | "not_found" | "ambiguous" | "config_missing" | "enrichment_failed";
};

/**
 * Méthode de résolution effective qui a permis de produire le résultat. Sert
 * de signal de traçabilité pour le caller LLM (Resolver V2).
 *
 * - `rpps` : cas nominal V0.7.0 — RPPS a fourni ≥ 1 SIRET, DINUM a enrichi,
 *   au moins un candidat matche l'adresse FINESS. **Pas de fallback déclenché.**
 * - `address_fallback` : RPPS n'a fourni aucun SIRET exploitable (vide ou tous
 *   sentinelle/malformés). Le resolver est passé en fallback géographique
 *   (DINUM `/near_point`) filtré par NAF compatible avec la famille FINESS.
 * - `mixed` : RPPS a fourni des SIRET ET le fallback a été déclenché aussi
 *   (parce qu'aucun candidat RPPS ne matchait l'adresse FINESS, et que DINUM
 *   a répondu sans erreur). Les candidats finaux mélangent les 2 sources.
 */
export type ResolutionMethod = "rpps" | "address_fallback" | "mixed";

/**
 * Pourquoi le fallback géographique a été déclenché. `null` si la méthode est
 * `"rpps"` (cas nominal, pas de fallback). Sert au caller LLM à comprendre
 * la nature du fallback (et au futur audit prod).
 *
 * - `no_rpps` : aucun SIRET trouvé côté RPPS (table vide pour ce num_finess
 *   ou tous SIRET filtrés par les sentinelles `finess_unmatched` / malformés).
 * - `no_best_match_with_clean_dinum` : RPPS a fourni des SIRET, DINUM a
 *   répondu sans erreur, mais aucun candidat n'atteint le seuil d'adresse
 *   (`score_adresse >= 0.6`). Cas typique : PS a déclaré le siège HQ d'un
 *   groupe distant du site physique.
 * - `no_naf_mapping_for_famille` : un fallback ALLAIT être tenté mais la
 *   famille FINESS source n'a aucun NAF compatible mappé (cf.
 *   `DELIBERATELY_NO_NAF` ou famille `autre`). Skip silencieux — préserve le
 *   garde-fou Franco-Britannique (mieux vaut pas de fallback qu'un mauvais
 *   match). Le `method` reste `"rpps"` dans ce cas, et seul `fallback_reason`
 *   est renseigné pour permettre l'audit.
 * - `no_finess_coords` : tenté mais impossible — le FINESS source n'a pas
 *   de coordonnées (`finess.coords === null`). Survient pour les structures
 *   très anciennes / non géoréférencées par DREES, ou pour les ingestions
 *   FINESS où le Lambert93 n'a pas pu être reprojeté. Skip silencieux.
 * - `best_match_ferme` : le pivot RPPS a bien produit un `best_match`, mais
 *   il est FERMÉ. Le fallback géo a été déclenché pour chercher un repreneur
 *   actif co-localisé (succession / M&A) — V0.16. Distinct de
 *   `no_best_match_with_clean_dinum` : ici il y a un best_match, juste fermé.
 */
export type FallbackReason =
  | "no_rpps"
  | "no_best_match_with_clean_dinum"
  | "no_naf_mapping_for_famille"
  | "no_finess_coords"
  | "best_match_ferme"
  | null;

/**
 * Statut de désambiguïsation après application du gate NAF + signal RPPS.
 * Décrit ce qui est arrivé quand le fallback géo a ramené > 1 candidat (ou,
 * pour `not_applicable`, qu'il n'a même pas été déclenché).
 *
 * - `not_applicable` : pas de fallback déclenché (method === `"rpps"`) OU
 *   fallback déclenché mais 0 candidat retenu après gate NAF. Le caller ne
 *   doit pas interpréter ce statut comme une qualité de match.
 * - `single_after_gate` : 1 seul candidat après gate d'activité ET gate
 *   adresse (`score_adresse >= BEST_MATCH_THRESHOLD`, V0.13.1) — pas
 *   d'ambiguïté à arbitrer. **Note V0.13.1** : si le fallback ramène N
 *   candidats dont N-1 sont hors-périmètre adresse (cas EYLAU prod), ils
 *   sont écartés du best_match (mais restent dans `candidates[]` pour audit).
 * - `by_name_score` : > 1 candidat après gate, départage par disqualification
 *   d'au moins 1 candidat dont le score nom est trop faible (`< NAME_DISQUALIFY_THRESHOLD`).
 *   **V0.13.1 (Raffinement #2)** : permet d'écarter un candidat hors-sujet
 *   (cas type CHOUAIEB sur FINESS EYLAU) que le gate NAF seul ne peut éliminer.
 * - `by_active_succession` : > 1 candidat après gate, tous appartiennent au
 *   MÊME SIREN à la MÊME adresse, ≥ 1 actif → on retient le SIRET actif.
 *   **V0.13.1 (Raffinement #3)** : succession temporelle de SIRET (l'un fermé,
 *   un nouveau ouvert) — pas une ambiguïté d'entreprise, juste une réorganisation
 *   administrative. Cas type FINESS 920028487 EYLAU UNILABS (SIRET ...070 fermé +
 *   SIRET ...419 ouvert 2025-09-08, même SIREN 784652026, même adresse).
 * - `by_rpps_signal` : > 1 candidat après gate, départage par présence d'un
 *   SIRET côté RPPS (le PS l'avait déclaré → signal de confiance).
 * - `ambiguous` : > 1 candidat ex-aequo après gate ET signal RPPS épuisé.
 *   `best_match` est `null` et le caller doit cross-checker manuellement —
 *   les candidats sont exposés dans `candidates[]` avec leur scoring complet.
 */
export type DisambiguationStatus =
  | "not_applicable"
  | "single_after_gate"
  | "by_name_score"
  | "by_active_succession"
  | "by_rpps_signal"
  | "ambiguous";

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
   * Distance géodésique en mètres entre les coordonnées FINESS et le point GPS
   * SIRENE/DINUM de cet établissement (haversine). `null` quand le point GPS du
   * SIRET est absent (origine RPPS pure, fallback INSEE sans coords) ou que le
   * FINESS lui-même n'a pas de coordonnées.
   *
   * **V0.16** — juge de co-localisation « même bâtiment » (cf. `COLOCATION_RADIUS_M`).
   * Renseigné pour les candidats passés par le fallback géo `/near_point` (qui
   * fournit toujours `point`). Plus fiable que `score_adresse` pour trancher
   * « même site » : le Dice textuel ne discrimine pas le numéro de voie.
   */
  distance_finess_m: number | null;
  /**
   * Score Sørensen-Dice 0..1 entre la raison sociale FINESS et la raison sociale
   * de l'unité légale côté SIRENE/DINUM (`raison_sociale_ul`). `null` quand
   * `raison_sociale_ul` est absent (RPPS-only sans cross-vérification DINUM).
   *
   * **V0.13.1 — sous-score nom (Raffinement #2)** : permet d'écarter les
   * candidats hors-sujet quand le scoring d'adresse seul est insuffisant — cas
   * type : FINESS 920028487 EYLAU labo Victor Hugo. Le fallback géo ramène le
   * SIRET CHOUAIEB (PMA voisine, score adresse identique à 0.9) que le gate NAF
   * ne peut éliminer (NAF 8690B compatible). Le score nom (~0.04 vs ~0.97 pour
   * EYLAU UNILABS) permet de le disqualifier dans la désambiguïsation.
   *
   * Exposé pour audit/traçabilité — pas utilisé comme critère principal du
   * `best_match` (qui reste piloté par `score_adresse`), mais comme tie-breaker
   * et comme gate de disqualification dans `tryAddressFallback`.
   */
  score_nom: number | null;
  /**
   * État administratif SIRENE de l'établissement (champ DINUM `actif`).
   * `null` quand le SIRET vient uniquement de RPPS et n'a pas été cross-vérifié.
   */
  actif: boolean | null;
  /** Adresse libellée (depuis DINUM). `null` si origine RPPS pure. */
  adresse_libelle: string | null;
  /** Date de création (depuis DINUM). `null` si origine RPPS pure. */
  date_creation: string | null;
  /**
   * Raison sociale de l'unité légale parente (DINUM `nomComplet`, ou
   * `raisonSocialeUniteLegale` côté fallback INSEE). `null` quand le candidat
   * vient uniquement de RPPS sans cross-vérification DINUM (lookup SIREN
   * non tenté ou échoué).
   *
   * Utilisé par `reconcilierFinessSirene` (Fix P2.3) pour éviter des appels
   * INSEE redondants : quand ce champ est non-null, la raison sociale est déjà
   * disponible sans nouvel appel à `/siret/{siret}`.
   */
  raison_sociale_ul: string | null;
}

/**
 * Trace de succession d'exploitants sur un site (V0.16). Quand le `best_match`
 * d'une résolution est un SIRET actif co-localisé avec un ou plusieurs SIRET
 * fermés, le site a probablement changé d'exploitant (réorganisation interne,
 * déménagement, rachat / M&A).
 *
 * Fait BRUT exposé au caller (Geo Intel) : le resolver ne qualifie PAS la
 * succession de « rachat ». Co-localisation + chronologie de SIRET ≠ preuve
 * juridique de cession. Le caller croise avec sa connaissance des enseignes.
 */
export interface SiteSuccession {
  /**
   * `true` quand `best_match` est actif ET ≥ 1 SIRET fermé est co-localisé
   * avec lui (distance géo ≤ `COLOCATION_RADIUS_M`). Signale un site repris.
   */
  detected: boolean;
  /**
   * SIRET fermés co-localisés avec le `best_match` — les exploitants précédents
   * du site, triés par `date_creation` décroissante. Les SIRET sans
   * `date_creation` sont placés en fin, ordonnés par SIRET croissant (ordre
   * déterministe — l'absence de date n'est PAS comblée par une valeur
   * inventée). Vide quand `detected` est `false`.
   */
  exploitants_precedents: SiretCandidate[];
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
  /**
   * Méthode effective de résolution. **Resolver V2 (V0.13.0)** : permet au
   * caller LLM de savoir si le SIRET retourné vient du pivot RPPS classique
   * (V0.7) ou du fallback géographique introduit en V0.13.
   *
   * Pour rétrocompatibilité avant V0.13 : la valeur `"rpps"` est strictement
   * équivalente au comportement V0.7 (jamais de fallback déclenché).
   */
  method: ResolutionMethod;
  /**
   * Pourquoi le fallback a été déclenché (ou skippé). `null` si pas de
   * fallback envisagé (`method === "rpps"` et best_match trouvé directement).
   * Cf. `FallbackReason` pour les 3 cas distingués.
   *
   * Notamment : `"no_naf_mapping_for_famille"` peut être renseigné AVEC un
   * `method === "rpps"` — c'est le skip silencieux du fallback pour
   * `DELIBERATELY_NO_NAF` / famille `autre`. Ce cas garantit le garde-fou
   * Franco-Britannique : pas de fallback ≠ pas d'amélioration possible.
   */
  fallback_reason: FallbackReason;
  /**
   * Liste des NAF effectivement passés à DINUM `/near_point` côté fallback
   * géographique. Vide tableau si pas de fallback déclenché.
   *
   * Exposé pour audit + observabilité prod (savoir quels NAF ont été cherchés
   * permet de mesurer combien de cas le mapping `naf-finess-mapping.ts` aurait
   * besoin d'élargir/resserrer).
   */
  naf_filter_used: string[];
  /**
   * Statut de désambiguïsation après gate d'activité + signal RPPS. Cf.
   * `DisambiguationStatus`. La valeur `"ambiguous"` signale au caller que
   * plusieurs candidats matchent les critères et qu'`best_match` est `null` :
   * une intervention manuelle est requise pour trancher.
   */
  disambiguation_status: DisambiguationStatus;
  /**
   * Trace de succession d'exploitants sur le site (V0.16). `detected: true`
   * quand le `best_match` est un SIRET actif co-localisé avec ≥ 1 SIRET fermé.
   * Fait brut pour le caller (Geo Intel) — cf. `SiteSuccession`.
   */
  succession: SiteSuccession;
}

/** Seuil au-dessus duquel un score d'adresse Dice est considéré comme un match physique du site. */
const BEST_MATCH_THRESHOLD = 0.6;

/**
 * Rayon de co-localisation « même bâtiment » en mètres (V0.16 — fix succession
 * M&A). Deux établissements SIRENE dont les points GPS sont à ≤ `COLOCATION_RADIUS_M`
 * des coordonnées FINESS sont considérés sur LE MÊME site physique.
 *
 * **Valeur 100 m** (V0.16.1, recalibrée prod 2026-05-29 — cf.
 * `docs/plans/verifier-site-actif-succession-fix.md` § recalibrage). La valeur
 * initiale 50 m produisait des FAUX NÉGATIFS de succession M&A : le géocodage
 * DREES (Lambert93, souvent grossier) place le point FINESS à plusieurs dizaines
 * de mètres du point BAN de l'adresse — décalage PARTAGÉ par tous les SIRET de
 * cette adresse. Deux repreneurs réels mesurés à 52,1 m (Cerballiance Aulnay) et
 * 96,6 m (EYLAU Courbevoie), à la distance IDENTIQUE de leur ancien exploitant
 * (même adresse) → tous deux écartés à 50 m. 100 m couvre ces décalages tout en
 * restant sous le voisin-piège testé à ~110 m (autre numéro de voie). Le faux
 * positif inverse que ce rayon élargi pourrait ouvrir (voisin actif d'un autre
 * bâtiment) est neutralisé par la bande RELATIVE `COLOCATION_SAME_SITE_TOLERANCE_M`.
 *
 * Pourquoi la distance géo et pas le score d'adresse Dice : le Dice ne
 * discrimine PAS le numéro de voie (prouvé prod — un voisin au n°48 d'une
 * avenue score 0,90 contre le n°85 du FINESS). La distance GPS est le seul
 * juge fiable de « même site ».
 */
const COLOCATION_RADIUS_M = 100;

/**
 * Tolérance de distance, en mètres, de la bande « même site » (V0.16.1). Au sein
 * des candidats co-localisés (≤ `COLOCATION_RADIUS_M`), seuls ceux à `≤
 * min(distance) + COLOCATION_SAME_SITE_TOLERANCE_M` sont considérés comme occupant
 * le même bâtiment que le FINESS. Au-delà = adresse voisine.
 *
 * **Garde-fou faux positif inverse au rayon élargi.** Le passage de 50 → 100 m
 * (fix succession M&A V0.16.1, cf. `docs/plans/verifier-site-actif-succession-fix.md`)
 * ramène désormais dans le rayon des voisins d'une AUTRE adresse (numéro de voie
 * distinct, géocodés à un point BAN différent). Sans cette bande, un voisin actif
 * du même métier promouvrait un verdict « actif » sur un site réellement fermé
 * (prouvé : test garde-fou `cross-source.test.ts` voisin 80 m / prédécesseur 30 m).
 *
 * **Valeur 30 m** : les SIRET d'une MÊME adresse partagent le même point géocodé
 * (prouvé prod 2026-05-29 — Cerballiance Aulnay et EYLAU Courbevoie : repreneur
 * actif et ancien fermé ressortent à la distance IDENTIQUE du FINESS, 52,1 m resp.
 * 96,6 m). 30 m absorbe le bruit de géocodage intra-adresse résiduel sans englober
 * une adresse voisine. NE PAS confondre avec `COLOCATION_RADIUS_M` (gate absolu) :
 * la bande est RELATIVE au candidat le plus proche.
 */
const COLOCATION_SAME_SITE_TOLERANCE_M = 30;

/**
 * Un candidat n'est éligible best_match que si son `score_adresse` atteint
 * `BEST_MATCH_THRESHOLD`. `null` (donnée manquante côté DINUM/INSEE) n'est
 * PAS un candidat valide pour best_match — mais il reste exposé dans
 * `candidates[]` pour audit caller.
 *
 * **V0.13.1** : factorise les 3 call-sites historiques de ce gate :
 * (1) `resolveSiretsForFiness` ligne ~510 (chemin RPPS direct, `bestMatch`
 * initial), (2) `disambiguateFallbackCandidates` étape 0 (gate adresse
 * fallback prod-validé sur FINESS 920028487), et (3) implicitement
 * `mergeOrInsertDinumCandidate` qui n'insère un nouveau candidat DINUM que
 * sous ce seuil. Centraliser le predicat évite que les 3 sites divergent
 * silencieusement si on ajuste le seuil ou la sémantique `null`.
 */
function meetsBestMatchAddressGate(c: { score_adresse: number | null }): boolean {
  return c.score_adresse !== null && c.score_adresse >= BEST_MATCH_THRESHOLD;
}

/**
 * Seuil sous lequel un candidat est disqualifié par son score nom dans le
 * fallback géographique (Raffinement #2 V0.13.1). Très bas (0.2) à dessein :
 *
 * - `> 0.2` : ne disqualifie pas un candidat dont le nom ressemble, même de
 *   loin, au libellé FINESS.
 * - `< 0.2` : élimine les co-locataires NAF-compatibles dont la raison sociale
 *   n'a aucun rapport (cas type CHOUAIEB 0.04 sur EYLAU labo Victor Hugo).
 *
 * **V0.16** : le name filter s'applique APRÈS l'étape « actif prime » de
 * `disambiguateFallbackCandidates` — il ne départage donc plus que des
 * candidats de même statut d'activité et ne peut PLUS écarter un repreneur
 * actif au profit d'un ancien exploitant fermé. L'hypothèse pré-V0.16 « un
 * M&A est protégé par le chemin RPPS, le fallback n'est pas déclenché » était
 * FAUSSE — réfutée prod (Neuilly Sablons / Pont de Neuilly : RPPS vide ⇒
 * fallback déclenché ⇒ name filter actif sur le repreneur).
 *
 * Appliqué UNIQUEMENT dans `tryAddressFallback` (fallback géo) — jamais sur le
 * chemin RPPS direct où le signal métier "le PS a déclaré ce SIRET" prime sur
 * tout scoring textuel. Un candidat avec `score_nom === null` (raison_sociale_ul
 * absente) n'est PAS disqualifié : l'absence de donnée ne doit pas écarter un
 * candidat légitime ramené par le gate NAF.
 */
const NAME_DISQUALIFY_THRESHOLD = 0.2;

/**
 * Rayon du fallback géographique (DINUM `/near_point`) en kilomètres.
 *
 * **Valeur 0.150 km (150 m)** verrouillée par le cadrage Resolver V2 (Q2) :
 * couvre la variance d'adressage SIRENE↔FINESS (numéro de voie, abréviation
 * de type, géocodage Lambert93 vs WGS84) sans embarquer le voisinage immédiat
 * (immeubles adjacents = entités économiques distinctes). Ajustable plus tard
 * selon monitoring des `ambiguous` en prod.
 */
const FALLBACK_RADIUS_KM = 0.15;

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
  // V0.13 Resolver V2 : pas d'early return ici. Si RPPS est vide, la cascade
  // DINUM (boucle vide → no-op) est court-circuitée naturellement, et le
  // bloc fallback géographique en aval prend le relais — préservant le
  // chemin causal `fallback_reason: "no_rpps"` exposé au caller LLM.

  // Dérive les SIREN distincts depuis les SIRET RPPS (9 premiers chars).
  // Set pour dédupliquer : un SIREN peut avoir plusieurs SIRET RPPS-déclarés.
  // Vide si rppsSirets vide → pas d'appel DINUM dans la branche V0.7.
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
  // V0.13.1 (Raffinement #2) : même hoist pour la raison sociale FINESS. Sert
  // au calcul du `score_nom` dans `mergeOrInsertDinumCandidate` et au gate
  // nom du fallback géo.
  const finessNomNorm = normalizeForCompare(finess.raison_sociale);
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
      distance_finess_m: null,
      score_nom: null,
      actif: null,
      adresse_libelle: null,
      date_creation: null,
      raison_sociale_ul: null,
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
      mergeOrInsertDinumCandidate(
        candidates,
        etab,
        finessAddrNorm,
        finessNomNorm,
        lookup.nomComplet,
      );
    }
  }

  // === Fallback INSEE pour les SIREN DINUM partial/failed ===================
  //
  // DINUM retourne `enrichmentStatus: "partial"` pour les SIREN multi-sites
  // (≥ ~20 établissements, ex: Biogroup Nord SIREN 507815942 = 38 sites) et ne
  // liste QUE le siège. Conséquence : les SIRET fermés (ex: 50781594200218
  // Bd Bizet, fermé 2024-02-16) sont invisibles, et `verifier_site_actif`
  // répond `indetermine` au lieu de `ferme`. Le fallback INSEE corrige ça.
  //
  // On identifie les SIREN à fallbacker : ceux dont le lookup DINUM a réussi
  // (found:true) et avec enrichmentStatus === "partial" (DINUM multi-sites
  // tronqué, liste incomplète). Restreint à "partial" uniquement :
  // - "failed" = second appel DINUM en panne transitoire. Déclencher INSEE
  //   dans ce cas serait inutile (le manque est une panne, pas une troncature
  //   structurelle) ET coûteux (rate limit INSEE 30/min). En revanche on
  //   pousse une entrée `enrichment_failed` dans `dinum_errors` pour ne pas
  //   laisser le caller croire que le siège est la liste complète.
  // - "success" = liste complète, "not_attempted" = monosite, undefined = non
  //   renseigné par certains callers de test → aucun appel supplémentaire.
  const sirensNeedingInseeRefinement: string[] = [];
  for (let i = 0; i < dinumResults.length; i++) {
    const settled = dinumResults[i] as PromiseSettledResult<{
      siren: string;
      lookup: Awaited<ReturnType<typeof getEntrepriseBySiren>>;
    }>;
    if (settled.status !== "fulfilled" || !settled.value.lookup.found) continue;
    if (settled.value.lookup.enrichmentStatus === "partial") {
      sirensNeedingInseeRefinement.push(settled.value.siren);
    } else if (settled.value.lookup.enrichmentStatus === "failed") {
      // Signal visible au caller : DINUM a paniqué sur le second appel, le
      // siège seul est listé. Pas de fallback INSEE (rate limit) mais retry
      // justifié — d'où le status "enrichment_failed" distinct de "rejected".
      const warning =
        settled.value.lookup.enrichmentWarning ?? "DINUM enrichment failed (no warning provided)";
      console.warn(
        `[france-data-mcp] siret-resolver: DINUM enrichment_failed for siren=${settled.value.siren}: ${warning}`,
      );
      dinumErrors.push({
        siren: settled.value.siren,
        message: `DINUM enrichment failed (siège seul listé) : ${warning}`,
        status: "enrichment_failed",
      });
    }
  }

  if (sirensNeedingInseeRefinement.length > 0) {
    const inseeResults = await Promise.allSettled(
      sirensNeedingInseeRefinement.map((siren) => lookupSiretsBySirenViaInsee(siren)),
    );

    for (let i = 0; i < inseeResults.length; i++) {
      const settled = inseeResults[i];
      const siren = sirensNeedingInseeRefinement[i] as string;
      if (!settled) continue;

      if (settled.status === "rejected") {
        const msg =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        console.error(
          `[france-data-mcp] siret-resolver: INSEE fallback rejected for siren=${siren}: ${msg}`,
        );
        dinumErrors.push({
          siren,
          message: `insee_fallback error: ${msg}`,
          status: "rejected",
        });
        continue;
      }

      const result = settled.value;
      if (!result.found) {
        // Distinguer "clé absente" (config_missing) de "SIREN vraiment absent SIRENE"
        // (not_found) : le caller peut filtrer config_missing sans comptabiliser
        // ces entrées comme preuve d'un SIREN inexistant.
        const isConfigMissing = result.message.includes("INSEE_SIRENE_API_KEY non configurée");
        const errorStatus: DinumLookupError["status"] = isConfigMissing
          ? "config_missing"
          : "not_found";
        console.warn(
          `[france-data-mcp] siret-resolver: INSEE fallback ${errorStatus} for siren=${siren}: ${result.message}`,
        );
        dinumErrors.push({
          siren,
          message: `insee_fallback not_found: ${result.message}`,
          status: errorStatus,
        });
        continue;
      }

      // `raisonSocialeUniteLegale` est déjà dérivé par INSEE → passé comme nomComplet.
      for (const etabSirene of result.etablissements) {
        mergeOrInsertDinumCandidate(
          candidates,
          {
            siret: etabSirene.siret,
            adresse: etabSirene.adresse.libelle,
            actif: etabSirene.actif,
            dateCreation: etabSirene.dateCreation ?? undefined,
          },
          finessAddrNorm,
          finessNomNorm,
          etabSirene.raisonSocialeUniteLegale,
        );
      }
    }
  }

  const sortedBeforeFallback = [...candidates.values()].sort(compareByScoreDesc);
  const topBeforeFallback = sortedBeforeFallback[0];
  let bestMatch =
    topBeforeFallback && meetsBestMatchAddressGate(topBeforeFallback) ? topBeforeFallback : null;

  // === Resolver V2 — fallback géographique conditionnel ====================
  //
  // On déclenche le fallback /near_point si :
  //   (1) best_match === null (rien de bon côté RPPS+DINUM cascade), OU
  //       best_match.actif === false (L1 V0.16 — best_match fermé : on cherche
  //       un repreneur actif co-localisé, cf. fix succession M&A) ;
  //   (2) dinum_errors.length === 0 (DINUM a répondu sans erreur — on est sûr
  //       que l'absence est réelle, pas une panne transitoire).
  //
  // Sinon : pas de fallback. Préserve la sémantique "on n'invente pas de
  // candidats quand DINUM est en panne" — laissera le caller retry.
  //
  // Sirens explorés mutable car le fallback peut en ajouter (SIREN nouveau).
  const sirensExploredMutable = [...sirensDistincts];
  let method: ResolutionMethod = "rpps";
  let fallbackReason: FallbackReason = null;
  let nafFilterUsed: string[] = [];
  let disambiguationStatus: DisambiguationStatus = "not_applicable";

  if ((bestMatch === null || bestMatch.actif === false) && dinumErrors.length === 0) {
    const outcome = await tryAddressFallback({
      finess,
      triggeredByClosedBestMatch: bestMatch !== null,
      rppsSirets,
      finessAddrNorm,
      finessNomNorm,
      candidates,
      sirensExplored: sirensExploredMutable,
      sirensActif,
      dinumErrors,
    });
    method = outcome.method;
    fallbackReason = outcome.fallback_reason;
    nafFilterUsed = outcome.naf_filter_used;
    disambiguationStatus = outcome.disambiguation_status;
    if (outcome.best_match) bestMatch = outcome.best_match;
  }

  // Re-tri final : nécessaire car le fallback peut avoir muté `candidates`
  // (nouveaux SIRET, scores updated). Si pas de fallback, sortedBeforeFallback
  // était déjà bon — mais ce re-tri est idempotent et négligeable en coût.
  const sorted = [...candidates.values()].sort(compareByScoreDesc);

  return {
    candidates: sorted,
    best_match: bestMatch,
    sirens_explored: sirensExploredMutable,
    sirens_actif: sirensActif,
    dinum_errors: dinumErrors,
    method,
    fallback_reason: fallbackReason,
    naf_filter_used: nafFilterUsed,
    disambiguation_status: disambiguationStatus,
    succession: buildSuccession(bestMatch, sorted),
  };
}

/**
 * Dérive la trace de succession d'exploitants d'un site (V0.16). Une succession
 * est « détectée » quand le `best_match` retenu est un SIRET ACTIF et qu'au
 * moins un SIRET FERMÉ est co-localisé avec lui — l'ancien exploitant du site.
 *
 * Le prédicat est `sameSiteBand` appliqué au pool **address-gaté** (V0.16.1) —
 * STRICTEMENT le même filtre composite que l'arbitrage du best_match
 * (`disambiguateFallbackCandidates` : `meetsBestMatchAddressGate` PUIS `sameSiteBand`).
 * Crucial depuis le rayon 100 m sur les DEUX axes :
 * - `sameSiteBand` (vs `isColocated` ≤ 100 m brut) écarte un voisin fermé d'une
 *   AUTRE adresse (50-100 m, hors bande) que l'arbitrage vient d'écarter — sinon
 *   le faux positif inverse rouvre côté succession.
 * - le gate adresse (vs `allCandidates` brut) évite qu'un candidat co-localisé
 *   recalé par le gate (score_adresse < 0.6) mais GPS-proche fausse le `minDist`
 *   de la bande — il abaisserait la fenêtre et POURRAIT dropper un prédécesseur
 *   légitime / en faire entrer un autre. Aligner l'ensemble d'entrée garantit que
 *   `succession` reflète exactement le pool qui a produit le best_match.
 * Un fermé sans `distance_finess_m` n'entre pas dans la bande (on n'invente pas
 * une co-localisation que Geo Intel interprétera).
 */
function buildSuccession(
  bestMatch: SiretCandidate | null,
  allCandidates: SiretCandidate[],
): SiteSuccession {
  if (!bestMatch || bestMatch.actif !== true) {
    return { detected: false, exploitants_precedents: [] };
  }
  const exploitantsPrecedents = sameSiteBand(allCandidates.filter(meetsBestMatchAddressGate))
    .filter((c) => c.siret !== bestMatch.siret && c.actif === false)
    .sort((a, b) => {
      // Tri chronologique décroissant ; tie-break SIRET ascendant pour un ordre
      // DÉTERMINISTE quand `date_creation` est absente — l'absence de date n'est
      // pas comblée par une valeur inventée, juste ordonnée stablement.
      const dateDiff = (b.date_creation ?? "").localeCompare(a.date_creation ?? "");
      return dateDiff !== 0 ? dateDiff : a.siret.localeCompare(b.siret);
    });
  return {
    detected: exploitantsPrecedents.length > 0,
    exploitants_precedents: exploitantsPrecedents,
  };
}

/**
 * Tri primaire des candidats SIRET.
 *
 * 1. `score_adresse` décroissant ; les `null` en queue (donnée incomplète).
 * 2. **Tie-breaker V0.13.1** : si `score_adresse` est ex-aequo (même bâtiment),
 *    `score_nom` décroissant prime — un candidat dont le nom matche le libellé
 *    FINESS doit remonter au-dessus d'un co-locataire NAF-compatible sans lien
 *    nom. Pas appliqué comme disqualifier global (cf. `NAME_DISQUALIFY_THRESHOLD`
 *    réservé au fallback) — juste comme ordre stable. Les `null` en queue.
 * 3. Dernier tie-break déterministe : SIRET ascendant (utile pour les snapshots
 *    de tests qui s'appuient sur l'ordre quand 2 scores sont strictement égaux).
 */
function compareByScoreDesc(a: SiretCandidate, b: SiretCandidate): number {
  const adresseDiff = compareNullableDesc(a.score_adresse, b.score_adresse);
  if (adresseDiff !== 0) return adresseDiff;
  const nomDiff = compareNullableDesc(a.score_nom, b.score_nom);
  if (nomDiff !== 0) return nomDiff;
  return a.siret.localeCompare(b.siret);
}

/** Tri descendant tolérant aux `null` (en queue). 0 si égalité ou les 2 null. */
function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Calcule le score Dice nom FINESS ↔ raison sociale UL. Retourne `null` si
 * `nomComplet` est absent — l'absence ne disqualifie pas un candidat (cf.
 * `NAME_DISQUALIFY_THRESHOLD`). Factorise les 2 sites de calcul historiques
 * (`mergeOrInsertDinumCandidate` + bloc d'injection des candidats fallback)
 * pour garantir que la règle « pas de nomComplet → pas de score » ne dérive pas.
 */
function computeNameScore(finessNomNorm: string, nomComplet: string | null): number | null {
  return nomComplet ? diceCoefficient(finessNomNorm, normalizeForCompare(nomComplet)) : null;
}

/**
 * Merge un établissement DINUM (ou fallback INSEE) dans la map des candidats.
 * Trois branches :
 *
 * 1. SIRET déjà seedé via RPPS → enrichit les champs DINUM. Ajoute
 *    `dinum_address_match` aux sources UNIQUEMENT si l'adresse matche réellement,
 *    sinon le SIRET du siège RPPS (qui partage le SIREN mais pas l'adresse)
 *    serait toujours flaggé en double source — trompeur pour le caller.
 * 2. SIRET nouveau ET adresse matche → insère un nouveau candidat. C'est le
 *    cas typique du SIRET fermé invisible côté RPPS.
 * 3. SIRET nouveau ET adresse ne matche pas → bruit (autre site du SIREN sans
 *    lien avec le FINESS). Ignoré.
 *
 * Le paramètre `nomComplet` (raison sociale UL, depuis DINUM ou fallback INSEE)
 * est stocké dans `raison_sociale_ul` pour éviter des appels INSEE redondants
 * dans `reconcilierFinessSirene` (Fix P2.3).
 */
function mergeOrInsertDinumCandidate(
  candidates: Map<string, SiretCandidate>,
  etab: { siret: string; adresse?: string; actif: boolean; dateCreation?: string },
  finessAddrNorm: string,
  finessNomNorm: string,
  nomComplet: string | null = null,
): void {
  const adresse = etab.adresse?.trim() || null;
  const score = adresse ? diceCoefficient(finessAddrNorm, normalizeForCompare(adresse)) : null;
  // V0.13.1 (Raffinement #2) : score nom factorisé via `computeNameScore` —
  // garantit la sémantique partagée avec le bloc d'injection fallback.
  const scoreNom = computeNameScore(finessNomNorm, nomComplet);
  const existing = candidates.get(etab.siret);
  if (existing) {
    existing.adresse_libelle = adresse;
    existing.actif = etab.actif;
    existing.date_creation = etab.dateCreation ?? null;
    existing.score_adresse = score;
    // Surcharger raison_sociale_ul si le caller passe une valeur (DINUM/INSEE
    // est plus fiable que null RPPS). Ne pas écraser une valeur déjà renseignée
    // par une null (si plusieurs passages, garder la première valeur trouvée).
    if (nomComplet !== null) {
      existing.raison_sociale_ul = nomComplet;
      existing.score_nom = scoreNom;
    }
    if (
      score !== null &&
      score >= BEST_MATCH_THRESHOLD &&
      !existing.sources.includes("dinum_address_match")
    ) {
      existing.sources.push("dinum_address_match");
    }
    return;
  }
  if (score !== null && score >= BEST_MATCH_THRESHOLD) {
    candidates.set(etab.siret, {
      siret: etab.siret,
      sources: ["dinum_address_match"],
      score_adresse: score,
      // Distance géo non calculée sur le chemin DINUM principal : seul le
      // fallback géo (qui pilote la désambiguïsation par co-localisation)
      // en a besoin, et il la renseigne lui-même via la branche `existing`.
      distance_finess_m: null,
      score_nom: scoreNom,
      actif: etab.actif,
      adresse_libelle: adresse,
      date_creation: etab.dateCreation ?? null,
      raison_sociale_ul: nomComplet,
    });
  }
}

// === Resolver V2 — fallback géographique helpers =============================

/**
 * Résultat agrégé d'une tentative de fallback géographique. Renvoyé par
 * `tryAddressFallback` au caller principal qui assemble la `SiretResolution`
 * finale.
 */
interface FallbackOutcome {
  /** Voir `ResolutionMethod`. Reste `"rpps"` quand le fallback skippe / n'aide pas. */
  method: ResolutionMethod;
  /** Voir `FallbackReason`. Toujours renseigné si le fallback a été tenté. */
  fallback_reason: FallbackReason;
  /** Voir `SiretResolution.naf_filter_used`. */
  naf_filter_used: string[];
  /** Voir `DisambiguationStatus`. */
  disambiguation_status: DisambiguationStatus;
  /** Best match recalculé si le fallback a tranché ; sinon `null`. */
  best_match: SiretCandidate | null;
}

/**
 * Tente d'enrichir une résolution RPPS infructueuse par recherche géographique
 * DINUM `/near_point` filtrée par NAF compatible avec la famille FINESS source.
 *
 * **Préconditions** : appelé UNIQUEMENT par `resolveSiretsForFiness` quand
 * `best_match === null` et `dinum_errors.length === 0` (cf. cadrage Q1). Cette
 * fonction NE vérifie PAS ces conditions — c'est la responsabilité du caller.
 *
 * **Sortie** :
 *   - skip silencieux (famille `autre` / `DELIBERATELY_NO_NAF` / coords null)
 *     → `fallback_reason: "no_naf_mapping_for_famille"` ou `"no_finess_coords"`,
 *     `method: "rpps"`, `naf_filter_used: []`.
 *   - tenté mais 0 candidat post-gate → `method: "rpps"`,
 *     `naf_filter_used` rempli (audit), `disambiguation_status: "not_applicable"`.
 *   - 1 candidat post-gate → `method: "address_fallback"` (ou `"mixed"` si
 *     RPPS avait des SIRET), `disambiguation_status: "single_after_gate"`,
 *     `best_match` peuplé.
 *   - > 1 candidat post-gate, signal RPPS départage → `"by_rpps_signal"`.
 *   - > 1 candidat ex-aequo → `"ambiguous"`, `best_match: null` exposé pour
 *     intervention manuelle.
 *
 * **Mutations** : enrichit en place la `candidates` Map et les structures
 * `sirens_explored` / `sirens_actif` / `dinum_errors` pour conserver le
 * pattern V0.7 (le caller assemble la `SiretResolution` finale à partir de
 * ces structures partagées).
 *
 * @internal Exporté uniquement pour test unitaire (`_tryAddressFallbackForTesting`).
 */
async function tryAddressFallback(args: {
  finess: FinessResult;
  /**
   * `true` quand le fallback est déclenché parce que le pivot RPPS a produit
   * un `best_match` mais FERMÉ (L1 V0.16). Sert à exposer `fallback_reason:
   * "best_match_ferme"` plutôt que `"no_best_match_with_clean_dinum"`.
   */
  triggeredByClosedBestMatch: boolean;
  rppsSirets: string[];
  finessAddrNorm: string;
  finessNomNorm: string;
  candidates: Map<string, SiretCandidate>;
  sirensExplored: string[];
  sirensActif: Record<string, boolean | null>;
  dinumErrors: DinumLookupError[];
}): Promise<FallbackOutcome> {
  const {
    finess,
    triggeredByClosedBestMatch,
    rppsSirets,
    finessAddrNorm,
    finessNomNorm,
    candidates,
    sirensExplored,
    sirensActif,
    dinumErrors,
  } = args;

  // Garde-fou (1) : coords FINESS manquantes → fallback impossible.
  if (!finess.coords) {
    return {
      method: "rpps",
      fallback_reason: "no_finess_coords",
      naf_filter_used: [],
      disambiguation_status: "not_applicable",
      best_match: null,
    };
  }
  // Coords FINESS garanties non-null ici — capturées en const pour préserver
  // le narrowing TypeScript à travers les `await` qui suivent (le narrowing
  // d'une propriété d'objet est perdu après un point de suspension).
  const finessCoords: Coordinates = finess.coords;

  // Garde-fou (2) : famille sans mapping NAF → skip silencieux (Franco-Britannique).
  const nafs = [...nafsForFamille(finess.categorie.famille)];
  if (nafs.length === 0) {
    return {
      method: "rpps",
      fallback_reason: "no_naf_mapping_for_famille",
      naf_filter_used: [],
      disambiguation_status: "not_applicable",
      best_match: null,
    };
  }

  // Raison de fallback « de base » partagée par les returns post-near_point :
  // `best_match_ferme` quand L1 (V0.16) a déclenché le fallback sur un best_match
  // fermé, sinon la sémantique V0.13 (no_rpps / no_best_match_with_clean_dinum).
  const baseFallbackReason: FallbackReason = triggeredByClosedBestMatch
    ? "best_match_ferme"
    : rppsSirets.length === 0
      ? "no_rpps"
      : "no_best_match_with_clean_dinum";

  // Recherche /near_point parallèle, 1 appel DINUM par NAF. `onlyActive: false`
  // pour capturer aussi les SIRET fermés (cas déménagement à détecter).
  // Promise.allSettled : un NAF qui plante (rate limit, 5xx) n'invalide pas
  // les autres — log + continue.
  const nearPointResults = await Promise.allSettled(
    nafs.map((naf) =>
      searchEntreprises({
        center: finessCoords,
        radiusKm: FALLBACK_RADIUS_KM,
        naf,
        onlyActive: false,
        perPage: 25,
      }),
    ),
  );

  // Dédup des Etablissement par SIRET. Plusieurs NAF peuvent ramener la même
  // entreprise si DINUM retourne plusieurs activités sur un même siège — on
  // garde la première occurrence rencontrée. On capte AUSSI `nomComplet` côté
  // entreprise au passage (Fix P2 code-reviewer) : DINUM /near_point l'expose
  // déjà, pas besoin de re-lookup SIREN si l'enrichment ultérieur échoue.
  const fallbackEtabs = new Map<string, Etablissement>();
  const nomCompletByEtab = new Map<string, string>();
  for (let i = 0; i < nearPointResults.length; i++) {
    const settled = nearPointResults[i];
    const naf = nafs[i] as string;
    if (!settled) continue;
    if (settled.status === "rejected") {
      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      console.error(
        `[france-data-mcp] siret-resolver: fallback near_point naf=${naf} for num_finess=${finess.num_finess} failed: ${msg}`,
      );
      // Fix P1 silent-failure-hunter : surface l'échec partiel dans
      // `dinum_errors` pour ne pas mentir au caller sur la propreté de la
      // résolution. Clé sentinelle `near_point:<naf>` (pas un SIREN) — distingue
      // visuellement un échec de NAF d'un échec d'enrichment SIREN.
      dinumErrors.push({
        siren: `near_point:${naf}`,
        message: `near_point naf=${naf}: ${msg}`,
        status: "rejected",
      });
      continue;
    }
    for (const ent of settled.value.entreprises) {
      for (const etab of ent.etablissements) {
        if (!fallbackEtabs.has(etab.siret)) {
          fallbackEtabs.set(etab.siret, etab);
          if (ent.nomComplet) nomCompletByEtab.set(etab.siret, ent.nomComplet);
        }
      }
    }
  }

  // Gate d'activité (mode "compatible") : éliminer les SIRET dont le NAF
  // n'est pas compatible avec la famille FINESS. Filet anti-Franco-Britannique
  // — un labo doit être rattaché à un FINESS labo, jamais à un IFSI co-localisé.
  const compatibleEtabs: Etablissement[] = [];
  for (const etab of fallbackEtabs.values()) {
    if (isNafCompatibleWithFamille(etab.naf, finess.categorie.famille)) {
      compatibleEtabs.push(etab);
    }
  }

  // Cas trivial : 0 candidat post-gate → fallback tenté mais sans amélioration.
  // On garde method="rpps" (rien à ajouter aux candidates) mais on expose
  // naf_filter_used pour audit prod.
  if (compatibleEtabs.length === 0) {
    return {
      method: "rpps",
      fallback_reason: baseFallbackReason,
      naf_filter_used: nafs,
      disambiguation_status: "not_applicable",
      best_match: null,
    };
  }

  // Enrichir via lookup SIREN pour récupérer raison sociale UL + sirens_actif.
  // Permet au caller (verifierSiteActif) de calculer un verdict_groupe propre
  // sur les candidats fallback, pas seulement verdict_site.
  const distinctSirens = [...new Set(compatibleEtabs.map((e) => e.siret.slice(0, 9)))];
  const sirenLookups = await Promise.allSettled(
    distinctSirens.map(async (siren) => ({ siren, lookup: await getEntrepriseBySiren(siren) })),
  );
  const sirenInfo = new Map<string, { actif: boolean | null; nomComplet: string | null }>();
  for (let i = 0; i < sirenLookups.length; i++) {
    const siren = distinctSirens[i] as string;
    const settled = sirenLookups[i];
    if (!settled) continue;
    if (settled.status === "rejected") {
      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      console.error(
        `[france-data-mcp] siret-resolver: fallback SIREN enrichment rejected for siren=${siren}: ${msg}`,
      );
      dinumErrors.push({ siren, message: `fallback_siren_enrichment: ${msg}`, status: "rejected" });
      sirenInfo.set(siren, { actif: null, nomComplet: null });
      continue;
    }
    const lookup = settled.value.lookup;
    if (!lookup.found) {
      // Fix P1 silent-failure-hunter : push dans `dinum_errors` pour distinguer
      // « SIREN sans enrichment » (diffusion partielle = info récupérable) de
      // « pas exploré » (vrai silence). Symétrique au pattern V0.7 cascade
      // (lookup INSEE fallback) qui pousse aussi dans dinum_errors. La
      // `lookupStatus` discrimine la cause (not_found / ambiguous) pour audit
      // ops — `config_missing` et `enrichment_failed` ne sont JAMAIS émis par
      // `getEntrepriseBySiren` (DINUM principal), uniquement par le pipeline
      // INSEE de la cascade V0.7 (cf. siret-resolver:418/427).
      console.warn(
        `[france-data-mcp] siret-resolver: fallback SIREN ${siren} not_found (${lookup.lookupStatus}): ${lookup.message}`,
      );
      dinumErrors.push({
        siren,
        message: `fallback_siren_enrichment: ${lookup.message}`,
        status: lookup.lookupStatus,
      });
      sirenInfo.set(siren, { actif: null, nomComplet: null });
      continue;
    }
    sirenInfo.set(siren, { actif: lookup.actif, nomComplet: lookup.nomComplet });
    if (!sirensExplored.includes(siren)) sirensExplored.push(siren);
    sirensActif[siren] = lookup.actif;
  }

  // Injecter les candidats fallback dans la Map partagée. Calcule :
  //  - `score` Dice adresse : signal secondaire (exposé pour audit) ;
  //  - `distance` géo FINESS↔point DINUM : juge de co-localisation V0.16, le
  //    seul fiable pour trancher « même bâtiment » (cf. `COLOCATION_RADIUS_M`).
  //
  // Fix P2 code-reviewer : si l'enrichment SIREN a échoué, on retombe sur le
  // `nomComplet` que DINUM /near_point avait DÉJÀ fourni (capté dans
  // `nomCompletByEtab` en amont). Évite un `raison_sociale_ul: null` alors
  // que la donnée était disponible — et économise un appel INSEE redondant
  // côté `reconcilierFinessSirene` (P2.3 V0.7.1).
  const fallbackCandidates: SiretCandidate[] = [];
  for (const etab of compatibleEtabs) {
    const siren = etab.siret.slice(0, 9);
    const info = sirenInfo.get(siren);
    const nearPointNomComplet = nomCompletByEtab.get(etab.siret) ?? null;
    const resolvedNomComplet = info?.nomComplet ?? nearPointNomComplet;
    const adresse = etab.adresse?.trim() || null;
    const score = adresse ? diceCoefficient(finessAddrNorm, normalizeForCompare(adresse)) : null;
    const scoreNom = computeNameScore(finessNomNorm, resolvedNomComplet);
    // `etab.point` est fourni par /near_point quand l'adresse SIRENE est
    // géocodée — quasi toujours. `null` (distance) si absent → la cascade de
    // désambiguïsation retombe sur le score Dice pour ce candidat.
    const distance = etab.point != null ? haversineMeters(finessCoords, etab.point) : null;
    const existing = candidates.get(etab.siret);
    if (existing) {
      // SIRET déjà connu via RPPS (signal RPPS positif) — enrichir, ajouter source.
      existing.score_adresse = score;
      existing.distance_finess_m = distance;
      existing.actif = etab.actif;
      existing.adresse_libelle = adresse;
      existing.date_creation = etab.dateCreation ?? null;
      if (resolvedNomComplet) {
        existing.raison_sociale_ul = resolvedNomComplet;
        existing.score_nom = scoreNom;
      }
      if (!existing.sources.includes("dinum_address_match")) {
        existing.sources.push("dinum_address_match");
      }
      fallbackCandidates.push(existing);
    } else {
      // Nouveau candidat ramené uniquement par le fallback géo.
      const cand: SiretCandidate = {
        siret: etab.siret,
        sources: ["dinum_address_match"],
        score_adresse: score,
        distance_finess_m: distance,
        score_nom: scoreNom,
        actif: etab.actif,
        adresse_libelle: adresse,
        date_creation: etab.dateCreation ?? null,
        raison_sociale_ul: resolvedNomComplet,
      };
      candidates.set(etab.siret, cand);
      fallbackCandidates.push(cand);
    }
  }

  // Garde-fou observabilité (V0.16) : si AUCUN candidat fallback n'a de point
  // GPS, l'étape « actif prime » (qui exige une distance prouvée) est
  // inopérante — le fix succession serait silencieusement désactivé. Signale
  // pour audit ops (cause probable : DINUM /near_point ne fournit plus `point`).
  if (
    fallbackCandidates.length >= 2 &&
    fallbackCandidates.every((c) => c.distance_finess_m === null)
  ) {
    console.warn(
      `[france-data-mcp] siret-resolver: fallback géo num_finess=${finess.num_finess} — ${fallbackCandidates.length} candidats mais AUCUN point GPS : étape de co-localisation V0.16 inopérante, arbitrage retombé sur Dice/nom (audit : DINUM /near_point fournit-il encore \`point\` ?)`,
    );
  }

  // Désambiguïsation cascade (V0.16 — « actif prime ») :
  //   0. Gate adresse grossier → addressGated. Vide → ambiguous. 1 → single.
  //   1. ACTIF PRIME : s'il existe ≥ 1 candidat ACTIF co-localisé (distance géo
  //      ≤ COLOCATION_RADIUS_M), le pool d'arbitrage est restreint à ces actifs
  //      co-localisés — les SIRET fermés du site sont écartés du best_match
  //      (ils restent dans candidates[] pour la timeline). 1 actif → tranché.
  //   2. Name filter : disqualifie les candidats au score_nom trop faible.
  //   3. Active succession même SIREN : départage une réorganisation interne.
  //   4. Signal RPPS : 1 seul candidat RPPS-déclaré.
  //   5. Sinon → ambiguous (best_match=null).
  const disamb = disambiguateFallbackCandidates(fallbackCandidates, rppsSirets);

  return {
    method: rppsSirets.length > 0 ? "mixed" : "address_fallback",
    fallback_reason: baseFallbackReason,
    naf_filter_used: nafs,
    disambiguation_status: disamb.status,
    best_match: disamb.best_match,
  };
}

/**
 * Un candidat est « co-localisé » avec le FINESS s'il occupe le même site
 * physique : distance géodésique ≤ `COLOCATION_RADIUS_M` (V0.16) — le seul juge
 * fiable, le Dice textuel ne discrimine pas le numéro de voie.
 *
 * Un candidat sans `distance_finess_m` (point GPS absent) n'est **pas** présumé
 * co-localisé : faute de preuve géographique, l'étape « actif prime » ne
 * l'accélère pas. Il n'est pas écarté pour autant — il reste dans
 * `candidates[]` ET dans la cascade name/RPPS classique, qui peut toujours le
 * retenir. Choix conservateur : interdit qu'un candidat actif sans position
 * prouvée promeuve un verdict « actif » sur un site possiblement fermé (garde-
 * fou faux positif inverse). En pratique les candidats du fallback viennent de
 * `/near_point` (recherche PAR proximité) → ils ont quasi toujours un point ;
 * le cas `null` est un cas-limite, pas le cas nominal.
 */
function isColocated(c: SiretCandidate): boolean {
  return c.distance_finess_m !== null && c.distance_finess_m <= COLOCATION_RADIUS_M;
}

/**
 * Bande « même site » (V0.16.1) : parmi un ensemble de candidats, ceux qui sont
 * co-localisés (`isColocated`) ET à la distance la plus proche du FINESS, à
 * `COLOCATION_SAME_SITE_TOLERANCE_M` près. Source UNIQUE de ce prédicat, partagée
 * par l'arbitrage du best_match (`disambiguateFallbackCandidates`, étape 1) ET la
 * construction de la succession (`buildSuccession`).
 *
 * Pourquoi factoriser : sans prédicat commun, les deux divergent — un voisin fermé
 * d'une AUTRE adresse (dans le rayon 100 m mais hors bande), correctement écarté du
 * best_match, ressurgirait comme « ancien exploitant » dans `succession` exposé au
 * caller (le faux positif inverse rouvert côté succession). Le décalage de géocodage
 * DREES étant PARTAGÉ par tous les SIRET d'une même adresse, c'est la distance
 * RELATIVE au plus proche — pas le rayon absolu — qui distingue « même site » d'un
 * voisin. Un candidat sans `distance_finess_m` n'entre jamais dans la bande (ni ne
 * tire le min : `?? +Infinity`).
 */
function sameSiteBand(candidates: SiretCandidate[]): SiretCandidate[] {
  const colocated = candidates.filter(isColocated);
  if (colocated.length === 0) return [];
  const minDist = Math.min(
    ...colocated.map((c) => c.distance_finess_m ?? Number.POSITIVE_INFINITY),
  );
  return colocated.filter(
    (c) =>
      (c.distance_finess_m ?? Number.POSITIVE_INFINITY) <=
      minDist + COLOCATION_SAME_SITE_TOLERANCE_M,
  );
}

/**
 * Cascade de désambiguïsation pour les candidats post-gate NAF du fallback géo.
 * Sortie : statut + best_match (ou null si ambigu). Logique linéaire, chaque
 * étape n'est essayée que si la précédente n'a pas tranché.
 *
 * **V0.16 — « actif prime » (fix succession M&A), recalibré V0.16.1.** Étape pivot
 * ajoutée AVANT le name filter : si ≥ 1 candidat ACTIF est sur la bande « même
 * site » (`sameSiteBand` : co-localisés les plus proches du FINESS), le pool
 * d'arbitrage du best_match est restreint à ces actifs. Les SIRET fermés du site
 * (ancien exploitant) ne sont alors plus best_match-éligibles — ils restent dans
 * `candidates[]` pour la timeline / succession.
 *
 * Pourquoi AVANT le name filter : le libellé FINESS conserve l'ancienne
 * enseigne (latence DREES). Un repreneur dont la raison sociale ne ressemble
 * plus au libellé FINESS serait sinon disqualifié par son score nom au profit
 * de l'ancien exploitant fermé — régression M&A prouvée prod (Neuilly Sablons /
 * Pont de Neuilly, cf. `docs/plans/verifier-site-actif-succession-fix.md`).
 *
 * Garde-fou faux positif inverse : on ne promeut un actif que s'il est sur la
 * bande « même site » (distance la plus proche du FINESS + tolérance). Un voisin
 * actif du même métier à une AUTRE adresse — même ramené dans le rayon 100 m —
 * ressort plus loin que le prédécesseur co-localisé et reste hors bande, donc
 * non promu. Et plusieurs actifs sur bande de SIREN distincts = entreprises
 * concurrentes, pas une succession → l'étape 1 ne tranche pas (la cascade
 * name/RPPS continue, sinon `ambiguous`). Préserve le test "2 labos co-localisés
 * ex-aequo → ambiguous".
 */
function disambiguateFallbackCandidates(
  candidates: SiretCandidate[],
  rppsSirets: string[],
): { status: DisambiguationStatus; best_match: SiretCandidate | null } {
  // Étape 0 — Gate adresse grossier (V0.13.1 prod-prouvé sur FINESS 920028487).
  // Au sein du rayon /near_point, DINUM peut ramener plusieurs sites ; ceux au
  // score_adresse < BEST_MATCH_THRESHOLD ne sont PAS le site cherché. La liste
  // candidates[] exposée au caller reste COMPLÈTE (audit) ; seul le best_match
  // est arbitré sur le pool gated.
  const addressGated = candidates.filter(meetsBestMatchAddressGate);
  if (addressGated.length === 0) {
    console.warn(
      `[france-data-mcp] siret-resolver: address gate eliminated all ${candidates.length} fallback candidates (score_adresse < ${BEST_MATCH_THRESHOLD}) — ambiguous returned (audit recommandé : coords FINESS imprécises ? rayon /near_point trop large ? gate NAF anormalement permissif ?)`,
    );
    return { status: "ambiguous", best_match: null };
  }
  const [firstGated] = addressGated;
  if (addressGated.length === 1 && firstGated) {
    return { status: "single_after_gate", best_match: firstGated };
  }

  // Étape 1 — ACTIF PRIME (V0.16, recalibré V0.16.1). On restreint l'arbitrage à
  // la bande « même site » (`sameSiteBand` : co-localisés les plus proches, cf.
  // helper). Si ≥ 1 candidat actif y figure, le site est exploité → le pool est
  // restreint à ces actifs ; les SIRET fermés du site restent dans candidates[]
  // pour la timeline / succession. `succession` = vrai s'il y avait aussi ≥ 1
  // fermé sur la bande (ancien exploitant écarté) — détermine le statut retourné.
  const sameSite = sameSiteBand(addressGated);
  let pool = addressGated;
  let succession = false;
  if (sameSite.length > 0) {
    const sameSiteActifs = sameSite.filter((c) => c.actif === true);
    if (sameSiteActifs.length > 0) {
      pool = sameSiteActifs;
      succession = sameSite.some((c) => c.actif === false);
    } else {
      // Aucun actif sur la bande la plus proche (que des fermés / statut inconnu) :
      // on garde cette bande. Un candidat actif plus lointain (autre adresse, dans
      // le rayon 100 m mais hors bande) ne peut PAS basculer le verdict en
      // « actif » — un site vraiment fermé reste fermé (garde-fou faux positif
      // inverse au rayon élargi).
      pool = sameSite;
    }
  }
  const [firstPool] = pool;
  if (pool.length === 1 && firstPool) {
    return {
      status: succession ? "by_active_succession" : "single_after_gate",
      best_match: firstPool,
    };
  }

  // Étape 2 — Name filter (V0.13.1 Raffinement #2). Disqualifie les candidats
  // dont le nom est trop éloigné du libellé FINESS (`score_nom < threshold`,
  // mais SEULEMENT si score_nom est non-null : un score absent ne disqualifie
  // jamais). S'applique sur le pool courant — déjà restreint aux actifs
  // co-localisés si l'étape 1 a réduit sans trancher.
  const nameFiltered = pool.filter(
    (c) => c.score_nom === null || c.score_nom >= NAME_DISQUALIFY_THRESHOLD,
  );
  const [firstNameFiltered] = nameFiltered;
  if (nameFiltered.length === 1 && firstNameFiltered) {
    return { status: "by_name_score", best_match: firstNameFiltered };
  }
  // Si tout a été disqualifié (cas limite : tous les candidats au score_nom
  // faible), on reste sur le pool courant — ne pas écarter un candidat
  // légitime sur une donnée incertaine. Cas pathologique tracé en warn.
  if (nameFiltered.length === 0) {
    console.warn(
      `[france-data-mcp] siret-resolver: name filter eliminated all ${pool.length} candidates post-gate — fallback sur le pool courant (audit recommandé : gate NAF anormalement permissif ?)`,
    );
  }
  const pool2 = nameFiltered.length > 0 ? nameFiltered : pool;

  // Étape 3 — Active succession même SIREN (V0.13.1 Raffinement #3). Si tous
  // les candidats du pool partagent (SIREN, adresse normalisée) ET il y a ≥ 1
  // actif, on retient l'actif le plus récent. Cas : réorganisation interne
  // d'un groupe (plusieurs SIRET actifs au même siège) — distinct du M&A
  // inter-SIREN, déjà tranché à l'étape 1.
  const [firstPool2, ...restPool2] = pool2;
  if (firstPool2 && restPool2.length >= 1) {
    // Truthy plutôt que `=== null` strict : si le type `adresse_libelle` est
    // élargi un jour à `string | null | undefined`, ce guard reste safe et ne
    // throw pas via `normalizeForCompare(undefined)`. Robustesse type-future.
    const groupKey = (c: SiretCandidate) =>
      `${c.siret.slice(0, 9)}|${c.adresse_libelle ? normalizeForCompare(c.adresse_libelle) : ""}`;
    const firstKey = groupKey(firstPool2);
    const allSameGroup = pool2.every((c) => groupKey(c) === firstKey);
    if (allSameGroup) {
      const actifs = pool2.filter((c) => c.actif === true);
      // Plusieurs actifs (rare : 2 SIRET actifs même siège) → le plus récent
      // par date_creation. Tie-break SIRET asc pour déterminisme quand les
      // dates sont absentes (snapshots de tests stables).
      actifs.sort((a, b) => {
        const dateDiff = (b.date_creation ?? "").localeCompare(a.date_creation ?? "");
        return dateDiff !== 0 ? dateDiff : a.siret.localeCompare(b.siret);
      });
      const [bestActif] = actifs;
      if (bestActif) {
        return { status: "by_active_succession", best_match: bestActif };
      }
    }
  }

  // Étape 4 — Signal RPPS : un seul candidat du pool a été déclaré côté RPPS.
  const rppsSet = new Set(rppsSirets);
  const withRppsSignal = pool2.filter((c) => rppsSet.has(c.siret));
  const [rppsBest] = withRppsSignal;
  if (withRppsSignal.length === 1 && rppsBest) {
    return { status: "by_rpps_signal", best_match: rppsBest };
  }

  // Étape 5 — Ambigu : aucun critère propre pour départager. best_match=null,
  // caller doit cross-checker manuellement.
  return { status: "ambiguous", best_match: null };
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
