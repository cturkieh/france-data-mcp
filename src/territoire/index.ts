/**
 * Module territoire — données géographiques et démographiques françaises.
 *
 * Sources :
 *  - geo.api.gouv.fr (DINUM/Etalab) → recherche de communes
 *  - data.geopf.fr (IGN Géoplateforme) → géocodage d'adresse
 *  - INSEE Melodi → population municipale par commune et département
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

export {
  getPopulationByCommune,
  getPopulationByDept,
  type PopulationData,
  type GeoLevel,
} from "./insee-melodi.js";

export {
  getPopulationByIris,
  fetchIrisProfilByCode,
  assertIrisCode,
  type IrisPopulationLookup,
  type IrisProfilRow,
} from "./iris-db.js";

export const TERRITOIRE_VERSION = "0.1.0";
