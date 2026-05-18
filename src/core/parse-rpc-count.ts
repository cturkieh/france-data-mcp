/**
 * Parse fail-loud la valeur d'une RPC `RETURNS BIGINT` sérialisée par
 * PostgREST (un `number`, ou une string décimale entière `"339000"`/`"0"`).
 *
 * BACKSTOP ANTI-S-1 : toute autre forme (`null`, `""`, objet, string non
 * décimale, valeur non finie) = régression de contrat RPC → `throw`. Le
 * caller garde son propre contrat d'erreur (fail-loud côté `ban-backfill`,
 * best-effort `partial` côté cron via son `catch`). UNIQUE source de cette
 * garde (jadis dupliquée ~25 lignes verbatim entre `scripts/ingest/rpps.ts`
 * et `scripts/ban-backfill.mjs` — dérive silencieuse possible d'un jumeau
 * sur un backstop de panne totale silencieuse). `label` est interpolé tel
 * quel dans le message (les deux callers passent leur propre préfixe).
 */
/** Décrit une valeur de count invalide pour le message fail-loud (if/else
 * plat plutôt qu'un ternaire imbriqué — backstop auditable rapidement). */
function describeBadCount(value: unknown): string {
  if (value === null) return "null";
  if (value === "") return "an empty string";
  if (typeof value === "string") return `a non-decimal string (${JSON.stringify(value)})`;
  return typeof value;
}

export function parseRpcCount(value: unknown, label: string): number {
  if (
    value === null ||
    value === "" ||
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^\s*\d+\s*$/.test(value))
  ) {
    throw new Error(
      `${label} returned ${describeBadCount(value)} instead of a count — RPC contract regression`,
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${label} returned a non-finite value (${JSON.stringify(value)}) — RPC contract regression`,
    );
  }
  return n;
}
