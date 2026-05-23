import "./load-env.js";
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { finessFamille } from "../../src/sante/finess-categories.js";
import { isValidDept } from "../../src/territoire/dept-codes.js";
import {
  IngestError,
  type IngestLogEntry,
  atomicSwapTables,
  downloadCsv,
  getLastSuccessChecksum,
  getNonEmpty,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
  preValidateFile,
  rebuildHostedActivities,
  runAndRecordCanary,
  runIfMain,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
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
  /** Lambert 93 X coordinate (EPSG:2154), parsed from CSV. NULL if missing/invalid. */
  coordx_lambert93: number | null;
  /** Lambert 93 Y coordinate (EPSG:2154), parsed from CSV. NULL if missing/invalid. */
  coordy_lambert93: number | null;
  raw: Record<string, string>;
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
    // 1. DOWNLOAD + lookup last success checksum en parallèle. Le checksum
    // précédent ne dépend pas du download courant — Promise.all économise un
    // RTT Supabase sur le chemin nominal. DREES regenerates le FINESS extract
    // hebdomadaire mais le contenu peut être byte-identique entre 2 runs ; on
    // skip COPY/VALIDATE/SWAP dans ce cas (économise plusieurs min Postgres).
    const [downloaded, lastSha] = await Promise.all([
      downloadCsv(FINESS_CSV_URL, "finess.csv"),
      getLastSuccessChecksum("finess"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    if (await shortCircuitIfSameChecksum(log, lastSha, downloaded.sha256, "finess")) return;

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
    const supabase = getUntypedServiceClient("finess");
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
    // V0.4.3 — coord rejection ladder. Soft warn à >2% (drift léger), hard
    // throw à >5%. MIN_GEOM_COVERAGE 0.8 côté swap atomic ne catch QUE après
    // reprojection server-side : un drift 5-15% au parse rejette les rows
    // upstream (`coordx_lambert93 = null` à l'insert), géom NULL, et
    // ST_DWithin les ignore — ingestion silencieusement partielle. On bloque
    // explicitement avant le swap.
    const coordRejectRate = rateOf(stats.parsedCoordRejected);
    if (stats.parsedCoordRejected > 0 && coordRejectRate > 0.02) {
      console.warn(
        `[finess] coords Lambert93 rejected by strict regex : ${stats.parsedCoordRejected} rows (${fmt(coordRejectRate)} of inserted). Expected baseline < 2% — investigate column shift or DREES coord format change.`,
      );
      if (coordRejectRate > 0.05) {
        throw new IngestError(
          "validate",
          `Lambert93 coord rejection rate ${fmt(coordRejectRate)} above 5% — likely upstream regression (CSV column shift on coordxet/coordyet, or DREES format change). Refusing to swap a partially geocoded ingestion.`,
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

    // 5b. CANARY POST-SWAP — non-bloquant. Vérifie que les num_finess
    // hardcodés dans `ingest_canary_targets` sont bien présents en prod après
    // le swap. Si l'un disparaît, on logue dans `canary_failures` sans rollback.
    await runAndRecordCanary(supabase, "finess", log, "finess");

    // 5c. REBUILD `finess_hosted_activities` post-swap (Phase 2 — chantier
    // « Complétude territoriale & lentilles »). La matview JOIN `finess` ET
    // `rpps` → suit l'OID de la table swappée → DOIT être rebuilt (jamais
    // REFRESH). Hook symétrique côté RPPS dans `scripts/ingest/rpps.ts`.
    // Politique d'erreur (partial sans throw, couche secondaire) dans
    // `rebuildHostedActivities` (`./shared.js`).
    await rebuildHostedActivities(supabase, log, "finess");

    // SUCCESS — IMPORTANT : préserver un éventuel `status: "partial"` posé
    // par `rebuildHostedActivities` (échec de la couche secondaire = dégradation
    // bénigne ; le cron FINESS principal a réussi). NE PAS écraser
    // silencieusement avec "success" — même pattern défensif que rpps.ts.
    if (log.status !== "partial") {
      log.status = "success";
    }
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "finess");
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[finess] success: ${stats.inserted} rows ingested in ${elapsedSec}s`);
  } catch (err) {
    console.error("[finess] ingestion failed:", err);
    // Wrap non-IngestError as `validate` (programming bug catch-all) — using
    // "download" by default mis-attributes a TypeError thrown during swap
    // as "CSV download failure". Same pattern as Ameli (V0.4).
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
    await writeIngestLogFailureFallback(log, "finess");
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
   * Lignes où `coordxet` ou `coordyet` étaient présents dans le CSV mais ont
   * été rejetés par `parseLambert93Coord` (regex stricte). Symétrique à
   * `parsedNoLigneAch` : surface un drift 5-15% que `MIN_GEOM_COVERAGE=0.8`
   * ne catche pas, signalant un column shift ou un format upstream modifié
   * par DREES.
   */
  parsedCoordRejected: number;
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
  let parsedCoordRejected = 0;
  const unknownCategorieCounts = new Map<string, number>();
  let firstBatch = true;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertStagingBatchWithRetry(supabase, "finess_staging", batch, {
      logPrefix: "finess",
      isFirstBatch: firstBatch,
    });
    firstBatch = false;
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = parseFinessRecord(record);
    if (parsed.row) {
      batch.push(parsed.row);
      // Track ligneacheminement parse failures — silent null CP/ville was the
      // v0.2.0 bug, so a re-emergence (DREES layout change) must be loud.
      if (parsed.ligneAchPresentButUnparsed) {
        parsedNoLigneAch++;
      }
      // V0.4.3 — track Lambert93 coords rejected by the strict regex. Same
      // motivation as parsedNoLigneAch : surfaces a column shift / format
      // drift that MIN_GEOM_COVERAGE=0.8 alone wouldn't catch at 5-15% rates.
      if (parsed.coordPresentButUnparsed) {
        parsedCoordRejected++;
      }
      // Track DREES codes that fall into "autre" — surfaces a nomenclature
      // drift (new code at high volume) so it can be added to a family in one PR.
      const code = parsed.row.categorie_code;
      if (code && finessFamille(code) === "autre") {
        unknownCategorieCounts.set(code, (unknownCategorieCounts.get(code) ?? 0) + 1);
      }
    } else {
      // Exhaustive switch: a new SkipReason without a counter triggers a TS
      // compile error via the `never` check, preventing silent drops. We
      // assign the discriminant to a local variable so TypeScript narrows
      // `reason` to `never` in the default branch — narrowing through a
      // property access expression (`parsed.skipReason`) doesn't work here.
      const reason = parsed.skipReason;
      switch (reason) {
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
    skippedNoFinessId,
    skippedNoCommune,
    skippedBadDept,
    skippedDom,
    parsedNoLigneAch,
    parsedCoordRejected,
    unknownCategorieCounts,
  };
}

type SkipReason = "no_finess_id" | "no_commune" | "bad_dept" | "dom_unsupported";

type ParsedFinessRow =
  | {
      row: FinessStagingRow;
      ligneAchPresentButUnparsed: boolean;
      coordPresentButUnparsed: boolean;
      skipReason?: never;
    }
  | {
      row?: never;
      ligneAchPresentButUnparsed?: never;
      coordPresentButUnparsed?: never;
      skipReason: SkipReason;
    };

/**
 * Match `ligneacheminement` of the form `"08000 CHARLEVILLE MEZIERES CEDEX"`.
 * Extracts a leading 5-digit postal code followed by the city name.
 * The trailing "CEDEX"/"CEDEX 02"/etc. suffix is stripped from the city name.
 */
const LIGNE_ACHEMINEMENT_REGEX = /^(\d{5})\s+(.+?)(?:\s+CEDEX(?:\s+\d+)?)?$/;

// Note: `isValidDept` was moved to `src/territoire/dept-codes.ts` (V0.4
// consolidation) — single source of truth shared with Ameli, commune-index,
// and the MCP tools layer. Imported above.

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
  // collapseWhitespace : DREES upstream émet parfois des doubles espaces
  // ("08000  CHARLEVILLE  MEZIERES") qui produisent des doublons logiques
  // côté equality matching avec/sans normalisation.
  const ligneAch = getNonEmpty(rec, "ligneacheminement") ?? "";
  const ligneMatch = ligneAch.match(LIGNE_ACHEMINEMENT_REGEX);
  const codePostal = ligneMatch?.[1] ?? null;
  const ville = ligneMatch?.[2] ? collapseWhitespace(ligneMatch[2]) : null;
  // Surface to the streamer for monitoring (raw is empty post-V0.4.2).
  const ligneAchPresentButUnparsed = ligneAch !== "" && !ligneMatch;

  // Build full address line: "12 CRS BRIAND" instead of just "BRIAND".
  // collapseWhitespace après concat : si `numVoie` est null mais typVoie/voie
  // présents, `filter(Boolean).join(" ")` produit déjà un seul espace entre
  // les deux mots, mais l'un d'eux peut contenir des doubles-espaces internes
  // hérités du CSV brut DREES — on normalise ici.
  const numVoie = getNonEmpty(rec, "numvoie");
  const typVoie = getNonEmpty(rec, "typvoie");
  const voieRaw = getNonEmpty(rec, "voie");
  const voieFullRaw = [numVoie, typVoie, voieRaw].filter(Boolean).join(" ");
  const voieFull = voieFullRaw === "" ? null : collapseWhitespace(voieFullRaw);

  // geom NULL ici — populé server-side par ingest_apply_finess_geom_batch
  // qui lit coordx/y_lambert93 et reprojette Lambert 93 → WGS84. SSOT = le RPC.
  // Postmortem V0.2 : commit 88ebfc0 ; switch typed columns : V0.4.2.
  const coordxRaw = getNonEmpty(rec, "coordxet");
  const coordyRaw = getNonEmpty(rec, "coordyet");
  const coordxParsed = parseLambert93Coord(coordxRaw);
  const coordyParsed = parseLambert93Coord(coordyRaw);
  // Drift signal V0.4.3 : présent dans le CSV mais rejeté par la regex stricte.
  // Catche les column shifts 5-15% que MIN_GEOM_COVERAGE=0.8 laisse passer.
  const coordPresentButUnparsed =
    (coordxRaw !== null && coordxParsed === null) || (coordyRaw !== null && coordyParsed === null);

  // DREES émet parfois des doubles espaces dans `rs` ("LBM  BIO ARD'AISNE"),
  // ce qui crée des doublons logiques côté equality / search_text. getNonEmpty
  // strippe les control chars mais préserve les espaces internes — on collapse ici.
  const raisonSocialeRaw = getNonEmpty(rec, "rs") ?? "";
  const raisonSociale = raisonSocialeRaw === "" ? "" : collapseWhitespace(raisonSocialeRaw);

  return {
    row: {
      num_finess: numFiness,
      raison_sociale: raisonSociale,
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
      coordx_lambert93: coordxParsed,
      coordy_lambert93: coordyParsed,
      // V0.4.2 — colonnes typées remplacent raw->>'coordxet' ; colonne gardée pour rétro-compat.
      raw: {},
    },
    ligneAchPresentButUnparsed,
    coordPresentButUnparsed,
  };
}

/**
 * Collapse runs of whitespace (\s+) into a single ASCII space, then trim.
 * Used to normalize DREES upstream artifacts like "LBM  BIO ARD'AISNE".
 *
 * NB. `getNonEmpty` strips control chars (0x00-0x1f) and trims outer
 * whitespace, but preserves internal spaces. `collapseWhitespace` is applied
 * only on fields where double-spaces are unambiguous upstream noise
 * (raison_sociale, ville, voie).
 */
export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Parses a Lambert 93 coordinate from the CSV. Tolerates French decimal
 * comma ("823923,6") and surrounding whitespace. Returns null when the
 * input is missing, blank, or NOT a clean numeric literal.
 *
 * Strict regex anchor (`^-?\d+(\.\d+)?$`) blocks `Number.parseFloat`'s
 * silent partial-parse: without it, a CSV column shift placing "12 RUE
 * DUMAS" into `coordxet` would yield 12, projecting to an ocean point
 * that silently passes the geom-coverage threshold.
 */
export function parseLambert93Coord(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(",", ".").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

export const __TESTING__ = {
  parseFinessRecord,
  isValidDept,
  LIGNE_ACHEMINEMENT_REGEX,
  parseLambert93Coord,
  collapseWhitespace,
};

// Only run main() when this file is executed as a script, not when imported
// by the test suite or another module. Without this guard, vitest pulls in
// the module to test the pure helpers and immediately tries to connect to
// Supabase via `main()` — failing with "Missing SUPABASE_URL" before any
// test runs. See `runIfMain` for the rationale on `fileURLToPath`.
await runIfMain(import.meta.url, main);
