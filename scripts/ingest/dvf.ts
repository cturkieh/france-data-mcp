import "./load-env.js";
import { DEFAULT_USER_AGENT, fetchJson } from "../../src/core/http.js";
import {
  type DvfAggregate,
  type DvfFile,
  type DvfResource,
  aggregateDvfRecords,
  assertDvfDryRunAllowed,
  assertDvfStagingCount,
  dvfDeliverySignature,
  selectDvfFiles,
  staleDvfReason,
  streamDvfFiles,
  validateDvfAggregate,
} from "./dvf-parse.js";
import {
  GZIP_MAGIC,
  IngestError,
  type IngestLogEntry,
  appendLogMessage,
  atomicSwapTables,
  downloadCsv,
  getLastSuccessChecksum,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
  isForceReingestEnv,
  preValidateFile,
  runAndRecordCanary,
  runIfMain,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
} from "./shared.js";

// Chargement national DVF dans `dvf_mutations` : les 2 derniers fichiers Etalab,
// 12 mois glissants, staging + swap atomique. Règles et gardes : `dvf-parse.ts`.
//
// `DVF_DRY_RUN=1` : tout jusqu'à la vérification du nombre de lignes, staging
// conservée pour mesure, ni swap ni ligne `success`. Refusé sur un `schedule`.

const DATASET_API_URL =
  "https://www.data.gouv.fr/api/1/datasets/demandes-de-valeurs-foncieres-geolocalisees/";

/** Plus petit fichier du dataset mesuré le 2026-11-06 : 51,7 Mo (`full-2026-s1`). */
const MIN_SIZE_BYTES = 30_000_000;

/** ~805 lots à 1,6 M lignes, ~570 Ko de JSON par lot (mesuré), insérés avec le GiST déjà posé. */
const BATCH_SIZE = 2_000;

