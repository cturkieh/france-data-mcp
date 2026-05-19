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
import { withTimeout } from "../../src/core/with-timeout.js";
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
export type IngestSource = "finess" | "ameli_ps" | "rpps" | "cds";

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
  /**
   * Phase 1 mesure (RPPS uniquement) — nb d'adresses DISTINCTES éligibles
   * BAN dans `rpps_staging` au moment du cron (post-FINESS, pre-ban_join).
   * Mesure dimensionne la future Phase 2 (re-géocodage récurrent). NULL si
   * la mesure n'a pas pu s'exécuter (best-effort : un échec ne casse pas
   * le cron — distinct d'un "0 mesuré"). Mesuré par
   * `rpps_measure_ban_to_geocode` (migration 20260520T000000).
   */
  ban_eligible_distinct?: number | null;
  /**
   * Phase 1 mesure (RPPS uniquement) — sous-ensemble des éligibles
   * distincts PAS encore résolu/capé dans `geocoded_addresses` (= taille
   * de la file BAN qu'un re-géocodage automatique aurait à traiter ce
   * cycle). NULL : idem ci-dessus.
   */
  ban_to_geocode_distinct?: number | null;
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
 * `force=true` (levier opérationnel, ex. `FORCE_REINGEST` en
 * `workflow_dispatch`) NEUTRALISE le court-circuit : retourne `false`
 * immédiatement SANS toucher `log` ni écrire d'entrée skip — la ré-ingestion
 * complète se déroule et se loggue normalement (audit intact). Sert à
 * réappliquer un traitement aval (ex. cache BAN jamais posé) quand la source
 * n'a pas changé. Générique (chokepoint partagé) mais opt-in par caller.
 *
 * Retourne `true` si le short-circuit s'est déclenché, `false` sinon.
 */
