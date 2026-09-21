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

export type PermitsResult = {
  couverture: "ok" | "indisponible:no_data";
  logements_autorises_recent: number;
  logements_commences_recent: number;
  par_annee: Record<string, { aut: number; com: number }>;
  habitants_attendus: number;
  annees: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valeur DiDo `TYPE_LGT` du total — partagée avec le script d'ingestion. */
export const SITADEL_TYPE_LGT_TOTAL = "Tous Logements";

/**
 * Années conservées en base EN PLUS de l'année courante (fenêtre du cron). La
 * lecture sert par défaut les 5 dernières années publiées ; la 6e est la marge
 * d'un caller `years: 6`. Source unique écrivain (cron) ↔ lecteur.
 */
export const SITADEL_YEARS_BACK = 5;

/** Ratio habitants/logement retenu pour l'estimation. */
const HABITANTS_PAR_LOGEMENT = 2.2;

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
 * @param opts.years        Nombre d'années servies (défaut 5) : les plus récentes
 *                          PUBLIÉES, pas un intervalle calé sur l'horloge.
 * @param opts.currentYear  Borne haute (défaut : année UTC actuelle).
 *
 * Comportement :
 * - 0 ligne dans la fenêtre → couverture "indisponible:no_data" avec zéros.
 * - Commune connue à 0 logement → couverture "ok" (0 est une donnée).
 * - Erreur DB → console.warn + re-throw (caller composite gère la dégradation).
 */
export async function permitsForCommune(
  insee: string,
  opts?: { years?: number; currentYear?: number },
): Promise<PermitsResult> {
  const years = opts?.years ?? 5;
  const currentYear = opts?.currentYear ?? new Date().getUTCFullYear();
  const commune = parentCommuneInsee(insee);
  if (years > SITADEL_YEARS_BACK + 1) {
    console.warn(
      `${LOG_TAG}(${commune}): fenêtre demandée ${years} ans > ${SITADEL_YEARS_BACK + 1} ans stockés — résultat tronqué aux années en base`,
    );
  }

  // Les `years` dernières années PUBLIÉES, pas `[horloge − years ; horloge]` : en
  // janvier-février l'année civile n'existe pas encore chez le SDES, une fenêtre
  // calée sur l'horloge servirait 4 années au lieu de 5 (−20 % sur le total
  // scoré) en `ok`, sans signal. `currentYear` reste une borne HAUTE.
  const { data, error } = await getUntypedAnonClient()
    .from("sitadel_logements")
    .select("annee, log_aut, log_com")
    .eq("code_insee", commune)
    .lte("annee", currentYear)
    .order("annee", { ascending: false })
    .limit(years);

  if (error) {
    const msg = `${LOG_TAG}(${commune}): DB error [code=${error.code ?? "none"}]: ${error.message}`;
    console.warn(msg);
    throw new Error(msg);
  }

  return buildPermitsResult((data ?? []) as SitadelRow[], commune);
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------

type SitadelRow = { annee: unknown; log_aut: unknown; log_com: unknown };

/**
 * Colonnes INTEGER → PostgREST rend des numbers, mais on coerce quand même au
 * boundary DB (doctrine projet : un type SQL qui dérive en NUMERIC/BIGINT
 * arriverait en string et `+=` concaténerait). `null` testé À PART :
 * `Number(null)` vaut 0, un zéro fini qui passerait pour « 0 logement ».
 * Des lignes en base dont AUCUNE n'est lisible = corruption → throw, jamais
 * `no_data` (« pas de résultat » ≠ « erreur »).
 */
function buildPermitsResult(rows: SitadelRow[], commune: string): PermitsResult {
  const par_annee: Record<string, { aut: number; com: number }> = {};

  for (const row of rows) {
    const annee = Number(row.annee);
    const aut = Number(row.log_aut);
    const com = Number(row.log_com);
    if (
      row.annee == null ||
      row.log_aut == null ||
      row.log_com == null ||
      !Number.isInteger(annee) ||
      !Number.isFinite(aut) ||
      !Number.isFinite(com)
    ) {
      console.warn(`${LOG_TAG}(${commune}): ligne illisible ignorée ${JSON.stringify(row)}`);
      continue;
    }
    par_annee[String(annee)] = { aut, com };
  }

  const annees = Object.keys(par_annee).sort();
  if (rows.length > 0 && annees.length === 0) {
    const msg = `${LOG_TAG}(${commune}): ${rows.length} lignes en base, AUCUNE lisible — corruption, pas une absence de donnée`;
    console.warn(msg);
    throw new Error(msg);
  }
  const entries = Object.values(par_annee);
  const totalAut = entries.reduce((sum, e) => sum + e.aut, 0);

  // Aucune année → tous les totaux valent 0 par construction.
  return {
    couverture: annees.length > 0 ? "ok" : "indisponible:no_data",
    logements_autorises_recent: totalAut,
    logements_commences_recent: entries.reduce((sum, e) => sum + e.com, 0),
    par_annee,
    habitants_attendus: Math.round(totalAut * HABITANTS_PAR_LOGEMENT),
    annees,
  };
}
