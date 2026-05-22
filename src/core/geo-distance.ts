/**
 * Distance géodésique entre deux points WGS84, en mètres (formule de Haversine).
 *
 * Pourquoi une primitive TypeScript et pas un appel PostGIS : le resolver SIRET
 * (`sante/siret-resolver.ts`) compare la position d'un FINESS à celle
 * d'établissements SIRENE/DINUM déjà chargés en mémoire — un aller-retour DB
 * par paire de points serait absurde. Haversine sur la sphère est largement
 * assez précise pour trancher « même bâtiment » vs « autre adresse » (erreur
 * < 0,3 % vs l'ellipsoïde — négligeable à l'échelle d'un site urbain).
 *
 * Primitive maths générique → vit dans `core/`, jamais dans `sante/` (cf.
 * CLAUDE.md § conventions : `sante/` importe `territoire/`, une primitive
 * partagée dans `sante/` créerait une inversion de couche).
 */
import type { Coordinates } from "./types.js";

/** Rayon moyen de la Terre en mètres (sphère IUGG). */
const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Distance en mètres entre deux coordonnées WGS84. Toujours ≥ 0, symétrique.
 */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // `Math.min(1, …)` borne l'argument d'`asin` : une accumulation d'erreur
  // flottante peut pousser `sqrt(h)` infinitésimalement au-dessus de 1 pour
  // deux points antipodaux, ce qui produirait `NaN`.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
