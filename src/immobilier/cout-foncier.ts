/**
 * `coutFoncier` — prix foncier et bâti au m² dans un rayon donné.
 *
 * Wrapper INFO-ONLY sur DVF. Ne contribue PAS au score de la dynamique
 * immobilière — usage : affichage dans le rapport d'implantation.
 */

import { aggregatePrix, dvfInRadius } from "./dvf.js";

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

/**
 * Retourne les prix au m² (médiane, P25, P75) dans le rayon indiqué à partir
 * des données DVF (mutations foncières). Les erreurs de `dvfInRadius` sont
 * propagées sans être swallowées.
 */
export async function coutFoncier(input: CoutFoncierInput): Promise<CoutFoncierResult> {
  const { lat, lon, rayon_km } = input;

  const rows = await dvfInRadius(lat, lon, rayon_km);

  if (rows.length === 0) {
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

  const agg = aggregatePrix(rows);

  // Dériver la période depuis les dates de mutation (min..max year)
  const years = rows
    .map((r) => {
      const y = Number.parseInt(r.date_mutation.slice(0, 4), 10);
      return Number.isFinite(y) ? y : null;
    })
    .filter((y): y is number => y !== null);

  let periode: string | null = null;
  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    periode = minYear === maxYear ? String(minYear) : `${minYear}–${maxYear}`;
  }

  return {
    couverture: "ok",
    prix_m2_median: agg.prix_m2_median,
    prix_m2_p25: agg.prix_m2_p25,
    prix_m2_p75: agg.prix_m2_p75,
    n_ventes: agg.n_ventes,
    periode,
    source: "DGFiP DVF",
  };
}
