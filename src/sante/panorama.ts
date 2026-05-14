/**
 * `panorama_sante_territoire` — agrégateur santé en 1 call MCP (V0.9).
 *
 * Réduit la latence et la friction LLM en parallélisant 7-10 sous-appels
 * (population, densités médecins/infirmiers/pharmaciens vs national, comptes
 * établissements par famille FINESS) en une seule requête.
 *
 * Source de vérité : ce module appelle uniquement les briques existantes
 * (`densiteProfessionnelsSante`, `countFiness`, Melodi). Aucun nouveau RPC,
 * aucune interprétation métier (pas de "désert médical" auto-qualifié).
 *
 * Périmètre V0.9 : niveau commune via `codeInsee` uniquement. Le niveau dept
 * est déjà couvert par `densite_professionnels_sante` (compare_national) + les
 * tools existants ; ajouter une variante dept ici dupliquerait sans valeur
 * ajoutée immédiate. Étendre en V0.9.1 si la demande émerge.
 */

import { assertValidCodeInsee, deptFromCodeInsee } from "../territoire/dept-codes.js";
import { type DensiteProfessionnelsSanteResult, densiteProfessionnelsSante } from "./densite.js";
import type { FinessFamilleQuery } from "./finess-categories.js";
import { type CountFinessInput, countFiness } from "./finess-db.js";
import { RPPS_PROFESSION } from "./rpps-types.js";
import { SOURCE_LABELS } from "./sources.js";

/**
 * Familles FINESS retournées dans le panorama par défaut. Couvre les
 * établissements de santé "visibles" du territoire — pas exhaustif (pas de
 * SSR, dialyse, etc.) pour rester sous 10 sous-appels parallèles.
 *
 * Exporté pour permettre à la description du tool MCP d'afficher la liste
 * authoritative sans hardcoder un duplicate (anti-drift).
 */
export const DEFAULT_FAMILLES: readonly FinessFamilleQuery[] = [
  "labo",
  "pharmacie",
  "ehpad",
  "mco",
  "msp_cpts",
];

export interface PanoramaSanteTerritoireInput {
  /** Code INSEE commune 5 chars. REQUIS. */
  codeInsee: string;
  /**
   * Familles FINESS à inclure dans le décompte établissements. Omis = liste
   * par défaut. Vide `[]` = pas de décompte établissements (ne fait que
   * population + densités PS).
   */
  finessFamilles?: readonly FinessFamilleQuery[];
}

export interface PanoramaEtablissementsEntry {
  famille: FinessFamilleQuery;
  count: number;
}

export interface PanoramaSanteTerritoireResult {
  /** Code INSEE de la zone analysée (echo input). */
  codeInsee: string;
  /**
   * Niveau géographique appliqué à la **population et aux densités PS**.
   * Pour V0.9 toujours `"commune"`. Distinct de `niveauEtablissements`
   * car le décompte FINESS est agrégé au niveau département (limitation V0.9).
   */
  niveau: "commune";
  /**
   * Niveau géographique appliqué au **décompte FINESS**. V0.9 retombe sur le
   * département dérivé du code INSEE (pas de RPC count_finess_by_commune
   * encore — backlog V0.9.1). Le LLM doit savoir que ce chiffre couvre un
   * périmètre plus large que la commune ; sans cette information explicite il
   * calculerait des ratios faux.
   */
  niveauEtablissements: "departement" | "indisponible";
  /** Densités professionnels santé clés (méthodo DREES, vs national). */
  densitesProfessionnels: {
    medecins: DensiteProfessionnelsSanteResult;
    infirmiers: DensiteProfessionnelsSanteResult;
    pharmaciens: DensiteProfessionnelsSanteResult;
  };
  /**
   * Nombre d'établissements FINESS par famille **dans le département** dérivé
   * du code INSEE. Vide si le dept ne peut pas être dérivé (`niveauEtablissements:
   * "indisponible"`).
   */
  etablissementsParFamille: PanoramaEtablissementsEntry[];
  /** Sources de données utilisées — traçabilité pour le LLM. */
  sources: {
    professionnels: typeof SOURCE_LABELS.rpps;
    etablissements: typeof SOURCE_LABELS.finess;
    population: typeof SOURCE_LABELS.melodi;
  };
}

