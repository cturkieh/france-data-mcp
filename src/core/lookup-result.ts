/**
 * Type partagé pour les lookups d'entité unique (par identifiant).
 *
 * Pourquoi : retourner `null` brut quand un identifiant n'est pas trouvé est
 * un silent failure — le caller MCP ne peut pas distinguer "introuvable" de
 * "panne API" ni obtenir un message actionnable. Pattern aligné sur
 * `enrichmentStatus` (cf. `src/sante/dinum.ts`) qui a déjà fait ses preuves.
 *
 * Le discriminant `found: boolean` permet au caller de narrower côté TS et
 * facilite la lecture côté LLM : un agent voit immédiatement le statut au
 * lieu de devoir tester `=== null`.
 *
 * Cas d'usage actuels (v0.4.3) :
 * - `getEntrepriseBySiren` (DINUM)
 * - `getCommuneByCode` (geo.api.gouv)
 * - `getFinessByNumFiness` (FINESS / DREES)
 *
 * Pour les listes (radius, dept, etc.), `count: 0` + `results: []` reste le
 * pattern adapté — pas besoin de ce type.
 */

/**
 * Statuts possibles pour un lookup. Les valeurs reflètent les causes
 * sémantiquement distinctes pour le caller :
 *
 * - `found` : entité trouvée et retournée.
 * - `not_found` : identifiant absent du référentiel cible (cas le plus courant).
 * - `ambiguous` : l'API a renvoyé des résultats mais aucun ne matche
 *   exactement l'identifiant fourni — typiquement un signal de régression
 *   amont (recherche full-text qui matche sur autre chose), à surveiller.
 */
export type LookupStatus = "found" | "not_found" | "ambiguous";

/**
 * Cas "introuvable" d'un lookup. `key` reflète l'identifiant fourni par le
 * caller (siren, code INSEE, num_finess…) pour faciliter le debug côté agent.
 * `message` doit être actionnable — orienter vers une alternative quand elle
 * existe (ex: `entreprises_in_radius` pour SIREN en diffusion partielle).
 */
export interface LookupNotFound {
  found: false;
  /** Identifiant fourni par le caller (siren / code INSEE / num_finess / …). */
  key: string;
  lookupStatus: Exclude<LookupStatus, "found">;
  message: string;
}

/**
 * Forme générique d'un résultat de lookup. `T` doit être l'entité brute
 * (sans champ discriminant) — le wrapper ajoute `found: true` et
 * `lookupStatus: "found"` au moment du return.
 */
export type LookupResult<T> = (T & { found: true; lookupStatus: "found" }) | LookupNotFound;

/** Helper pour wrapper un résultat trouvé sans répétition au call-site. */
export function lookupFound<T>(entity: T): T & { found: true; lookupStatus: "found" } {
  return { ...entity, found: true, lookupStatus: "found" };
}

/** Helper pour produire un résultat "introuvable" typé. */
export function lookupNotFound(
  key: string,
  message: string,
  status: Exclude<LookupStatus, "found"> = "not_found",
): LookupNotFound {
  return { found: false, key, lookupStatus: status, message };
}
