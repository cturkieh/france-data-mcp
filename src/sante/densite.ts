/**
 * Cross-source densité professionnels de santé : RPPS (ANS) ÷ population
 * INSEE Melodi × 100 000.
 *
 * Méthodo DREES par défaut : médecins (`profession_code='10'`) en activité
 * régulière (`mode_exercice ∈ {'1','2','3'}` = libéral / salarié / mixte),
 * hors étudiants (E) et hors agents publics (M sauf si demandé). Le caller
 * peut surcharger les filtres pour calculer la densité d'une autre profession
 * (infirmiers, pharmaciens, sages-femmes…) ou d'une spécialité (cardiologues
 * via `savoir_faire_code`).
 *
 * Le flag `compareNational=true` ajoute un calcul similaire au niveau France
 * entière (DOM inclus, méthodo DREES) + l'écart relatif en pourcentage,
 * permettant au LLM de qualifier "sous-doté" / "sur-doté".
 *
 * Source de vérité : ce module n'expose AUCUNE interprétation métier (pas
 * de seuil "désert médical", pas de qualification automatique). Le ratio
 * brut est retourné, le caller applique sa propre grille de lecture.
 */

import { round2 } from "../core/numbers.js";
import { plmDept } from "../territoire/commune-index.js";
import {
  type PopulationData,
  getPopulationByCommune,
  getPopulationByDept,
  getPopulationFrance,
} from "../territoire/insee-melodi.js";
import type { FinessFamilleQuery } from "./finess-categories.js";
import { type CountFinessInput, countFiness } from "./finess-db.js";
import {
  type CountRppsByCommuneInput,
  type CountRppsInput,
  assertKnownRppsCodes,
  countRpps,
  countRppsByCommune,
  resolveCategorieCodes,
} from "./rpps-db.js";
import { RPPS_MODE_EXERCICE, RPPS_PROFESSION } from "./rpps-types.js";
import { SOURCE_LABELS } from "./sources.js";

/** Code profession ANS pour Médecin (TRE_R94). Reexport pour rétro-compat ;
 * la source unique est `RPPS_PROFESSION.MEDECIN` dans rpps-types.ts. */
export const PROFESSION_CODE_MEDECIN = RPPS_PROFESSION.MEDECIN;

/**
 * Modes d'exercice composant l'« activité régulière » au sens DREES :
 * libéral (L), salarié (S), mixte (M). Exclut remplaçants (R), bénévoles (B),
 * autres (A) — qui ne participent pas aux indicateurs de couverture.
 *
 * IMPORTANT : les codes ANS sont ALPHABÉTIQUES en base RPPS, pas numériques
 * (cf. rpps-types.ts RPPS_MODE_EXERCICE). V0.8.0 utilisait à tort `["1","2","3"]`
 * → 0 match → densité=0 silencieux. Régression chopped en smoke test prod
 * post-publish, fix V0.8.1.
 */
export const MODE_EXERCICE_ACTIVITE_REGULIERE = [
  RPPS_MODE_EXERCICE.LIBERAL,
  RPPS_MODE_EXERCICE.SALARIE,
  RPPS_MODE_EXERCICE.MIXTE,
] as const;

const PER_100K_FACTOR = 100_000;

/**
 * Décrit la population réellement comptée selon les filtres. Le texte par
 * défaut (médecins activité régulière, méthodo DREES) n'est exact que pour
 * `profession_code` médecin sans `savoir_faire_code` — l'annoncer tel quel
 * pour un autre filtre était trompeur (audit B7).
 */
function buildMethodologie(professionCode: string, savoirFaireCode: string | null): string {
  const formula = "Densité = count(RPPS matching filtres) / population municipale × 100 000.";
  if (professionCode === PROFESSION_CODE_MEDECIN && !savoirFaireCode) {
    return `${formula} Population comptée : médecins en activité régulière (libéral + salarié + mixte) hors étudiants — méthodo DREES.`;
  }
  const specialite = savoirFaireCode ? ` spécialité savoir_faire '${savoirFaireCode}'` : "";
  const profession =
    professionCode === PROFESSION_CODE_MEDECIN
      ? "médecins"
      : `PS profession ANS '${professionCode}'`;
  return `${formula} Population comptée : ${profession}${specialite} selon les filtres mode_exercice fournis (voir parametres.modeExerciceCodes).`;
}

