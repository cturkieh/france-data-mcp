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
