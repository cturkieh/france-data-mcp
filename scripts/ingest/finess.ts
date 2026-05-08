import "dotenv/config";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { finessFamille } from "../../src/sante/finess-categories.js";
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

/**
 * Aborts the run when structural anomalies (missing nofinesset, missing
 * commune, ligneacheminement format change) cross 1% — those grow rapidly
 * past 1% on real upstream regressions.
 */
const STRUCTURAL_FAIL_THRESHOLD = 0.01;

/**
 * Aborts the run when `bad_dept` skips cross 5%. Steady state is ~2.5%
 * (csv-parse `relax_quotes` cannot recover all un-quoted commas in `rs` /
 * `voie`); a real DREES layout change pushes far past 5%.
 */
const BAD_DEPT_NOISE_THRESHOLD = 0.05;

/**
 * Expected envelope for the "autre" famille. Catalogue covers ~92% of
 * FINESS volume by design; above 15%, DREES likely introduced a new code
 * at scale and FINESS_CATEGORIES needs extending. Warning, not blocker.
 */
const AUTRE_FAMILY_DRIFT_THRESHOLD = 0.15;

interface FinessStagingRow {
  num_finess: string;
  raison_sociale: string;
  categorie_code: string | null;
  categorie_libelle: string | null;
  num_voie: string | null;
  type_voie: string | null;
  voie: string | null;
  code_postal: string | null;
  code_departement: string;
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