export interface DensiteProfessionnelsSanteInput {
  /**
   * Code département (2-3 chars). Exactement UN des deux entre `departement`
   * et `codeInsee` est requis. Le département agrège tous les arrondissements
   * (Paris 75, Lyon 69, Marseille 13) — c'est le bon niveau pour la densité
   * « ville métropole » au sens DREES.
   */
  departement?: string;
  /**
   * Code INSEE commune 5 chars (V0.9). Exclusif avec `departement`. Pour
   * Paris/Lyon/Marseille, le code INSEE correspond à un arrondissement précis
   * (ex 75108 Paris 8e) — utiliser `departement` pour la métropole entière.
   */
  codeInsee?: string;
  /** Code profession ANS. Default `'10'` (Médecin). */
  professionCode?: string | null;
  /** Code savoir_faire (spécialité, ex 'SM04' Cardiologie). */
  savoirFaireCode?: string | null;
  /**
   * Codes mode_exercice ANS. Default `['L','S','M']` (activité régulière DREES).
   * Passer un subset (ex `['L']` libéral seul) pour spécialiser. `[]` ou `null`
   * → pas de filtre (tous statuts inclus, comportement non-DREES).
   */
  modeExerciceCodes?: string[] | null;
  /** Codes catégorie ANS. Default `['C','M']` (Civil + Militaire actifs). */
  categorieCodes?: string[];
  /**
   * Si true, ajoute le même calcul au niveau national + l'écart relatif.
   * Coût : 1 appel RPC count supplémentaire (sans filtre zone) +
   * 1 appel Melodi (FRANCE-F, cacheable). Recommandé pour "désert médical".
   */
  compareNational?: boolean;
}

export interface DensiteResult {
  /** Code zone analysée (dept ou code INSEE commune). */
  zone: string;
  /** Niveau géographique analysé. Utile pour le LLM pour interpréter. */
  niveau: "departement" | "commune";
  /** Nombre de PS matching les filtres dans la zone. */
  countPs: number;
  /** Population PMUN de la zone (méthodo DREES). */
  population: number;
  /** Année du recensement INSEE retenue. */
  populationAnnee: number;
  /** Densité = countPs / population × 100 000 (arrondi 2 décimales). */
  densitePour100k: number;
}

export interface DensiteNationale {
  countPs: number;
  population: number;
  populationAnnee: number;
  densitePour100k: number;
}

export interface DensiteComparaison {
  national: DensiteNationale;
  /** Différence relative zone vs national en %. + = sur-doté, - = sous-doté. */
  ecartVsNationalPct: number;
}

export interface DensiteProfessionnelsSanteResult {
  zone: DensiteResult;
  /** Méthodo et filtres appliqués — pour traçabilité côté caller LLM. */
  parametres: {
    professionCode: string | null;
    savoirFaireCode: string | null;
    modeExerciceCodes: string[] | null;
    categorieCodes: string[];
    methodologie: string;
  };
  source: {
    ps: typeof SOURCE_LABELS.rpps;
    population: typeof SOURCE_LABELS.melodi;
  };
  /** Présent uniquement si `compareNational=true`. */
  comparaisonNationale?: DensiteComparaison;
}

function computeDensite(countPs: number, population: number): number {
  if (population <= 0) {
    // Défense en profondeur : population devrait toujours être > 0 (PMUN INSEE
    // est garanti par parseObservations qui throw si absent). Si on arrive ici,
    // c'est qu'un futur refactor a rendu getPopulationFrance / getPopulationByDept
    // tolérant à pop=0. Log pour ne pas masquer silencieusement l'incident.
    console.error(
      `[france-data-mcp] computeDensite: population <= 0 (${population}), countPs=${countPs} — incident upstream Melodi probable`,
    );
    return 0;
  }
  return round2((countPs * PER_100K_FACTOR) / population);
}

