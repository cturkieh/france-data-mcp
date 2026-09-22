/**
 * Service permis de construire Sit@del — lu EN BASE (`sitadel_logements`).
 *
 * Source : SDES/DiDo, séries mensuelles communales « Logements autorisés et
 * commencés », recopiées une fois par mois par `scripts/ingest/sitadel.ts`
 * (agrégat commune × année, type « Tous Logements » uniquement — les sous-types
 * « Individuel pur », « Collectif »… double-compteraient).
 *
 * Pourquoi plus d'appel live : l'API DiDo met ~37 s par commune MÊME filtrée
 * (mesuré 2026-09-21), soit 42 des ~45 s de `dynamique_immobiliere`. PAS de
 * repli live quand la commune manque : il ramènerait les 37 s et couplerait
 * l'outil à la disponibilité de DiDo — on rend `indisponible:no_data`.
 * Cf. docs/plans/sitadel-ingestion.md.
 */

import { getUntypedAnonClient } from "../storage/supabase.js";
import { parentCommuneInsee } from "../territoire/commune-index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Année la plus récente publiée quand elle est INCOMPLÈTE (< 12 mois chez le
 * SDES, qui publie avec ~2 mois de retard). Servie à part : sommée aux années
 * pleines, elle passait pour comparable (Villejuif 2026 : 68 logements sur
 * 7 mois lus comme une chute de 80 % face aux 328 de 2025).
 */
export type PermitsAnneeEnCours = {
  annee: number;
  /** Mois publiés dans l'année (1-11). */
  mois_couverts: number;
  logements_autorises: number;
  logements_commences: number;
};

/**
 * Fenêtre exploitable : au moins une année hors année en cours, donc un total
 * qui a un sens. `partiel:*` = total SERVI mais non comparable, non scorable :
 * - `fenetre_courte` : moins de `years` années en base (commune récente) ;
 * - `annees_incompletes` : une année de la fenêtre a moins de 12 mois publiés
 *   (mois perdu par le SDES — les communes nouvelles naissent au 1er janvier,
 *   une année amputée n'est jamais légitime) ;
 * - `lignes_illisibles` : une ligne rejetée au parse a amputé la fenêtre.
 */
export type PermitsFenetre = {
  couverture:
    | "ok"
    | "partiel:fenetre_courte"
    | "partiel:annees_incompletes"
    | "partiel:lignes_illisibles";
  /** Somme des années de `annees` uniquement. */
  logements_autorises_recent: number;
  logements_commences_recent: number;
  /** Années de la fenêtre avec leurs mois publiés (12 sauf `partiel:annees_incompletes`). */
  par_annee: Record<string, { aut: number; com: number; mois_couverts: number }>;
  /** Hors de `annees`/`par_annee` et de TOUT total. `null` : dernière année publiée complète. */
  annee_en_cours: PermitsAnneeEnCours | null;
  habitants_attendus: number;
  /** Années de la fenêtre, triées croissant. Non vide par construction. */
  annees: [string, ...string[]];
};

/**
 * Aucune année pleine : il N'Y A PAS de total — pas de zéros à lire (le bug
 * « 0 servi comme fiable » a frappé deux fois en prod avec des zéros typés).
 */
export type PermitsNoData = {
  couverture: "indisponible:no_data";
  /** Commune apparue cette année : seule donnée disponible, jamais un total. */
  annee_en_cours: PermitsAnneeEnCours | null;
};

export type PermitsResult = PermitsFenetre | PermitsNoData;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valeur DiDo `TYPE_LGT` du total — partagée avec le script d'ingestion. */
export const SITADEL_TYPE_LGT_TOTAL = "Tous Logements";

/**
 * Années conservées en base EN PLUS de la dernière publiée (fenêtre du cron).
 * La lecture sert par défaut les 5 dernières années PLEINES ; la 6e étiquette
 * est le budget de l'année en cours, pas une marge. Source unique écrivain
 * (cron) ↔ lecteur.
 */
export const SITADEL_YEARS_BACK = 5;

/**
 * Fenêtre servie par défaut. Doit tenir dans la rétention du cron
 * (`SITADEL_YEARS_BACK + 1` étiquettes, dont l'année en cours) — sinon toute
 * la France ressort `partiel:fenetre_courte` (test garde-fou).
 */
export const SITADEL_DEFAULT_YEARS = 5;

/** Ratio habitants/logement retenu pour l'estimation. */
const HABITANTS_PAR_LOGEMENT = 2.2;

/**
 * Une année est pleine quand ses 12 mois sont publiés (`mois_couverts`). Même
 * définition côté cron (garde « années pleines sans leurs 12 mois ») : c'est
 * ce garde qui rend vraie l'hypothèse de la lecture.
 */
export const MOIS_PAR_AN = 12;

