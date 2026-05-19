// Primitive générique de normalisation d'adresse en clé déterministe.
// L'équivalent SQL inline (migration) DOIT rester strictement identique à cette
// logique : trim + collapse espaces + UPPERCASE + retrait du segment CEDEX, champs
// joints par `|`. Toute divergence casserait la jointure clé lib ↔ clé SQL.
// Jumeau SQL byte-exact (forme 3-arg) : supabase/migrations/20260516T060000_geocoded_addresses_cache.sql
// (`rpps_normalize_address_key`). Côté SQL, `toUpperCase()` V8 n'est PAS
// reproductible par `upper()` sous le LC_CTYPE prod `C.UTF-8` (glibc mono-char :
// pas d'expansion ß→SS / ligatures) → le jumeau pré-remplace ces codepoints
// avant `upper()`. Parité garantie par
// scripts/ingest/ban-geocode-parity.integration.test.ts (HARD GATE).

const CEDEX_RE = /\bCEDEX\s*\d*/gi;

export function normalizeAddressKey(
  adresse: string | null,
  codePostal: string | null,
  codeInsee: string | null,
  ville?: string | null,
): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "").replace(CEDEX_RE, " ").replace(/\s+/g, " ").trim().toUpperCase();
  const parts = [norm(adresse), norm(codePostal), norm(codeInsee)];
  if (ville != null) parts.push(norm(ville));
  return parts.join("|");
}

/**
 * Garde STRUCTURELLE C1 (S-4-bis). Le jumeau SQL `rpps_normalize_address_key`
 * est à 3 arguments / 3 segments. Passer un 4e argument `ville` à
 * `normalizeAddressKey` produit une clé à 4 segments qui ne matche JAMAIS le
 * jumeau SQL → 0 ligne géocodée tout en rapportant un succès (panne totale
 * silencieuse). Les sites d'appel cache (`rpps.ts` step `ban_join` via la
 * RPC `ingest_apply_rpps_ban_join_batch`, `ban-backfill.mjs`) DOIVENT
 * s'appuyer sur cette clé : la fonction ne déclare
 * EXACTEMENT 3 paramètres, aucun 4e optionnel — une régression 4-arg y est
 * structurellement IMPOSSIBLE (le compilateur la refuse), pas seulement
 * commentée. Byte-identique à `normalizeAddressKey(a, b, c)` (ville omise) ;
 * `address-geocode.test.ts` verrouille cette équivalence pour préserver la
 * couverture du HARD GATE de parité SQL↔JS.
 */
export function normalizeAddressKey3(
  adresse: string | null,
  codePostal: string | null,
  codeInsee: string | null,
): string {
  return normalizeAddressKey(adresse, codePostal, codeInsee);
}
