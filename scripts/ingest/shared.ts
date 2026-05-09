import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { DEFAULT_USER_AGENT } from "../../src/core/http.js";
import { getServiceClient, requireEnv } from "../../src/storage/supabase.js";

export type IngestPhase = "download" | "pre_validate" | "copy" | "validate" | "swap";

/**
 * Read a column from a CSV record, returning `null` if it is missing or empty.
 * Shared across ingestion scripts (FINESS today, Ameli/IRIS next) so that the
 * "empty string === absent" convention stays consistent everywhere.
 *
 * Aussi : strippe les caractères de contrôle ASCII (\x00-\x1F) qui peuvent
 * survivre au parser CSV (typiquement `\r` dans une cellule mal échappée
 * côté upstream). Sans ce strip, ces chars finissent en clair dans des
 * strings JSON sérialisées par PostgREST → tout client JSON-strict
 * (Python json.loads, jq) tombe avec "Invalid control character".
 * Reproduit en empirique 2026-05-08 sur des raisons sociales FINESS et
 * des voies Ameli.
 */
export function getNonEmpty(rec: Record<string, string>, name: string): string | null {
  const raw = rec[name];
  if (raw === undefined || raw === "") return null;
  // Strip control chars (each run collapsed to a single space). Trim so a
  // string of only control chars / whitespace becomes null. Voluntary
  // spaces inside the value are preserved — we only fix the JSON-breaking
  // \r/\n/\t residues from upstream CSV.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional strip of \x00-\x1f from CSV residues
  const cleaned = raw.replace(/[\x00-\x1f]+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
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
  /**
   * Hex-encoded SHA-256 of the downloaded file content. Used to short-circuit
   * the ingestion pipeline when the upstream CSV is byte-identical to the
   * previous successful run (skipping COPY → VALIDATE → SWAP saves several
   * minutes of Postgres CPU + free-tier IOPS).
   */
  sha256: string;
}

/**
 * Stream a file through SHA-256 to avoid loading the whole CSV (~150 MB for
 * Ameli) into memory. Hex output keeps `ingest_log.csv_sha256` human-readable
 * and CHAR(64) compatible.
 */
export async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest("hex");
}

/**
 * Synchronous-Buffer variant of `computeSha256` — exposed for unit testing
 * with a known-vector input. The async version takes a path to support
 * the multi-hundred-MB CSVs without loading them into memory.
 */
export function computeSha256Buffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
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
      // Compute checksum BEFORE returning so the caller never sees a partial
      // download — if we fail to read the file back, the attempt is retried.
      const sha256 = await computeSha256(filePath);
      return { filePath, sizeBytes: stat.size, url, sha256 };
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

/** Sources supportées dans `ingest_log.source` (utile pour `getLastSuccessChecksum`). */
export type IngestSource = "finess" | "ameli_ps" | "rpps";

export interface IngestLogEntry {
  source: string;
  started_at: string;
  finished_at?: string;
  status: "success" | "partial" | "failed";
  row_count?: number | null;
  csv_size_bytes?: number;
  csv_url?: string;
  error_phase?: IngestPhase;
  error_message?: string;
  github_run_url?: string;
  /** SHA-256 hex (CHAR(64)) du CSV téléchargé. Permet le short-circuit "même fichier qu'avant". */
  csv_sha256?: string;
  /**
   * Raison textuelle d'un run sans ingestion réelle. Aujourd'hui une seule
   * valeur : `"same_checksum"` (CSV byte-identique au dernier success). Champ
   * libre pour distinguer d'autres no-ops futurs (ex: `"upstream_unchanged"`).
   */
  skip_reason?: string;
  /**
   * Liste des `key_value` canary attendus mais introuvables après le swap
   * en prod. Vide ou absent = canary OK. Non-bloquant — alerte douce, pas
   * de rollback.
   */
  canary_failures?: string[];
}

/**
 * Untyped service client pour `ingest_log`. Le type généré `Database` ne
 * connaît pas encore les colonnes ajoutées par la migration B2/B3
 * (csv_sha256, skip_reason, canary_failures) tant que `pnpm db:types` n'a
 * pas été relancé après la migration. Plutôt qu'un cast `as any`, on utilise
 * un client untyped pour ce point d'écriture précis — même pattern que
 * `getUntypedServiceClient` pour les staging tables.
 */
