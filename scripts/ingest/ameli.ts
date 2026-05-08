import "dotenv/config";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import {
  type CommuneIndex,
  type IndexedCommune,
  buildCommuneIndex,
  matchCommune,
} from "../../src/territoire/commune-index.js";
import { fetchAllCommunes } from "../../src/territoire/communes.js";
import {
  IngestError,
  type IngestLogEntry,
  atomicSwapTables,
  downloadCsv,
  getNonEmpty,
  getUntypedServiceClient,
  preValidateFile,
  safeSerializeIngestLog,
  writeIngestLog,
} from "./shared.js";

// Canonical Annuaire Santé Ameli PS extract on data.gouv. The dataset slug
// `annuaire-sante-ameli` is stable, but the resource id rotates each weekly
// regeneration — point at the dataset latest-resource alias here. Override
// at runtime via AMELI_PS_CSV_URL env var when bisecting upstream changes.
const AMELI_PS_CSV_URL =
  process.env.AMELI_PS_CSV_URL ??
  "https://www.data.gouv.fr/api/1/datasets/r/432983b9-2e6f-473a-b35a-20403c300a5f";

/** ~154 Mo CSV; 100 Mo floor catches truncations without missing legitimate weekly variations. */
const MIN_SIZE_BYTES = 100_000_000;
/**
 * Real volume confirmed on first prod run (2026-05-08): ~462 K rows from
 * a 153.6 MB CSV (≈ 333 bytes/ligne moyenne, cohérent avec 24 colonnes
 * Ameli + adresse). Annuaire Ameli ne couvre QUE les PS libéraux
 * conventionnés (sous-ensemble du RPPS), donc bien plus petit que les
 * 1.5 M initialement supposés. Bounds 300 K – 800 K avec marge pour
 * absorber les variations hebdomadaires (entrées/sorties conventionnement).
 */
const MIN_ROWS = 300_000;
const MAX_ROWS = 800_000;
const BATCH_SIZE = 500;

/**
 * Maximum tolerated rate of CP+ville combinations that fail to match a known
 * INSEE commune (geo.api.gouv). Above this, suspect an INSEE drift (new
 * communes nouvelles not in geo.api yet, Ameli re-spelling) and abort the
 * run — partial matching would silently drop populated areas.
 */
const UNMATCHED_LOCALITY_THRESHOLD = 0.05;

/**
 * Maximum tolerated rate of structural anomalies (missing nom AND prénom,
 * missing both CP and ville). These should be near-zero in a clean upstream;
 * 1% lets the ingestion survive a handful of dirty rows without flagging a
 * regression.
 */
const STRUCTURAL_FAIL_THRESHOLD = 0.01;

