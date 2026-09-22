/**
 * Recherche d'un établissement de santé par son NOM — logique pure (seuil,
 * rang, preuve de commune). L'appel RPC vit dans `finess-db.ts`.
 *
 * Pourquoi : « le nouveau quartier derrière l'IGR » — le LLM de geo-intel
 * envoyait le nom à la BAN, qui ne connaît que des rues (→ « rue Gustave »
 * n'importe où en France). Ici le LLM extrait le nom (et la commune s'il la
 * connaît), FINESS vérifie et rend le point exact.
 *
 * Mesures prod 2026-09-22 (`docs/plans/finess-recherche-par-nom.md`), 25 noms
 * tapés comme un humain, `word_similarity` sur la raison sociale normalisée :
 * - les vrais matchs sortent à 1,00 (le nom cherché est un SOUS-ENSEMBLE de la
 *   raison sociale : « gustave roussy » ⊂ « INSTITUT GUSTAVE ROUSSY SITE VILLE
 *   JUIF ») ;
 * - les faux positifs plafonnent à 0,76-0,79 (« GEORGES POMPIER » pour
 *   « Georges Pompidou », « CH DE VERNON » pour « CH de Versailles ») ;
 * - une table d'abréviations n'aide PAS (« CH de Bretagne Sud » n'existe pas
 *   sous ce nom ; « ch » court ajoute du bruit : « CMP DE VERSAILLES ») —
 *   limite documentée, le LLM relance avec la partie distinctive du nom.
 */

import { stripCedex } from "../core/address-geocode.js";
import { normalizeForCompare } from "../core/text-match.js";
import { parentCommuneInsee } from "../territoire/commune-index.js";
import { FINESS_FAMILLE_PRIORITE_NOM, type FinessFamille } from "./finess-categories.js";
import type { FinessResult } from "./finess-db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FinessNameCandidate extends FinessResult {
  /** `word_similarity` du nom cherché dans la raison sociale normalisée (0-1, 2 décimales). */
  similarite: number;
}

/**
 * - `unique` : un seul établissement retenu ;
 * - `ambigu` : plusieurs (homonymes, ou plusieurs fiches d'un même campus —
 *   l'IGR en a 4), ou ensemble tronqué ; lire `commune_prouvee` avant de
 *   conclure ;
 * - `aucun` : rien au-dessus du seuil.
 */
export type FinessNameStatut = "unique" | "ambigu" | "aucun";

export type FinessCommuneProofReason =
  | "un_seul_candidat"
  | "candidats_meme_commune"
  | "communes_divergentes"
  | "tronque"
  | "aucun_candidat";

export interface FinessNameSearchResult {
  /** Ce qui a réellement été cherché (minuscules, sans accents ni ponctuation). */
  query_normalisee: string;
  statut: FinessNameStatut;
  /** Candidats ≥ seuil, triés : similarité, rang de famille, libellé court. */
  readonly candidats: readonly FinessNameCandidate[];
  /**
   * Commune-mère (Paris/Lyon/Marseille : 75056, pas l'arrondissement) quand
   * TOUS les candidats retenus y sont — jamais un « meilleur candidat » servi
   * seul quand les communes divergent (non résolu plutôt que faux).
   */
  commune_prouvee: { code_insee: string; ville: string | null } | null;
  raison_commune: FinessCommuneProofReason;
  /** Communes-mères distinctes des candidats retenus (vide si `aucun`). */
  readonly communes_candidates: readonly string[];
  /**
   * Meilleure similarité vue, même sous le seuil — pour comprendre un `aucun`.
   * `null` = la RPC n'a rendu AUCUNE ligne dans le scope (hint territorial
   * faux ?), à distinguer d'un nom qui ne ressemble à rien.
   */
  meilleure_similarite: number | null;
  /**
   * Des candidats ≥ seuil ont pu être coupés par `limit` : la RPC a rendu
   * `limit` lignes ET la dernière LISIBLE (tri par similarité décroissante)
   * est encore ≥ seuil. Une commune ne se PROUVE pas sur un ensemble tronqué (« Sainte
   * Marie » : 77 communes, 39 dans le top 50 → preuve fausse sinon) →
   * `raison_commune: "tronque"`. Monter `limit` ou préciser le territoire.
   * Des lignes sous le seuil qui remplissent la fenêtre ne tronquent rien.
   */
  tronque: boolean;
  /** Lignes RPC illisibles écartées (similarité non numérique) — dégradation visible au contrat. */
  lignes_rejetees: number;
}

// ---------------------------------------------------------------------------
// Constantes mesurées
// ---------------------------------------------------------------------------

/**
 * Seuil de DÉCISION (candidat retenu). 0,80 : vrais matchs à 1,00, faux
 * positifs ≤ 0,79 sur 25 noms (cf. en-tête). Le seuil de RAPPEL (0,5) vit dans
 * la RPC ; l'écart entre les deux fait remonter `meilleure_similarite`.
 */
export const FINESS_NAME_MATCH_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Logique pure
// ---------------------------------------------------------------------------