function resolveModeExercice(input: DensiteProfessionnelsSanteInput): string[] {
  if (input.modeExerciceCodes === null) return [];
  return input.modeExerciceCodes ?? [...MODE_EXERCICE_ACTIVITE_REGULIERE];
}

/**
 * Construit la shape commune des filtres RPPS (profession + savoir_faire +
 * mode_exercice + categorie). Extraite pour éviter la duplication entre les
 * deux builders dept et commune — une seule source de vérité quand un nouveau
 * filtre est ajouté.
 */
function buildRppsFilters(
  input: DensiteProfessionnelsSanteInput,
  modeExerciceCodes: string[],
): {
  professionCode: string;
  savoirFaireCode: string | null;
  modeExerciceCodes: string[];
  categorieCodes: string[];
} {
  return {
    professionCode: input.professionCode ?? PROFESSION_CODE_MEDECIN,
    savoirFaireCode: input.savoirFaireCode ?? null,
    modeExerciceCodes,
    // Défaut canonique TS-side appliqué à TOUS les callers (V0.10.2). Sans
    // ça, panorama (pas de categorieCodes) divergeait du tool standalone :
    // la RPC a son propre défaut `C`+`M`, le standalone passe `['C']`.
    categorieCodes: [...resolveCategorieCodes(input.categorieCodes)],
  };
}

function buildCountInput(
  input: DensiteProfessionnelsSanteInput,
  departement: string | null,
  modeExerciceCodes: string[],
): CountRppsInput {
  const out: CountRppsInput = buildRppsFilters(input, modeExerciceCodes);
  if (departement !== null) out.departement = departement;
  return out;
}

function buildCountByCommuneInput(
  input: DensiteProfessionnelsSanteInput,
  codeInsee: string,
  modeExerciceCodes: string[],
): CountRppsByCommuneInput {
  return { ...buildRppsFilters(input, modeExerciceCodes), codeInsee };
}

/**
 * Garantit qu'exactement un des deux entre `departement` et `codeInsee` est
 * fourni. RangeError pour mapping JSON-RPC -32602 côté boundary MCP.
 */
function resolveZone(
  input: DensiteProfessionnelsSanteInput,
): { kind: "departement"; code: string } | { kind: "commune"; code: string } {
  const hasDept = typeof input.departement === "string" && input.departement.length > 0;
  const hasInsee = typeof input.codeInsee === "string" && input.codeInsee.length > 0;
  if (hasDept && hasInsee) {
    throw new RangeError(
      "densiteProfessionnelsSante: passer SOIT departement SOIT codeInsee, pas les deux",
    );
  }
  if (!hasDept && !hasInsee) {
    throw new RangeError("densiteProfessionnelsSante: departement ou codeInsee requis");
  }
  return hasInsee
    ? { kind: "commune", code: input.codeInsee as string }
    : { kind: "departement", code: input.departement as string };
}

/**
 * Garde-fou Paris/Lyon/Marseille (audit P1+P2). La densité par commune y est
 * structurellement impossible : les praticiens RPPS sont rattachés aux
 * arrondissements (75101-75120…) tandis qu'INSEE Melodi n'expose la population
 * qu'au niveau commune entière (75056…). Sans ce garde-fou :
 *  - commune-mère 75056 → countPs=0 + population 2,1M → densité 0 (faux
 *    "désert médical" SILENCIEUX) ;
 *  - arrondissement 75108 → Melodi 404 → RangeError au message trompeur
 *    ("commune fusionnée").
 * On lève une RangeError explicite orientant vers `code_dept` (mappe
 * JSON-RPC -32602), AVANT tout appel DB/Melodi. Détection PLM = source
 * unique `plmDept` (territoire/commune-index, autorité PLM du repo).
 */