interface AmeliStagingRow {
  nom: string;
  prenom: string;
  civilite: string | null;
  raison_sociale: string | null;
  specialite_code: string | null;
  specialite_libelle: string | null;
  type_ps_code: string | null;
  type_ps_libelle: string | null;
  activite_particuliere_code: string | null;
  activite_particuliere_libelle: string | null;
  adresse: string | null;
  code_postal: string | null;
  ville: string | null;
  code_departement: string;
  code_insee: string | null;
  secteur_conventionnel_code: string | null;
  secteur_conventionnel_libelle: string | null;
  nature_exercice_code: string | null;
  nature_exercice_libelle: string | null;
  option_tarifaire_code: string | null;
  option_tarifaire_libelle: string | null;
  telephone: string | null;
  /** EWKT string — PostGIS auto-casts to `geometry(Point, 4326)` on insert. */
  geom: string;
  raw: Record<string, string>;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const log: IngestLogEntry = {
    source: "ameli_ps",
    started_at: startedAt,
    status: "failed",
    csv_url: AMELI_PS_CSV_URL,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    // 1. DOWNLOAD
    const downloaded = await downloadCsv(AMELI_PS_CSV_URL, "annuaire-sante-ameli-ps.csv");
    log.csv_size_bytes = downloaded.sizeBytes;

    // 2. PRE-VALIDATE
    await preValidateFile(downloaded.filePath, {
      minSizeBytes: MIN_SIZE_BYTES,
      // Ameli PS columns confirmed against a real range download on
      // 2026-05-08. The CSV is semicolon-delimited (NOT comma like FINESS),
      // UTF-8 with BOM. Pre-validate strips BOM via `replace(/^"|"$/g, "")`
      // and we whitelist the columns we depend on so a rename is loud.
      expectedHeaderColumns: [
        "ps_activite_nom",
        "ps_activite_prenom",
        "specialite_code",
        "type_ps_code",
        "coordonnees_code_postal",
        "coordonnees_ville",
      ],
      delimiter: ";",
    });

    // 3. BUILD COMMUNE INDEX (geo.api.gouv, ~35K communes, ~4 MB JSON, 1 call).
    // Done before opening staging so a network failure aborts before we
    // touch the DB. Wrap explicitly so a geo.api outage shows up as
    // `pre_validate` in ingest_log (not "download" which would mislead the
    // operator into checking the Ameli CSV URL).
    console.log("[ameli] fetching all communes for geocoding…");
    let communes: Awaited<ReturnType<typeof fetchAllCommunes>>;
    try {
      communes = await fetchAllCommunes();
    } catch (err) {
      console.error("[ameli] fetchAllCommunes failed:", err);
      throw new IngestError(
        "pre_validate",
        `geo.api.gouv fetchAllCommunes failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    const communeIndex = buildCommuneIndex(communes);
    console.log(
      `[ameli] commune index built: ${communes.length} communes, ${communeIndex.byCpAndName.size} (cp,nom) keys, ${communeIndex.byCp.size} CPs`,
    );

    // 4. COPY → STAGING
    const supabase = getUntypedServiceClient("ameli");
    const { error: stagingErr } = await supabase.rpc("ingest_create_annuaire_ameli_staging");
    if (stagingErr) {
      throw new IngestError(
        "copy",
        `Failed to create annuaire_ameli_staging table: ${stagingErr.message}`,
      );
    }
    // PostgREST polls schema-change notifications on a small interval — wait
    // 2s so the first INSERT finds the staging table in cache. The retry
    // loop in `flush()` is the second-line defence for the very rare miss.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const stats = await streamCsvToStaging(downloaded.filePath, supabase, communeIndex);
    log.row_count = stats.inserted;

    // 5. VALIDATE COHERENCE
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

    const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
    const denominator =
      stats.inserted +
      stats.skippedNoIdentity +
      stats.skippedNoLocality +
      stats.skippedUnmatchedLocality;
    // Defense-in-depth: MIN_ROWS catches the empty-pipeline case above, but
    // a future tweak of the threshold (debug, lower bound) could let a
    // zero-denominator slip through and silently swap an empty staging
    // table into prod. Belt-and-braces guard.
    if (denominator === 0) {
      throw new IngestError(
        "validate",
        `Pipeline produced zero parser events (inserted=${stats.inserted}, all skips=0). Likely upstream parser regression — refuse to swap an empty table into prod.`,
      );
    }
    const rateOf = (failures: number) => failures / denominator;

    const structuralFailures = stats.skippedNoIdentity + stats.skippedNoLocality;
    const structuralRate = rateOf(structuralFailures);
    const unmatchedRate = rateOf(stats.skippedUnmatchedLocality);

    if (structuralFailures > 0) {
      console.warn(
        `[ameli] structural skips: ${stats.skippedNoIdentity} no_identity, ${stats.skippedNoLocality} no_locality (${fmt(structuralRate)} of total)`,
      );
      if (structuralRate > STRUCTURAL_FAIL_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Structural skip rate ${fmt(structuralRate)} above ${fmt(STRUCTURAL_FAIL_THRESHOLD)} — suspected upstream column rename / format change`,
        );
      }
    }

