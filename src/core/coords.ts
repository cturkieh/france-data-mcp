/**
 * Helpers internes pour la conversion `lon/lat string|number → Coordinates`.
 * Pas exporté publiquement (usage strictement interne aux mappers d'API).
 *
 * Pourquoi un helper ? Les CSV FINESS utilisent la virgule décimale FR
 * ("4,7192") tandis que l'API DINUM renvoie soit `string` ASCII ("4.7192")
 * soit `number`. La même logique de validation `Number.isFinite` est ensuite
 * appliquée des deux côtés, d'où la mutualisation.
 */
import type { Coordinates } from "./types.js";

/**
 * Convertit une paire `lon/lat` (string ou number, virgule ou point décimal)
 * en `Coordinates` validées. Renvoie `undefined` si l'un des deux est absent
 * ou non finite — préférable à des coordonnées (NaN, NaN) qui pollueraient
 * silencieusement la suite du pipeline.
 */
export function parseCoordinates(
  lon: string | number | undefined,
  lat: string | number | undefined,
): Coordinates | undefined {
  const lonNum = parseLooseNumber(lon);
  const latNum = parseLooseNumber(lat);
  if (lonNum === undefined || latNum === undefined) return undefined;
  return { lon: lonNum, lat: latNum };
}

function parseLooseNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // Les CSV FR (FINESS, INSEE…) utilisent la virgule comme séparateur décimal.
  const normalized = value.replace(",", ".");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : undefined;
}
