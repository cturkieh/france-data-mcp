/**
 * Helpers shared between the typed DB wrappers (`finess-db.ts`, `ameli-db.ts`,
 * future `iris-db.ts`) — extracted in V0.4 to remove duplication that was
 * about to ramify across each new ingester.
 *
 * Conventions:
 *   - Pure functions, no side effects beyond throwing on bad input.
 *   - `[france-data-mcp]` log prefix already in place upstream — these
 *     helpers just throw, callers preserve their domain prefix.
 */

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
/**
 * Plafond OFFSET : 100K. Au-delà, Postgres scan une part énorme de la table
 * pour atteindre le row N — donc soit le caller paginate à un volume qu'il
 * ne devrait pas (re-design : filtrer plus en amont), soit c'est une faute
 * de saisie (5 zéros au lieu de 4). Throw plutôt que clamp silencieux,
 * cohérent avec `clampLimit`.
 */
export const MAX_OFFSET = 100_000;
/**
 * Bornes radius_km homogènes pour toutes les recherches géographiques (FINESS,
 * Ameli, futurs IRIS). Source unique pour empêcher la dérive entre layers
 * (avant V0.4.1, FINESS DB n'avait aucune validation et acceptait `radiusKm:
 * 1000` côté boundary alors que le tool layer plafonnait à 50).
 */
export const RADIUS_MIN_KM = 0.1;
export const RADIUS_MAX_KM = 50;

/**
 * Validates and returns a row limit. Throws RangeError outside [1, 500].
 * No clamping (silently capping a 1000-row request to 500 hides the truncation
 * from the caller, which is exactly the kind of silent failure the audit
 * V0.2 flagged).
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(
      `[france-data-mcp] limit must be between 1 and ${MAX_LIMIT}, got ${limit}`,
    );
  }
  return limit;
}

/**
 * Validates and returns a pagination offset. Default 0. Throws RangeError if
 * negative, non-finite, or above MAX_OFFSET. Same loud-failure philosophy as
 * `clampLimit` — silently zeroing a -1 offset would mask a caller bug that
 * iterates downward thinking it's going forward.
 */
export function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new RangeError(
      `[france-data-mcp] offset must be between 0 and ${MAX_OFFSET}, got ${offset}`,
    );
  }
  return Math.floor(offset);
}

/**
 * Validates a search radius in kilometres. Bounds [0.1, 50] : 0.1 km est le
 * plus petit rayon utile (≈ rue), 50 km couvre une aire d'attraction urbaine.
 * Au-delà, ST_DWithin sur 95K rows commence à coûter sans valeur ajoutée
 * (le caller devrait passer en query par département à la place).
 */
export function validateRadiusKm(radiusKm: number): void {
  if (!Number.isFinite(radiusKm) || radiusKm < RADIUS_MIN_KM || radiusKm > RADIUS_MAX_KM) {
    throw new RangeError(
      `[france-data-mcp] radiusKm must be in [${RADIUS_MIN_KM}, ${RADIUS_MAX_KM}], got ${radiusKm}`,
    );
  }
}

/**
 * Validates WGS84 coordinates. PostGIS itself accepts any number, so a
 * caller that swaps lat/lon (e.g. lat=2.6, lon=49.7) silently returns 0
 * results — indistinguishable from "no data here". Validating bounds here
 * makes that mistake loud.
 */
export function validateCoords(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`[france-data-mcp] lat must be in [-90, 90], got ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`[france-data-mcp] lon must be in [-180, 180], got ${lon}`);
  }
}

/**
 * Formats a Supabase RPC error into a single string preserving the postgres
 * code, hint, and details. Losing those fields turned a "permission denied"
 * incident in v0.2.0 into a 30-minute investigation. Always include
 * `error.code` so the operator can grep PgError tables (PGRST205 / 42703 /
 * etc.) directly in logs.
 */
export function formatRpcError(
  rpc: string,
  error: { code?: string; message: string; hint?: string; details?: string },
): string {
  const code = error.code ? ` (${error.code})` : "";
  const hint = error.hint ? ` — hint: ${error.hint}` : "";
  const details = error.details ? ` — details: ${error.details}` : "";
  return `[france-data-mcp] ${rpc}${code}: ${error.message}${details}${hint}`;
}

/**
 * Trim CHAR-padded fields. Postgres CHAR(N) right-pads with spaces, so a
 * dept "08" stored as CHAR(3) comes back as "08 ". Strip it once at the
 * boundary so callers don't have to special-case the padding.
 */
export function trimOrNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Pattern numéro FINESS site (9 chiffres, contrainte SQL `CHAR(9)`).
 * Exporté pour partager la source de vérité entre `assertValidNumFiness` (lib)
 * et `requireFinessId` (`api/_lib/args.ts` — tool boundary). Un futur changement
 * de format (ex: Mayotte ou DOM-COM widening) ne se modifiera qu'à un seul
 * endroit.
 */
export const NUM_FINESS_PATTERN = /^\d{9}$/;

/**
 * Valide un numéro FINESS site (9 chiffres) côté boundary public. Renvoie le
 * `numFiness` trimmed pour que le caller forward la version normalisée à la
 * RPC. Throw `RangeError` (mappé JSON-RPC -32602 par `api/mcp.ts`) sur format
 * invalide. Aligné sur `assertValidDept` (territoire/dept-codes.ts).
 */
export function assertValidNumFiness(numFiness: string): string {
  const trimmed = numFiness.trim();
  if (!NUM_FINESS_PATTERN.test(trimmed)) {
    throw new RangeError(
      `[france-data-mcp] num_finess invalide "${numFiness}" — attendu 9 chiffres (FINESS site).`,
    );
  }
  return trimmed;
}

/**
 * Normalise le `data` retourné par un RPC supabase-js en array typé.
 *
 * Supabase RPC convention : sur un SETOF, `error == null` ⇒ `data` est un
 * `T[]` (potentiellement vide). Recevoir `data == null` quand `error` est
 * également null signale une violation du contrat (RPC renommé sans erreur,
 * permission silencieuse, glitch côté supabase-js). Le caller bénéficiait
 * jusqu'ici d'un `data ?? []` qui masquait silencieusement ce cas comme un
 * résultat vide — exactement le silent failure que CLAUDE.md interdit.
 *
 * Throw plutôt que log + fallback : un caller LLM voit le throw remonter
 * dans la réponse MCP et peut décider (retry, fallback, abandon).
 */
export function expectRpcRows<T>(rpc: string, data: unknown): T[] {
  if (data === null || data === undefined) {
    throw new Error(
      `[france-data-mcp] ${rpc}: RPC contract violation — supabase-js returned no error but data is ${data === null ? "null" : "undefined"}. Expected an array (possibly empty). Investigate RPC name, schema cache, or supabase-js version.`,
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `[france-data-mcp] ${rpc}: RPC contract violation — expected array, got ${typeof data}. Likely an RPC signature mismatch.`,
    );
  }
  return data as T[];
}
