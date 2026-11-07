/**
 * `coutFoncier` — prix foncier et bâti au m² dans un rayon donné.
 *
 * Wrapper INFO-ONLY sur DVF. Ne contribue PAS au score de la dynamique
 * immobilière — usage : affichage dans le rapport d'implantation.
 */

import { dvfStatsInRadius } from "./dvf.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoutFoncierInput {
  lat: number;
  lon: number;
  rayon_km: number;
}

export interface CoutFoncierResult {
  couverture: "ok" | "indisponible:no_data";
  prix_m2_median: number | null;
  prix_m2_p25: number | null;
  prix_m2_p75: number | null;
  n_ventes: number;
  periode: string | null;
  source: "DGFiP DVF";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Année seule si les deux dates tombent la même année, sinon `2025–2026`. */
function periodeFromDates(dateMin: string | null, dateMax: string | null): string | null {
  if (!dateMin || !dateMax) return null;
  const minYear = dateMin.slice(0, 4);
  const maxYear = dateMax.slice(0, 4);
  return minYear === maxYear ? minYear : `${minYear}–${maxYear}`;
}

/**
 * Retourne les prix au m² (médiane, P25, P75) dans le rayon indiqué à partir
 * des statistiques DVF calculées en base. Les erreurs de `dvfStatsInRadius` sont
 * propagées sans être swallowées.
 */
export async function coutFoncier(input: CoutFoncierInput): Promise<CoutFoncierResult> {
  const { lat, lon, rayon_km } = input;

  const stats = await dvfStatsInRadius(lat, lon, rayon_km);

  if (stats.n_lignes === 0) {
    return {
      couverture: "indisponible:no_data",
      prix_m2_median: null,
      prix_m2_p25: null,
      prix_m2_p75: null,
      n_ventes: 0,
      periode: null,
      source: "DGFiP DVF",
    };
  }

  return {
    couverture: "ok",
    prix_m2_median: stats.prix_m2_median,
    prix_m2_p25: stats.prix_m2_p25,
    prix_m2_p75: stats.prix_m2_p75,
    n_ventes: stats.n_ventes,
    periode: periodeFromDates(stats.date_min, stats.date_max),
    source: "DGFiP DVF",
  };
}