async function resolveDvfFiles(): Promise<DvfFile[]> {
  let dataset: { resources?: unknown };
  try {
    dataset = await fetchJson<{ resources?: unknown }>(DATASET_API_URL, {
      headers: { "User-Agent": DEFAULT_USER_AGENT },
    });
  } catch (err) {
    console.error("[dvf] API data.gouv.fr indisponible :", err);
    throw new IngestError(
      "download",
      `API data.gouv.fr indisponible : ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!Array.isArray(dataset.resources)) {
    throw new IngestError("download", "API data.gouv.fr : champ `resources` absent de la réponse.");
  }
  return selectDvfFiles(dataset.resources as DvfResource[]);
}

function describeAggregate(agg: DvfAggregate): string {
  return `lues=${agg.lignesLues}, gardées=${agg.rows.length}, avec_prix=${agg.avecPrix}, avec_terrain=${agg.avecTerrain}, communes=${agg.rowsByCommune.size}, dernier_mois=${agg.lastMonth ?? "aucun"}, médiane=${agg.medianPrixM2 ?? "aucune"}, sans_coords=${agg.sansCoords}, sans_date=${agg.sansDate}, invalides=${agg.invalides}, inutiles=${agg.inutiles}, doublons=${agg.doublons}, hors_fenêtre=${agg.horsFenetre}`;
}

export async function main(): Promise<void> {
  const startedAt = new Date();
  const dryRun = isForceReingestEnv(process.env.DVF_DRY_RUN);
  const log: IngestLogEntry = {
    source: "dvf",
    started_at: startedAt.toISOString(),
    status: "failed",
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    assertDvfDryRunAllowed(dryRun, process.env.GITHUB_EVENT_NAME);

    // 1. LIVRAISON : signature depuis l'API, court-circuit AVANT tout téléchargement
    // (cron mensuel, livraison semestrielle : 5 crons sur 6 s'arrêtent ici).
    const force = isForceReingestEnv(process.env.FORCE_REINGEST);
    const [files, lastSignature] = await Promise.all([
      resolveDvfFiles(),
      getLastSuccessChecksum("dvf"),
    ]);
    const signature = dvfDeliverySignature(files);
    log.csv_url = files.map((f) => f.url).join(" ");
    log.csv_sha256 = signature;
    console.log(`[dvf] livraison : ${files.map((f) => f.fileName).join(" + ")}`);

    // Dry-run : jamais de court-circuit, il écrirait une ligne `success`.
    if (
      !dryRun &&
      (await shortCircuitIfSameChecksum(log, lastSignature, signature, "dvf", force))
    ) {
      return;
    }

    // 2. TÉLÉCHARGEMENT + PRÉ-VALIDATION. L'en-tête du CSV est contrôlé par le lecteur.
    const filePaths: string[] = [];
    let sizeBytes = 0;
    for (const file of files) {
      const downloaded = await downloadCsv(file.url, file.fileName);
      await preValidateFile(downloaded.filePath, {
        minSizeBytes: MIN_SIZE_BYTES,
        magicBytes: GZIP_MAGIC,
        label: file.fileName,
      });
      filePaths.push(downloaded.filePath);
      sizeBytes += downloaded.sizeBytes;
    }
    log.csv_size_bytes = sizeBytes;

    // 3. AGRÉGATION en mémoire + gardes AVANT toute écriture en base.
    const agg = await aggregateDvfRecords(streamDvfFiles(filePaths));
    console.log(`[dvf] agrégé : ${describeAggregate(agg)}`);
    validateDvfAggregate(agg);

    // 4. STAGING : index déjà posés par la RPC (un `CREATE INDEX` lourd est impossible
    // via PostgREST, plafond passerelle de 60 s).
    const supabase = getUntypedServiceClient("dvf");
    const { error: stagingErr } = await supabase.rpc("ingest_create_dvf_mutations_staging");
    if (stagingErr) {
      throw new IngestError(
        "copy",
        `Création de dvf_mutations_staging échouée : ${stagingErr.message}`,
        stagingErr,
      );
    }
    // PostgREST recharge son cache de schéma ; le retry du 1er lot est le 2e filet.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    let inserted = 0;
    for (let i = 0; i < agg.rows.length; i += BATCH_SIZE) {
      const batch = agg.rows.slice(i, i + BATCH_SIZE);
      await insertStagingBatchWithRetry(supabase, "dvf_mutations_staging", batch, {
        logPrefix: "dvf",
        isFirstBatch: i === 0,
      });
      inserted += batch.length;
      if (inserted % 200_000 === 0) console.log(`[dvf] ${inserted}/${agg.rows.length} insérées`);
    }
    log.row_count = inserted;

    // 5. ANALYZE + filet anti-doublons : sans clé primaire, seul ce compte voit un lot dupliqué.
    const { data: rawCount, error: analyzeErr } = await supabase.rpc(
      "ingest_analyze_dvf_mutations_staging",
    );
    if (analyzeErr) {
      throw new IngestError(
        "validate",
        `ingest_analyze_dvf_mutations_staging échouée : ${analyzeErr.message}`,
        analyzeErr,
      );
    }
    assertDvfStagingCount(rawCount, inserted);

    if (dryRun) {
      console.log(
        `[dvf] DRY RUN : ${inserted} lignes vérifiées dans dvf_mutations_staging, conservée pour mesure. Swap NON exécuté, aucune ligne ingest_log écrite.`,
      );
      return;
    }

    // 6. SWAP + canary (canary manquant → `partial`, cf. runAndRecordCanary).
    await atomicSwapTables({ prodTable: "dvf_mutations" });
    await runAndRecordCanary(supabase, "dvf", log, "dvf");

    // `lastMonth` non nul ici : `validateDvfAggregate` a refusé « aucun mois ».
    const stale = agg.lastMonth ? staleDvfReason(agg.lastMonth, startedAt) : null;
    if (stale) {
      log.status = "partial";
      appendLogMessage(log, stale);
      console.warn(`[dvf] ${stale} : run marqué partial (swap fait)`);
    }

    if (log.status !== "partial") log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "dvf");
    const elapsedSec = (new Date(log.finished_at).getTime() - startedAt.getTime()) / 1000;
    console.log(`[dvf] ${log.status} : ${inserted} lignes en ${elapsedSec} s`);
  } catch (err) {
    console.error("[dvf] ingestion failed:", err);
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
    log.error_message = dryRun ? `[dry-run] ${ingestErr.message}` : ingestErr.message;
    log.finished_at = new Date().toISOString();
    await writeIngestLogFailureFallback(log, "dvf");
    console.error(`[dvf] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

await runIfMain(import.meta.url, main);
