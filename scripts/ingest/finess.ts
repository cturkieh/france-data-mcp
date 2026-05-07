import "dotenv/config";
import * as fs from "node:fs";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
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
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new IngestError(
      "copy",
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — required for staging inserts.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
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
      delimiter: ";",
    });

    // 3. COPY → STAGING
    const supabase = getUntypedServiceClient();
    const { error: stagingErr } = await supabase.rpc("ingest_create_finess_staging");
    if (stagingErr) {
      throw new IngestError("copy", `Failed to create finess_staging table: ${stagingErr.message}`);
    }
    const rowCount = await streamCsvToStaging(downloaded.filePath, supabase);
    log.row_count = rowCount;

    // 4. VALIDATE COHERENCE
    if (rowCount < MIN_ROWS) {
      throw new IngestError(
        "validate",
        `Row count ${rowCount} below minimum ${MIN_ROWS} — suspected partial parse`,
      );
    }
    if (rowCount > MAX_ROWS) {
      throw new IngestError(
        "validate",
        `Row count ${rowCount} above maximum ${MAX_ROWS} — suspected format change`,
      );
    }

    // 5. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "finess" });

    // SUCCESS
    log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[finess] success: ${rowCount} rows ingested in ${elapsedSec}s`);
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

async function streamCsvToStaging(filePath: string, supabase: SupabaseClient): Promise<number> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });

  // csv-parse handles quoted fields, embedded delimiters, and CRLF correctly.
  const parser = stream.pipe(
    parse({
      delimiter: ";",
      columns: true, // first line = header → records are objects keyed by column name
      skip_empty_lines: true,
      relax_quotes: true, // FINESS source occasionally has unbalanced quotes
      trim: true,
      bom: true, // strip UTF-8 BOM if present
    }),
  );

  let batch: FinessStagingRow[] = [];
  let total = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const { error } = await supabase.from("finess_staging").insert(batch);
    if (error) {
      throw new IngestError("copy", `Insert into finess_staging failed: ${error.message}`);
    }
    total += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const row = parseFinessRecord(record);
    if (row) batch.push(row);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return total;
}

function parseFinessRecord(rec: Record<string, string>): FinessStagingRow | null {
  const get = (name: string): string | null => {
    const v = rec[name];
    if (v === undefined || v === "") return null;
    return v;
  };

  const numFiness = get("nofinesset");
  if (!numFiness) return null;

  const codeInsee = get("commune");
  if (!codeInsee) return null;

  // FINESS extract publishes coords as separate `latitude` / `longitude` columns
  // in the augmented dataset (the raw ANS extract is geocoded by data.gouv).
  // See https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/
  // for the column reference. Fall back to NULL if absent.
  const lat = get("latitude");
  const lon = get("longitude");
  const latNum = lat ? Number.parseFloat(lat.replace(",", ".")) : Number.NaN;
  const lonNum = lon ? Number.parseFloat(lon.replace(",", ".")) : Number.NaN;
  const geomWkt =
    Number.isFinite(latNum) && Number.isFinite(lonNum)
      ? `SRID=4326;POINT(${lonNum} ${latNum})`
      : null;

  // Filter raw to only non-empty string entries, for compact JSONB storage.
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== "" && v !== undefined) raw[k] = v;
  }

  return {
    num_finess: numFiness,
    raison_sociale: get("rs") ?? "",
    categorie_code: get("categetab"),
    categorie_libelle: get("libcategetab"),
    num_voie: get("numvoie"),
    type_voie: get("typvoie"),
    voie: get("voie"),
    code_postal: null, // FINESS embeds postal in `ligneacheminement`; left for V0.3 to extract
    code_insee: codeInsee,
    ville: get("libdepartement"),
    telephone: get("telephone"),
    email: null,
    date_ouverture: get("dateouv"),
    date_maj: get("datemaj"),
    geom: geomWkt,
    raw,
  };
}

await main();
