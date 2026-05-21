import "./load-env.js";
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { parseRpcCount, withTimeout } from "../../src/core/index.js";
import { missingRpcHint } from "../../src/core/retry-transient.js";
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
  getLastSuccessChecksum,
  getNonEmpty,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
  isForceReingestEnv,
  preValidateFile,
  runAndRecordCanary,
  runIfMain,
  runKeysetRpc,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
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
 * CSV brut : 549 222 lignes au 2026-05-08 (153.6 MB), répartis en :
 *  - 251 K "Autres PS" (IDE, kinés, sages-femmes, orthophonistes…)
 *  - 189 K médecins
 *  - 59 K personnes morales non conventionnées (pharmacies, transporteurs) ← skip
 *  - 45 K dentistes
 *  - 4.6 K laboratoires ← skip
 * Sémantique : Ameli = personnes physiques. Personnes morales (labos,
 * pharmacies, transporteurs) skippées car elles ont leur place dans FINESS.
 * Volume attendu inséré : ~485 K (549 K brut − 63 K personnes morales) ;
 * bounds 400 K – 600 K. Cf. PERSONNE_MORALE_TYPE_PS_CODES plus bas.
 */
const MIN_ROWS = 400_000;
const MAX_ROWS = 600_000;

const BATCH_SIZE = 500;

/**
 * Rows par lot `ban_join` (keyset). Aligné sur le pattern RPPS prouvé prod
 * (`docs/plans/ban-join.md` §3.2 : ~4,8 s/lot constant début↔fin). Le volume
 * Ameli (~462 K vs ~2,23 M RPPS) tient largement dans le budget
 * `statement_timeout='55s'` de `ingest_apply_ameli_ban_join_batch` avec ce
 * lotissement (~46 lots × ~1 s/lot estimé Ameli, à valider en prod).
 */
const BAN_JOIN_BATCH_SIZE = 10_000;

/**
 * Borne ANTI-HANG des lectures RPC (`ameli_measure_ban_to_geocode`). Un
 * `supabase.rpc()` brut sur socket figé pendrait jusqu'au kill GitHub Actions
 * sans `partial` ni trace `ingest_log`. 60 s : large pour un COUNT/DISTINCT
 * server-side (statement_timeout fonction 55 s) sans laisser un hang réel non
 * borné. Aligné sur `RPC_READ_TIMEOUT_MS` RPPS.
 */
const RPC_READ_TIMEOUT_MS = 60_000;

/**
 * Borne ANTI-HANG par lot de `runKeysetRpc` au step `ban_join`. 120 s : large
 * au-dessus d'un lot légitime (statement_timeout serveur 55 s + réseau), borne
 * un socket figé. Aligné sur `RPC_BATCH_TIMEOUT_MS` RPPS.
 */
const RPC_BATCH_TIMEOUT_MS = 120_000;

/**
 * Borne ANTI-HANG de la RPC fail-loud `ingest_analyze_ameli_staging`. ANALYZE
 * : statement_timeout serveur côté Postgres + marge réseau. Aligné sur
 * `RPC_ANALYZE_TIMEOUT_MS` RPPS (un hang sur cette RPC tuerait tout le cron
 * sans `partial` car elle est fail-loud).
 */
const RPC_ANALYZE_TIMEOUT_MS = 120_000;

/** Distinct (cp,ville) keys tracked in the unmatched top-N report (memory bound). */
const SAMPLE_CAP = 200;

/**
 * Maximum tolerated rate of CP+ville combinations that fail to match a known
 * INSEE commune (geo.api.gouv). Above this, suspect an INSEE drift (new
 * communes nouvelles not in geo.api yet, Ameli re-spelling) and abort the
 * run — partial matching would silently drop populated areas.
 *
 * Calibration 1st prod run : 24 K rows skippées sur 485 K rows ayant
 * CP+ville → 4.9 % steady state. Bumpé de 5 % à 8 % pour absorber la
 * variabilité observée sans hairtrigger.
 */