const LOG_TAG = "[france-data-mcp] sitadel permitsForCommune";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Retourne les statistiques de permis de construire pour une commune.
 *
 * @param insee  Code INSEE commune (courant, recalé géographie actuelle). Un
 *               arrondissement Paris/Lyon/Marseille est replié sur sa commune :
 *               Sit@del ne connaît que 75056 / 69123 / 13055.
 * @param opts.years        Nombre d'années PLEINES servies (défaut 5) : les plus
 *                          récentes PUBLIÉES, pas un intervalle calé sur l'horloge.
 * @param opts.currentYear  Borne haute (défaut : année UTC actuelle).
 *
 * Comportement :
 * - La dernière année publiée, si incomplète, sort dans `annee_en_cours` et
 *   n'entre dans AUCUN total ; les `years` années suivantes forment la fenêtre.
 * - 0 ligne dans la fenêtre → "indisponible:no_data" : AUCUN total (l'union ne
 *   porte pas de zéros), seul `annee_en_cours` peut être servi.
 * - Commune connue à 0 logement → couverture "ok" (0 est une donnée).
 * - Erreur DB → console.warn + re-throw (caller composite gère la dégradation).
 */
export async function permitsForCommune(
  insee: string,
  opts?: { years?: number; currentYear?: number },
): Promise<PermitsResult> {
  const years = opts?.years ?? SITADEL_DEFAULT_YEARS;
  const currentYear = opts?.currentYear ?? new Date().getUTCFullYear();
  if (!Number.isInteger(years) || years < 1) {
    throw new RangeError(`years doit être un entier ≥ 1, reçu ${years}`);
  }
  if (!Number.isInteger(currentYear)) {
    throw new RangeError(`currentYear doit être un entier, reçu ${currentYear}`);
  }
  const commune = parentCommuneInsee(insee);
  if (years > SITADEL_YEARS_BACK) {
    console.warn(
      `${LOG_TAG}(${commune}): fenêtre demandée ${years} ans > ${SITADEL_YEARS_BACK} années pleines garanties en base — peut ressortir partiel:fenetre_courte`,
    );
  }

  // Les `years` dernières années PUBLIÉES, pas `[horloge − years ; horloge]` : en
  // janvier-février l'année civile n'existe pas encore chez le SDES, une fenêtre
  // calée sur l'horloge servirait 4 années au lieu de 5 (−20 % sur le total
  // scoré) en `ok`, sans signal. `currentYear` reste une borne HAUTE.
  // `years + 1` : la ligne la plus récente peut être l'année en cours, qui ne
  // compte pas dans la fenêtre.
  const { data, error } = await getUntypedAnonClient()
    .from("sitadel_logements")
    .select("annee, log_aut, log_com, mois_couverts")
    .eq("code_insee", commune)
    .lte("annee", currentYear)
    .order("annee", { ascending: false })
    .limit(years + 1);

  if (error) {
    const msg = `${LOG_TAG}(${commune}): DB error [code=${error.code ?? "none"}]: ${error.message}`;
    console.warn(msg);
    throw new Error(msg);
  }

  return buildPermitsResult((data ?? []) as SitadelRow[], commune, years, currentYear);
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------

type SitadelRow = { annee: unknown; log_aut: unknown; log_com: unknown; mois_couverts: unknown };

/** Ligne lue en base, complète ou non (`mois_couverts` 1-12). Interne. */
type SitadelAnnee = {
  annee: number;
  mois_couverts: number;
  logements_autorises: number;
  logements_commences: number;
};

/**
 * Colonnes INTEGER/SMALLINT → PostgREST rend des numbers, mais on coerce quand
 * même au boundary DB (doctrine projet : un type SQL qui dérive en
 * NUMERIC/BIGINT arriverait en string et `+=` concaténerait). `null` testé À
 * PART : `Number(null)` vaut 0, un zéro fini qui passerait pour « 0 logement ».
 */
function parseRow(row: SitadelRow): SitadelAnnee | null {
  if (row.annee == null || row.log_aut == null || row.log_com == null) return null;
  const annee = Number(row.annee);
  const logements_autorises = Number(row.log_aut);
  const logements_commences = Number(row.log_com);
  const mois_couverts = Number(row.mois_couverts);
  if (
    !Number.isInteger(annee) ||
    !Number.isFinite(logements_autorises) ||
    !Number.isFinite(logements_commences) ||
    !Number.isInteger(mois_couverts) ||
    mois_couverts < 1 ||
    mois_couverts > MOIS_PAR_AN
  ) {
    return null;
  }
  return { annee, mois_couverts, logements_autorises, logements_commences };
}

/**
 * SEUL producteur de `PermitsAnneeEnCours` : porte le `mois_couverts < 12` que
 * le système de types ne peut pas exprimer.
 */
function asAnneeEnCours(a: SitadelAnnee | undefined): PermitsAnneeEnCours | null {
  return a && a.mois_couverts < MOIS_PAR_AN ? a : null;
}

/**
 * Sépare l'année en cours des années de la fenêtre puis somme ces dernières.
 *
 * Seule la ligne la PLUS RÉCENTE peut être « en cours » ; une année ancienne
 * à moins de 12 mois reste dans la fenêtre mais dégrade en
 * `partiel:annees_incompletes`. Les lignes arrivent dans n'importe quel ordre
 * (fonction pure, tri local). Des lignes en base dont AUCUNE n'est lisible =
 * corruption → throw, jamais `no_data` (« pas de résultat » ≠ « erreur »).
 */
function buildPermitsResult(
  rows: SitadelRow[],
  commune: string,
  years: number,
  currentYear: number,
): PermitsResult {
  const parsed: SitadelAnnee[] = [];
  for (const row of rows) {
    const p = parseRow(row);
    if (p) parsed.push(p);
    else console.warn(`${LOG_TAG}(${commune}): ligne illisible ignorée ${JSON.stringify(row)}`);
  }
  if (rows.length > 0 && parsed.length === 0) {
    const msg = `${LOG_TAG}(${commune}): ${rows.length} lignes en base, AUCUNE lisible — corruption, pas une absence de donnée`;
    console.warn(msg);
    throw new Error(msg);
  }

  parsed.sort((a, b) => b.annee - a.annee);
  const annee_en_cours = asAnneeEnCours(parsed[0]);
  // Le SDES publie à ~2 mois : une « année en cours » plus vieille que l'an
  // dernier est une série TARIE (fusion de commune, cron cassé), pas une année
  // partielle — angle mort du post-mortem DREES. Elle reste hors total (la
  // sommer sous-compterait) ; seul le signal change.
  if (annee_en_cours && annee_en_cours.annee < currentYear - 1) {
    console.warn(
      `${LOG_TAG}(${commune}): dernière année publiée ${annee_en_cours.annee} (${annee_en_cours.mois_couverts} mois) < ${currentYear - 1} — série tarie, pas une « année en cours »`,
    );
  }
  const pleines = (annee_en_cours ? parsed.slice(1) : parsed).slice(0, years);

  const par_annee: PermitsFenetre["par_annee"] = {};
  const annees: string[] = [];
  const incompletes: string[] = [];
  let totalAut = 0;
  let totalCom = 0;
  // Parcours décroissant → `annees` empilé à rebours ressort croissant.
  for (const { annee, mois_couverts, logements_autorises, logements_commences } of pleines) {
    par_annee[String(annee)] = {
      aut: logements_autorises,
      com: logements_commences,
      mois_couverts,
    };
    annees.unshift(String(annee));
    if (mois_couverts < MOIS_PAR_AN) incompletes.push(`${annee}:${mois_couverts}m`);
    totalAut += logements_autorises;
    totalCom += logements_commences;
  }

  // Aucune année pleine → PAS de total, même si une année en cours existe
  // (elle reste servie) : un total « 0, fiable » sur une commune apparue cette
  // année serait le piège d'origine.
  const [premiere, ...reste] = annees;
  if (premiere === undefined) return { couverture: "indisponible:no_data", annee_en_cours };

  // Un total dont la fenêtre n'est pas celle annoncée se compare par accident
  // (même classe de bug que l'année en cours) → `partiel`, jamais `ok`. Une
  // seule raison servie, la plus en amont : ligne rejetée > mois manquants >
  // fenêtre courte.
  const illisibles = rows.length - parsed.length;
  let couverture: PermitsFenetre["couverture"] = "ok";
  if (illisibles > 0) {
    couverture = "partiel:lignes_illisibles";
    console.warn(
      `${LOG_TAG}(${commune}): ${illisibles}/${rows.length} ligne(s) illisible(s) — fenêtre amputée, total servi en partiel:lignes_illisibles`,
    );
  } else if (incompletes.length > 0) {
    couverture = "partiel:annees_incompletes";
    console.warn(
      `${LOG_TAG}(${commune}): année(s) à moins de ${MOIS_PAR_AN} mois publiés dans la fenêtre (${incompletes.join(" ")}) — total sous-compté, servi en partiel:annees_incompletes`,
    );
  } else if (annees.length < years) {
    couverture = "partiel:fenetre_courte";
    console.warn(
      `${LOG_TAG}(${commune}): ${annees.length} année(s) en base pour ${years} demandées — total servi en partiel:fenetre_courte`,
    );
  }
  return {
    couverture,
    logements_autorises_recent: totalAut,
    logements_commences_recent: totalCom,
    par_annee,
    annee_en_cours,
    habitants_attendus: Math.round(totalAut * HABITANTS_PAR_LOGEMENT),
    annees: [premiere, ...reste],
  };
}