/**
 * Normalisation TS du nom cherché : VALIDATION (`RangeError` sous 3
 * caractères utiles — rien à discriminer en trigrammes) et écho
 * `query_normalisee`. Le MATCH n'en dépend pas : la RPC normalise elle-même
 * `p_query` avec `finess_nom_normalise`, la même fonction que la colonne
 * indexée — une seule normalisation fait foi, pas de jumeau à maintenir
 * (`normalizeForCompare` ne replie pas œ/æ, le SQL ignore les diacritiques
 * hors français : différences sans effet sur le résultat).
 */
export function normalizeFinessName(nom: string): string {
  const normalized = normalizeForCompare(nom);
  if (normalized.length < 3) {
    throw new RangeError(
      `nom d'établissement trop court après normalisation ("${normalized}") : 3 caractères minimum`,
    );
  }
  return normalized;
}

/** Rang dans `FINESS_FAMILLE_PRIORITE_NOM` ; famille non listée → après toutes. */
function familleRank(f: FinessFamille): number {
  const i = FINESS_FAMILLE_PRIORITE_NOM.indexOf(f);
  return i === -1 ? FINESS_FAMILLE_PRIORITE_NOM.length : i;
}

/**
 * Applique seuil, rang et preuve de commune à des candidats déjà mappés
 * (`similarite` arrondie à 2 décimales au mapping : deux candidats à 0,996 et
 * 1,0 sont à égalité, le rang de famille tranche). Le scope territoire est
 * entièrement porté par la RPC (`communeInseeRange`), y compris Paris/Lyon/
 * Marseille — pas de post-filtre après `LIMIT`.
 */
export function resolveFinessNameCandidates(
  queryNormalisee: string,
  rows: FinessNameCandidate[],
  opts: { limit: number; lignesRejetees: number } = {
    limit: Number.POSITIVE_INFINITY,
    lignesRejetees: 0,
  },
): FinessNameSearchResult {
  const similarites = rows.map((r) => r.similarite);
  const meilleure = rows.length === 0 ? null : Math.max(...similarites);
  // Fenêtre pleine ET sa pire ligne encore au-dessus du seuil : d'autres
  // candidats retenus existent peut-être au-delà (`limit` compte les lignes
  // RPC lisibles + rejetées, d'où `>=`).
  const tronque =
    rows.length + opts.lignesRejetees >= opts.limit &&
    rows.length > 0 &&
    Math.min(...similarites) >= FINESS_NAME_MATCH_THRESHOLD;

  const candidats = rows
    .filter((r) => r.similarite >= FINESS_NAME_MATCH_THRESHOLD)
    .sort((a, b) => {
      if (a.similarite !== b.similarite) return b.similarite - a.similarite;
      const ra = familleRank(a.categorie.famille);
      const rb = familleRank(b.categorie.famille);
      if (ra !== rb) return ra - rb;
      // 2,4 % des fiches n'ont pas de point : à famille égale, celle qui en a
      // un passe devant (« Hôpital Foch » : deux fiches identiques, une sans).
      if ((a.coords === null) !== (b.coords === null)) return a.coords === null ? 1 : -1;
      if (a.raison_sociale.length !== b.raison_sociale.length) {
        return a.raison_sociale.length - b.raison_sociale.length;
      }
      return a.num_finess.localeCompare(b.num_finess);
    });

  const communes = [...new Set(candidats.map((c) => parentCommuneInsee(c.adresse.code_insee)))];

  return {
    query_normalisee: queryNormalisee,
    ...verdict(candidats, communes, tronque),
    candidats,
    communes_candidates: communes,
    meilleure_similarite: meilleure,
    tronque,
    lignes_rejetees: opts.lignesRejetees,
  };
}

/**
 * Une seule dérivation pour les trois champs redondants (`statut`,
 * `raison_commune`, `commune_prouvee`) : dérivés séparément ils pourraient
 * diverger. La redondance elle-même est voulue — le LLM lit mieux trois
 * champs toujours présents qu'une union à clés variables.
 */
function verdict(
  candidats: FinessNameCandidate[],
  communes: string[],
  tronque: boolean,
): Pick<FinessNameSearchResult, "statut" | "raison_commune" | "commune_prouvee"> {
  const [premier, ...autres] = candidats;
  const [commune] = communes;
  if (premier === undefined || commune === undefined) {
    return { statut: "aucun", raison_commune: "aucun_candidat", commune_prouvee: null };
  }
  // Ensemble coupé par le LIMIT : les communes absentes de la fenêtre sont
  // inconnues, on ne prouve rien (non résolu plutôt que faux).
  if (tronque) {
    return { statut: "ambigu", raison_commune: "tronque", commune_prouvee: null };
  }
  const prouvee = { code_insee: commune, ville: villeSansCedex(premier.adresse.ville) };
  if (autres.length === 0) {
    return { statut: "unique", raison_commune: "un_seul_candidat", commune_prouvee: prouvee };
  }
  if (communes.length === 1) {
    return { statut: "ambigu", raison_commune: "candidats_meme_commune", commune_prouvee: prouvee };
  }
  return { statut: "ambigu", raison_commune: "communes_divergentes", commune_prouvee: null };
}

/** Ville du candidat sans CEDEX, en majuscules (FINESS mélange « PARIS » et « Paris »). */
function villeSansCedex(ville: string | null): string | null {
  if (ville === null) return null;
  const cleaned = stripCedex(ville).toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}