function getIngestLogClient(): SupabaseClient {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function writeIngestLog(entry: IngestLogEntry): Promise<void> {
  const supabase = getIngestLogClient();
  const { error } = await supabase.from("ingest_log").insert(entry);
  if (error) {
    // We don't throw — failing to log shouldn't override the original ingest failure.
    console.error(`[france-data-mcp] failed to write ingest_log: ${error.message}`);
  }
}

/**
 * Retourne le checksum SHA-256 du dernier run `success` pour cette source,
 * ou `null` si aucun run réussi (premier run, table vidée). Utilisé par
 * `finess.ts` et `ameli.ts` pour court-circuiter les étapes COPY → SWAP
 * quand le CSV upstream n'a pas changé d'un poil.
 *
 * Erreurs Supabase loggées via `console.error` (pas de throw) — un échec de
 * lecture du log ne doit pas bloquer l'ingestion : on retombe sur le chemin
 * "pas de checksum connu, ingest normal".
 */
export async function getLastSuccessChecksum(source: IngestSource): Promise<string | null> {
  const supabase = getIngestLogClient();
  const { data, error } = await supabase
    .from("ingest_log")
    .select("csv_sha256")
    .eq("source", source)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error(
      `[france-data-mcp] getLastSuccessChecksum(${source}) failed: ${error.message} — falling back to full ingest`,
    );
    return null;
  }
  if (!data || data.length === 0) return null;
  // PostgREST renvoie l'objet brut; le champ peut être null (run pré-B2).
  const row = data[0] as { csv_sha256?: string | null };
  return row.csv_sha256 ?? null;
}

/**
 * Court-circuite l'ingestion quand le CSV téléchargé est byte-identique au
 * dernier run `success` pour cette source. Renseigne `log` (skip_reason +
 * status success), écrit l'entrée dans `ingest_log`, log un message console.
 * Le caller fait `if (await shortCircuitIfSameChecksum(...)) return;` pour
 * sortir tôt et éviter COPY/VALIDATE/SWAP coûteux.
 *
 * Retourne `true` si le short-circuit s'est déclenché, `false` sinon.
 */
export async function shortCircuitIfSameChecksum(
  log: IngestLogEntry,
  lastSha: string | null,
  currentSha: string,
  tag: string,
): Promise<boolean> {
  if (!lastSha || lastSha !== currentSha) return false;
  log.status = "success";
  log.skip_reason = "same_checksum";
  log.row_count = null;
  log.finished_at = new Date().toISOString();
  await writeIngestLog(log);
  console.log(
    `[${tag}] same checksum as last success (${currentSha.slice(0, 8)}…) — skipping ingestion`,
  );
  return true;
}

/**
 * Lance le canary post-swap, écrit le résultat dans `log.canary_failures` si
 * non-vide et logue un warn. Helper non-bloquant (la swap est déjà committée).
 * Encapsule le pattern dupliqué entre finess.ts et ameli.ts.
 */
export async function runAndRecordCanary(
  supabase: Pick<SupabaseClient, "rpc">,
  source: IngestSource,
  log: IngestLogEntry,
  tag: string,
): Promise<void> {
  const missing = await runCanaryCheck(supabase, source);
  if (missing.length === 0) return;
  log.canary_failures = missing;
  console.warn(`[${tag}] canary missing: ${missing.join(", ")} — investigate (no rollback)`);
}

/**
 * Appel post-swap du RPC `check_ingest_canary(p_source)`. Retourne la liste
 * des `key_value` canary attendus mais introuvables en prod après le swap.
 * Vide = canary OK.
 *
 * Non-bloquant par contrat : la swap est déjà committée, on alerte sans
 * rollback. Une erreur RPC réseau renvoie le sentinelle `["__rpc_error__"]`
 * pour que le caller puisse l'écrire dans `log.canary_failures` et que
 * l'opérateur sache distinguer "canary missing" de "canary check unavailable".
 *
 * Le client est injecté pour faciliter le test unitaire (mock RPC). En prod,
 * passer `getUntypedServiceClient(...)` car `check_ingest_canary` n'est pas
 * dans la `Database` typée tant que `pnpm db:types` n'a pas été regénéré.
 */
export async function runCanaryCheck(
  supabase: Pick<SupabaseClient, "rpc">,
  source: IngestSource,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("check_ingest_canary", { p_source: source });
  if (error) {
    console.error(
      `[france-data-mcp] check_ingest_canary(${source}) RPC failed: ${error.message} — non-blocking, swap already committed`,
    );
    return ["__rpc_error__"];
  }
  // Le RPC retourne TEXT[] (jamais NULL grâce au COALESCE côté SQL) — mais
  // on défend quand même contre une régression PostgREST qui renverrait
  // null/undefined. Type-narrow strict pour éviter `as string[]`.
  if (!Array.isArray(data)) return [];
  return data.filter((v): v is string => typeof v === "string");
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

/**
 * Executes `fn` only when the importing module is the script entrypoint.
 * Use `fileURLToPath` rather than literal URL compare — process.argv[1] is the
 * raw filesystem path while import.meta.url URL-encodes spaces/accents.
 */
export async function runIfMain(moduleUrl: string, fn: () => Promise<void>): Promise<void> {
  if (process.argv[1] && fileURLToPath(moduleUrl) === process.argv[1]) {
    await fn();
  }
}
