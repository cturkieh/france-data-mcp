import "./load-env.js";
import * as fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { parseRpcCount } from "../../src/core/parse-rpc-count.js";
import { missingRpcHint } from "../../src/core/retry-transient.js";
import { finessFamille } from "../../src/sante/finess-categories.js";
import { type AnsPmej, type FinessStagingRow, mapEgeToRow } from "./finess-ans-parse.js";
import {
  type Assessment,
  type IngestStreamStats,
  type StagingDiff,
  assessParsedRows,
  assessStagingDiff,
} from "./finess-validate.js";
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
  rebuildHostedActivities,
  runAndRecordCanary,
  runIfMain,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
} from "./shared.js";

/**
 * Ingestion FINESS depuis le flux « nouvelle génération » de l'ANS
 * (dataset data.gouv `finess-structures-1`, JSON.gz quotidien).
 *
 * Pourquoi plus le CSV DREES : la DREES a arrêté la génération des flux le
 * 20 juillet 2026 (dernier millésime 04/05/2026). Le cron court-circuitait en
 * `same_checksum` depuis juin, statut `success`, sans qu'aucun signal ne
 * distingue « rien de neuf en amont » de « source morte ». Post-mortem et
 * inventaire du flux ANS : `docs/plans/finess-migration-ans.md`.
 *
 * Ressource journalière : l'id `cd493959-…` est STABLE (créé le 2026-05-06,
 * modifié chaque jour) — l'URL data.gouv redirige vers le fichier du jour.
 * Le contenu changeant quotidiennement (`generatedAt`), le court-circuit par
 * checksum ne s'applique qu'à un re-jeu le même jour (~105 K lignes, ~50 s
 * par run). Conservé pour la symétrie avec les autres crons.
 *
 * Mapping du flux : `finess-ans-parse.ts` (pur, testé sur fixtures réelles).
 * Politique de validation (seuils qui décident du swap) : `finess-validate.ts`
 * (pur, testé sur les chiffres mesurés). Ici : l'orchestration seulement.
 */
const FINESS_ANS_URL =
  process.env.FINESS_ANS_URL ??
  "https://www.data.gouv.fr/fr/datasets/r/cd493959-fb03-41e5-9347-0edd14dfbc22";

/** Le .gz pèse ~50 Mo (715 Mo décompressés) ; 30 Mo attrape une troncature. */
const MIN_GZ_SIZE_BYTES = 30_000_000;
/** Aligné sur RPPS (`rpps.ts`) : ~105 lots au lieu de 210, payload ≈ 600 Ko, sous les limites PostgREST. */
const BATCH_SIZE = 1_000;

/**
 * How long to wait after `NOTIFY pgrst, 'reload schema'` before issuing the
 * first insert against the freshly-created staging table. PostgREST polls the
 * notification on a short interval; ~1-2s is the canonical pause documented
 * in Supabase's runtime-DDL recipes. Without it, the first insert can race
 * the schema-cache refresh and fail with "Could not find the table ...".
 */
const PGRST_RELOAD_WAIT_MS = 2000;

/**
 * `FINESS_DRY_RUN=1` : tout le pipeline jusqu'à la validation (staging
 * peuplée, repli geom appliqué, diff staging↔prod loguée), puis ARRÊT avant
 * le swap. La staging est conservée pour inspection SQL. Aucune ligne
 * `ingest_log` n'est écrite. Sert à prouver une migration de format avant
 * de basculer la prod.
 */
