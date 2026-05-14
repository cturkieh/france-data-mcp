/**
 * Helpers de lecture d'environnement pour des secrets externes (API keys).
 *
 * Pattern récurrent (cf. `getInseeApiKey`, `getAnsFhirApiKey`) :
 *  - Lire `process.env[name]`
 *  - Trim + strip des quotes entourantes (Vercel UI / parsers .env les gardent
 *    parfois, et un `Bearer "<UUID>"` renvoyé en `Authorization` = 401 silencieux
 *    indiscernable d'une clé révoquée)
 *  - Retourner `null` si absente ou vide après nettoyage (no-op gracieux, les
 *    callers décident de skipper l'enrichissement ou throw)
 *
 * Centralisé pour qu'un nouvel intégrateur (CDS, FHIR alternatif, autre clé)
 * n'ait pas à redécouvrir le strip-quotes en debug à 23h.
 */

/**
 * Lit une variable d'env de type "secret API key" en nettoyant trim + quotes.
 * Retourne `null` quand la valeur est absente ou vide après nettoyage — les
 * callers traitent ce cas en mode dégradé (skip enrichissement live, fallback DB).
 *
 * NE THROW PAS : pattern miroir de `getInseeApiKey`/`getAnsFhirApiKey`. Pour un
 * lookup qui DOIT échouer si la var manque (ex. `SUPABASE_URL` pour le client),
 * utiliser `requireEnv` (`src/storage/supabase.ts`) qui distingue absente vs vide.
 */
export function readApiKeyEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  return cleaned === "" ? null : cleaned;
}
