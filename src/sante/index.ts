/**
 * Module sante — données françaises de santé publique.
 *
 * Sources :
 *  - DINUM Recherche Entreprises → entreprises secteur santé (live API)
 *  - FINESS (data.gouv) → établissements sanitaires et médico-sociaux (dump CSV bimestriel)
 *  - Annuaire Santé Ameli (data.gouv/CNAM) → PS libéraux conventionnés (dump CSV hebdo)
 *  - RPPS / Annuaire Santé ANS (data.gouv) → tous les PS (libéraux + salariés), ID stable, dump CSV mensuel
 *  - FHIR ANS live → fallback fraîcheur quotidienne pour lookup individuel par RPPS ID
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
  nafsForFamille,
  isNafCompatibleWithFamille,
  DELIBERATELY_NO_NAF,
} from "./naf-finess-mapping.js";

/**
 * Types Resolver V2 (V0.13.0) — exposés pour les callers npm qui veulent
 * typer un consommateur de `verifierSiteActif` / `historiqueEtablissement` /
 * `reconcilierFinessSirene` / `inspectSite` (tous renvoient désormais les
 * champs `method` / `fallback_reason` / `naf_filter_used` / `disambiguation_status`).
 */
export type {
  ResolutionMethod,
  FallbackReason,
  DisambiguationStatus,
  SiretCandidate,
  SiretCandidateSource,
  SiretResolution,
  DinumLookupError,
} from "./siret-resolver.js";

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

export {
  getRppsInRadius,
  getRppsParSpecialiteDept,
  getRppsDansEtablissement,
  getRppsById,
  type RppsResult,
  type RppsLookupResult,
  type RppsQueryResult,
  type RppsInRadiusInput,
  type RppsParSpecialiteDeptInput,
  type RppsDansEtablissementInput,
} from "./rpps-db.js";

export { RPPS_CGU_NOTICE, RPPS_MODE_EXERCICE } from "./rpps-types.js";

export {
  getAnsFhirApiKey,
  getAnsFhirBaseUrl,
  lookupPractitionerByRpps,
  type AnsFhirPractitioner,
} from "./ans-fhir.js";

export const SANTE_VERSION = "0.5.1";
