import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase-types.js";

let anonClient: SupabaseClient<Database> | null = null;
let serviceClient: SupabaseClient<Database> | null = null;
let untypedAnonClient: SupabaseClient | null = null;
let untypedServiceClient: SupabaseClient | null = null;

/**
 * Read a required environment variable, distinguishing "absent" from "set
 * but empty" — the latter is the typical signature of a misconfigured GitHub
 * Secret (renamed, unscoped, or out-of-org). Exported so ingestion scripts
 * (`scripts/ingest/*`) can reuse the same diagnostic.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(
      `[france-data-mcp] Missing required environment variable: ${name}. Set it in .env.local for local dev or in GitHub Secrets for CI/Actions.`,
    );
  }
  // GitHub Actions substitutes "" for `${{ secrets.X }}` when X is renamed,
  // unset, or out-of-scope. Distinguishing this from "var truly missing" gives
  // operators a faster diagnosis path than a generic "missing var" message.
  if (value === "") {
    throw new Error(
      `[france-data-mcp] Environment variable ${name} is set but empty. Likely a misconfigured GitHub Secret (renamed/unscoped) or an empty line in .env.local.`,
    );
  }
  return value;
}

/**
 * Read-only client used by MCP tools. Respects RLS policies (only SELECT on
 * tables that grant anon read access).
 */
export function getAnonClient(): SupabaseClient<Database> {
  if (!anonClient) {
    const url = requireEnv("SUPABASE_URL");
    const key = requireEnv("SUPABASE_ANON_KEY");
    anonClient = createClient<Database>(url, key, {
      auth: { persistSession: false },
    });
  }
  return anonClient;
}

/**
 * Privileged client used ONLY by ingestion scripts running in GitHub Actions.
 * Bypasses RLS — never expose to end users.
 */
export function getServiceClient(): SupabaseClient<Database> {
  if (!serviceClient) {
    const url = requireEnv("SUPABASE_URL");
    const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    serviceClient = createClient<Database>(url, key, {
      auth: { persistSession: false },
    });
  }
  return serviceClient;
}

/**
 * Read-only client SANS typage Database — utilisé pour les RPCs ajoutées par
 * une migration qui n'a pas encore été suivie d'un `pnpm db:types` (donc
 * absentes du type généré). Bypass purement TypeScript : runtime identique au
 * client typé. Caller responsable du typage des params + du retour.
 *
 * Pattern miroir de `getUntypedServiceClient` côté `scripts/ingest/shared.ts`
 * pour les staging tables. À utiliser temporairement le temps qu'une regen
 * de types soit faite post-merge.
 */
export function getUntypedAnonClient(): SupabaseClient {
  if (!untypedAnonClient) {
    const url = requireEnv("SUPABASE_URL");
    const key = requireEnv("SUPABASE_ANON_KEY");
    untypedAnonClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return untypedAnonClient;
}

/**
 * Privileged client SANS typage Database — jumeau de `getUntypedAnonClient`
 * mais avec la clé service_role (bypass RLS). Utilisé pour les ÉCRITURES de
 * cache paresseux côté serveur (ex. `dvf_mutations` / `dvf_commune_cache`),
 * quand la table n'est pas encore dans les types générés. Comme
 * `getServiceClient`, ne JAMAIS exposer aux end users : réservé au runtime
 * serveur (endpoint Vercel, scripts). Doctrine du projet : le rôle anon reste
 * en lecture seule ; toute écriture passe par service_role.
 */
export function getUntypedServiceClient(): SupabaseClient {
  if (!untypedServiceClient) {
    const url = requireEnv("SUPABASE_URL");
    const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    untypedServiceClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return untypedServiceClient;
}

/** Test-only helper: forces clients to be re-created on next call. */
export function __resetClientsForTesting(): void {
  anonClient = null;
  serviceClient = null;
  untypedAnonClient = null;
  untypedServiceClient = null;
}
