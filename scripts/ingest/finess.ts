import "dotenv/config";
import * as fs from "node:fs";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { requireEnv } from "../../src/storage/supabase.js";
import {
  IngestError,
  type IngestLogEntry,
  atomicSwapTables,
  downloadCsv,
  getNonEmpty,
  preValidateFile,
  writeIngestLog,
} from "./shared.js";

// Canonical FINESS extract on data.gouv (geocoded version). Verify the resource
// id is current at https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/
// before each release — the data.gouv dataset slug is stable, but the underlying
// resource id can rotate. Override at runtime via FINESS_CSV_URL env var.
const FINESS_CSV_URL =
  process.env.FINESS_CSV_URL ??
  "https://www.data.gouv.fr/fr/datasets/r/3dc9b1d5-0157-440d-a7b5-c894fcfdfd45";

const MIN_SIZE_BYTES = 30_000_000; // FINESS extract is ~35 MB; 30 MB threshold catches truncations.
const MIN_ROWS = 50_000;
const MAX_ROWS = 200_000;
const BATCH_SIZE = 500;

/**
 * How long to wait after `NOTIFY pgrst, 'reload schema'` before issuing the
 * first insert against the freshly-created staging table. PostgREST polls the
 * notification on a short interval; ~1-2s is the canonical pause documented
 * in Supabase's runtime-DDL recipes. Without it, the first insert can race
 * the schema-cache refresh and fail with "Could not find the table ...".
 */
const PGRST_RELOAD_WAIT_MS = 2000;

/** Rows per batched call to `ingest_apply_finess_geom_batch` (PostgREST 60s proxy timeout safe). */
const GEOM_BATCH_SIZE = 10_000;

/** Hard floor on geocoded-rows ratio. Below this, we suspect a CSV format change. */
const MIN_GEOM_COVERAGE = 0.8;

interface FinessStagingRow {
  num_finess: string;
  raison_sociale: string;
  categorie_code: string | null;
  categorie_libelle: string | null;
  num_voie: string | null;
  type_voie: string | null;
  voie: string | null;
  code_postal: string | null;
  code_insee: string;
  ville: string | null;
  telephone: string | null;
  email: string | null;
  date_ouverture: string | null;
  date_maj: string | null;
  /** EWKT string — PostGIS auto-casts to `geometry(Point, 4326)` on insert. */
  geom: string | null;
  raw: Record<string, string>;
}

/**
 * Untyped Supabase client used to insert into the runtime-created
 * `finess_staging` table. The generated `Database` type only knows about prod
 * tables; staging is dropped/recreated each run via the
 * `ingest_create_finess_staging()` RPC, so it can't appear in the generated
 * types. Using an untyped client for staging inserts is the most honest option
 * and avoids `as any` casts on the payload.
 */