export async function shortCircuitIfSameChecksum(
  log: IngestLogEntry,
  lastSha: string | null,
  currentSha: string,
  tag: string,
  force = false,
): Promise<boolean> {
  if (force) {
    // Helper générique : message agnostique du caller (ne nomme PAS la var
    // d'env du caller, ce serait une inversion de couche).
    console.warn(
      `[${tag}] court-circuit same-checksum neutralisé (force) — ré-ingestion complète forcée`,
    );
    return false;
  }
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
 * Décide si la var d'env de forçage active le bypass du court-circuit. Pur
 * (testable sans `vi.stubEnv`). TOLÉRANT aux formes intuitives : `"1"` ou
 * `"true"` (insensible à la casse, espaces tolérés). Tout le reste — `"0"`,
 * `"false"`, `""`, absent — = pas de forçage.
 *
 * Pourquoi tolérer `"true"` : un opérateur câblant `FORCE_REINGEST=true`
 * (valeur intuitive) au lieu de `"1"` ne doit PAS voir son run ignoré
 * silencieusement (faux négatif opérateur : il coche la case, rien ne se
 * force, le cache BAN reste non posé, status `success` trompeur). Le
 * `workflow_dispatch` n'émet que `"1"`/`"0"` mais ce helper protège aussi
 * l'invocation manuelle/locale.
 */
export function isForceReingestEnv(value: string | undefined): boolean {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
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

export interface DropStalePreviousInput {
  /** Logical name of the production table (e.g. "rpps"). `<prodTable>_previous` is the candidate. */
  prodTable: string;
  /** Source name as written in `ingest_log` (e.g. "rpps", "finess", "ameli_ps"). */
  source: string;
  /** Tolerance before DROP. Default 7 days. */
  maxAgeDays?: number;
}

/**
 * Default age threshold (jours) avant DROP automatique de `<prod>_previous`.
 * Miroir du `p_max_age_days INT DEFAULT 7` côté SQL (migration
 * `20260514T080000_rpc_drop_stale_previous.sql`) — toute modification doit
 * synchroniser les deux côtés.
 */
export const DROP_STALE_PREVIOUS_DEFAULT_DAYS = 7;

/**
 * Borne maximale autorisée par la RPC SQL (`p_max_age_days <= 365`). Au-delà,
 * la RPC lève EXCEPTION. Exposé pour pré-valider côté TS avant l'appel et
 * éviter un round-trip réseau juste pour découvrir une borne SQL.
 */
export const DROP_STALE_PREVIOUS_MAX_DAYS = 365;

/**
 * Outcome retourné par `ingest_drop_stale_previous` (RPC SQL). Discriminé
 * pour que le caller distingue économie réelle vs no-op cosmétique.
 */
export type DropStalePreviousOutcome =
  | { kind: "dropped"; table: string; ageDays: number }
  | { kind: "kept"; table: string; ageDays: number }
  | { kind: "absent"; table: string }
  | { kind: "no_history"; table: string };

/**
 * Drop `<prodTable>_previous` si l'âge dépasse `maxAgeDays` (default 7).
 * Mesuré contre `MAX(ingest_log.started_at WHERE status='success')` de la
 * source — la date du dernier swap réussi. Idempotent : safe d'appeler
 * répétitivement (job de maintenance, post-mortem, etc.).
 *
 * Pas intégré au flow d'ingestion lui-même : le swap suivant overwrite
 * previous de toute façon. Utile UNIQUEMENT quand l'ingestion stagne (cron
 * down, source upstream cassée, checksum identique répété) — économie disk
 * sur RPPS_previous (~700 MB) et Ameli_previous (~150 MB) principalement.
 */
export async function dropStalePrevious(
  input: DropStalePreviousInput,
): Promise<DropStalePreviousOutcome> {
  // Untyped client : la RPC `ingest_drop_stale_previous` (V0.9.3, migration
  // 20260514T080000) n'est pas encore dans les types Supabase générés
  // — `getServiceClient` typé la refuserait au compile time. Pattern miroir
  // de `countFiness` / wrappers `rpps-db.ts`.
  const supabase = getUntypedServiceClient(`drop-stale:${input.source}`);
  const { data, error } = await supabase.rpc("ingest_drop_stale_previous", {
    p_prod_table: input.prodTable,
    p_source: input.source,
    p_max_age_days: input.maxAgeDays ?? DROP_STALE_PREVIOUS_DEFAULT_DAYS,
  });
  if (error) {
    throw new IngestError(
      "swap",
      `DROP stale previous failed for table "${input.prodTable}": ${error.message}`,
    );
  }
  if (typeof data !== "string") {
    throw new IngestError(
      "swap",
      `ingest_drop_stale_previous returned non-string for "${input.prodTable}" (got ${typeof data}: ${JSON.stringify(data)})`,
    );
  }
  return parseDropStalePreviousOutcome(data);
}

/**
 * Parse la string retournée par `ingest_drop_stale_previous` en union
 * discriminée. Exporté pour permettre des tests unitaires sans mock Supabase.
 *
 * Formats reconnus (kind:table[:ageDays]) :
 *   - `dropped:<table>:<n>d`
 *   - `kept:<table>:<n>d`
 *   - `absent:<table>`
 *   - `no_history:<table>`
 *
 * Le pattern table reproduit `^[a-z_][a-z0-9_]*$` (miroir du check SQL
 * `p_prod_table !~ '...'`) pour bloquer un drift de contrat où la RPC
 * retournerait une string hostile ou mal échappée.
 */
const DROP_STALE_OUTCOME_PATTERN =
  /^(dropped|kept|absent|no_history):([a-z_][a-z0-9_]*)(?::(\d+)d)?$/;

export function parseDropStalePreviousOutcome(raw: string): DropStalePreviousOutcome {
  const match = raw.match(DROP_STALE_OUTCOME_PATTERN);
  if (!match) {
    throw new IngestError(
      "swap",
      `ingest_drop_stale_previous returned unexpected format: ${JSON.stringify(raw)}`,
    );
  }
  const kind = match[1];
  const table = match[2];
  const ageGroup = match[3];
  if (table === undefined) {
    throw new IngestError("swap", `ingest_drop_stale_previous: missing table name in "${raw}"`);
  }
  if (kind === "dropped" || kind === "kept") {
    if (ageGroup === undefined) {
      throw new IngestError(
        "swap",
        `ingest_drop_stale_previous: missing ageDays for kind "${kind}" in "${raw}"`,
      );
    }
    return { kind, table, ageDays: Number(ageGroup) };
  }
  if (kind === "absent" || kind === "no_history") {
    return { kind, table };
  }
  // Inatteignable car la regex contraint déjà les 4 valeurs — defense-in-depth
  // au cas où la regex serait élargie sans mise à jour du discriminé TS.
  throw new IngestError("swap", `ingest_drop_stale_previous: unknown kind "${kind}" in "${raw}"`);
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

/**
 * Boucle un RPC server-side qui traite un lot de rows par appel et retourne
 * le nombre de rows mises à jour, jusqu'à ce qu'aucune row ne soit éligible
 * (`rowCount === 0`). Pattern partagé par les ingesters qui restent sous le
 * timeout PostgREST 60s : `ingest_apply_finess_geom_batch` (Lambert93→WGS84
 * sur ~95K rows), `ingest_apply_rpps_finess_enrichment_batch` (FINESS join
 * sur ~970K rows RPPS sans geom).
 *
 * Garde anti-divergence : si après `ceil(expectedTotal / batchSize) + 5`
 * itérations le RPC retourne toujours non-zéro, on suspecte un bug de
 * contrat (UPDATE compté mais condition WHERE jamais réduite) et on throw.
 * La marge `+5` absorbe les batches partiels où certaines rows n'ont pas
 * de match upstream et restent visibles à chaque scan.
 *
 * Type-strict : un retour `null`/`string` est traité comme régression
 * PostgREST (pas un fallback à 0 silencieux qui sort la boucle trop tôt).
 *
 * @param expectedTotal — borne haute pour le `maxIterations` cap. Pas une
 *   contrainte fonctionnelle ; le RPC peut traiter moins (et la boucle
 *   terminera plus tôt sur le `rowCount === 0`).
 */
/**
 * UN appel RPC borné anti-hang, partagé par `runBatchedRpc` (sentinelle) et
 * `runKeysetRpc` (curseur). Factorise le bloc try/catch timeout + check
 * `error` byte-identique des deux pilotes (DRY — la divergence est dans la
 * terminaison/le contrat de retour, PAS dans l'appel unitaire). Retourne le
 * `data` brut (forme validée par l'appelant selon son contrat). `TimeoutError`
 * (socket figé) → `IngestError` fail-loud (cron non surveillé) ; toute autre
 * exception est re-levée telle quelle ; `{ error }` PostgREST → `IngestError`.
 * `perCallTimeoutMs` undefined = aucun timeout (rétrocompat FINESS/Ameli de
 * `runBatchedRpc`).
 */
async function callRpcOne(
  supabase: SupabaseClient,
  rpcName: string,
  params: Record<string, unknown>,
  iter: number,
  perCallTimeoutMs?: number,
): Promise<unknown> {
  const call = supabase.rpc(rpcName, params);
  let result: Awaited<typeof call>;
  try {
    result =
      perCallTimeoutMs === undefined
        ? await call
        : await withTimeout(call, perCallTimeoutMs, `${rpcName} (batch ${iter})`);
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      console.error(
        `[france-data-mcp][ingest] ${rpcName} timed out after ${perCallTimeoutMs}ms (batch ${iter}) — anti-silent-hang bound tripped, failing loud`,
      );
      throw new IngestError(
        "validate",
        `${rpcName} timed out after ${perCallTimeoutMs}ms (batch ${iter}) — possible hung apply RPC (anti-silent-hang bound)`,
      );
    }
    console.error(
      `[france-data-mcp][ingest] ${rpcName} (batch ${iter}) threw a non-timeout error, re-raising`,
    );
    throw e;
  }
  const { data, error } = result;
  if (error) {
    throw new IngestError("validate", `${rpcName} failed: ${error.message}`);
  }
  return data;
}

export async function runBatchedRpc(
  supabase: SupabaseClient,
  rpcName: string,
  params: Record<string, unknown>,
  expectedTotal: number,
  batchSize: number,
  // Borne ANTI-HANG optionnelle par appel. `undefined` (défaut) = aucun
  // timeout (comportement inchangé pour les ingesters FINESS/Ameli). Posé par
  // le step BAN du cron RPPS non surveillé : un `supabase.rpc()` brut sur un
  // socket figé pendrait indéfiniment jusqu'au kill GitHub Actions, SANS
  // `partial` ni trace `ingest_log` (la classe de hang silencieux que
  // `RPC_READ_TIMEOUT_MS` ferme déjà sur les lectures — laissée ouverte ici
  // sinon). Le `TimeoutError` est converti en `IngestError` fail-loud → le
  // caller best-effort le rabat en `partial` + message persisté.
  perCallTimeoutMs?: number,
): Promise<{ totalUpdated: number; iterations: number }> {
  const maxIterations = Math.ceil(Math.max(expectedTotal, 1) / batchSize) + 5;
  let totalUpdated = 0;
  let iter = 0;
  while (true) {
    if (++iter > maxIterations) {
      throw new IngestError(
        "validate",
        `${rpcName} did not converge after ${maxIterations} batches — likely RPC contract regression (rows updated but WHERE predicate not narrowing)`,
      );
    }
    const data = await callRpcOne(supabase, rpcName, params, iter, perCallTimeoutMs);
    if (typeof data !== "number") {
      throw new IngestError(
        "validate",
        `${rpcName} returned ${typeof data} instead of number — RPC contract regression`,
      );
    }
    totalUpdated += data;
    if (data === 0) return { totalUpdated, iterations: iter };
  }
}

/**
 * Pilote keyset générique pour une RPC d'application batchée par CURSEUR
 * (≠ `runBatchedRpc` qui s'appuie sur un prédicat auto-rétrécissant /
 * sentinelle). La RPC DOIT accepter `p_after` (curseur) + les `params` fixes
 * (dont `p_limit`), et renvoyer UNE ligne `{ last_id: bigint|null, applied: int }` :
 * `last_id` = dernière clé VUE (matchée ou non) du lot ; `null` ⇒ page vide ⇒
 * fin. Garde de NON-PROGRESSION : si `last_id` n'augmente pas strictement → un
 * `IngestError` (régression de contrat : rows vues mais curseur figé = boucle
 * infinie). Pourquoi keyset et NON sentinelle : prouvé prod (cf.
 * docs/plans/2026-05-19-ban-join-design.md §3.2) — la sentinelle re-scanne le
 * préfixe déjà traité (quadratique → 57014 en fin de parcours, proxy OFFSET
 * 1.2M > 120 s) ; le keyset démarre où le lot précédent s'est arrêté
 * (linéaire, ~4,8 s/lot constant prouvé prod). Borne anti-hang `withTimeout`
 * par appel (le cron RPPS n'est pas surveillé : un socket figé pendrait
 * jusqu'au kill GitHub Actions sans `partial` ni trace `ingest_log`).
 * `perCallTimeoutMs` défaut 120 s (= le `RPC_BATCH_TIMEOUT_MS` que le caller
 * cron passe explicitement ; littéral ici pour éviter une dépendance croisée
 * shared↔rpps et garder les tests autonomes).
 */
export async function runKeysetRpc(
  supabase: SupabaseClient,
  rpcName: string,
  params: Record<string, unknown>,
  expectedTotal: number,
  perCallTimeoutMs = 120_000,
): Promise<{ totalApplied: number; iterations: number }> {
  // FAIL-LOUD : `p_limit` absent/invalide rendrait `maxIterations` aveugle
  // (`Number(undefined) || 1` → batchSize 1 → garde de convergence ≈ inerte
  // sur 1,29 M lignes). On REJETTE explicitement plutôt que de masquer une
  // mauvaise invocation (discipline projet anti-silencieux).
  const pLimit = params.p_limit;
  if (typeof pLimit !== "number" || !Number.isInteger(pLimit) || pLimit <= 0) {
    throw new IngestError(
      "validate",
      `runKeysetRpc(${rpcName}): params.p_limit doit être un entier positif (reçu ${JSON.stringify(pLimit)}) — sinon la garde maxIterations est aveugle`,
    );
  }
  const maxIterations = Math.ceil(Math.max(expectedTotal, 1) / pLimit) + 5;
  let after = 0;
  let totalApplied = 0;
  let iter = 0;
  while (true) {
    if (++iter > maxIterations) {
      throw new IngestError(
        "validate",
        `${rpcName} did not converge after ${maxIterations} batches — likely RPC contract regression (cursor not advancing to a NULL terminator)`,
      );
    }
    const data = await callRpcOne(
      supabase,
      rpcName,
      { ...params, p_after: after },
      iter,
      perCallTimeoutMs,
    );
    // `RETURNS TABLE(...)` via PostgREST = tableau de lignes ; on attend
    // EXACTEMENT 1 ligne. Un tableau VIDE n'est PAS une page vide (celle-ci
    // renvoie 1 ligne `{ last_id: null }`) : c'est une régression de contrat
    // — fail-loud explicite plutôt que sortie success-shaped silencieuse
    // (`data[0]` serait `undefined` → `row == null` → faux « fin » muet).
    if (Array.isArray(data) && data.length === 0) {
      throw new IngestError(
        "validate",
        `${rpcName} returned an empty array — expected exactly one { last_id, applied } row (RPC contract regression)`,
      );
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row == null || typeof row !== "object" || !("last_id" in row) || !("applied" in row)) {
      throw new IngestError(
        "validate",
        `${rpcName} returned an unexpected shape instead of { last_id, applied } — RPC contract regression`,
      );
    }
    // Un seul cast après narrowing de présence ; les types sont ensuite
    // validés explicitement. `last_id` DOIT être number|null (le `null` = page
    // vide terminale ; un string casserait `lastId <= after` en comparaison
    // lexicographique → garde de non-progression aveugle — asymétrie fermée
    // /review P1 LOW). `applied` DOIT être un number (compteur de posés).
    const { last_id: lastId, applied } = row as { last_id: unknown; applied: unknown };
    if ((lastId !== null && typeof lastId !== "number") || typeof applied !== "number") {
      throw new IngestError(
        "validate",
        `${rpcName} returned an unexpected shape instead of { last_id, applied } — RPC contract regression`,
      );
    }
    totalApplied += applied;
    if (lastId == null) return { totalApplied, iterations: iter };
    if (lastId <= after) {
      throw new IngestError(
        "validate",
        `${rpcName} cursor did not progress (after=${after} last_id=${lastId}) — RPC contract regression (rows seen but cursor frozen)`,
      );
    }
    after = lastId;
  }
}

/**
 * Codes PostgREST de schema-cache miss (typed contract > regex sur message
 * localisable). `PGRST205` = table absente du cache (post-CREATE staging),
 * `PGRST204` = colonne absente (post-ALTER, ex RPPS `geom_source`). Le NOTIFY
 * 'reload schema' posté par la RPC SECURITY DEFINER n'est pas encore propagé :
 * phénomène transitoire, le retry couvre les deux.
 */
export const PGRST_TABLE_CACHE_MISS = "PGRST205";
export const PGRST_COLUMN_CACHE_MISS = "PGRST204";

/**
 * Insère UN batch dans une table de staging avec retry sur schema-cache miss
 * PostgREST (PGRST205 table absente du cache, +PGRST204 colonne pour RPPS).
 *
 * Pourquoi factorisé : cette boucle d'insert+retry était dupliquée à
 * l'identique dans `finess.ts`, `ameli.ts`, `rpps.ts` et `cds.ts` (4×) — la
 * seule divergence légitime étant les codes cache-miss RPPS. Une copie
 * dérivait déjà (compteur de retry affiché). Le caller garde sa propre
 * stratégie de batching (flush() streaming vs slice de tableau pré-construit)
 * et ne délègue ici QUE l'insert d'un batch + le retry + le wrapping
 * `IngestError("copy", …)` qui préserve l'erreur Supabase complète en `cause`
 * (sinon post-mortem aveugle sur un échec non-PGRST205 : RLS, trigger, drift).
 *
 * `isFirstBatch` : seul le 1er batch retry (le sleep post-RPC de création
 * staging couvre le cas courant, le retry est le 2e filet sous charge ; une
 * fois le 1er batch passé la table est forcément en cache).
 */
export async function insertStagingBatchWithRetry<TRow extends object>(
  supabase: Pick<SupabaseClient, "from">,
  table: string,
  batch: readonly TRow[],
  opts: { logPrefix: string; isFirstBatch: boolean; extraCacheMissCodes?: readonly string[] },
): Promise<void> {
  if (batch.length === 0) return;
  const cacheMissCodes = new Set<string>([
    PGRST_TABLE_CACHE_MISS,
    ...(opts.extraCacheMissCodes ?? []),
  ]);
  const isSchemaCacheMiss = (err: { code?: string } | null): boolean =>
    err?.code !== undefined && cacheMissCodes.has(err.code);
  const maxAttempts = opts.isFirstBatch ? 4 : 1;
  let lastErr: { message: string; code?: string } | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const wait = 2000 * attempt;
      console.warn(
        `[${opts.logPrefix}] schema cache miss, retry ${attempt}/${maxAttempts - 1} in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
    // L'INSERT PostgREST sur table de staging non typée (client `untyped`)
    // attend `never[]` côté types Supabase générés : cast borné au call,
    // identique à ce que faisaient les 4 callers historiques.
    const { error } = await supabase.from(table).insert(batch as never[]);
    if (!error) return;
    lastErr = error;
    if (!isSchemaCacheMiss(error)) break;
  }
  // Préserver l'erreur Supabase complète (code, hint, details) via `cause` :
  // sans ça un échec non-cache (RLS, schema drift, trigger) ne laisse que
  // `lastErr.message` à l'opérateur pour le post-mortem.
  console.error(`[${opts.logPrefix}] insert into ${table} failed:`, lastErr);
  throw new IngestError(
    "copy",
    `Insert into ${table} failed [code=${lastErr?.code ?? "none"}]: ${lastErr?.message ?? "unknown"}`,
    lastErr,
  );
}