function assertNotPlmCommune(codeInsee: string): void {
  const dept = plmDept(codeInsee);
  if (dept) {
    throw new RangeError(
      `densiteProfessionnelsSante: la densité par commune n'est pas disponible pour Paris/Lyon/Marseille (code ${codeInsee}). Les praticiens RPPS sont rattachés aux arrondissements alors qu'INSEE n'expose la population qu'à la commune entière. Utiliser code_dept='${dept}' pour la densité ville entière.`,
    );
  }
}

export async function densiteProfessionnelsSante(
  input: DensiteProfessionnelsSanteInput,
): Promise<DensiteProfessionnelsSanteResult> {
  const zoneSpec = resolveZone(input);
  // Garde-fou nomenclature ANS AVANT les counts (dette #1) : un code
  // profession/savoir_faire inconnu — ou un code Ameli homographe — ferait
  // sinon countPs=0 → densité 0 → faux « désert médical » indistinguable
  // d'un vrai zéro. No-op (zéro I/O) si le caller n'a fourni aucun code.
  await assertKnownRppsCodes({
    professionCode: input.professionCode,
    savoirFaireCode: input.savoirFaireCode,
  });
  const modeExerciceCodes = resolveModeExercice(input);
  const filters = buildRppsFilters(input, modeExerciceCodes);

  let countPs: number;
  let populationLookup: PopulationData;

  if (zoneSpec.kind === "commune") {
    assertNotPlmCommune(zoneSpec.code);
    const countInput = buildCountByCommuneInput(input, zoneSpec.code, modeExerciceCodes);
    const [count, popLookup] = await Promise.all([
      countRppsByCommune(countInput),
      getPopulationByCommune(zoneSpec.code),
    ]);
    if (!popLookup.found) {
      // RangeError pour mapping JSON-RPC -32602 (Invalid params) : commune
      // fusionnée ou code invalide = faute caller récupérable, pas une panne.
      throw new RangeError(
        `Population introuvable pour la commune ${zoneSpec.code} via INSEE Melodi (commune peut-être fusionnée ou code invalide) : ${popLookup.message}`,
      );
    }
    countPs = count;
    populationLookup = popLookup;
  } else {
    const countInput = buildCountInput(input, zoneSpec.code, modeExerciceCodes);
    const [count, popLookup] = await Promise.all([
      countRpps(countInput),
      getPopulationByDept(zoneSpec.code),
    ]);
    if (!popLookup.found) {
      throw new RangeError(
        `Population introuvable pour le département ${zoneSpec.code} via INSEE Melodi : ${popLookup.message}`,
      );
    }
    countPs = count;
    populationLookup = popLookup;
  }

  const population = populationLookup.populationMunicipale;
  const zone: DensiteResult = {
    zone: zoneSpec.code,
    niveau: zoneSpec.kind,
    countPs,
    population,
    populationAnnee: populationLookup.annee,
    densitePour100k: computeDensite(countPs, population),
  };

  const result: DensiteProfessionnelsSanteResult = {
    zone,
    parametres: {
      professionCode: filters.professionCode,
      savoirFaireCode: filters.savoirFaireCode,
      modeExerciceCodes:
        modeExerciceCodes.length > 0 ? modeExerciceCodes : [...MODE_EXERCICE_ACTIVITE_REGULIERE],
      categorieCodes: filters.categorieCodes,
      methodologie: buildMethodologie(filters.professionCode, filters.savoirFaireCode),
    },
    source: {
      ps: SOURCE_LABELS.rpps,
      population: SOURCE_LABELS.melodi,
    },
  };

  if (input.compareNational) {
    // Le compare_national reste basé sur countRpps (France entière) — la
    // sémantique "vs national" est identique que la zone soit dept ou commune.
    const nationalInput = buildCountInput(input, null, modeExerciceCodes);
    const [countNational, popFrance] = await Promise.all([
      countRpps(nationalInput),
      getPopulationFrance(),
    ]);
    const popFranceValue = popFrance.populationMunicipale;
    const densiteNationale = computeDensite(countNational, popFranceValue);
    const ecart =
      densiteNationale > 0
        ? round2(((zone.densitePour100k - densiteNationale) / densiteNationale) * 100)
        : 0;
    result.comparaisonNationale = {
      national: {
        countPs: countNational,
        population: popFranceValue,
        populationAnnee: popFrance.annee,
        densitePour100k: densiteNationale,
      },
      ecartVsNationalPct: ecart,
    };
  }

  return result;
}

