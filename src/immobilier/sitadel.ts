/**
 * Service permis de construire Sit@del — API DiDo SDES (live, par commune).
 *
 * Source : SDES/DiDo — fichier CSV par commune, URL canonique :
 *   https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles/
 *   577a8a66-4157-4787-b00a-031b61afea61/csv?withColumnName=true&CODE_INSEE=eq:<INSEE>
 *
 * Pas d'ingestion, pas de table DB. Appel live, résultat agrégé à la volée.
 *
 * Séparateur `;`, chaque valeur double-quotée.
 * En-tête : "ANNEE";"MOIS";"CODE_INSEE";"TYPE_LGT";"LOG_AUT";"LOG_COM";"SDP_AUT";"SDP_COM"
 *
 * ⚠️ TYPE_LGT contient des sous-types ("Individuel pur", "Collectif", …).
 *    On ne conserve QUE les rows "Tous Logements" (total) pour éviter le double-comptage.
 */

import { parseCsv } from "../core/csv.js";
import { DEFAULT_USER_AGENT } from "../core/http.js";

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

const DIDO_BASE_URL =
  "https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles/577a8a66-4157-4787-b00a-031b61afea61/csv";

const TYPE_LGT_TOTAL = "Tous Logements";

/** Ratio habitants/logement retenu pour l'estimation. */
const HABITANTS_PAR_LOGEMENT = 2.2;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Retourne les statistiques de permis de construire pour une commune.
 *
 * @param insee  Code INSEE commune (courant, recalé géographie actuelle).
 * @param opts.years        Fenêtre temporelle en années (défaut 5).
 * @param opts.currentYear  Année courante (défaut : année UTC actuelle).
 *
 * Comportement :
 * - 0 rows "Tous Logements" dans la fenêtre → couverture "indisponible:no_data" avec zéros.
 * - Erreur réseau/HTTP → console.warn + re-throw (caller composite gère la dégradation).
 */
export async function permitsForCommune(
  insee: string,
  opts?: { years?: number; currentYear?: number },
): Promise<PermitsResult> {
  const years = opts?.years ?? 5;
  const currentYear = opts?.currentYear ?? new Date().getUTCFullYear();
  const firstYear = currentYear - years + 1;

  const url = `${DIDO_BASE_URL}?withColumnName=true&CODE_INSEE=eq:${insee}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/csv,*/*",
      },
    });
  } catch (err) {
    const msg = `[france-data-mcp] sitadel permitsForCommune(${insee}): network error: ${(err as Error).message}`;
    console.warn(msg);
    throw new Error(msg);
  }

  if (!response.ok) {
    const msg = `[france-data-mcp] sitadel permitsForCommune(${insee}): HTTP ${response.status}`;
    console.warn(msg);
    throw new Error(msg);
  }

  const text = await response.text();
  return parsePermitsCsv(text, firstYear);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse le CSV DiDo et agrège les logements autorisés/commencés.
 * Conserve uniquement les rows TYPE_LGT === "Tous Logements" dans la fenêtre.
 */
function parsePermitsCsv(csvText: string, firstYear: number): PermitsResult {
  const rows = parseCsv(csvText, { delimiter: ";" });

  const par_annee: Record<string, { aut: number; com: number }> = {};

  for (const row of rows) {
    const typeLgt = row.TYPE_LGT ?? "";
    if (typeLgt !== TYPE_LGT_TOTAL) continue;

    const anneeRaw = row.ANNEE ?? "";
    const annee = Number(anneeRaw);
    if (!Number.isFinite(annee) || annee < firstYear) continue;

    const aut = Number(row.LOG_AUT ?? "0");
    const com = Number(row.LOG_COM ?? "0");

    const key = anneeRaw;
    const existing = par_annee[key];
    if (existing) {
      existing.aut += Number.isFinite(aut) ? aut : 0;
      existing.com += Number.isFinite(com) ? com : 0;
    } else {
      par_annee[key] = {
        aut: Number.isFinite(aut) ? aut : 0,
        com: Number.isFinite(com) ? com : 0,
      };
    }
  }

  const annees = Object.keys(par_annee).sort();

  if (annees.length === 0) {
    return {
      couverture: "indisponible:no_data",
      logements_autorises_recent: 0,
      logements_commences_recent: 0,
      par_annee: {},
      habitants_attendus: 0,
      annees: [],
    };
  }

  let totalAut = 0;
  let totalCom = 0;
  for (const key of annees) {
    const entry = par_annee[key];
    if (entry) {
      totalAut += entry.aut;
      totalCom += entry.com;
    }
  }

  return {
    couverture: "ok",
    logements_autorises_recent: totalAut,
    logements_commences_recent: totalCom,
    par_annee,
    habitants_attendus: Math.round(totalAut * HABITANTS_PAR_LOGEMENT),
    annees,
  };
}
