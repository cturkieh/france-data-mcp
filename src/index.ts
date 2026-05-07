/**
 * france-data-mcp — boîte à outils pour interroger les données publiques françaises.
 *
 * Imports recommandés par domaine :
 *   import { ... } from "france-data-mcp/territoire";
 *   import { ... } from "france-data-mcp/sante";
 *
 * Cet entry point ré-exporte tout pour les usages globaux.
 */

export * from "./territoire/index.js";
export * from "./sante/index.js";
export type { Coordinates, RateLimitOptions } from "./core/types.js";