// --- Densité établissements (FINESS + Melodi) ------------------------------

export interface DensiteEtablissementsSanteInput {
  /** Code département (2-3 chars). Requis. */
  departement: string;
  /**
   * Famille FINESS à compter. Obligatoire — sans filtre, le ratio mélangerait
   * labos, hôpitaux, EHPAD et n'aurait pas de sens.
   */
  famille: FinessFamilleQuery;
  /** Si true, ajoute le calcul France entière + écart relatif. */
  compareNational?: boolean;
}

export interface DensiteEtablissementsResult {
  zone: string;
  countEtablissements: number;
  population: number;
  populationAnnee: number;
  densitePour100k: number;
}

export interface DensiteEtablissementsNationale {
  countEtablissements: number;
  population: number;
  populationAnnee: number;
  densitePour100k: number;
}

export interface DensiteEtablissementsComparaison {
  national: DensiteEtablissementsNationale;
  ecartVsNationalPct: number;
}

export interface DensiteEtablissementsSanteResult {
  zone: DensiteEtablissementsResult;
  parametres: {
    famille: FinessFamilleQuery;
    methodologie: string;
  };
  source: {
    etablissements: typeof SOURCE_LABELS.finess;
    population: typeof SOURCE_LABELS.melodi;
  };
  comparaisonNationale?: DensiteEtablissementsComparaison;
}

function buildFinessCountInput(
  input: DensiteEtablissementsSanteInput,
  departement: string | null,
): CountFinessInput {
  const out: CountFinessInput = { famille: input.famille };
  if (departement !== null) out.departement = departement;
  return out;
}

export async function densiteEtablissementsSante(
  input: DensiteEtablissementsSanteInput,
): Promise<DensiteEtablissementsSanteResult> {
  const [countEtab, populationLookup] = await Promise.all([
    countFiness(buildFinessCountInput(input, input.departement)),
    getPopulationByDept(input.departement),
  ]);

  if (!populationLookup.found) {
    // RangeError pour mapping JSON-RPC -32602 (faute caller récupérable),
    // aligné avec `densiteProfessionnelsSante` (V0.9 /review Passe 2).
    throw new RangeError(
      `Population introuvable pour le département ${input.departement} via INSEE Melodi : ${populationLookup.message}`,
    );
  }

  const population = populationLookup.populationMunicipale;
  const zone: DensiteEtablissementsResult = {
    zone: input.departement,
    countEtablissements: countEtab,
    population,
    populationAnnee: populationLookup.annee,
    densitePour100k: computeDensite(countEtab, population),
  };

  const result: DensiteEtablissementsSanteResult = {
    zone,
    parametres: {
      famille: input.famille,
      methodologie:
        "Densité établissements = count(FINESS catégories famille) / population municipale × 100 000. Famille obligatoire (cf. FINESS_FAMILY_CODES).",
    },
    source: {
      etablissements: SOURCE_LABELS.finess,
      population: SOURCE_LABELS.melodi,
    },
  };

  if (input.compareNational) {
    const [countNational, popFrance] = await Promise.all([
      countFiness(buildFinessCountInput(input, null)),
      getPopulationFrance(),
    ]);
    const popFranceValue = popFrance.populationMunicipale;
    const densiteNationale = computeDensite(countNational, popFranceValue);
    const ecart =
      densiteNationale > 0
        ? round2(((zone.densitePour100k - densiteNationale) / densiteNationale) * 100)
        : 0;
    result.comparaisonNationale = {
      national: {
        countEtablissements: countNational,
        population: popFranceValue,
        populationAnnee: popFrance.annee,
        densitePour100k: densiteNationale,
      },
      ecartVsNationalPct: ecart,
    };
  }

  return result;
}
