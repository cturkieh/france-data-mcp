export {
  aggregatePrix,
  deptPrefixFromInsee,
  dvfInRadius,
  ensureCommuneCached,
  fetchCommuneCsv,
  fetchCommunesInRadius,
  getCacheRow,
  markCommuneCached,
  upsertMutations,
} from "./dvf.js";

export type { DvfAggregate, DvfCacheRow, DvfMutation } from "./dvf.js";

export { getZonesAU } from "./apicarto-plu.js";
export type { ZonesAUEntry, ZonesAUResult } from "./apicarto-plu.js";

export { permitsForCommune } from "./sitadel.js";
export type { PermitsResult } from "./sitadel.js";

export { dynamiqueImmobiliere } from "./dynamique-immobiliere.js";
export type {
  DynamiqueImmobiliereInput,
  DynamiqueImmobiliereNote,
  DynamiqueImmobiliereInfo,
  DynamiqueImmobiliereResult,
} from "./dynamique-immobiliere.js";

export { coutFoncier } from "./cout-foncier.js";
export type { CoutFoncierInput, CoutFoncierResult } from "./cout-foncier.js";
