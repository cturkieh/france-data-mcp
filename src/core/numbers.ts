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
