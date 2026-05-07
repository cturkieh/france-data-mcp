import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase-types.js";

let anonClient: SupabaseClient<Database> | null = null;
let serviceClient: SupabaseClient<Database> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[france-data-mcp] Missing required environment variable: ${name}. Set it in .env.local for local dev or in GitHub Secrets for CI/Actions.`,
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