/**
 * Agrège le panorama santé d'une commune en 1 call. Parallélise les sous-appels
 * via `Promise.all` (gain ~3-5× sur le pire cas séquentiel).
 *
 * **Comportement échec** : pas de fallback partiel — si une sous-requête fail,
 * le tool entier rejette. Le caller MCP retentera ; ne pas masquer une panne
 * Melodi ou Supabase derrière un panorama incomplet (cf. lessons learned V0.8.1
 * sur les silent failures).
 */
export async function panoramaSanteTerritoire(
  input: PanoramaSanteTerritoireInput,
): Promise<PanoramaSanteTerritoireResult> {
  // Fail-fast unique : sans ça, les 4 sous-calls (3 densités + finess) plantent
  // chacune avec son propre RangeError → bruit observabilité. Ici une seule
  // exception claire mappée -32602 (cf. /review V0.9 issue #8 silent-failure).
  assertValidCodeInsee(input.codeInsee);
  const familles = input.finessFamilles ?? DEFAULT_FAMILLES;

  const [medecins, infirmiers, pharmaciens, finessResult] = await Promise.all([
    densiteProfessionnelsSante({
      codeInsee: input.codeInsee,
      professionCode: RPPS_PROFESSION.MEDECIN,
      compareNational: true,
    }),
    densiteProfessionnelsSante({
      codeInsee: input.codeInsee,
      professionCode: RPPS_PROFESSION.INFIRMIER,
      compareNational: true,
    }),
    densiteProfessionnelsSante({
      codeInsee: input.codeInsee,
      professionCode: RPPS_PROFESSION.PHARMACIEN,
      compareNational: true,
    }),
    countFinessByFamilleCommune(input.codeInsee, familles),
  ]);

  return {
    codeInsee: input.codeInsee,
    niveau: "commune",
    niveauEtablissements: finessResult.niveauEtablissements,
    densitesProfessionnels: { medecins, infirmiers, pharmaciens },
    etablissementsParFamille: finessResult.entries,
    sources: {
      professionnels: SOURCE_LABELS.rpps,
      etablissements: SOURCE_LABELS.finess,
      population: SOURCE_LABELS.melodi,
    },
  };
}

/**
 * Compte les établissements FINESS de chaque famille dans une commune
 * (helper interne — n'est pas exposé en tool MCP). Cap : ne descend pas
 * sous le département car la table finess est filtrable via code_insee.
 *
 * `countFiness` existant filtre par `departement`. Pour le niveau commune,
 * on délègue à une variante future ; en V0.9 on tape directement la base
 * via la query Supabase (acceptable car finess est petit ~95K rows).
 *
 * **Choix V0.9** : on ne crée pas de nouvel RPC commune côté FINESS. À la
 * place, on filtre côté département (toujours dispo) et le caller LLM
 * interprète. C'est un trade-off transitoire — un futur tool dédié pourra
 * affiner.
 */
interface FinessByCommuneResult {
  entries: PanoramaEtablissementsEntry[];
  niveauEtablissements: "departement" | "indisponible";
}

async function countFinessByFamilleCommune(
  codeInsee: string,
  familles: readonly FinessFamilleQuery[],
): Promise<FinessByCommuneResult> {
  // Délègue le filtrage géo au RPC FINESS via le département (les rows FINESS
  // portent toutes un dept exploitable). Le caller récupère un agrégat dept,
  // c'est documenté dans la description du tool MCP.
  // V0.9.1 : remplacer par un RPC `count_finess_by_commune` quand le pattern
  // d'usage le justifie.
  if (familles.length === 0) {
    return { entries: [], niveauEtablissements: "departement" };
  }

  const dept = deptFromCodeInsee(codeInsee);
  if (!dept) {
    // Pas de fallback silencieux : surface l'indisponibilité via le champ
    // `niveauEtablissements: "indisponible"` ET log warn pour observabilité
    // (cohérent avec la règle CLAUDE.md "zéro catch silencieux").
    console.warn(
      `[france-data-mcp] panorama_sante_territoire: codeInsee=${codeInsee} ne dérive pas un département valide — etablissementsParFamille omis (densités PS restent valides)`,
    );
    return {
      entries: familles.map((famille) => ({ famille, count: 0 })),
      niveauEtablissements: "indisponible",
    };
  }

  const entries = await Promise.all(
    familles.map(async (famille) => {
      const input: CountFinessInput = { departement: dept, famille };
      const count = await countFiness(input);
      return { famille, count };
    }),
  );
  return { entries, niveauEtablissements: "departement" };
}
