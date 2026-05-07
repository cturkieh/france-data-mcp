/**
 * Module territoire — données géographiques et démographiques françaises.
 *
 * Sources :
 *  - geo.api.gouv.fr (DINUM/Etalab) → recherche de communes
 *  - data.geopf.fr (IGN Géoplateforme) → géocodage d'adresse
 *  - INSEE → population IRIS infra-communale (à venir)
 */

export {
  searchCommunes,
  getCommuneByCode,
  type Commune,
  type SearchCommunesOptions,
} from "./communes.js";

export {
  geocode,
  geocodeMany,
  reverseGeocode,
  type GeocodeResult,
  type GeocodeOptions,
} from "./geocode.js";

export const TERRITOIRE_VERSION = "0.1.0";
