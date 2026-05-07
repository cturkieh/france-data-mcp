import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase-types.js";

let anonClient: SupabaseClient<Database> | null = null;
let serviceClient: SupabaseClient<Database> | null = null;

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

/** Test-only helper: forces clients to be re-created on next call. */
export function __resetClientsForTesting(): void {
  anonClient = null;
  serviceClient = null;
}
