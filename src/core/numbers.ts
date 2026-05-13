/**
 * Helpers numériques internes (pas exportés publiquement).
 */

/**
 * Borne `value` dans l'intervalle `[min, max]`. Aucune coercition : si la
 * valeur est NaN, elle reste NaN — le caller doit la valider en amont.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Convertit des mètres en kilomètres arrondis à 2 décimales (10 m de précision).
 * Cohérent entre les wrappers FINESS et Ameli — `distance_meters` (PostGIS
 * `ST_Distance` géography) → `distance_km` exposé au caller MCP.
 *
 * Renvoie `null` si l'entrée est `null`/`undefined` ou non-numérique : utilisé
 * sur les RPCs *_by_dept où `distance_meters` est `NULL::DOUBLE PRECISION` car
 * il n'y a pas de centre de référence.
 */
export function metersToKm(meters: number | null | undefined): number | null {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return null;
  return Math.round((meters / 1000) * 100) / 100;
}

/**
 * Arrondit `value` à 2 décimales. Utilisé pour les ratios et pourcentages
 * exposés au caller MCP (densités pour 100k hab., écarts vs national en %).
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
