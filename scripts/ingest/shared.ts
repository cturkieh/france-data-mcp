import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { DEFAULT_USER_AGENT } from "../../src/core/http.js";
import { getServiceClient, requireEnv } from "../../src/storage/supabase.js";

export type IngestPhase = "download" | "pre_validate" | "copy" | "validate" | "swap";

/**
 * Read a column from a CSV record, returning `null` if it is missing or empty.
 * Shared across ingestion scripts (FINESS today, Ameli/IRIS next) so that the
 * "empty string === absent" convention stays consistent everywhere.
 */
export function getNonEmpty(rec: Record<string, string>, name: string): string | null {
  const v = rec[name];
  return v === undefined || v === "" ? null : v;
}

export class IngestError extends Error {
  constructor(
    public readonly phase: IngestPhase,
    message: string,
    cause?: unknown,
  ) {
    // Pass cause via Error options so engine-internal slots (Sentry,
    // util.inspect, structured loggers) read it correctly. Constructor-field
    // shadowing breaks that machinery.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "IngestError";
  }
}

export interface PreValidateConfig {
  minSizeBytes: number;
  expectedHeaderColumns: string[];
  delimiter: string;
}

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  url: string;
}

/** Download a CSV with retry-on-failure (3 attempts, exponential backoff). */
export async function downloadCsv(url: string, destFilename: string): Promise<DownloadResult> {
  const filePath = path.join(os.tmpdir(), destFilename);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": DEFAULT_USER_AGENT } });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const fileStream = fs.createWriteStream(filePath);
      // biome-ignore lint/suspicious/noExplicitAny: Node's Readable.fromWeb expects the DOM ReadableStream type, not the lib.dom one.
      await pipeline(Readable.fromWeb(res.body as any), fileStream);
      const stat = await fsp.stat(filePath);
      return { filePath, sizeBytes: stat.size, url };
    } catch (err) {
      lastErr = err;
      console.error(
        `[france-data-mcp] downloadCsv attempt ${attempt}/3 failed for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw new IngestError("download", `Failed to download ${url} after 3 attempts`, lastErr);
}

export async function preValidateFile(filePath: string, config: PreValidateConfig): Promise<void> {
  const stat = await fsp.stat(filePath);
  if (stat.size < config.minSizeBytes) {
    throw new IngestError(
      "pre_validate",
      `File size ${stat.size} below minimum ${config.minSizeBytes} (suspected truncated download)`,
    );
  }

  // Read just the first line (header) without loading the whole file.
  const fd = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, 8192, 0);
    const firstLine = buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)[0] ?? "";
    const headers = firstLine.split(config.delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
    const missing = config.expectedHeaderColumns.filter((c) => !headers.includes(c));
    if (missing.length > 0) {
      throw new IngestError(
        "pre_validate",
        `Missing expected header columns: [${missing.join(", ")}]. Got: [${headers.slice(0, 10).join(", ")}...]`,
      );
    }
  } finally {
    await fd.close();
  }
}

export interface IngestLogEntry {
  source: string;
  started_at: string;
  finished_at?: string;
  status: "success" | "partial" | "failed";
  row_count?: number;
  csv_size_bytes?: number;
  csv_url?: string;
  error_phase?: IngestPhase;
  error_message?: string;
  github_run_url?: string;
}

export async function writeIngestLog(entry: IngestLogEntry): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.from("ingest_log").insert(entry);
  if (error) {
    // We don't throw — failing to log shouldn't override the original ingest failure.
    console.error(`[france-data-mcp] failed to write ingest_log: ${error.message}`);
  }
}

export interface AtomicSwapInput {
  /** Logical name of the production table (e.g. "finess"). */
  prodTable: string;
}

/**
 * Atomically swap `<prodTable>_staging` into `<prodTable>`, keeping the
 * previous version as `<prodTable>_previous` for rollback.
 *
 * Implemented via a single PL/pgSQL block executed through a Postgres RPC
 * (see migration `20260508000005_rpc_atomic_swap.sql`).
 */
export async function atomicSwapTables(input: AtomicSwapInput): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.rpc("ingest_atomic_swap", {
    p_prod_table: input.prodTable,
  });
  if (error) {
    throw new IngestError(
      "swap",
      `Atomic swap failed for table "${input.prodTable}": ${error.message}`,
    );
  }
}

/**
 * Best-effort serialize an `IngestLogEntry` for the stderr fallback.
 * `JSON.stringify` itself can throw on a circular ref or BigInt — and the
 * fallback line is the LAST resort if `writeIngestLog` already failed.
 * If JSON throws, we still emit a flat key=value string so the operator
 * sees something parseable in the GitHub Actions log.
 */
export function safeSerializeIngestLog(log: IngestLogEntry): string {
  try {
    return JSON.stringify(log);
  } catch (err) {
    // We're already in a "log of last resort" path — JSON.stringify failing
    // means there's a circular ref / BigInt / non-enumerable in `log`. Emit
    // a console.warn so the failure mode is auditable, then return the
    // flat serialization so the caller still gets a parseable line.
    console.warn("[france-data-mcp] safeSerializeIngestLog: JSON.stringify failed:", err);
    const flat = Object.entries(log)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    return `[serialize-fallback err=${err instanceof Error ? err.message : String(err)}] ${flat}`;
  }
}

/**
 * Build an UNTYPED Supabase service-role client for ingestion scripts. The
 * generated `Database` type only knows about prod tables; staging tables are
 * dropped/recreated each run via RPC, so they can't appear in the generated
 * types. Using an untyped client at this boundary avoids `as any` casts on
 * the insert payload while preserving the rest of the type safety in
 * downstream code.
 *
 * Reuses `requireEnv` so empty-string env vars (e.g. unscoped GitHub Secret)
 * are diagnosed the same way as in the typed clients — caught early instead
 * of failing later with an opaque PostgREST error.
 *
 * @param source — short tag like "ameli", "finess" used in console.error
 *   prefixes to disambiguate which ingester logged the failure.
 */
export function getUntypedServiceClient(source: string): SupabaseClient {
  try {
    const url = requireEnv("SUPABASE_URL");
    const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    return createClient(url, key, { auth: { persistSession: false } });
  } catch (err) {
    console.error(`[${source}] failed to build service client:`, err);
    throw new IngestError("copy", err instanceof Error ? err.message : String(err), err);
  }
}