    // Two anomaly families with distinct semantics — see threshold consts.
    //   - structural (STRUCTURAL_FAIL_THRESHOLD) : DREES schema change.
    //   - bad_dept (BAD_DEPT_NOISE_THRESHOLD)    : csv-parse baseline noise.
    //   - DOM rows are a documented architectural limit, log-only.
    const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
    const rateOf = (failures: number) =>
      stats.inserted > 0 ? failures / (stats.inserted + failures) : 0;
    const blockingFailures = stats.skippedNoFinessId + stats.skippedNoCommune;
    const skipRate = rateOf(blockingFailures + stats.parsedNoLigneAch);
    const badDeptRate = rateOf(stats.skippedBadDept);
    if (stats.skippedDom > 0) {
      console.log(
        `[finess] skipped ${stats.skippedDom} DOM rows (architectural limit — V0.3 widens code_insee to support DOM)`,
      );
    }
    if (stats.skippedBadDept > 0) {
      console.log(
        `[finess] skipped ${stats.skippedBadDept} bad-dept rows (${fmt(badDeptRate)} — csv-parse column shifts on unquoted commas, baseline noise)`,
      );
      if (badDeptRate > BAD_DEPT_NOISE_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Bad-dept rate ${fmt(badDeptRate)} above ${fmt(BAD_DEPT_NOISE_THRESHOLD)} — beyond the steady-state CSV noise floor, likely a real DREES layout change`,
        );
      }
    }
    if (blockingFailures > 0 || stats.parsedNoLigneAch > 0) {
      console.warn(
        `[finess] structural parsing anomalies (${fmt(skipRate)} of inserted): ${stats.skippedNoFinessId} missing nofinesset, ${stats.skippedNoCommune} missing commune, ${stats.parsedNoLigneAch} ligneacheminement non-match (DREES format change suspect)`,
      );
      if (skipRate > STRUCTURAL_FAIL_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Structural parsing anomaly rate ${fmt(skipRate)} above ${fmt(STRUCTURAL_FAIL_THRESHOLD)} — likely upstream regression (required column rename/removed or ligneacheminement format change)`,
        );
      }
    }

    // 4d. NOMENCLATURE DRIFT — surface DREES codes that fell into "autre".
    // Catalogue covers ~92% of FINESS volume by design. If `autre` overshoots
    // its expected envelope, DREES probably introduced a new code at scale
    // (new structure type 2026, etc.). Logged as warning, not blocker.
    if (stats.unknownCategorieCounts.size > 0) {
      const totalAutre = [...stats.unknownCategorieCounts.values()].reduce((a, b) => a + b, 0);
      const autreRate = stats.inserted > 0 ? totalAutre / stats.inserted : 0;
      const top = [...stats.unknownCategorieCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, count]) => `${code}=${count}`)
        .join(", ");
      console.log(
        `[finess] ${stats.unknownCategorieCounts.size} codes catégorie en famille "autre" (${fmt(autreRate)} du volume). Top: ${top}`,
      );
      if (autreRate > AUTRE_FAMILY_DRIFT_THRESHOLD) {
        console.warn(
          `[finess] ⚠️ "autre" rate ${fmt(autreRate)} above ${fmt(AUTRE_FAMILY_DRIFT_THRESHOLD)} expected envelope — DREES nomenclature drift suspect, consider extending FINESS_CATEGORIES`,
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
  skippedBadDept: number;
  skippedDom: number;
  parsedNoLigneAch: number;
  /**
   * Codes catégorie that finessFamille() classified as "autre" together with
   * the count of rows. Surfaces a DREES nomenclature drift early — if a new
   * code lands at high volume, the operator can decide to add it to
   * FINESS_CATEGORIES + a family in one PR.
   */
  unknownCategorieCounts: Map<string, number>;
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
  let skippedBadDept = 0;
  let skippedDom = 0;
  let parsedNoLigneAch = 0;
  const unknownCategorieCounts = new Map<string, number>();
  let firstBatch = true;

  // PGRST205 = PostgREST's canonical code for "Could not find the table in
  // the schema cache" — typed contract beats regex against a localizable
  // human message.
  const isSchemaCacheMiss = (err: { code?: string } | null): boolean => err?.code === "PGRST205";

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // The first batch can race with PostgREST's schema-cache reload after the
    // RPC created `finess_staging`. Retry with linear backoff (2s/4s/6s)
    // ONLY on the first batch and ONLY on the schema-cache error. After the
    // first successful insert the cache is warm; subsequent batches don't
    // retry (failure there is a real problem, not a transient race).
    const maxAttempts = firstBatch ? 4 : 1; // 1 initial + 3 retries on cold cache
    let lastErr: { message: string; code?: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const wait = 2000 * attempt;
        console.warn(`[finess] schema cache miss, retry ${attempt}/3 in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
      const { error } = await supabase.from("finess_staging").insert(batch);
      if (!error) {
        lastErr = null;
        break;
      }
      lastErr = error;
      if (!isSchemaCacheMiss(error)) break; // non-cache errors fail immediately
    }
    firstBatch = false;
    if (lastErr) {
      throw new IngestError("copy", `Insert into finess_staging failed: ${lastErr.message}`);
    }
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = parseFinessRecord(record);
    if (parsed.row) {
      batch.push(parsed.row);
      // Track ligneacheminement parse failures separately — silent null CP/ville
      // was the v0.2.0 bug we're fixing, so a re-emergence (DREES layout change)
      // must be loud.
      if (parsed.row.code_postal === null && parsed.row.raw.ligneacheminement) {
        parsedNoLigneAch++;
      }
      // Track DREES codes that fall into "autre" — surfaces a nomenclature
      // drift (new code at high volume) so it can be added to a family in one PR.
      const code = parsed.row.categorie_code;
      if (code && finessFamille(code) === "autre") {
        unknownCategorieCounts.set(code, (unknownCategorieCounts.get(code) ?? 0) + 1);
      }
    } else {
      // Exhaustive switch: a new SkipReason without a counter triggers a TS
      // compile error via the `never` check, preventing silent drops.
      switch (parsed.skipReason) {
        case "no_finess_id":
          skippedNoFinessId++;
          break;
        case "no_commune":
          skippedNoCommune++;
          break;
        case "bad_dept":
          skippedBadDept++;
          break;
        case "dom_unsupported":
          skippedDom++;
          break;
        default: {
          const _exhaustive: never = parsed.skipReason;
          throw new Error(`unreachable skipReason: ${String(_exhaustive)}`);
        }
      }
    }
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return {
    inserted,
    skippedNoFinessId,
    skippedNoCommune,
    skippedBadDept,
    skippedDom,
    parsedNoLigneAch,
    unknownCategorieCounts,
  };
}

type SkipReason = "no_finess_id" | "no_commune" | "bad_dept" | "dom_unsupported";

type ParsedFinessRow =
  | { row: FinessStagingRow; skipReason?: never }
  | { row?: never; skipReason: SkipReason };

/**
 * Match `ligneacheminement` of the form `"08000 CHARLEVILLE MEZIERES CEDEX"`.
 * Extracts a leading 5-digit postal code followed by the city name.
 * The trailing "CEDEX"/"CEDEX 02"/etc. suffix is stripped from the city name.
 */
const LIGNE_ACHEMINEMENT_REGEX = /^(\d{5})\s+(.+?)(?:\s+CEDEX(?:\s+\d+)?)?$/;

/**
 * Validates a FINESS `departement` cell. Accepts:
 *  - 2-char metropole codes ("01"–"95", excluding "20" — Corse uses 2A/2B)
 *  - "2A" / "2B" (Corse)
 *  - 3-char DOM/COM codes : 971-978 (DROM) and 984-988 (COM)
 *
 * Note: 970, 979, 989 and other 9X0 / 9X9 codes are NOT valid INSEE
 * departments — review-1 caught a too-permissive `/^9[78]\d$/` regex that
 * was accepting them. Tightened to the exact INSEE-published ranges.
 *
 * Anything else is a malformed CSV row (column shift, dirty data) and gets
 * dropped at parse time so we never insert garbage into `code_insee`.
 */
function isValidDept(dept: string): boolean {
  if (dept === "2A" || dept === "2B") return true;
  if (/^\d{2}$/.test(dept)) return dept !== "20"; // Corse must use 2A/2B
  if (/^(97[1-8]|98[4-8])$/.test(dept)) return true;
  return false;
}

function parseFinessRecord(rec: Record<string, string>): ParsedFinessRow {
  const numFiness = getNonEmpty(rec, "nofinesset");
  if (!numFiness) return { skipReason: "no_finess_id" };

  const codeCommuneRaw = getNonEmpty(rec, "commune");
  const codeDepartementRaw = getNonEmpty(rec, "departement");
  if (!codeCommuneRaw || !codeDepartementRaw) return { skipReason: "no_commune" };

  const codeDepartement = codeDepartementRaw.trim();
  if (!isValidDept(codeDepartement)) return { skipReason: "bad_dept" };

  // FINESS stores commune as the 3-char code WITHIN the department.
  // Reconstruct canonical 5-char INSEE: "08" + "105" = "08105".
  // Schema is CHAR(5) → DOM (dept 3 chars) is skipped until V0.3 widens it.
  if (codeDepartement.length === 3) return { skipReason: "dom_unsupported" };
  const codeInsee = `${codeDepartement}${codeCommuneRaw.trim().padStart(3, "0")}`;

  // `ligneacheminement` is the canonical source for postal code + real city
  // name (e.g. "08005 CHARLEVILLE MEZIERES CEDEX"). The previous parser used
  // `libdepartement` ("ARDENNES") as `ville`, which was wrong. CEDEX suffix
  // is stripped from the city name; the postal code keeps its CEDEX form.
  const ligneAch = getNonEmpty(rec, "ligneacheminement") ?? "";
  const ligneMatch = ligneAch.match(LIGNE_ACHEMINEMENT_REGEX);
  const codePostal = ligneMatch?.[1] ?? null;
  const ville = ligneMatch?.[2]?.trim() ?? null;

  // Build full address line: "12 CRS BRIAND" instead of just "BRIAND".
  const numVoie = getNonEmpty(rec, "numvoie");
  const typVoie = getNonEmpty(rec, "typvoie");
  const voieRaw = getNonEmpty(rec, "voie");
  const voieFull = [numVoie, typVoie, voieRaw].filter(Boolean).join(" ") || null;

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
      num_voie: numVoie,
      type_voie: typVoie,
      voie: voieFull,
      code_postal: codePostal,
      code_departement: codeDepartement,
      code_insee: codeInsee,
      ville,
      telephone: getNonEmpty(rec, "telephone"),
      email: null,
      date_ouverture: getNonEmpty(rec, "dateouv"),
      date_maj: getNonEmpty(rec, "datemaj"),
      geom: null,
      raw,
    },
  };
}

export const __TESTING__ = { parseFinessRecord, isValidDept, LIGNE_ACHEMINEMENT_REGEX };

// Only run main() when this file is executed as a script, not when imported
// by the test suite or another module. Without this guard, vitest pulls in
// the module to test the pure helpers and immediately tries to connect to
// Supabase via `main()` — failing with "Missing SUPABASE_URL" before any
// test runs.
//
// Use `fileURLToPath` instead of string-comparing `import.meta.url` against
// `file://${process.argv[1]}` — the latter URL-encodes spaces/accents while
// `process.argv[1]` is the raw path, so the literal comparison breaks
// silently when the repo lives under e.g. "/Users/My Name/...". Caught by
// the v0.2.1 review.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