const UNMATCHED_LOCALITY_THRESHOLD = 0.08;

/**
 * Maximum tolerated rate of structural anomalies (missing nom AND prénom,
 * missing both CP and ville). These should be near-zero in a clean upstream;
 * 1% lets the ingestion survive a handful of dirty rows without flagging a
 * regression.
 */
const STRUCTURAL_FAIL_THRESHOLD = 0.01;

/**
 * Helper local fail-loud + anti-hang pour les RPC sans payload (ANALYZE).
 * Dupliqué à dessein de `rpps.ts:callRpcFailLoud` — même rationale que
 * `AMELI_TRANSIENT_REBUILD_CODES` (ne PAS modifier rpps.ts code critique
 * stabilisé pour factoriser un helper court ; factorisation = dette mineure
 * si `/simplify` la juge nécessaire). Préfixe log `[ameli]` au lieu de
 * `[rpps]` — sinon byte-identique.
 *
 * Un `supabase.rpc()` brut sur socket figé pendrait jusqu'au kill GitHub
 * Actions sans `partial` ni `ingest_log`. `TimeoutError` (socket figé) OU
 * `{ error }` PostgREST → `IngestError("validate")` fail-loud.
 */
async function callRpcFailLoud(
  supabase: SupabaseClient,
  rpcName: string,
  timeoutMs: number,
  errPrefix: string,
): Promise<void> {
  let res: Awaited<ReturnType<typeof supabase.rpc>>;
  try {
    res = await withTimeout(supabase.rpc(rpcName), timeoutMs, rpcName);
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      console.error(
        `[france-data-mcp][ameli] ${rpcName} timed out after ${timeoutMs}ms — anti-silent-hang bound, failing loud`,
      );
      throw new IngestError(
        "validate",
        `${errPrefix}: timed out after ${timeoutMs}ms (anti-silent-hang bound)`,
      );
    }
    console.error(`[france-data-mcp][ameli] ${rpcName} threw a non-timeout error, re-raising`);
    throw e;
  }
  if (res.error) {
    throw new IngestError("validate", `${errPrefix}: ${res.error.message}`);
  }
}

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
    // 1. DOWNLOAD + lookup last success checksum en parallèle. Le checksum
    // précédent ne dépend pas du download courant — Promise.all économise un
    // RTT Supabase. Ameli regenerates l'extract hebdomadaire ; sur 154 MB un
    // build sans nouveau PS conventionné peut produire un CSV byte-identique.
    // Skip COPY/VALIDATE/SWAP économise plusieurs min (~485K rows + index).
    const [downloaded, lastSha] = await Promise.all([
      downloadCsv(AMELI_PS_CSV_URL, "annuaire-sante-ameli-ps.csv"),
      getLastSuccessChecksum("ameli_ps"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    // FORCE_REINGEST (input `force` du workflow_dispatch / env locale) →
    // bypass du short-circuit checksum, marque `log.forced=true` (cf.
    // CLAUDE.md V0.12.2 « marqueur forced dans ingest_log »). Sémantique
    // détaillée + tolérance "1"/"true" : JSDoc de isForceReingestEnv.
    // Chantier C 2026-05-21 : câblage manquant côté Ameli (asymétrie avec
    // RPPS rpps.ts:256). Sans ça, après backfill BAN, le ban_join du cron
    // ne tournerait JAMAIS tant que le CSV Ameli reste byte-identique
    // — bloquant pour appliquer le cache enrichi.
    if (
      await shortCircuitIfSameChecksum(
        log,
        lastSha,
        downloaded.sha256,
        "ameli",
        isForceReingestEnv(process.env.FORCE_REINGEST),
      )
    )
      return;

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
    // Always log the skip breakdown FIRST so the operator can diagnose a
    // failure even when the row-count check fires. Without this, throwing
    // on MIN_ROWS hides the counters that explain WHY we're below threshold.
    console.log(
      `[ameli] insert summary: inserted=${stats.inserted}, personne_morale=${stats.skippedPersonneMorale} (FINESS scope), no_identity=${stats.skippedNoIdentity}, no_locality=${stats.skippedNoLocality}, unmatched_locality=${stats.skippedUnmatchedLocality}`,
    );

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

    // 5b. ANALYZE STAGING — stats fraîches après le bulk INSERT (~462 K rows
    // dans une table fraîchement CREATE). Sans ça le planner attaque la
    // jointure cache (5d) aveugle → seq scan plein de geocoded_addresses par
    // batch → 57014 en zone dense (gotcha CLAUDE.md RPPS C2). Pratique
    // Postgres canonique « bulk INSERT puis ANALYZE avant de requêter ».
    // Fail-loud : un ANALYZE qui throw signale une régression grave
    // (statement_timeout server-side dépassé, lock contesté) — ne pas swap.
    await callRpcFailLoud(
      supabase,
      "ingest_analyze_ameli_staging",
      RPC_ANALYZE_TIMEOUT_MS,
      "Failed to ANALYZE annuaire_ameli_staging before ban_join",
    );

    // 5c. PHASE 1 MESURE — chiffre le delta BAN à chaque cron pour dimensionner
    // la future automatisation (Phase 2, cf. backlog). BEST-EFFORT : un échec
    // (timeout, RPC absente, contrat cassé) → warn + log NULL + persistence du
    // message dans `log.error_message` (audit trail DB, pas seulement console).
    // Mesuré pre-ban_join. Locales préservent une mesure partielle (#1 reste
    // posé si #2 throw). Réutilise les colonnes ingest_log ajoutées par
    // 20260520T000000 (partagées Ameli/RPPS, source distingue).
    let eligibleDistinct: number | null = null;
    let toGeocodeDistinct: number | null = null;
    let measureFailedReason: string | null = null;
    try {
      const { data: deltaData, error: deltaErr } = await withTimeout(
        supabase.rpc("ameli_measure_ban_to_geocode", {
          p_source_table: "annuaire_ameli_staging",
        }),
        RPC_READ_TIMEOUT_MS,
        "ameli_measure_ban_to_geocode",
      );
      if (deltaErr) {
        measureFailedReason = `BAN delta measurement skipped: ${deltaErr.message}${missingRpcHint(deltaErr.message)}`;
        console.warn(`[france-data-mcp][ameli] ${measureFailedReason}`);
      } else {
        const row = (
          deltaData as Array<{
            eligible_distinct: number | string;
            to_geocode_distinct: number | string;
          }> | null
        )?.[0];
        eligibleDistinct = parseRpcCount(
          row?.eligible_distinct,
          "ameli_measure_ban_to_geocode.eligible_distinct",
        );
        toGeocodeDistinct = parseRpcCount(
          row?.to_geocode_distinct,
          "ameli_measure_ban_to_geocode.to_geocode_distinct",
        );
        console.log(
          `[france-data-mcp][ameli] BAN delta measure: ${eligibleDistinct} distinct eligible addresses in staging, ${toGeocodeDistinct} not yet in cache (Phase 2 size)`,
        );
      }
    } catch (err) {
      // Couvre TimeoutError (légitime best-effort) + Error de parseRpcCount
      // (contract regression structurel) + TypeError programmer-bug. Persiste
      // le message dans log.error_message pour audit DB — sinon Phase 2 serait
      // dimensionnée sur des NULL sans signal opérationnel (cf. silent-failure
      // hunter H-3 Passe 1). console.error (pas warn) car couvre la classe
      // structurelle indistinguable du timeout best-effort à ce niveau —
      // l'audit DB tranche post-mortem.
      measureFailedReason = `BAN delta measurement failed (best-effort, run continues): ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.error(`[france-data-mcp][ameli] ${measureFailedReason}`);
    }
    log.ban_eligible_distinct = eligibleDistinct;
    log.ban_to_geocode_distinct = toGeocodeDistinct;
    if (measureFailedReason !== null) {
      log.error_message = log.error_message
        ? `${log.error_message}; ${measureFailedReason}`
        : measureFailedReason;
    }

    // 5d. BAN_JOIN — pose ensembliste du cache `geocoded_addresses` (partagé
    // avec RPPS, rempli par `ban-backfill.mjs` hors cron) dans
    // `annuaire_ameli_staging`. Jumeau STRICT du step 5c RPPS, prédicat
    // éligibilité simplifié (Ameli n'a pas de FINESS join → un seul état non
    // précis = `commune_centroid` AND adresse NOT NULL). Curseur KEYSET (cf.
    // docs/plans/ban-join.md §3.2 — sentinelle re-scan quadratique → 57014
    // fin de parcours prouvé prod RPPS ; keyset linéaire constant).
    //
    // `expectedTotal = stats.inserted` (borne SÛRE pour `maxIterations`) : la
    // RPC itère keyset, le filtre WHERE narrow côté SQL mais la borne JS doit
    // couvrir l'extrême haut. Un over-estimate ne pénalise pas (loop sort sur
    // `last_id IS NULL` page vide terminale).
    //
    // Skip si `eligibleDistinct=0` (cas dégénéré). `eligibleDistinct=null`
    // (mesure cassée) NE skip PAS — on tente le ban_join (il convergera vite
    // si table effectivement vide d'éligibles).
    if (eligibleDistinct !== 0) {
      const { totalApplied: banApplied, iterations: banIterations } = await runKeysetRpc(
        supabase,
        "ingest_apply_ameli_ban_join_batch",
        { p_limit: BAN_JOIN_BATCH_SIZE },
        stats.inserted,
        RPC_BATCH_TIMEOUT_MS,
      );
      console.log(
        `[france-data-mcp][ameli][ban_join] ${banApplied} posed in ${banIterations} batches (eligible_distinct=${eligibleDistinct ?? "n/a"})`,
      );
      // Sentinelle de cohérence (≠ RPPS evaluateBanJoinOutcome : pattern
      // « warn-only, l'opérateur décide » au lieu de `partial`, divergence
      // SÉMANTIQUE assumée — RPPS bloque l'audit DB sur 0-posé, Ameli reste
      // success+warn car le repli commune_centroid sert encore l'utilisateur
      // pendant l'enquête). MAIS on persiste `log.error_message` (audit DB)
      // et `log.status='partial'` quand la mesure ne sait rien (eligibleDistinct
      // null ET 0 posé = double opacité). Cf. silent-failure hunter C-1/C-2/C-3.
      if (banApplied === 0) {
        const { count: cacheAccepted, error: cacheErr } = await supabase
          .from("geocoded_addresses")
          .select("address_key", { count: "exact", head: true })
          .eq("accepted", true);
        let outcomeMessage: string | null = null;
        let shouldMarkPartial = false;

        // ORDRE D'ÉVALUATION (review P2 F1) : `eligibleDistinct === null`
        // (mesure cassée) prime sur `cacheErr` — sinon une cascade
        // « mesure cassée + cache sanity cassée » serait warn-only alors
        // qu'elle représente une TRIPLE opacité (mesure morte + ban_join 0
        // + cache inaudible) qui mérite `partial`. Le message inclut le
        // détail du cacheErr quand applicable, sans inversion silencieuse.
        const cacheTail = cacheErr
          ? `; cache sanity also failed: ${cacheErr.message}`
          : `; cache has ${cacheAccepted ?? 0} accepted entries`;

        if (eligibleDistinct === null) {
          // Mesure cassée + 0 posé : double opacité (triple si cacheErr).
          // partial → signal ops dans ingest_log (≠ message éphémère console).
          outcomeMessage = `ban_join posed 0 rows AND measure failed → eligibility unknown${cacheTail}`;
          shouldMarkPartial = true;
        } else if (eligibleDistinct > 0 && cacheErr) {
          // Mesure dit éligibles + cache illisible + 0 posé : parity break
          // POSSIBLE mais on ne peut pas le confirmer (cache muet).
          // partial : on signale qu'on n'a pas pu prouver la légitimité.
          outcomeMessage = `ban_join posed 0 rows; ${eligibleDistinct} eligible measured but cache sanity unverifiable: ${cacheErr.message}`;
          shouldMarkPartial = true;
        } else if (eligibleDistinct > 0 && (cacheAccepted ?? 0) > 0) {
          // Mesure dit éligibles + cache rempli + 0 posé = parity break suspect.
          outcomeMessage = `ban_join posed 0 rows but ${eligibleDistinct} distinct eligible + ${cacheAccepted} accepted cache — suspect parity break or empty intersection`;
          shouldMarkPartial = true;
        } else if (eligibleDistinct > 0) {
          // eligibleDistinct > 0 + cacheErr false + cacheAccepted=0 : cache
          // vide légitime, backfill jamais lancé. Warn-only (état attendu
          // pré-backfill, le cron continue normalement avec repli centroïde).
          outcomeMessage =
            "ban_join posed 0 rows: cache geocoded_addresses has 0 accepted entries — backfill never ran or wiped";
        } else if (cacheErr) {
          // eligibleDistinct === 0 (skip ban_join déjà décidé plus haut) ne
          // tombe pas ici. Cas restant : `eligibleDistinct === 0` est filtré
          // par `if (eligibleDistinct !== 0)`. Donc inatteignable.
          // Pour le défensive : `cacheErr` seul sans contexte mesure → warn.
          outcomeMessage = `ban_join posed 0 rows; cache sanity check failed (non-blocking): ${cacheErr.message}`;
        }

        if (outcomeMessage !== null) {
          console.warn(`[france-data-mcp][ameli][ban_join] ${outcomeMessage}`);
          log.error_message = log.error_message
            ? `${log.error_message}; ${outcomeMessage}`
            : outcomeMessage;
          if (shouldMarkPartial) log.status = "partial";
        }
      }
    } else {
      console.log("[france-data-mcp][ameli][ban_join] 0 eligible addresses (measure), skipped");
    }

    // 6. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "annuaire_ameli" });

    // 6b. RECONSTRUCTION MATERIALIZED VIEW post-swap (PAS un REFRESH).
    // `ameli_nomenclature_stats` est définie `FROM annuaire_ameli` : un
    // simple REFRESH la laisse suivre l'OID de l'ancienne table (désync 1er
    // cron) puis la fait détruire par le `DROP CASCADE` du 2e swap — même
    // bombe OID que RPPS (cf. migration 20260519T200000). `rebuildAmeliMatviews`
    // la RECONSTRUIT (`CREATE ... FROM annuaire_ameli` résolu PAR NOM = la
    // NOUVELLE table), bascule atomique RENAME. Échec transitoire = "partial"
    // non bloquant (ancienne matview préservée par rollback) ; échec
    // structurel = throw → "failed" + exit(1) (LOUD). Symétrique exact de
    // `rebuildRppsMatviews`.
    await rebuildAmeliMatviews(supabase, log);

    // 6c. CANARY POST-SWAP — non-bloquant. La table `ingest_canary_targets`
    // n'a pas encore de cibles seedées pour `ameli_ps` ; tant qu'elle est vide
    // côté Ameli, le RPC retourne `[]` et le canary est inactif sans bruit.
    // Une migration corrective ajoutera des cibles stables (ex: MG 75 + IDE 13).
    await runAndRecordCanary(supabase, "ameli_ps", log, "ameli");

    // SUCCESS — préserver un éventuel `status: "partial"` posé par
    // `rebuildAmeliMatviews` : un rebuild matview en échec TRANSITOIRE (lock,
    // 57014, deadlock) doit rester visible en ingest_log, pas masqué en
    // "success" (un échec STRUCTUREL aurait throw → on ne serait pas ici).
    // Symétrique du garde RPPS (rpps.ts).
    if (log.status !== "partial") {
      log.status = "success";
    }
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "ameli");
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
    await writeIngestLogFailureFallback(log, "ameli");
    console.error(`[ameli] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

interface IngestStreamStats {
  inserted: number;
  /**
   * Personnes morales (labos, pharmacies, transporteurs) skippées car
   * elles relèvent de FINESS, pas de l'annuaire Ameli des PS personnes
   * physiques. ~63 K en steady state — c'est la majorité du skip volume,
   * et c'est attendu (pas une anomalie).
   */
  skippedPersonneMorale: number;
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
  let skippedPersonneMorale = 0;
  let skippedNoIdentity = 0;
  let skippedNoLocality = 0;
  let skippedUnmatchedLocality = 0;
  let unmatchedDistinctKeysDropped = 0;
  const unmatchedSampleCounts = new Map<string, number>();
  let firstBatch = true;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertStagingBatchWithRetry(supabase, "annuaire_ameli_staging", batch, {
      logPrefix: "ameli",
      isFirstBatch: firstBatch,
    });
    firstBatch = false;
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
        case "personne_morale":
          skippedPersonneMorale++;
          break;
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
    skippedPersonneMorale,
    skippedNoIdentity,
    skippedNoLocality,
    skippedUnmatchedLocality,
    unmatchedSampleCounts,
    unmatchedDistinctKeysDropped,
  };
}

/**
 * Codes type_ps Ameli correspondant aux PERSONNES MORALES (entités
 * juridiques conventionnées). Skippées à l'ingestion car elles ont leur
 * place dans FINESS (catégories 611 labo, 620 pharmacie, etc.), pas dans
 * l'index Ameli des PS personnes physiques.
 *   - "3" = Laboratoires
 *   - "4" = Non conventionnés (pharmacies, fournisseurs de matériel, transporteurs)
 */
const PERSONNE_MORALE_TYPE_PS_CODES = new Set(["3", "4"]);

type SkipReason = "personne_morale" | "no_identity" | "no_locality" | "unmatched_locality";

type ParsedAmeliRow =
  | { row: AmeliStagingRow; skipReason?: never; sampleKey?: never }
  | { row?: never; skipReason: Exclude<SkipReason, "unmatched_locality">; sampleKey?: never }
  | { row?: never; skipReason: "unmatched_locality"; sampleKey: string };

/**
 * Parses one CSV row into a staging row. Non-data parsing failures
 * (column rename, structurally invalid row) become skip reasons that the
 * caller counts and threshold-aborts on.
 */
export function parseAmeliRecord(rec: Record<string, string>, index: CommuneIndex): ParsedAmeliRow {
  const typePsCode = getNonEmpty(rec, "type_ps_code");
  if (typePsCode && PERSONNE_MORALE_TYPE_PS_CODES.has(typePsCode)) {
    return { skipReason: "personne_morale" };
  }
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

  return {
    row: {
      // Schema NOT NULL — duplicate the present field if one is empty (rare).
      nom: nom || prenom,
      prenom: prenom || nom,
      civilite: getNonEmpty(rec, "ps_activite_civilite"),
      raison_sociale: getNonEmpty(rec, "ps_activite_raison_sociale"),
      specialite_code: getNonEmpty(rec, "specialite_code"),
      specialite_libelle: getNonEmpty(rec, "specialite_libelle"),
      type_ps_code: typePsCode,
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
      // V0.4.1 — `raw` JSONB stockait la ligne CSV brute (~70-80% du poids row
      // sur ~462K rows) et saturait le disque sur free tier (incident 2026-05-08).
      // Jamais lu côté tools MCP. La colonne reste dans le schéma pour
      // rétro-compat avec les anciens dumps, mais les nouveaux INSERT
      // n'écrivent plus rien dedans.
      raw: {},
    },
  };
}

// Codes SQLSTATE transitoires d'un rebuild matview (lock indisponible,
// deadlock, statement_timeout, out-of-memory) : `ingest_rebuild_ameli_matviews`
// est transactionnelle → un rollback intégral préserve l'ANCIENNE matview
// (peuplée, juste périmée) ⇒ dégradation bénigne, retry au prochain cron.
// Tout autre code = structurel (matview cassée) → fail-loud. Dupliqué de
// `rpps.ts:TRANSIENT_REBUILD_CODES` à dessein : ne PAS modifier `rpps.ts`
// (mergé/prouvé-prod, code critique stabilisé) pour factoriser un Set de 4
// constantes ; factorisation = dette mineure si /simplify la juge nécessaire.
const AMELI_TRANSIENT_REBUILD_CODES = new Set(["55P03", "40P01", "57014", "53300"]);

/**
 * Reconstruction post-swap de la matview `ameli_nomenclature_stats`
 * (`FROM annuaire_ameli` → sert `ameli_lister_specialites` /
 * `ameli_lister_types_ps`). RECONSTRUIT (build-new + RENAME atomique) au
 * lieu de REFRESH : un REFRESH suit l'OID de l'ancienne table (désync 1er
 * cron) puis subit le `DROP CASCADE` du 2e swap (bombe OID, cf. migration
 * 20260519T200000). Symétrique exact de `rebuildRppsMatviews`.
 *
 * Échec TRANSITOIRE (lock/deadlock/57014/OOM) : la fonction SQL étant
 * transactionnelle, le rollback préserve l'ancienne matview (peuplée, juste
 * périmée) → `status="partial"` non bloquant, retry au prochain cron, on
 * NOMME la reconstruction (le statut seul ne dit pas QUOI est dégradé).
 * Échec STRUCTUREL : throw `IngestError` → catch de `main` → `failed` +
 * exit(1) LOUD (ne PAS avaler en "partial" : matviews cassées =
 * `lister_specialites_ameli`/`lister_types_ps_ameli` down masqué).
 *
 * Exporté pour testabilité unitaire (miroir de `rebuildRppsMatviews`).
 */
export async function rebuildAmeliMatviews(
  supabase: SupabaseClient,
  log: IngestLogEntry,
): Promise<void> {
  const start = Date.now();
  const { error } = await supabase.rpc("ingest_rebuild_ameli_matviews");
  const elapsedMs = Date.now() - start;

  if (!error) {
    console.log(`[ameli] ingest_rebuild_ameli_matviews OK in ${elapsedMs}ms`);
    return;
  }

  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? String(error);
  const detail = `post-swap matview rebuild failed [code=${code ?? "none"}] after ${elapsedMs}ms: ${message}`;

  if (code !== undefined && AMELI_TRANSIENT_REBUILD_CODES.has(code)) {
    console.error(`[ameli] ${detail} — transitoire, ancienne matview préservée (rollback)`);
    log.status = "partial";
    const previousMsg = log.error_message ? `${log.error_message}; ` : "";
    log.error_message = `${previousMsg}post-swap matview rebuild (transient ${code}): ${message}`;
    return;
  }

  console.error(`[ameli] ${detail} — STRUCTUREL, échec dur`);
  throw new IngestError("validate", detail, error);
}

export const __TESTING__ = { parseAmeliRecord, rebuildAmeliMatviews };

// Only run main() when this file is executed as a script. Without this guard,
// vitest pulls in the module to test the pure helpers and immediately tries
// to connect to Supabase. See `runIfMain` for the rationale on `fileURLToPath`.
await runIfMain(import.meta.url, main);
