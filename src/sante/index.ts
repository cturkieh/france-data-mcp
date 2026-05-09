/**
 * Module sante — données françaises de santé publique.
 *
 * Sources :
 *  - DINUM Recherche Entreprises → entreprises secteur santé (live API)
 *  - FINESS (data.gouv) → établissements sanitaires et médico-sociaux (dump CSV)
 *  - Annuaire Santé Ameli (data.gouv/CNAM) → professionnels de santé libéraux (dump CSV)
 */

export {
  searchEntreprises,
  getEntrepriseBySiren,
  type Entreprise,
  type Etablissement,
  type Finance,
  type Dirigeant,
  type SearchEntreprisesOptions,
  type SearchEntreprisesResult,
} from "./dinum.js";

export { getInseeApiKey, lookupSirenViaInsee } from "./insee-sirene.js";

export {
  loadFiness,
  searchEtablissementsFiness,
  haversineDistance,
  type EtablissementFiness,
  type LoadFinessOptions,
  type SearchFinessOptions,
} from "./finess.js";

export {
  ensureAnnuaireAmeli,
  streamProfessionnels,
  loadProfessionnels,
  type ProfessionnelSante,
  type FilterAnnuaireOptions,
  type StreamAnnuaireOptions,
} from "./annuaire-ameli.js";

export {
  NAF_SANTE,
  NAF_LABOS,
  NAF_PHARMACIES,
  NAF_EHPAD,
  NAF_MEDECINE_VILLE,
  libelleNaf,
  type NafCodeSante,
} from "./naf-codes.js";

export {
  FINESS_CATEGORIES,
  FINESS_FAMILY_CODES,
  FINESS_HOPITAUX,
  FINESS_LABOS,
  FINESS_PHARMACIES,
  FINESS_EHPAD,
  FINESS_MSP_CPTS,
  libelleCategorieFiness,
  finessFamille,
  type FinessCategorieCode,
  type FinessFamille,
} from "./finess-categories.js";

export {
  getFinessInRadius,
  getFinessByCategorie,
  getFinessByNumFiness,
  type FinessResult,
  type FinessQueryResult,
  type InRadiusInput,
  type ByCategorieInput,
  type FinessFamilleQuery,
} from "./finess-db.js";

export const SANTE_VERSION = "0.2.0-pre";
