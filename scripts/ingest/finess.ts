import "dotenv/config";
import * as fs from "node:fs";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { parseCoordinates } from "../../src/core/coords.js";
import { requireEnv } from "../../src/storage/supabase.js";
import {
  IngestError,
  type IngestLogEntry,
  atomicSwapTables,
  downloadCsv,
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
    // small interval — give it a moment so the next insert finds the table
    // in the schema cache instead of "Could not find the table 'public.finess_staging'".
    await new Promise((resolve) => setTimeout(resolve, 2000));

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

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const { error } = await supabase.from("finess_staging").insert(batch);
    if (error) {
      throw new IngestError("copy", `Insert into finess_staging failed: ${error.message}`);
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

function getNonEmpty(rec: Record<string, string>, name: string): string | null {
  const v = rec[name];
  return v === undefined || v === "" ? null : v;
}

function parseFinessRecord(rec: Record<string, string>): ParsedFinessRow {
  const numFiness = getNonEmpty(rec, "nofinesset");
  if (!numFiness) return { skipReason: "no_finess_id" };

  const codeInsee = getNonEmpty(rec, "commune");
  if (!codeInsee) return { skipReason: "no_commune" };

  // FINESS extract publishes coords as separate `latitude` / `longitude` columns
  // in the augmented dataset (the raw ANS extract is geocoded by data.gouv).
  // See https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/
  // Fall back to NULL if absent or unparseable.
  const coords = parseCoordinates(
    getNonEmpty(rec, "longitude") ?? undefined,
    getNonEmpty(rec, "latitude") ?? undefined,
  );
  const geomWkt = coords ? `SRID=4326;POINT(${coords.lon} ${coords.lat})` : null;

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
      geom: geomWkt,
      raw,
    },
  };
}

await main();
