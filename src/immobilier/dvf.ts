/**
 * Service DVF (Demandes de Valeurs Foncières) — lecture de la table nationale.
 *
 * `dvf_mutations` est chargée par un cron mensuel qui détecte les livraisons
 * semestrielles et garde les 12 derniers mois publiés. Médiane et quartiles sont
 * calculés DANS la base par la RPC `dvf_stats_in_radius`, sans échantillonnage : lire un échantillon
 * plafonné puis agréger côté TypeScript faussait le prix (mesuré à 50 km de
 * Paris 15e : médiane exacte 4 833 €/m², 500 lignes les plus récentes 8 370 €/m²).
 */

import { formatRpcError, validateCoords, validateRadiusKm } from "../sante/db-helpers.js";
import { getUntypedAnonClient } from "../storage/supabase.js";

const RPC = "dvf_stats_in_radius";

export interface DvfStats {
  /** Lignes retenues du rayon. `0` = zone non couverte (57, 67, 68, 976) ou aucune vente retenue. */
  n_lignes: number;
  /**
   * Lignes de vente bâtie retenues, celles qui portent les prix ci-dessous. Retenues =
   * géolocalisées, une ligne par mutation, commune, date et type de local : une vente
   * de plusieurs lots du même type compte pour une ligne.
   */
  n_ventes: number;
  prix_m2_median: number | null;
  prix_m2_p25: number | null;
  prix_m2_p75: number | null;
  /** Mutations avec `surface_terrain > 0`, bâti compris : pas seulement des terrains nus. */
  n_terrains: number;
  prix_terrain_median: number | null;
  /** Date ISO `YYYY-MM-DD` de la mutation la plus ancienne, null si `n_lignes` = 0. */
  date_min: string | null;
  /** Date ISO `YYYY-MM-DD` de la mutation la plus récente, null si `n_lignes` = 0. */
  date_max: string | null;
}

function contractError(detail: string): Error {
  return new Error(`[france-data-mcp] ${RPC}: RPC contract violation — ${detail}`);
}

/**
 * `null` si la valeur n'est pas un nombre fini. Plus strict qu'un `Number(v)` nu :
 * `Number("")`, `Number(null)` et `Number(false)` valent 0, soit un faux zéro servi
 * comme une donnée.
 */
function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

/** Un compteur illisible lève : le remplacer par 0 ferait passer une panne pour « aucune vente ». */
function readCount(row: Record<string, unknown>, field: string): number {
  const x = finiteOrNull(row[field]);
  if (x === null || !Number.isInteger(x) || x < 0) {
    throw contractError(`${field} illisible (raw=${JSON.stringify(row[field])})`);
  }
  return x;
}

/** `null` est légitime (aucune vente) ; une clé absente ou une valeur illisible ne l'est pas. */
function readNullableNumber(row: Record<string, unknown>, field: string): number | null {
  const raw = row[field];
  if (raw === null) return null;
  const x = finiteOrNull(raw);
  if (x === null) {
    throw contractError(`${field} illisible (raw=${JSON.stringify(raw)})`);
  }
  return x;
}

function readNullableDate(row: Record<string, unknown>, field: string): string | null {
  const raw = row[field];
  if (raw === null) return null;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    throw contractError(`${field} illisible (raw=${JSON.stringify(raw)})`);
  }
  return raw;
}

/**
 * Statistiques DVF dans un rayon. La RPC rend toujours exactement une ligne
 * (agrégat sans `GROUP BY`), y compris sans vente : `n_lignes` = 0 et médianes null.
 * Toute erreur RPC remonte, RPC absente (`PGRST202`) comprise : jamais « 0 vente ».
 */
export async function dvfStatsInRadius(
  lat: number,
  lon: number,
  radiusKm: number,
): Promise<DvfStats> {
  validateCoords(lat, lon);
  validateRadiusKm(radiusKm);

  const { data, error } = await getUntypedAnonClient().rpc(RPC, {
    p_lat: lat,
    p_lon: lon,
    p_radius_meters: radiusKm * 1000,
  });

  if (error) {
    throw new Error(formatRpcError(RPC, error));
  }

  const rows: unknown = data;
  if (!Array.isArray(rows) || rows.length !== 1) {
    const got = Array.isArray(rows) ? `${rows.length} lignes` : typeof rows;
    throw contractError(`attendu un tableau d'exactement 1 ligne, reçu ${got}`);
  }
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) {
    throw contractError(`ligne illisible (raw=${JSON.stringify(first)})`);
  }
  const row = first as Record<string, unknown>;

  return {
    n_lignes: readCount(row, "n_lignes"),
    n_ventes: readCount(row, "n_ventes"),
    prix_m2_median: readNullableNumber(row, "prix_m2_median"),
    prix_m2_p25: readNullableNumber(row, "prix_m2_p25"),
    prix_m2_p75: readNullableNumber(row, "prix_m2_p75"),
    n_terrains: readCount(row, "n_terrains"),
    prix_terrain_median: readNullableNumber(row, "prix_terrain_median"),
    date_min: readNullableDate(row, "date_min"),
    date_max: readNullableDate(row, "date_max"),
  };
}