function getUntypedServiceClient(): SupabaseClient {
  // Reuse the shared `requireEnv` helper so empty-string env vars are
  // diagnosed the same way as in the typed clients (catches misconfigured
  // GitHub Secrets early — see SFH-1 round 2 audit).
  try {
    const url = requireEnv("SUPABASE_URL");
    const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    return createClient(url, key, { auth: { persistSession: false } });
  } catch (err) {
    console.error("[finess] failed to build service client:", err);
    throw new IngestError("copy", err instanceof Error ? err.message : String(err), err);
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const log: IngestLogEntry = {
    source: "finess",
    started_at: startedAt,
    status: "failed",
    csv_url: FINESS_CSV_URL,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    // 1. DOWNLOAD
    const downloaded = await downloadCsv(FINESS_CSV_URL, "finess.csv");
    log.csv_size_bytes = downloaded.sizeBytes;

    // 2. PRE-VALIDATE
    await preValidateFile(downloaded.filePath, {
      minSizeBytes: MIN_SIZE_BYTES,
      expectedHeaderColumns: ["nofinesset", "rs", "categetab", "departement"],
      // The data.gouv geocoded FINESS CSV is comma-delimited (NOT ";", which
      // would be the convention for raw ANS extracts). Verified from a real
      // run on 2026-05-08 — first line started with "," (empty first column).
      delimiter: ",",
    });

    // 3. COPY → STAGING
    const supabase = getUntypedServiceClient();
    const { error: stagingErr } = await supabase.rpc("ingest_create_finess_staging");
    if (stagingErr) {
      throw new IngestError("copy", `Failed to create finess_staging table: ${stagingErr.message}`);
    }
    // The RPC emits NOTIFY pgrst,'reload schema' but PostgREST polls on a
    // small interval — wait so the next insert finds the table in the schema
    // cache instead of "Could not find the table 'public.finess_staging'".
    await new Promise((resolve) => setTimeout(resolve, PGRST_RELOAD_WAIT_MS));

    const stats = await streamCsvToStaging(downloaded.filePath, supabase);
    log.row_count = stats.inserted;

    // 4. VALIDATE COHERENCE
    if (stats.inserted < MIN_ROWS) {
      throw new IngestError(
        "validate",
        `Row count ${stats.inserted} below minimum ${MIN_ROWS} — suspected partial parse`,
      );
    }
    if (stats.inserted > MAX_ROWS) {
      throw new IngestError(
        "validate",
        `Row count ${stats.inserted} above maximum ${MAX_ROWS} — suspected format change`,
      );
    }

    // 4b. APPLY GEOM (Lambert 93 → WGS84 transform server-side, batched)
    // The CSV uses coordxet/coordyet (EPSG:2154) which were stored in `raw`.
    // We batch the UPDATE to stay under PostgREST's 60s proxy timeout — each
    // call updates up to GEOM_BATCH_SIZE rows that don't yet have a geom,
    // and we loop until the RPC returns fewer rows than requested.
    // Bounded safety net: 95K rows / 10K batch = 10 iterations max under
    // healthy operation. We add a generous margin so a slow tail (last batch
    // tiny) doesn't trip the cap, but a runaway loop (RPC contract regression)
    // will surface as a clear error instead of hanging the workflow.
    const maxGeomIterations = Math.ceil(stats.inserted / GEOM_BATCH_SIZE) + 5;
    let updated = 0;
    let iter = 0;
    while (true) {
      if (++iter > maxGeomIterations) {
        throw new IngestError(
          "validate",
          `Geom transform did not converge after ${maxGeomIterations} batches — likely RPC contract regression (rows updated but geom still NULL)`,
        );
      }
      const { data: batchUpdated, error: geomErr } = await supabase.rpc(
        "ingest_apply_finess_geom_batch",
        { p_limit: GEOM_BATCH_SIZE },
      );
      if (geomErr) {
        throw new IngestError("validate", `Failed to apply geom transform: ${geomErr.message}`);
      }
      // Strict type check: the RPC must return a number. A null/string/object
      // is a PostgREST or Supabase serialization regression that we want to
      // fail loud, not coerce to 0 (which would silently exit the loop early).
      if (typeof batchUpdated !== "number") {
        throw new IngestError(
          "validate",
          `ingest_apply_finess_geom_batch returned ${typeof batchUpdated} instead of number — RPC contract regression`,
        );
      }
      updated += batchUpdated;
      // Exit ONLY on 0 — that's the canonical "no more rows to process"
      // signal. A short-but-non-zero batch (lock contention, planner choosing
      // parallel scan that returns slightly fewer than asked) does NOT mean
      // we're done.
      if (batchUpdated === 0) break;
    }
    console.log(`[finess] geom transform: ${updated}/${stats.inserted} rows geocoded`);
    if (updated < stats.inserted * MIN_GEOM_COVERAGE) {
      const pct = (MIN_GEOM_COVERAGE * 100).toFixed(0);
      throw new IngestError(
        "validate",
        `Only ${updated}/${stats.inserted} rows have a valid geom (< ${pct}% threshold) — coordxet/coordyet likely missing or malformed`,
      );
    }

    // Surface upstream-parsing-bug suspects: rows dropped due to missing
    // required fields. Threshold of 1% of inserted rows is the same alarm
    // bar discussed in the V0.2 final review (SFH-5).
    const skippedTotal = stats.skippedNoFinessId + stats.skippedNoCommune;
    const skipRate = stats.inserted > 0 ? skippedTotal / (stats.inserted + skippedTotal) : 0;
    if (skippedTotal > 0) {
      const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
      console.warn(
        `[finess] skipped ${skippedTotal} rows (${fmt(skipRate)}): ${stats.skippedNoFinessId} missing nofinesset, ${stats.skippedNoCommune} missing commune`,
      );
      if (skipRate > 0.01) {
        throw new IngestError(
          "validate",
          `Skip rate ${fmt(skipRate)} above 1% threshold — likely upstream parsing regression (column rename/shift)`,
        );
      }
    }

    // 5. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "finess" });

    // SUCCESS
    log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[finess] success: ${stats.inserted} rows ingested in ${elapsedSec}s`);
  } catch (err) {
    console.error("[finess] ingestion failed:", err);
    const ingestErr =
      err instanceof IngestError
        ? err
        : new IngestError("download", err instanceof Error ? err.message : String(err), err);
    log.status = "failed";
    log.error_phase = ingestErr.phase;
    log.error_message = ingestErr.message;
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    console.error(`[finess] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

interface IngestStreamStats {
  inserted: number;
  skippedNoFinessId: number;
  skippedNoCommune: number;
}

async function streamCsvToStaging(
  filePath: string,
  supabase: SupabaseClient,
): Promise<IngestStreamStats> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });

  const parser = stream.pipe(
    parse({
      // Match the pre-validate delimiter — see header-validation block above.
      delimiter: ",",
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }),
  );

  let batch: FinessStagingRow[] = [];
  let inserted = 0;
  let skippedNoFinessId = 0;
  let skippedNoCommune = 0;
  let firstBatch = true;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // The first batch can race with PostgREST's schema-cache reload. If it
    // hits "table not found in schema cache", retry with backoff — usually
    // PostgREST has caught up within 2-4 more seconds. After the first
    // successful insert the cache is warm; subsequent batches don't retry.
    const insert = async () => supabase.from("finess_staging").insert(batch);
    let result = await insert();
    if (firstBatch && result.error && /schema cache/i.test(result.error.message)) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const wait = 2000 * attempt;
        console.warn(`[finess] schema cache miss on first insert, retry ${attempt}/3 in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        result = await insert();
        if (!result.error) break;
        if (!/schema cache/i.test(result.error.message)) break;
      }
    }
    firstBatch = false;
    if (result.error) {
      throw new IngestError("copy", `Insert into finess_staging failed: ${result.error.message}`);
    }
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = parseFinessRecord(record);
    if (parsed.row) {
      batch.push(parsed.row);
    } else if (parsed.skipReason === "no_finess_id") {
      skippedNoFinessId++;
    } else if (parsed.skipReason === "no_commune") {
      skippedNoCommune++;
    }
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return { inserted, skippedNoFinessId, skippedNoCommune };
}

type ParsedFinessRow =
  | { row: FinessStagingRow; skipReason?: never }
  | { row?: never; skipReason: "no_finess_id" | "no_commune" };

function parseFinessRecord(rec: Record<string, string>): ParsedFinessRow {
  const numFiness = getNonEmpty(rec, "nofinesset");
  if (!numFiness) return { skipReason: "no_finess_id" };

  const codeInsee = getNonEmpty(rec, "commune");
  if (!codeInsee) return { skipReason: "no_commune" };

  // Geom is populated server-side by ingest_apply_finess_geom_batch which
  // reads coordxet/coordyet (Lambert 93) from `raw` and reprojects to WGS84.
  // We deliberately leave geom NULL here — single source of truth = the RPC.
  // See V0.2 final review (commit 88ebfc0) for the postmortem.

  // Filter raw to only non-empty string entries, for compact JSONB storage.
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== "" && v !== undefined) raw[k] = v;
  }

  return {
    row: {
      num_finess: numFiness,
      raison_sociale: getNonEmpty(rec, "rs") ?? "",
      categorie_code: getNonEmpty(rec, "categetab"),
      categorie_libelle: getNonEmpty(rec, "libcategetab"),
      num_voie: getNonEmpty(rec, "numvoie"),
      type_voie: getNonEmpty(rec, "typvoie"),
      voie: getNonEmpty(rec, "voie"),
      code_postal: null, // FINESS embeds postal in `ligneacheminement`; left for V0.3 to extract
      code_insee: codeInsee,
      ville: getNonEmpty(rec, "libdepartement"),
      telephone: getNonEmpty(rec, "telephone"),
      email: null,
      date_ouverture: getNonEmpty(rec, "dateouv"),
      date_maj: getNonEmpty(rec, "datemaj"),
      geom: null,
      raw,
    },
  };
}

await main();