    if (stats.skippedUnmatchedLocality > 0) {
      const topUnmatched = [...stats.unmatchedSampleCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.warn(
        `[ameli] unmatched localities: ${stats.skippedUnmatchedLocality} (${fmt(unmatchedRate)}). Top: ${topUnmatched}`,
      );
      if (stats.unmatchedDistinctKeysDropped > 0) {
        console.warn(
          `[ameli] sample cap saturated: ${stats.unmatchedDistinctKeysDropped} distinct unmatched (cp,ville) keys not tracked. Top-N report may be incomplete.`,
        );
      }
      if (unmatchedRate > UNMATCHED_LOCALITY_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Unmatched-locality rate ${fmt(unmatchedRate)} above ${fmt(UNMATCHED_LOCALITY_THRESHOLD)} — likely INSEE commune drift; refresh geo.api.gouv index or update Ameli source`,
        );
      }
    }

    // 6. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "annuaire_ameli" });

    // SUCCESS
    log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[ameli] success: ${stats.inserted} rows ingested in ${elapsedSec}s`);
  } catch (err) {
    console.error("[ameli] ingestion failed:", err);
    // Wrap non-IngestError as `validate` (programming bug catch-all). Using
    // "download" by default would mis-attribute a TypeError thrown during
    // swap to "CSV download failure", sending the operator hunting in the
    // wrong direction for hours.
    const ingestErr =
      err instanceof IngestError
        ? err
        : new IngestError(
            "validate",
            `unexpected non-IngestError (programming bug): ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
    log.status = "failed";
    log.error_phase = ingestErr.phase;
    log.error_message = ingestErr.message;
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    // Always emit a parseable JSON snapshot of the failure log on stderr.
    // If `writeIngestLog` itself silently failed (RLS, network, table
    // missing), this is the only structured trace surviving in the GitHub
    // Actions output. The auto-issue script greps the prefix. Use the
    // safe serializer so a circular ref / BigInt smuggled into `log`
    // doesn't throw INSIDE the catch and defeat the survival path.
    console.error(`[ameli][ingest_log_fallback] ${safeSerializeIngestLog(log)}`);
    console.error(`[ameli] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

interface IngestStreamStats {
  inserted: number;
  skippedNoIdentity: number;
  skippedNoLocality: number;
  skippedUnmatchedLocality: number;
  /** Top unmatched (cp, ville) pairs — surfaces upstream drift fast. */
  unmatchedSampleCounts: Map<string, number>;
  /**
   * Number of distinct unmatched (cp,ville) keys we couldn't track because
   * the 200-key cap was already saturated. > 0 means the top-N report is
   * incomplete — operator should investigate or raise the cap.
   */
  unmatchedDistinctKeysDropped: number;
}

async function streamCsvToStaging(
  filePath: string,
  supabase: SupabaseClient,
  index: CommuneIndex,
): Promise<IngestStreamStats> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });

  const parser = stream.pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }),
  );

  let batch: AmeliStagingRow[] = [];
  let inserted = 0;
  let skippedNoIdentity = 0;
  let skippedNoLocality = 0;
  let skippedUnmatchedLocality = 0;
  let unmatchedDistinctKeysDropped = 0;
  const unmatchedSampleCounts = new Map<string, number>();
  let firstBatch = true;
  const SAMPLE_CAP = 200;

  // PGRST205 = PostgREST canonical "table not in schema cache" code. Typed
  // contract beats regex-against-localizable-message (FINESS V0.2 lesson).
  const isSchemaCacheMiss = (err: { code?: string } | null): boolean => err?.code === "PGRST205";

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // Retry only on the first batch and only on schema-cache miss — the
    // 2s post-RPC sleep should already cover it, but PostgREST can be slow
    // under load. Subsequent batches don't retry.
    const maxAttempts = firstBatch ? 4 : 1;
    let lastErr: { message: string; code?: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const wait = 2000 * attempt;
        console.warn(`[ameli] schema cache miss, retry ${attempt}/3 in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
      const { error } = await supabase.from("annuaire_ameli_staging").insert(batch);
      if (!error) {
        lastErr = null;
        break;
      }
      lastErr = error;
      if (!isSchemaCacheMiss(error)) break;
    }
    firstBatch = false;
    if (lastErr) {
      // Preserve the full Supabase error (code, hint, details) by passing
      // it as `cause`. Without it, post-mortem on a non-PGRST205 retry
      // failure (RLS, schema drift, trigger violation) loses every
      // diagnostic clue and the operator only sees `lastErr.message`.
      console.error("[ameli] insert into annuaire_ameli_staging failed:", lastErr);
      throw new IngestError(
        "copy",
        `Insert into annuaire_ameli_staging failed [code=${lastErr.code ?? "none"}]: ${lastErr.message}`,
        lastErr,
      );
    }
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = parseAmeliRecord(record, index);
    if (parsed.row) {
      batch.push(parsed.row);
    } else {
      // Local var so TypeScript can narrow `reason` to `never` in the
      // default branch — narrowing through `parsed.skipReason` directly
      // doesn't work in nested-property accesses.
      const reason = parsed.skipReason;
      switch (reason) {
        case "no_identity":
          skippedNoIdentity++;
          break;
        case "no_locality":
          skippedNoLocality++;
          break;
        case "unmatched_locality": {
          skippedUnmatchedLocality++;
          // Cap distinct keys at SAMPLE_CAP (memory bound) but keep counting
          // hits on already-known keys so the top-N report stays accurate
          // for the keys we did capture. Track dropped distinct keys to
          // signal when the report is partial.
          const key = parsed.sampleKey;
          if (key) {
            const known = unmatchedSampleCounts.has(key);
            if (known || unmatchedSampleCounts.size < SAMPLE_CAP) {
              unmatchedSampleCounts.set(key, (unmatchedSampleCounts.get(key) ?? 0) + 1);
            } else {
              unmatchedDistinctKeysDropped++;
            }
          }
          break;
        }
        default: {
          const _exhaustive: never = reason;
          throw new Error(`unreachable skipReason: ${String(_exhaustive)}`);
        }
      }
    }
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return {
    inserted,
    skippedNoIdentity,
    skippedNoLocality,
    skippedUnmatchedLocality,
    unmatchedSampleCounts,
    unmatchedDistinctKeysDropped,
  };
}

type SkipReason = "no_identity" | "no_locality" | "unmatched_locality";

type ParsedAmeliRow =
  | { row: AmeliStagingRow; skipReason?: never; sampleKey?: never }
  | { row?: never; skipReason: "no_identity" | "no_locality"; sampleKey?: never }
  | { row?: never; skipReason: "unmatched_locality"; sampleKey: string };

/**
 * Parses one CSV row into a staging row. Non-data parsing failures
 * (column rename, structurally invalid row) become skip reasons that the
 * caller counts and threshold-aborts on.
 */
export function parseAmeliRecord(rec: Record<string, string>, index: CommuneIndex): ParsedAmeliRow {
  const nom = getNonEmpty(rec, "ps_activite_nom") ?? "";
  const prenom = getNonEmpty(rec, "ps_activite_prenom") ?? "";
  if (!nom && !prenom) return { skipReason: "no_identity" };

  const codePostalRaw = getNonEmpty(rec, "coordonnees_code_postal");
  const villeRaw = getNonEmpty(rec, "coordonnees_ville");
  if (!codePostalRaw && !villeRaw) return { skipReason: "no_locality" };

  const matched: IndexedCommune | null = matchCommune(index, codePostalRaw, villeRaw);
  if (!matched) {
    return {
      skipReason: "unmatched_locality",
      sampleKey: `${codePostalRaw ?? "?"}|${villeRaw ?? "?"}`,
    };
  }

  // Concaténer voie + complément + lieu-dit en une seule colonne adresse.
  // Ameli sépare ces 3 champs mais pour l'usage MCP "afficher l'adresse",
  // une seule chaîne lisible suffit. L'historique brut reste dans `raw`.
  const adresseParts = [
    getNonEmpty(rec, "coordonnees_voie"),
    getNonEmpty(rec, "coordonnees_complement"),
    getNonEmpty(rec, "coordonnees_lieu_dit"),
  ].filter((s): s is string => Boolean(s));
  const adresse = adresseParts.length > 0 ? adresseParts.join(", ") : null;

  const geom = `SRID=4326;POINT(${matched.lon} ${matched.lat})`;

  // Filter raw to non-empty entries only, for compact JSONB storage.
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== "" && v !== undefined) raw[k] = v;
  }

  return {
    row: {
      nom: nom || prenom, // Falls back to prénom if nom missing — keeps NOT NULL constraint happy
      prenom: prenom || nom,
      civilite: getNonEmpty(rec, "ps_activite_civilite"),
      raison_sociale: getNonEmpty(rec, "ps_activite_raison_sociale"),
      specialite_code: getNonEmpty(rec, "specialite_code"),
      specialite_libelle: getNonEmpty(rec, "specialite_libelle"),
      type_ps_code: getNonEmpty(rec, "type_ps_code"),
      type_ps_libelle: getNonEmpty(rec, "type_ps_libelle"),
      activite_particuliere_code: getNonEmpty(rec, "activite_particuliere_code"),
      activite_particuliere_libelle: getNonEmpty(rec, "activite_particuliere_libelle"),
      adresse,
      // Trim before slice so " 08000 CEDEX" → "08000" (not " 0800") — the
      // raw Ameli column can carry leading whitespace which CHAR(5) would
      // pad-store as " 0800" and break downstream string equality queries.
      code_postal: codePostalRaw ? codePostalRaw.trim().slice(0, 5) : null,
      ville: villeRaw,
      code_departement: matched.codeDepartement,
      code_insee: matched.codeInsee,
      secteur_conventionnel_code: getNonEmpty(rec, "secteur_conventionnel_code"),
      secteur_conventionnel_libelle: getNonEmpty(rec, "secteur_conventionnel_libelle"),
      nature_exercice_code: getNonEmpty(rec, "nature_exercice_code"),
      nature_exercice_libelle: getNonEmpty(rec, "nature_exercice_libelle"),
      option_tarifaire_code: getNonEmpty(rec, "option_tarifaire_code"),
      option_tarifaire_libelle: getNonEmpty(rec, "option_tarifaire_libelle"),
      telephone: getNonEmpty(rec, "coordonnees_num_tel"),
      geom,
      raw,
    },
  };
}

export const __TESTING__ = { parseAmeliRecord };

// Only run main() when this file is executed as a script. Without this guard,
// vitest pulls in the module to test the pure helpers and immediately tries
// to connect to Supabase. Use `fileURLToPath(import.meta.url)` so paths with
// spaces/accents compare correctly (FINESS v0.2.1 lesson).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
