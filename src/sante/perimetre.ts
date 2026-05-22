/**
 * Déclaration explicite de la « lentille » de chaque source de données.
 *
 * Chaque référentiel (FINESS, Ameli, RPPS) ne contient qu'une projection de la
 * réalité : FINESS classe un site sous UNE catégorie dominante, Ameli ne voit
 * que le libéral conventionné, RPPS est le registre le plus complet. Un tool
 * de comptage qui restitue un résultat filtré SANS déclarer sa lentille induit
 * un undercount silencieux (cf. cadrage docs/plans/completude-lentilles-sources.md).
 *
 * Ce module fournit les descripteurs `Perimetre` ; ils sont injectés dans la
 * sortie des tools au boundary `api/tools.ts` via `withPerimetre`.
 */
import type { FinessFamilleQuery } from "./finess-categories.js";

/** Descripteur de lentille — ce qu'un comptage inclut, exclut, et sa note. */
export interface Perimetre {
  /** Source amont (ex. "FINESS / DREES"). */
  source: string;
  /** Identifiant court et stable de la lentille (ex. "categorie_dominante"). */
  lens: string;
  /** Ce que le résultat compte effectivement. */
  compte: string;
  /** Ce que le résultat exclut structurellement. */
  exclut: string;
  /** Note lisible — à restituer telle quelle au lecteur final. */
  completeness_note: string;
}

const FINESS_LENS_BASE =
  "FINESS classe chaque établissement géographique sous UNE catégorie " +
  "administrative dominante. Une activité hébergée dans un site classé sous " +
  "une autre catégorie n'est pas comptée par un filtre de famille.";

/**
 * Compléments de note spécifiques à une famille dont la lentille mord fort.
 * Une famille absente de cette table n'ajoute aucun rider (note de base seule).
 */
const FAMILLE_RIDERS: Partial<Record<FinessFamilleQuery, string>> = {
  labo:
    "La biologie hospitalière (plateaux des CHR/CH/CLCC) est classée sous la " +
    "catégorie de l'hôpital, pas sous `labo` — plusieurs centaines de plateaux " +
    "sont hors de ce comptage.",
  imagerie:
    "FINESS ne répertorie quasiment pas les cabinets d'imagerie comme " +
    "établissements géographiques : la famille `imagerie` renvoie le plus " +
    "souvent 0 résultat. L'imagerie de ville se trouve via les radiologues " +
    "(tools RPPS).",
  pharmacie:
    "Les pharmacies à usage intérieur (PUI) des hôpitaux sont classées sous " +
    "la catégorie de l'hôpital, pas sous `pharmacie`.",
};

/**
 * Construit le descripteur de lentille pour un comptage FINESS filtré par
 * familles. Les riders des familles présentes sont cumulés dans la note.
 */
export function finessFamillePerimetre(
  familles: readonly FinessFamilleQuery[] | undefined,
): Perimetre {
  const list = familles ?? [];
  const riders = list.map((f) => FAMILLE_RIDERS[f]).filter((r): r is string => r !== undefined);
  return {
    source: "FINESS / DREES",
    lens: "categorie_dominante",
    compte:
      list.length > 0
        ? `Établissements dont la catégorie FINESS principale relève de : ${list.join(", ")}.`
        : "Tous les établissements FINESS, quelle que soit la catégorie.",
    exclut:
      "Les activités secondaires hébergées dans un établissement classé sous " +
      "une autre catégorie.",
    completeness_note: [FINESS_LENS_BASE, ...riders].join(" "),
  };
}

/** Lentille des tools Ameli — libéral conventionné, par construction. */
export const AMELI_PERIMETRE: Perimetre = {
  source: "Annuaire santé Ameli / CNAM",
  lens: "liberal_conventionne",
  compte: "Professionnels de santé en exercice libéral conventionné (soins de ville).",
  exclut:
    "Les praticiens salariés (hôpital public, centres de santé, salariat) — " +
    "soit ~49 % de l'effectif soignant recensé au RPPS.",
  completeness_note:
    "Pour dénombrer TOUS les professionnels d'une spécialité sur un " +
    "territoire, salariés inclus, utiliser les tools RPPS " +
    "(`professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`). Ameli " +
    "répond aux questions de conventionnement, secteur et tarifs.",
};

/** Lentille des tools RPPS — le registre le plus complet. */
export const RPPS_PERIMETRE: Perimetre = {
  source: "RPPS / Annuaire santé ANS",
  lens: "registre_complet",
  compte:
    "Professionnels de santé enregistrés, tous modes d'exercice " + "(libéral, salarié, mixte).",
  exclut:
    "Rien par construction — mais `mode_exercice` est non renseigné sur " + "~16 % des fiches.",
  completeness_note:
    "Source la plus complète pour dénombrer une population de professionnels " +
    "sur un territoire.",
};