const DRY_RUN = process.env.FINESS_DRY_RUN === "1";

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const log: IngestLogEntry = {
    source: "finess",
    started_at: startedAt,
    status: "failed",
    csv_url: FINESS_ANS_URL,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    // Un dry-run dans le cron produirait un run VERT sans swap ni ligne
    // ingest_log — exactement la classe d'échec silencieux que ce script
    // corrige. Refusé sous GitHub Actions (variable oubliée dans un env).
    if (DRY_RUN && process.env.GITHUB_ACTIONS === "true") {
      throw new IngestError(
        "validate",
        "FINESS_DRY_RUN=1 refusé sous GITHUB_ACTIONS — un dry-run en cron serait un run vert sans trace",
      );
    }

    // 1. DOWNLOAD + lookup last success checksum en parallèle.
    const [downloaded, lastSha] = await Promise.all([
      downloadCsv(FINESS_ANS_URL, "finess-structures.json.gz"),
      getLastSuccessChecksum("finess"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    // `FORCE_REINGEST=1` (workflow_dispatch ops, ou re-jeu local) : le
    // chokepoint marque `ingest_log.forced = true`. L'ancien script FINESS ne
    // transmettait pas ce flag — un forçage y était silencieusement ignoré.
    // Un dry-run force aussi : il doit exercer TOUT le pipeline, et le
    // court-circuit écrirait une ligne `ingest_log` (contrat du dry-run :
    // aucune).
    const force = isForceReingestEnv(process.env.FORCE_REINGEST) || DRY_RUN;
    if (!force && lastSha === downloaded.sha256) {
      // Flux QUOTIDIEN : deux crons à quinze jours d'écart avec le même SHA
      // ne signifient pas « rien de neuf » mais « publication ANS gelée » —
      // le symptôme exact de la panne DREES de 2026. Loud, puis court-circuit
      // (la donnée servie reste juste ; `data_age_days` le dit au caller).
      const frozen = `fichier ANS identique au dernier run (${downloaded.sha256.slice(0, 8)}…) alors que le flux est quotidien — publication gelée côté ANS ? La pose BAN du résiduel est aussi sautée sur ce run (elle n'a lieu qu'avec une ingestion complète : forcer via workflow_dispatch pour poser un cache fraîchement drainé)`;
      console.warn(`[finess] ⚠️ ${frozen}`);
      // Aussi dans `ingest_log` : le log Actions expire à 90 jours, la
      // table est interrogeable en SQL.
      appendLogMessage(log, frozen);
    }
    if (await shortCircuitIfSameChecksum(log, lastSha, downloaded.sha256, "finess", force)) {
      return;
    }

    // 2. PRE-VALIDATE — taille + signature gzip (page HTML de maintenance
    // servie en 200 = ni la taille ni les deux octets magiques).
    await preValidateFile(downloaded.filePath, {
      minSizeBytes: MIN_GZ_SIZE_BYTES,
      magicBytes: GZIP_MAGIC,
    });

    // 3. STREAM → STAGING
    const supabase = getUntypedServiceClient("finess");
    const { error: stagingErr } = await supabase.rpc("ingest_create_finess_staging");
    if (stagingErr) {
      throw new IngestError("copy", `Failed to create finess_staging table: ${stagingErr.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PGRST_RELOAD_WAIT_MS));

    const stats = await streamAnsToStaging(downloaded.filePath, supabase);
    log.row_count = stats.inserted;
    const skippedTotal = Object.values(stats.skipped).reduce((a, b) => a + b, 0);
    const skippedDetail = Object.entries(stats.skipped)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(
      `[finess] ${stats.pmej} PMEJ, ${stats.inserted + skippedTotal} EGE lus → ${stats.inserted} en service insérés ; écartés : ${skippedDetail}`,
    );

    // 4a. VALIDATION DU PARSING — volume, anomalies structurelles,
    // coordonnées inexploitables, nomenclature, débordements de colonne.
    // Avant toute RPC : inutile de travailler une staging déjà invalide.
    applyAssessment(assessParsedRows(stats), log);

    // 4b. REPLI `previous_ingest` — reprend le point de la prod actuelle pour
    // les num_finess déjà connus sans coordonnées ANS (migration
    // 20260905T210000 ; pourquoi PAS de centroïde commune : elle le documente).
    // Un seul UPDATE PK↔PK (~21 K lignes touchées sur 105 K, sub-seconde sous
    // les 55 s de la fonction) ; un 57014 tomberait ICI, avant le swap, prod
    // intacte — le keyset de `runKeysetRpc` répond à un problème (1,3 M lignes,
    // sentinelle quadratique) que FINESS n'a pas.
    const { data: previousApplied, error: prevErr } = await supabase.rpc(
      "ingest_apply_finess_geom_previous",
    );
    if (prevErr) {
      throw new IngestError(
        "validate",
        `ingest_apply_finess_geom_previous failed: ${prevErr.message}`,
      );
    }
    const previousCount = parseRpcCount(previousApplied, "ingest_apply_finess_geom_previous");
    console.log(`[finess] repli previous_ingest : ${previousCount} points repris de la prod`);

    // 4b-bis. POSE BAN depuis le cache `geocoded_addresses` (migration
    // 20260906T120000) pour ce qui reste SANS point après le repli : les
    // établissements nouveaux. Même mécanisme que RPPS/Ameli : le cron pose,
    // le drain `ban-backfill.mjs --source finess` (workflow_run post-cron)
    // remplit le cache. Précision rue/bâtiment seulement — jamais de
    // centroïde commune dans finess.geom. Un seul UPDATE (≤ ~5 K lignes).
    // Dénominateur de la sentinelle = ce que la pose FERAIT (éligibles dont la
    // clé est en cache, acceptée, précise), compté AVANT la pose. PAS les
    // éligibles : au 2e run forcé du 2026-09-06 tout le posable l'était déjà
    // (propagé par le repli), les 1 902 éligibles restants étaient des rejets
    // BAN → « 0 posé » légitime, marqué partial à tort (issue #76).
    const { data: banPosableData, error: banPosableErr } = await supabase.rpc(
      "finess_count_ban_posable",
      { p_source_table: "finess_staging" },
    );
    if (banPosableErr) {
      throw new IngestError(
        "validate",
        `finess_count_ban_posable failed: ${banPosableErr.message}${missingRpcHint(banPosableErr.message)}`,
      );
    }
    const banPosable = parseRpcCount(banPosableData, "finess_count_ban_posable");
    const { data: banApplied, error: banErr } = await supabase.rpc("ingest_apply_finess_ban_join");
    if (banErr) {
      throw new IngestError(
        "validate",
        `ingest_apply_finess_ban_join failed: ${banErr.message}${missingRpcHint(banErr.message)}`,
      );
    }
    const banCount = parseRpcCount(banApplied, "ingest_apply_finess_ban_join");
    console.log(
      `[finess] pose BAN (cache) : ${banCount} points posés sur ${banPosable} posables (résiduel sans point dont la clé est en cache, acceptée, précise)`,
    );
    // Pose muette ou partielle : posé < posable = la même jointure a compté des
    // lignes que l'UPDATE n'a pas touchées (RPC muette, dérive entre les deux
    // fonctions) → `partial` + trace en base (le log Actions expire à 90 j),
    // jamais un throw (la table reste servable). posable = 0 → « 0 posé » est
    // l'état NORMAL d'un résiduel convergé (rejets BAN, jamais drainé).
    if (banCount < banPosable) {
      const msg = `[france-data-mcp][finess][ban_join] ⚠️ ${banCount} posed over ${banPosable} posable (eligible rows whose key IS accepted & precise in geocoded_addresses) — the pose and the count share the same join: RPC drift or mute UPDATE (S-1: investigate). Non-blocking; rows stay without a point.`;
      console.warn(msg);
      console.log(`::warning::${msg}`);
      log.status = "partial";
      appendLogMessage(
        log,
        `ban_join: ${banCount} posed / ${banPosable} posable — mute or partial pose, investigate`,
      );
    } else if (banPosable === 0) {
      console.log(
        "[finess] pose BAN : rien de posable (le résiduel sans point est entièrement rejeté par la BAN ou pas encore drainé) — 0 posé attendu",
      );
    }

    // 4c. DIFF STAGING ↔ PROD — une seule RPC porte la couverture géo, les
    // disparitions et la non-régression ; loguée systématiquement.
    // `moved_gt_500m` est informatif (recalage BAN côté ANS).
    const diff = await fetchStagingDiff(supabase);
    console.log(`[finess] diff staging↔prod : ${JSON.stringify(diff)}`);

    // 4d. VALIDATION DE LA DIFF — couverture géo, établissements disparus,
    // non-régression de la géolocalisation.
    applyAssessment(assessStagingDiff(stats, diff), log);

    if (DRY_RUN) {
      console.log(
        "[finess] DRY RUN — validation passée, swap NON exécuté. finess_staging conservée pour inspection ; aucune ligne ingest_log écrite.",
      );
      return;
    }

    // 5. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "finess" });

    // 5b. CANARY POST-SWAP — non-bloquant.
    await runAndRecordCanary(supabase, "finess", log, "finess");

    // 5c. REBUILD `finess_hosted_activities` post-swap — la matview JOIN
    // `finess` ET `rpps` → suit l'OID de la table swappée → DOIT être
    // rebuilt (jamais REFRESH). Politique d'erreur dans `rebuildHostedActivities`.
    await rebuildHostedActivities(supabase, log, "finess");

    // SUCCESS — préserver un éventuel `status: "partial"` posé par
    // `rebuildHostedActivities` (couche secondaire), ne JAMAIS l'écraser.
    if (log.status !== "partial") {
      log.status = "success";
    }
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "finess");
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[finess] success: ${stats.inserted} rows ingested in ${elapsedSec}s`);
  } catch (err) {
    console.error("[finess] ingestion failed:", err);
    // Wrap non-IngestError as `validate` (programming bug catch-all).
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

/**
 * Logue les infos ; les warnings sont PERSISTÉS (`ingest_log.error_message`)
 * et marquent le run `partial` — un `console.warn` seul n'atteint personne :
 * la vigie post-cron (`notify-ingest-anomaly`) lit `status`, et le log
 * Actions expire à 90 jours (revue silent-failure 2026-09-06). Le swap a
 * lieu quand même (la donnée servie reste juste) ; l'issue idempotente de la
 * vigie porte le texte. Refuse le swap si au moins un fatal.
 */
function applyAssessment(a: Assessment, log: IngestLogEntry): void {
  for (const line of a.info) console.log(line);
  for (const line of a.warnings) {
    console.warn(line);
    console.log(`::warning::${line}`);
    appendLogMessage(log, line);
    log.status = "partial";
  }
  if (a.fatal.length > 0) throw new IngestError("validate", a.fatal.join(" | "));
}

/** `ingest_finess_staging_diff()` → jsonb, validé champ par champ (fail-loud). */
async function fetchStagingDiff(supabase: SupabaseClient): Promise<StagingDiff> {
  const { data, error } = await supabase.rpc("ingest_finess_staging_diff");
  if (error) {
    throw new IngestError("validate", `ingest_finess_staging_diff failed: ${error.message}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new IngestError("validate", "ingest_finess_staging_diff returned a non-object");
  }
  const d = data as Record<string, unknown>;
  // `parseRpcCount` = garde unique des compteurs RPC du repo (accepte aussi la
  // string décimale que PostgREST renvoie sur un BIGINT).
  const num = (k: keyof StagingDiff): number =>
    parseRpcCount(d[k], `ingest_finess_staging_diff.${k}`);
  const sources: Record<string, number> = {};
  const rawSources = d.staging_geom_source;
  // Clé absente ou non-objet = régression de la RPC (une def antérieure à
  // 20260905T210000, ou un rename) : fail-loud, jamais un `{}` qui se lirait
  // comme « aucune provenance ». Idem pour une valeur non numérique.
  if (typeof rawSources !== "object" || rawSources === null || Array.isArray(rawSources)) {
    throw new IngestError(
      "validate",
      `ingest_finess_staging_diff.staging_geom_source absent ou non-objet (${JSON.stringify(rawSources)}) — RPC antérieure ou drift`,
    );
  }
  for (const [k, v] of Object.entries(rawSources)) {
    sources[k] = parseRpcCount(v, `ingest_finess_staging_diff.staging_geom_source.${k}`);
  }
  return {
    staging_rows: num("staging_rows"),
    prod_rows: num("prod_rows"),
    prod_with_geom: num("prod_with_geom"),
    added: num("added"),
    removed: num("removed"),
    lost_geom: num("lost_geom"),
    moved_gt_500m: num("moved_gt_500m"),
    staging_geom_null: num("staging_geom_null"),
    staging_no_voie: num("staging_no_voie"),
    staging_geom_source: sources,
  };
}

/**
 * Décompresse et parse le JSON EN FLUX : 715 Mo décompressés dépassent la
 * taille maximale d'une chaîne V8 (~512 Mo), `JSON.parse` est impossible.
 * `pick({filter: "pmej"})` isole le tableau des personnes morales,
 * `streamArray` émet une PMEJ à la fois (avec ses EGE), la mémoire reste
 * bornée. `stream.pipeline` propage toute erreur gunzip/parse jusqu'ici
 * — un `.pipe()` nu laisserait le for-await pendre en silence.
 */
async function streamAnsToStaging(
  filePath: string,
  supabase: SupabaseClient,
): Promise<IngestStreamStats> {
  const out = streamArray.asStream();
  // Une erreur amont (gunzip, JSON) détruit `out` : le for-await ci-dessous
  // throw et remonte au catch de main(). On la logue AUSSI ici — c'est la
  // trace la plus proche de la cause (offset gzip, token JSON) — et on la
  // mémorise pour fail-loud si, par régression de la lib, le for-await se
  // terminait proprement malgré un pipeline en erreur.
  let pipelineError: unknown = null;
  const done = pipeline(
    // 1 Mo par lecture/décompression : 715 Mo décompressés en ~700 chunks au
    // lieu de ~44 000 aux tailles par défaut (64 Ko / 16 Ko).
    fs.createReadStream(filePath, { highWaterMark: 1 << 20 }),
    createGunzip({ chunkSize: 1 << 20 }),
    // `streamValues: false` : sinon le parser émet 4 tokens par scalaire
    // (start/chunk/end + valeur empaquetée) dont `pick` et `streamArray`
    // n'exploitent que le dernier — ~75 % des tokens alloués pour rien.
    parser.asStream({ streamValues: false }),
    pick.asStream({ filter: "pmej" }),
    out,
  ).catch((err: unknown) => {
    pipelineError = err;
    console.error(
      `[finess] stream pipeline (gunzip → stream-json) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const stats: IngestStreamStats = {
    inserted: 0,
    pmej: 0,
    skipped: {
      no_finess_id: 0,
      bad_finess_id: 0,
      ferme: 0,
      inactif: 0,
      no_adresse_geographique: 0,
      no_commune: 0,
      bad_commune: 0,
    },
    geomByLayout: { wgs84_first: 0, lambert_first: 0 },
    coordsUnusable: 0,
    nullCategorieCode: 0,
    emptyRaisonSociale: 0,
    municipalityRejected: 0,
    siretPresent: 0,
    siretMalformed: 0,
    siretMalformedSample: null,
    scoreBanUnparsable: 0,
    unknownCategorieCounts: new Map(),
    missingLabelCounts: new Map(),
    overflowCounts: new Map(),
  };

  let batch: FinessStagingRow[] = [];
  let firstBatch = true;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertStagingBatchWithRetry(supabase, "finess_staging", batch, {
      logPrefix: "finess",
      isFirstBatch: firstBatch,
    });
    firstBatch = false;
    stats.inserted += batch.length;
    batch = [];
  };

  try {
    for await (const item of out as AsyncIterable<unknown>) {
      const value = readStreamItem(item);
      stats.pmej++;
      const eges = Array.isArray(value.ege) ? value.ege : [];
      for (const ege of eges) {
        const parsed = mapEgeToRow(ege);
        if (parsed.kind === "skip") {
          stats.skipped[parsed.skipReason]++;
          continue;
        }
        batch.push(parsed.row);
        if (parsed.coordLayout !== null) stats.geomByLayout[parsed.coordLayout]++;
        if (parsed.municipalityCentroidRejected) stats.municipalityRejected++;
        if (parsed.row.siret !== null) stats.siretPresent++;
        if (parsed.siretMalformed !== null) {
          stats.siretMalformed++;
          stats.siretMalformedSample ??= parsed.siretMalformed;
        }
        if (parsed.scoreBanUnparsable) stats.scoreBanUnparsable++;
        if (parsed.coordsPresentButUnusable) stats.coordsUnusable++;
        for (const field of parsed.overflows) {
          stats.overflowCounts.set(field, (stats.overflowCounts.get(field) ?? 0) + 1);
        }
        const code = parsed.row.categorie_code;
        if (code === null) {
          stats.nullCategorieCode++;
        } else {
          if (finessFamille(code) === "autre") {
            stats.unknownCategorieCounts.set(
              code,
              (stats.unknownCategorieCounts.get(code) ?? 0) + 1,
            );
          }
          if (parsed.row.categorie_libelle === null) {
            stats.missingLabelCounts.set(code, (stats.missingLabelCounts.get(code) ?? 0) + 1);
          }
        }
        if (parsed.row.raison_sociale === "") stats.emptyRaisonSociale++;
        if (batch.length >= BATCH_SIZE) await flush();
      }
    }
  } catch (err) {
    // Le for-await rejette AVANT `await done` quand le pipeline se détruit :
    // sans ceci, un .gz tronqué remonterait en « programming bug », phase
    // `validate`. Une IngestError aval (insert PostgREST) passe telle quelle.
    console.error(
      `[finess] streaming aborted after ${stats.pmej} PMEJ / ${stats.inserted} rows inserted: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Sur une erreur AVAL (insert PostgREST), le pipeline gunzip → JSON
    // continuerait de décompresser 715 Mo dans un consommateur mort jusqu'à
    // la sortie du process : on le détruit (no-op s'il est déjà en erreur).
    out.destroy();
    if (err instanceof IngestError) throw err;
    const cause = pipelineError ?? err;
    throw new IngestError(
      "copy",
      `stream pipeline (gunzip → stream-json) failed after ${stats.pmej} PMEJ: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  await flush();
  await done;
  if (pipelineError !== null) {
    throw new IngestError(
      "copy",
      `stream pipeline ended in error after ${stats.pmej} PMEJ: ${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`,
      pipelineError,
    );
  }
  return stats;
}

/**
 * `streamArray` émet `{ key, value }` ; un item sans `value` = régression de la
 * lib, un `value` nul ou scalaire = donnée amont plausible (`pmej: [null]`) —
 * dans les deux cas une IngestError `copy` explicite plutôt qu'un TypeError
 * classé « programming bug ». Le contenu de l'objet n'est pas vérifié ici :
 * l'appelant tolère déjà un `ege` absent.
 */
function readStreamItem(item: unknown): AnsPmej {
  if (typeof item !== "object" || item === null || !("value" in item)) {
    throw new IngestError("copy", "stream-json streamArray emitted an item without `value`");
  }
  const value = (item as { value: unknown }).value;
  if (typeof value !== "object" || value === null) {
    throw new IngestError(
      "copy",
      `pmej[] element is ${value === null ? "null" : typeof value}, expected object`,
    );
  }
  return value as AnsPmej;
}

// Only run main() when this file is executed as a script, not when imported
// by the test suite or another module. See `runIfMain` for the rationale.
await runIfMain(import.meta.url, main);
