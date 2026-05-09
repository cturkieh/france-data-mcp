/**
 * Code département canonique français — utilities partagées entre les
 * différents callers (commune index, ingestion FINESS, tools MCP).
 *
 * Pourquoi un module dédié : trois variantes existaient avant V0.4 dans
 * `commune-index.ts`, `api/tools.ts`, `scripts/ingest/finess.ts` — chacune
 * avec un edge case manquant (Corse, DOM, longueur min). Centralise pour
 * éviter les divergences silencieuses au prochain ingester.
 */

/**
 * Dérive le code département canonique depuis un code INSEE 5 chars.
 *  - Métropole : "75001" → "75"
 *  - Corse     : "2A001" → "2A", "2B033" → "2B"
 *  - DOM/COM   : "97401" → "974", "98701" → "987"
 *
 * Renvoie `undefined` si le code est trop court pour être interprété
 * (les callers FINESS/Ameli traitent ça comme un skip avec compteur).
 */
export function deptFromCodeInsee(codeInsee: string | null | undefined): string | undefined {
  if (!codeInsee || codeInsee.length < 2) return undefined;
  if (codeInsee.startsWith("2A") || codeInsee.startsWith("2B")) return codeInsee.slice(0, 2);
  // DOM/COM codes need 3 chars to be unambiguous — "97" alone could be
  // 971-978 ; refuse rather than guess.
  if (codeInsee.startsWith("97") || codeInsee.startsWith("98")) {
    return codeInsee.length >= 3 ? codeInsee.slice(0, 3) : undefined;
  }
  return codeInsee.slice(0, 2);
}

/**
 * Validateur de code département (cellule CSV ou input MCP). Accepte :
 *  - 2 chars métropole : "01"-"95" (excluant "20" — Corse utilise 2A/2B)
 *  - "2A" / "2B" (Corse)
 *  - 3 chars DOM/COM : "971"-"978" (DROM) et "984"-"988" (COM)
 *
 * Anything else is malformed (column shift, dirty data, user typo) and
 * returns false. Les callers décident s'ils throw ou skip.
 */
export function isValidDept(dept: string): boolean {
  if (dept === "2A" || dept === "2B") return true;
  if (/^\d{2}$/.test(dept)) return dept !== "20";
  if (/^(97[1-8]|98[4-8])$/.test(dept)) return true;
  return false;
}

/**
 * Variante throw-on-invalid de `isValidDept`. Cohérent avec les autres
 * validators du DB layer (`validateCoords`, `validateRadiusKm`) : `RangeError`
 * pour permettre au boundary MCP de mapper vers JSON-RPC -32602 (Invalid
 * params) au lieu de -32603 (Internal error).
 */
export function assertValidDept(dept: string): void {
  if (isValidDept(dept)) return;
  throw new RangeError(`[france-data-mcp] departement must be a valid INSEE code, got "${dept}"`);
}
