import "./load-env.js";
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import {
  PG_TRANSIENT_REBUILD_CODES,
  isStatementTimeoutError,
  parseRpcCount,
  withTimeout,
} from "../../src/core/index.js";
import {
  isTransientSupabaseError,
  missingRpcHint,
  retryTransient,
} from "../../src/core/retry-transient.js";
import {
  type CommuneIndex,
  type IndexedCommune,
  buildCommuneIndex,
  matchCommune,
} from "../../src/territoire/commune-index.js";
import { fetchAllCommunes } from "../../src/territoire/communes.js";
import { deriveDeptFromCp } from "../../src/territoire/dept-codes.js";
import {
  IngestError,
  type IngestLogEntry,
  PGRST_COLUMN_CACHE_MISS,
  appendLogMessage,
  assertStagingRowBand,
  atomicSwapTables,
  downloadCsv,
  getLastRealIngestRowCount,
  getLastSuccessChecksum,
  getNonEmpty,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
  isForceReingestEnv,
  preValidateFile,
  rebuildHostedActivities,
  runAndRecordCanary,
  runBatchedRpc,
  runIfMain,
  runKeysetRpc,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
} from "./shared.js";

/**
 * RPPS / Annuaire Santé ANS — pipeline d'ingestion mensuel.
 * Source : data.gouv `annuaire-sante-extractions-...-rpps`, fichier
 * `ps-libreacces-personne-activite.txt` ~803 Mo, MAJ mensuelle.
 *
 * Diffère du pipeline Ameli sur 4 points :
 * - Délimiteur PIPE `|` (vs `;` Ameli, `,` FINESS)
 * - Pas de filtre personnes morales (RPPS = personnes physiques exclusivement
 *   par construction de la nomenclature ANS)
 * - Identifiant national stable (`rpps_id`) — exposé en colonne et indexé
 * - 4× plus de volume (~2.23M lignes vs ~462K Ameli) → BATCH_SIZE plus large
 *
 * Skip uniquement no_identity. Les PS sans adresse de structure (étudiants,
 * retraités, salariés CH/CHU sans adresse site déclarée, libéraux à domicile)
 * sont insérés avec geom NULL et dept dérivé du CP quand possible. Une phase
 * post-VALIDATE / pre-SWAP enrichit ces rows via JOIN avec FINESS sur
 * `num_finess` — les salariés CH/CHU se géolocalisent ainsi à la précision
 * adresse FINESS, ce qui couvre exactement la valeur ajoutée RPPS vs Ameli.
 */

const RPPS_CSV_URL =
  process.env.RPPS_CSV_URL ??
  "https://www.data.gouv.fr/api/1/datasets/r/fffda7e9-0ea2-4c35-bba0-4496f3af935d";

/** ~803 Mo CSV en steady state. 600 Mo floor catche les troncations sans
 * faux positif sur une variation mensuelle classique (±5%). */
const MIN_SIZE_BYTES = 600_000_000;
/**
 * Volumétrie cible : ~2.0-2.2 M lignes ingérées. Le CSV ANS expose ~2.23 M
 * lignes au 2026-05-09 ; MIN_ROWS proche du réel (2.0M) catche les partial
 * parses. MAX_ROWS 2.4M absorbe la croissance organique du référentiel ;
 * au-dessus, suspicion de changement de format ANS.
 */
const MIN_ROWS = 2_000_000;
const MAX_ROWS = 2_400_000;

/**
 * Insertions par batch. 1000 (vs 500 Ameli) car le volume est 4× plus grand
 * et le payload row est comparable — économise 2200 round-trips Supabase
 * sur l'ingestion complète. Reste sous le 65 KB postgrest hard limit.
 */
const BATCH_SIZE = 1_000;

/** Rows par batch d'enrichissement FINESS server-side (PostgREST 60s timeout safe). */
const ENRICH_BATCH_SIZE = 10_000;

/**
 * Rows par lot `ban_join` (keyset). Même ordre que l'enrichment FINESS ;
 * prouvé prod ~4,8 s/lot scan keyset CONSTANT début↔fin (cf.
 * docs/plans/2026-05-19-ban-join-design.md §3.2), large sous le budget
 * `statement_timeout='55s'` de `ingest_apply_rpps_ban_join_batch`.
 */
const BAN_JOIN_BATCH_SIZE = 10_000;

/**
 * Tolérance fail structurel — ne couvre QUE `no_identity` (rpps_id vide ou
 * nom/prénom manquant). Les PS sans adresse passent en geom NULL et sont
 * enrichis post-INSERT via FINESS. Au-dessus de 1 % de no_identity, on
 * suspecte un column rename ANS upstream.
 */
const STRUCTURAL_FAIL_THRESHOLD = 0.01;

/**
 * Couverture geom minimale post-enrichissement FINESS. Warn à 50 % (pour
 * surfacer une dégradation graduelle), hard fail à 25 % (catastrophe : FINESS
 * dataset corrompu, colonne `Numéro FINESS site` ANS renommée).
 */
const GEO_RATE_WARN = 0.5;
const GEO_RATE_FLOOR = 0.25;

/**
 * Match rate minimal du JOIN FINESS sur les rows éligibles (avec num_finess
 * mais sans geom centroïde). En steady state on attend ~50-60 % de match
 * (les num_finess RPPS ne pointent pas tous vers un FINESS prod, ex: cabinets
 * libéraux à domicile sans déclaration FINESS). Floor 10 % : en-dessous,
 * régression partielle ou totale du JOIN (column drift, GRANT cassé, dataset
 * incomplet) — refuse de swap. Évalué en ratio (pas en absolu) pour rester
 * robuste à la variance de volume du CSV ANS.
 */
const FINESS_MATCH_FLOOR = 0.1;
/** Plancher de volume sous lequel le ratio devient bruité ; on log seulement. */
const FINESS_MATCH_RATIO_MIN_SAMPLE = 1_000;

/**
 * Borne ANTI-HANG de la lecture RPC `rpps_count_ban_eligible_rows` (dry-run
 * initial du step `ban_join`, cf. docs/plans/2026-05-19-ban-join-design.md).
 * Un `supabase.rpc()` brut sur socket figé pendrait jusqu'au kill GitHub
 * Actions sans `partial` ni `ingest_log` (classe de hang silencieux fermée
 * par `withTimeout`). 60 s : large pour un COUNT server-side (statement_timeout
 * fonction 55 s) sans laisser un hang réel non borné.
 */
const RPC_READ_TIMEOUT_MS = 60_000;

/**
 * Jauge 6d (`rpps_measure_ban_to_geocode`) : UNE relance après un délai de
 * repos (`retryTransient`, `maxRetries: 1`, `baseDelayMs` = cette constante),
 * sur 57014 (`isStatementTimeoutError` ; `statement_timeout` 55 s côté
 * fonction) OU un blip transport RÉSOLU (`isTransientSupabaseError` — PostgREST
 * résout `{ error: "fetch failed" }` sans throw, prouvé prod G5) ; un blip
 * transport qui THROW est relancé par `retryTransient` lui-même.
 *
 * Prouvé prod run #33954453629 (2026-09-05) : la RPC a fait 57014 à 09:08:34
 * ALORS QUE le re-ANALYZE 5d avait tourné à 09:06:58 (stats fraîches — la
 * seule hypothèse « stats périmées » du fix 2026-07 est donc INSUFFISANTE) ;
 * un checkpoint de 612 Mo (write=269 s) venait de se terminer à 09:07:36 et
 * un second démarrait à 09:08:06, en plein dans la mesure. Relancée à la
 * main 20 min plus tard, base au repos : réponse < 1 s (42 194 / 7 048).
 * Cause = contention I/O post-run (35 min d'UPDATE ban_join + swap + rebuild
 * de 4 matviews sur un compute à ~256 Mo de shared_buffers), pas la requête.
 * 60 s de repos laissent le checkpoint se terminer avant la 2e tentative.
 * Coût au PIRE ≈ 175 s (55 s serveur + 60 s repos + jitter + 60 s
 * `RPC_READ_TIMEOUT_MS` sur la 2e), inséré ENTRE le swap et l'écriture
 * d'`ingest_log` — sous le budget job de 120 min, mais c'est un argument de
 * plus pour sortir la jauge du cron (backlog). Jamais relancés : une RPC
 * absente / permission / contrat (structurel, échec définitif → warn +
 * `missingRpcHint` + indice « structurel si récurrent ») et un hang client
 * (`withTimeout` throw `TimeoutError`, exclu par `retryTransient` — contrat
 * anti-hang).
 */
const MEASURE_RETRY_DELAY_MS = 60_000;

/**
 * Budget du job GitHub Actions — MIROIR de `timeout-minutes` dans
 * `.github/workflows/ingest-rpps.yml` (parité gardée par
 * `workflows-alerting.test.ts`). Sert au PRÉAVIS de dérive de durée : la
 * durée réelle a glissé 54 → 57 → 60 min sur 4 mois (2026-05 → 09) sans AUCUN
 * signal, jusqu'au mois perdu (run #30981501695 tué à 60 min). Au-delà de
 * `JOB_DURATION_WARN_RATIO` du budget, warn LOUD + annotation GitHub
 * (grep `DÉRIVE DE DURÉE`) : regarder quelle phase a grossi AVANT de remonter
 * le budget. 60 % = ~2 cycles de préavis au rythme observé (+1 min/mois).
 */
const RPPS_JOB_BUDGET_MINUTES = 120;
const JOB_DURATION_WARN_RATIO = 0.6;

// Borne ANTI-HANG par lot de `runKeysetRpc` au step 5c (`ban_join` :
// pose ensembliste cache→staging via `ingest_apply_rpps_ban_join_batch`).
// 120 s = large au-dessus d'un lot légitime (statement_timeout serveur 55 s
// + réseau) → aucun faux `partial` sur un lot lent ; borne en revanche un
// socket figé (sinon hang non borné jusqu'au kill GitHub Actions, sans trace
// — même classe que `RPC_READ_TIMEOUT_MS` ferme sur les lectures).
const RPC_BATCH_TIMEOUT_MS = 120_000;

// Borne ANTI-HANG de la RPC fail-loud 5a (`ingest_analyze_rpps_staging` via
// callRpcFailLoud) : un `supabase.rpc()` brut sur socket figé pendrait
// jusqu'au kill GitHub Actions, et 5a est fail-loud → un hang y tue TOUT le
// cron RPPS sans `partial`/`ingest_log`. ANALYZE : statement_timeout serveur
// 55 s (fix C2) → 120 s côté client.
const RPC_ANALYZE_TIMEOUT_MS = 120_000;

/**
 * Noms exacts des colonnes côté CSV ANS (français accentué). Centralisés ici
 * comme constantes pour rendre les renames upstream loud (un changement de
 * libellé déclenche `expectedHeaderColumns` puis casse les `getNonEmpty` —
 * en un seul endroit à corriger).
 *
 * Headers vérifiés sur sample 300 KB du 2026-05-05.
 */
const COL = {
  RPPS_ID: "Identification nationale PP",
  IDENTIFIANT_PP: "Identifiant PP",
  CIVILITE_LIBELLE: "Libellé civilité d'exercice",
  NOM: "Nom d'exercice",
  PRENOM: "Prénom d'exercice",
  PROFESSION_CODE: "Code profession",
  PROFESSION_LIBELLE: "Libellé profession",
  CATEGORIE_CODE: "Code catégorie professionnelle",
  CATEGORIE_LIBELLE: "Libellé catégorie professionnelle",
  SAVOIR_FAIRE_CODE: "Code savoir-faire",
  SAVOIR_FAIRE_LIBELLE: "Libellé savoir-faire",
  MODE_EXERCICE_CODE: "Code mode exercice",
  MODE_EXERCICE_LIBELLE: "Libellé mode exercice",
  SIRET: "Numéro SIRET site",
  SIREN: "Numéro SIREN site",
  NUM_FINESS: "Numéro FINESS site",
  NUM_FINESS_EJ: "Numéro FINESS établissement juridique",
  RAISON_SOCIALE: "Raison sociale site",
  ENSEIGNE: "Enseigne commerciale site",
  SECTEUR_LIBELLE: "Libellé secteur d'activité",
  NUM_VOIE: "Numéro Voie (coord. structure)",
  TYPE_VOIE_LIBELLE: "Libellé type de voie (coord. structure)",
  VOIE: "Libellé Voie (coord. structure)",
  CODE_POSTAL: "Code postal (coord. structure)",
  CODE_COMMUNE: "Code commune (coord. structure)",
  LIBELLE_COMMUNE: "Libellé commune (coord. structure)",
  TELEPHONE: "Téléphone (coord. structure)",
  EMAIL: "Adresse e-mail (coord. structure)",
} as const;

/**
 * Provenance du `geom` d'une row RPPS, pour observabilité. `commune_centroid`
 * est appliqué par le parser TS quand le CP+ville match une commune INSEE ;
 * `finess_join` est appliqué côté SQL par `ingest_apply_rpps_finess_enrichment_batch`
 * (5b, rows sans geom) ET par `ingest_apply_rpps_finess_centroid_fallback_batch`
 * (5c-bis, rows restées `commune_centroid` après ban_join avec `num_finess`
 * géolocalisé) quand la row est enrichie via JOIN sur `num_finess`. NULL = pas de geom.
 *
 * Const exporté pour servir de source unique de vérité (TS + SQL + tests).
 */
export const GEOM_SOURCES = {
  COMMUNE_CENTROID: "commune_centroid",
  FINESS_JOIN: "finess_join",
  /** Posé par le step 5c `ban_join` (RPC `ingest_apply_rpps_ban_join_batch`). */
  BAN_ADDRESS: "ban_address",
} as const;
export type GeomSource = (typeof GEOM_SOURCES)[keyof typeof GEOM_SOURCES];

interface RppsStagingRow {
  rpps_id: string;
  identifiant_pp: string | null;
  civilite: string | null;
  nom: string;
  prenom: string;
  profession_code: string | null;
  profession_libelle: string | null;
  categorie_code: string | null;
  categorie_libelle: string | null;
  savoir_faire_code: string | null;
  savoir_faire_libelle: string | null;
  mode_exercice_code: string | null;
  mode_exercice_libelle: string | null;
  num_finess: string | null;
  num_finess_ej: string | null;
  siret: string | null;
  siren: string | null;
  raison_sociale: string | null;
  enseigne_commerciale: string | null;
  secteur_activite_libelle: string | null;
  adresse: string | null;
  code_postal: string | null;
  ville: string | null;
  /** Nullable : dérivé du CP si pas de match commune, NULL si pas de CP exploitable. */
  code_departement: string | null;
  code_insee: string | null;
  telephone: string | null;
  email: string | null;
  geom: string | null;
  geom_source: GeomSource | null;
  raw: Record<string, never>;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const log: IngestLogEntry = {
    source: "rpps",
    started_at: startedAt,
    status: "failed",
    csv_url: RPPS_CSV_URL,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    // 1. DOWNLOAD + lookup last success checksum en parallèle
    const [downloaded, lastSha, referenceRows] = await Promise.all([
      downloadCsv(RPPS_CSV_URL, "rpps-personne-activite.txt"),
      getLastSuccessChecksum("rpps"),
      getLastRealIngestRowCount("rpps"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    // FORCE_REINGEST (input `force` du workflow_dispatch) → bypass du
    // court-circuit. Cron planifié = env absent → pas de forçage. Sémantique
    // détaillée + tolérance "1"/"true" : JSDoc de isForceReingestEnv.
    if (
      await shortCircuitIfSameChecksum(
        log,
        lastSha,
        downloaded.sha256,
        "rpps",
        isForceReingestEnv(process.env.FORCE_REINGEST),
      )
    )
      return;

    // 2. PRE-VALIDATE
    await preValidateFile(downloaded.filePath, {
      minSizeBytes: MIN_SIZE_BYTES,
      // Pipe-delimited (`|`), UTF-8 sans BOM. La colonne IDNPS porte
      // l'identifiant national stable — on la veut absolument.
      expectedHeaderColumns: [
        COL.RPPS_ID,
        COL.NOM,
        COL.PRENOM,
        COL.PROFESSION_CODE,
        COL.MODE_EXERCICE_CODE,
        COL.CODE_POSTAL,
      ],
      delimiter: "|",
    });

    // 3. BUILD COMMUNE INDEX (geo.api.gouv, ~35K communes, ~4 MB JSON, 1 call).
    console.log("[rpps] fetching all communes for geocoding…");
    let communes: Awaited<ReturnType<typeof fetchAllCommunes>>;
    try {
      communes = await fetchAllCommunes();
    } catch (err) {
      console.error("[rpps] fetchAllCommunes failed:", err);
      throw new IngestError(
        "pre_validate",
        `geo.api.gouv fetchAllCommunes failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    const communeIndex = buildCommuneIndex(communes);
    console.log(
      `[rpps] commune index built: ${communes.length} communes, ${communeIndex.byCpAndName.size} (cp,nom) keys, ${communeIndex.byCp.size} CPs`,
    );

    // 4. COPY → STAGING
    const supabase = getUntypedServiceClient("rpps");
    const { error: stagingErr } = await supabase.rpc("ingest_create_rpps_staging");
    if (stagingErr) {
      throw new IngestError("copy", `Failed to create rpps_staging table: ${stagingErr.message}`);
    }
    // Pas de sleep avant le 1er INSERT : `flush()` retry sur PGRST205 (schema
    // cache miss) avec backoff exponentiel — couvre déjà le cas. Plus le
    // `NOTIFY pgrst, 'reload schema'` posté par la RPC SECURITY DEFINER.

    const stats = await streamCsvToStaging(downloaded.filePath, supabase, communeIndex);
    log.row_count = stats.inserted;

    // 5. VALIDATE COHERENCE
    const insertedWithoutGeo = stats.inserted - stats.insertedWithGeo;
    const deptDerivedFromCp = insertedWithoutGeo - stats.deptUnknown;
    console.log(
      `[rpps] insert summary: inserted=${stats.inserted} (with_geo=${stats.insertedWithGeo}, without_geo=${insertedWithoutGeo}, dept_derived_from_cp=${deptDerivedFromCp}, dept_unknown=${stats.deptUnknown}), skipped no_identity=${stats.skippedNoIdentity}`,
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
    // Bande RELATIVE à la dernière ingestion réelle : le plancher absolu
    // (2,0 M vs 2,28 M réels) laissait passer une troncature de 230 K lignes.
    assertStagingRowBand(stats.inserted, referenceRows, "rpps");

    const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
    const denominator = stats.inserted + stats.skippedNoIdentity;
    if (denominator === 0) {
      throw new IngestError(
        "validate",
        "Pipeline produced zero parser events. Refuse to swap an empty table into prod.",
      );
    }
    const structuralRate = stats.skippedNoIdentity / denominator;
    if (stats.skippedNoIdentity > 0) {
      console.warn(
        `[rpps] structural skips: ${stats.skippedNoIdentity} no_identity (${fmt(structuralRate)} of total)`,
      );
      if (structuralRate > STRUCTURAL_FAIL_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Structural skip rate ${fmt(structuralRate)} above ${fmt(STRUCTURAL_FAIL_THRESHOLD)} — suspected upstream column rename / format change`,
        );
      }
    }

    // 5a. ANALYZE STAGING — stats fraîches après le bulk COPY (~2,24M lignes
    // dans une table fraîchement CREATE). Sans ça le planner attaque le 1er
    // batch d'enrichment aveugle → plan dégradé → batch ≫ budget
    // statement_timeout → 57014 déterministe en `validate`, avant le swap
    // (cause-racine prouvée prod 2026-05-18, run #26046475566). Pratique
    // Postgres canonique « bulk COPY puis ANALYZE avant de requêter ».
    await callRpcFailLoud(
      supabase,
      "ingest_analyze_rpps_staging",
      RPC_ANALYZE_TIMEOUT_MS,
      "Failed to ANALYZE rpps_staging before enrichment",
    );

    // 5b. ENRICH FROM FINESS — la RPC fait un LEFT JOIN finess + CASE WHEN
    // qui pose 'finess_join' (avec coords) ou 'finess_unmatched' (sentinelle
    // qui sort la row du predicate du prochain scan). Le retour = total rows
    // visitées dans la batch ; 0 = file vide → boucle sort proprement.
    const initialNoGeo = stats.inserted - stats.insertedWithGeo;
    const { totalUpdated: visited, iterations: enrichIterations } =
      initialNoGeo > 0
        ? await runBatchedRpc(
            supabase,
            "ingest_apply_rpps_finess_enrichment_batch",
            { p_limit: ENRICH_BATCH_SIZE },
            initialNoGeo,
            ENRICH_BATCH_SIZE,
          )
        : { totalUpdated: 0, iterations: 0 };
    // `visited` couvre matched + unmatched ; pour connaître le nombre de
    // rows réellement matchées (avec geom non-null), on relit la staging.
    const { count: enriched, error: enrichCountErr } = await supabase
      .from("rpps_staging")
      .select("*", { count: "exact", head: true })
      .eq("geom_source", "finess_join");
    if (enrichCountErr) {
      throw new IngestError("validate", `Failed to count enriched rows: ${enrichCountErr.message}`);
    }
    const enrichedCount = enriched ?? 0;
    const totalWithGeo = stats.insertedWithGeo + enrichedCount;
    const geoRate = stats.inserted > 0 ? totalWithGeo / stats.inserted : 0;
    console.log(
      `[rpps] FINESS enrichment: ${enrichedCount} matched / ${visited} visited / ${initialNoGeo} eligible in ${enrichIterations} batches. Total geo: ${totalWithGeo}/${stats.inserted} (${fmt(geoRate)})`,
    );
    // Defense en profondeur sur le JOIN FINESS — 2 sentinelles :
    //  1. 0 matched sur N>0 éligibles : régression totale du JOIN (num_finess
    //     column drift, GRANT cassé, finess table corrompue). Throw quel que
    //     soit N : c'est suspect même à petite échelle.
    //  2. Sample suffisant + ratio sous FINESS_MATCH_FLOOR : régression
    //     partielle. Sous MIN_SAMPLE, le ratio devient bruité — on log seul.
    if (initialNoGeo > 0) {
      const matchRate = enrichedCount / initialNoGeo;
      if (enrichedCount === 0) {
        throw new IngestError(
          "validate",
          `${initialNoGeo} rows eligible for FINESS enrichment but 0 matched — likely num_finess column drift or finess table regression`,
        );
      }
      if (initialNoGeo >= FINESS_MATCH_RATIO_MIN_SAMPLE && matchRate < FINESS_MATCH_FLOOR) {
        throw new IngestError(
          "validate",
          `FINESS join match rate ${fmt(matchRate)} below floor ${fmt(FINESS_MATCH_FLOOR)} (${enrichedCount}/${initialNoGeo} matched) — likely num_finess column drift or finess table regression`,
        );
      }
      console.log(`[rpps] FINESS match rate: ${fmt(matchRate)} (${enrichedCount}/${initialNoGeo})`);
    }
    if (geoRate < GEO_RATE_FLOOR) {
      throw new IngestError(
        "validate",
        `Geo coverage ${fmt(geoRate)} below floor ${fmt(GEO_RATE_FLOOR)} — likely FINESS dataset corruption or ANS column rename`,
      );
    }
    if (geoRate < GEO_RATE_WARN) {
      console.warn(
        `[rpps] ⚠️ Geo coverage ${fmt(geoRate)} below warn threshold ${fmt(GEO_RATE_WARN)} — investigate commune index drift or FINESS join rate degradation`,
      );
    }

    // 5b-bis. (mesure du delta BAN déplacée POST-SWAP — cf. step 6d ; le détail
    // du « pourquoi pré-swap = 57014 » y est documenté.)

    // 5c. BAN_JOIN — pose ensembliste du cache `geocoded_addresses` (déjà
    // rempli par `ban-backfill.mjs`, hors cron) dans `rpps_staging`, jumeau de
    // l'enrichment FINESS (5b) mais piloté CURSEUR KEYSET. Remplace l'ancien
    // build d'index lourd + géocodage API (timeouté structurellement au cap
    // passerelle PostgREST 60 s — réfuté prod run #26087010166 ; sentinelle pure
    // re-scannait le préfixe → quadratique → 57014 fin de parcours, réfuté prod
    // proxy OFFSET 1.2M > 120 s ; keyset ~4,8 s/lot constant, prouvé prod). Cf.
    // docs/plans/2026-05-19-ban-join-design.md. Fail-loud : une erreur SQL
    // réelle → IngestError → run échoué visible, `rpps` + cache intacts (échec
    // AVANT le swap). Le géocodage des NOUVELLES adresses reste `ban-backfill.mjs`
    // (manuel, hors scope — décidé PO). `expectedTotal` = nb de lignes éligibles
    // (count RPC dédié, byte-identique au prédicat de `ban_join`) → borne
    // `maxIterations` de la garde de convergence de `runKeysetRpc`.
    const { data: banEligibleData, error: banEligibleErr } = await withTimeout(
      supabase.rpc("rpps_count_ban_eligible_rows", { p_source_table: "rpps_staging" }),
      RPC_READ_TIMEOUT_MS,
      "rpps_count_ban_eligible_rows",
    );
    if (banEligibleErr) {
      throw new IngestError(
        "validate",
        `Failed to count BAN-eligible rows: ${banEligibleErr.message}${missingRpcHint(banEligibleErr.message)}`,
      );
    }
    const banEligible = parseRpcCount(banEligibleData, "rpps_count_ban_eligible_rows");
    if (banEligible > 0) {
      const { totalApplied: banApplied, iterations: banIterations } = await runKeysetRpc(
        supabase,
        "ingest_apply_rpps_ban_join_batch",
        { p_limit: BAN_JOIN_BATCH_SIZE },
        banEligible,
        RPC_BATCH_TIMEOUT_MS,
      );
      console.log(
        `[rpps] ban_join: ${banApplied} posed / ${banEligible} eligible in ${banIterations} batches`,
      );
      // Sentinelle de cohérence NON BLOQUANTE (décision pure déléguée à
      // `evaluateBanJoinOutcome`, testée unitairement). `ban_join` best-effort :
      // jamais de throw (un échec dur re-bloquerait un run sain — CLAUDE.md).
      // « 0 posé » ⇒ on interroge le cache puis on TRACE le sous-cas (les 3
      // sont anormaux et désormais tous tracés en `ingest_log`, préservé par
      // le bloc de finalisation plus bas). Repli `commune_centroid` servi.
      if (banApplied === 0) {
        const { count: cacheAccepted, error: cacheErr } = await supabase
          .from("geocoded_addresses")
          .select("address_key", { count: "exact", head: true })
          .eq("accepted", true);
        const outcome = evaluateBanJoinOutcome({
          banApplied,
          banEligible,
          cacheAccepted: cacheAccepted ?? 0,
          cacheErrMessage: cacheErr ? cacheErr.message : undefined,
        });
        if (outcome.warn) console.warn(outcome.warn);
        if (outcome.partial) log.status = "partial";
        if (outcome.logMessage) appendLogMessage(log, outcome.logMessage);
      }
    } else {
      console.log("[rpps] ban_join: 0 eligible rows, skipped");
    }

    // 5c-bis. REPLI FINESS sur les lignes restées `commune_centroid` APRÈS
    // ban_join et portant un `num_finess` géolocalisé DANS LA MÊME COMMUNE.
    // Prouvé prod 2026-09-05 (table `rpps` post-swap) : 70 677 lignes au
    // centroïde AVEC un num_finess, 57 462 géolocalisables, dont 3 857 dans une
    // AUTRE commune que celle déclarée (exclues : incohérence exposée) →
    // ~53 605 lignes corrigées. Cause : l'enrichment 5b ne vise que les lignes
    // SANS geom ; une ligne à commune reconnue reçoit le centroïde puis dépend
    // du cache BAN, or les adresses d'établissements (nom de structure, CS/BP,
    // cedex) se géocodent mal. Détail + décisions : migration 20260905T140000.
    //
    // Ordre : APRÈS ban_join (BAN housenumber > point FINESS DREES), AVANT le
    // re-ANALYZE 5d (stats fraîches) et le swap. EFFET DE BORD ASSUMÉ : ces
    // lignes sortent de l'éligibilité BAN → la jauge 6d chute d'un cran (~54 K)
    // au 1er run, ce n'est PAS un progrès BAN ; le drain ne les soumettra plus.
    //
    // BEST-EFFORT (même classe que le re-ANALYZE 5d, ≠ 5a/5b/5c fail-loud) :
    // une erreur ici (57014 sur un lot, RPC absente du cache PostgREST,
    // contrat) ne doit PAS tuer un run dont les données sont BONNES — juste
    // moins précises → warn LOUD + `partial` + trace audit `ingest_log`.
    // PAS de COUNT PostgREST préalable des éligibles (revue 2026-09-05, mesuré
    // prod) : une requête nue hérite du budget 8 s et prend déjà 4,4 s sur
    // table PROPRE ; sur la staging ballonnée post-ban_join (~1 M entrées
    // d'index mortes) elle ferait 57014. `expectedTotal` = `stats.inserted`
    // (borne LARGE de la garde de convergence de `runKeysetRpc` ; la vraie
    // protection anti-boucle est sa garde de NON-PROGRESSION du curseur).
    try {
      const { totalApplied: fallbackApplied, iterations: fallbackIterations } = await runKeysetRpc(
        supabase,
        "ingest_apply_rpps_finess_centroid_fallback_batch",
        { p_limit: ENRICH_BATCH_SIZE },
        stats.inserted,
        RPC_BATCH_TIMEOUT_MS,
      );
      console.log(
        `[rpps] finess_fallback: ${fallbackApplied} rows posed (centroid rows with a geolocated num_finess in the same commune) in ${fallbackIterations} batches`,
      );
      const outcome = evaluateFinessFallbackOutcome({
        applied: fallbackApplied,
        iterations: fallbackIterations,
      });
      if (outcome.warn) console.warn(outcome.warn);
      if (outcome.partial) log.status = "partial";
      if (outcome.logMessage) appendLogMessage(log, outcome.logMessage);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallbackMsg = `finess_fallback skipped (best-effort, run continues — ~53 K lignes restent au centroïde ce mois): ${reason}${missingRpcHint(reason)}`;
      console.warn(`[france-data-mcp][rpps][finess_fallback] ${fallbackMsg}`);
      log.status = "partial";
      appendLogMessage(log, fallbackMsg);
    }

    // 5d. RE-ANALYZE post-ban_join — stats fraîches pour la MESURE 6d.
    // L'enrichment (5b) + ban_join (5c) ont UPDATE ~1,6 M lignes depuis
    // l'ANALYZE 5a : la distribution `geom_source` des stats est périmée
    // (~1,3 M `commune_centroid` avant pose → ~135 K après). Les stats
    // suivent la table au RENAME du swap (même OID) : sans ce refresh, la
    // mesure post-swap `rpps_measure_ban_to_geocode` planifie sur ces stats
    // périmées → >55 s → 57014 « mesure indisponible » sur un run SAIN
    // (prouvé prod run #28733339515 du 2026-07-05 ; la même RPC répond <1 s
    // une fois l'autoanalyze passé). BEST-EFFORT (≠ 5a fail-loud) : ne
    // protège que la jauge 6d, elle-même best-effort — un échec ici ne doit
    // pas tuer un run dont les données sont bonnes (warn LOUD, run continue).
    try {
      await callRpcFailLoud(
        supabase,
        "ingest_analyze_rpps_staging",
        RPC_ANALYZE_TIMEOUT_MS,
        "Failed to re-ANALYZE rpps_staging after ban_join",
      );
    } catch (err) {
      // Warn console (grep ops) + trace audit DB `ingest_log` (doctrine
      // observabilité background) — la mesure 6d restera probablement NULL,
      // l'audit explique POURQUOI sans rejouer les logs GitHub Actions.
      const reAnalyzeMsg = `post-ban_join re-ANALYZE skipped (best-effort, la mesure 6d risque un 57014): ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.warn(`[rpps] ${reAnalyzeMsg}`);
      appendLogMessage(log, reAnalyzeMsg);
    }

    // 6. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "rpps" });

    // 6b. RECONSTRUCTION MATERIALIZED VIEWS post-swap. Les 3 matviews RPPS
    // (`rpps_savoir_faire_stats` → `lister_specialites_medicales`,
    // `rpps_count_stats` → `densite_professionnels_sante`,
    // `rpps_commune_centroids` → `rpps_in_radius`) sont définies `FROM rpps`.
    // Un simple REFRESH les laisse suivre l'OID de l'ancienne table : le swap
    // RENAME les désynchronise (1er cron) puis les détruit par CASCADE (2e
    // cron) — défaut prouvé prod (/review). `rebuildRppsMatviews` les
    // RECONSTRUIT (`CREATE ... FROM rpps` résolu par nom = la NOUVELLE table),
    // bascule atomique sans fenêtre. Échec transitoire = "partial" non
    // bloquant (ancienne matview préservée par rollback) ; échec structurel =
    // throw → "failed" + exit(1) (LOUD, fin de l'avalement silencieux).
    await rebuildRppsMatviews(supabase, log);

    // 6d. PHASE 1 MESURE du delta BAN — POST-SWAP sur `rpps` (le résidu après
    // ban_join = la vraie taille de file que la future automatisation Phase 2
    // aurait à géocoder). BEST-EFFORT : un échec (timeout, RPC absente, contrat
    // cassé) → console.warn + log NULL + on continue (Phase 1 = observabilité,
    // pas gating). Mesuré sur `rpps` (résidu ~150k éligibles, <1 s) et NON sur
    // `rpps_staging` pré-ban_join (~1,29 M → 57014 systématique, prouvé prod run
    // #27003446829). `rpps_measure_ban_to_geocode` fait une passe DISTINCT +
    // anti-jointure (PAS de skip-scan) → aucun index BAN requis. Locales
    // préservent une mesure partielle : si parseRpcCount #2 throw, #1 reste posé.
    // Cf. migration 20260520T000000_rpps_measure_ban_to_geocode.
    let eligibleDistinct: number | null = null;
    let toGeocodeDistinct: number | null = null;
    try {
      // Relance unique sur 57014 (contention I/O post-run, prouvée prod) — cf.
      // `MEASURE_RETRY_DELAY_MS`. `retryTransient` rend la dernière valeur
      // telle quelle : le `if (deltaErr)` ci-dessous voit l'échec définitif.
      const { data: deltaData, error: deltaErr } = await retryTransient(
        () =>
          withTimeout(
            supabase.rpc("rpps_measure_ban_to_geocode", { p_source_table: "rpps" }),
            RPC_READ_TIMEOUT_MS,
            "rpps_measure_ban_to_geocode",
          ),
        "rpps_measure_ban_to_geocode",
        {
          maxRetries: 1,
          baseDelayMs: MEASURE_RETRY_DELAY_MS,
          isRetryableResult: (r) =>
            isStatementTimeoutError(r.error) || isTransientSupabaseError(r.error),
        },
      );
      if (deltaErr) {
        // Dans CE projet, le 57014 a historiquement été STRUCTUREL (GiST partiel
        // perdu au swap, matview OID, budget 8 s hérité) — une régression
        // d'index se présenterait désormais comme « relance puis skip », mois
        // après mois : on nomme l'hypothèse pour que l'opérateur ne la range
        // pas en « blip ».
        const structuralHint = isStatementTimeoutError(deltaErr)
          ? " — 57014 APRÈS relance : si le symptôme se répète d'un cycle à l'autre, ce n'est PAS de la contention I/O mais du STRUCTUREL (index perdu au swap, plan dégradé) → EXPLAIN ANALYZE la RPC à froid"
          : "";
        const skippedMsg = `BAN delta measurement skipped: ${deltaErr.message}${missingRpcHint(deltaErr.message)}${structuralHint}`;
        console.warn(`[rpps] ${skippedMsg}`);
        // Trace audit `ingest_log` (revue 2026-09-05) : la jauge est NULL sur
        // les 4 derniers runs sans qu'aucune ligne DB ne dise pourquoi — le
        // `console.warn` seul se perd dans les logs GitHub Actions.
        appendLogMessage(log, skippedMsg);
      } else {
        const row = (
          deltaData as Array<{
            eligible_distinct: number | string;
            to_geocode_distinct: number | string;
          }> | null
        )?.[0];
        // Throw de parseRpcCount → attrapé par le catch outer = best-effort
        // (Phase 1 = observabilité, pas gating ; cf. JSDoc src/core/parse-rpc-count.ts).
        eligibleDistinct = parseRpcCount(
          row?.eligible_distinct,
          "rpps_measure_ban_to_geocode.eligible_distinct",
        );
        toGeocodeDistinct = parseRpcCount(
          row?.to_geocode_distinct,
          "rpps_measure_ban_to_geocode.to_geocode_distinct",
        );
        console.log(
          `[rpps] BAN delta measure: ${eligibleDistinct} distinct eligible addresses in rpps, ${toGeocodeDistinct} not yet in cache (Phase 2 residual queue)`,
        );
      }
    } catch (err) {
      console.warn(
        `[rpps] BAN delta measurement failed (best-effort, run continues): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    log.ban_eligible_distinct = eligibleDistinct;
    log.ban_to_geocode_distinct = toGeocodeDistinct;

    // 6c. CANARY POST-SWAP. Cibles seedées dans la migration `_canary_seed_rpps`
    // (placeholders à valider post 1er run prod — log warn non-bloquant si
    // tous missing tant que les vrais IDNPS référents n'ont pas remplacé les
    // placeholders).
    await runAndRecordCanary(supabase, "rpps", log, "rpps");

    // IMPORTANT : préserver un éventuel `status: "partial"` posé par
    // `rebuildRppsMatviews` (échec TRANSITOIRE de reconstruction matview ;
    // un échec STRUCTUREL aurait throw → on ne serait pas ici).
    // `runAndRecordCanary` actuel ne pose pas "partial" — il remplit seulement
    // `canary_failures`. Si un futur change y ajoute "partial", ce check le
    // préserve aussi. Écraser inconditionnellement masquerait un incident
    // d'observabilité (régression V0.9 Passe 1).
    if (log.status !== "partial") {
      log.status = "success";
    }
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "rpps");
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[rpps] success: ${stats.inserted} rows ingested in ${elapsedSec}s`);
    // Préavis de dérive (cf. `RPPS_JOB_BUDGET_MINUTES`) : le run n'a pas été
    // tué, mais il s'en rapproche. `::warning::` sur stdout = annotation
    // visible sur la page du run GitHub, pas seulement dans le log.
    if (elapsedSec > RPPS_JOB_BUDGET_MINUTES * 60 * JOB_DURATION_WARN_RATIO) {
      const minutes = Math.round(elapsedSec / 60);
      const pct = JOB_DURATION_WARN_RATIO * 100;
      const drift = `[rpps] DÉRIVE DE DURÉE : ${minutes} min pour un budget de ${RPPS_JOB_BUDGET_MINUTES} min (> ${pct} %) — regarder quelle phase a grossi (insert / enrichment FINESS / ban_join) AVANT de remonter timeout-minutes.`;
      console.warn(drift);
      console.log(`::warning::${drift}`);
    }
  } catch (err) {
    console.error("[rpps] ingestion failed:", err);
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
    // `appendLogMessage` (pas `=`) : conserve les notes `partial` posées par les
    // steps best-effort (5c-bis, 5d, 6d) si un step ultérieur throw.
    appendLogMessage(log, ingestErr.message);
    log.finished_at = new Date().toISOString();
    await writeIngestLogFailureFallback(log, "rpps");
    console.error(`[rpps] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

interface IngestStreamStats {
  inserted: number;
  /** Rows avec geom au centroïde commune (le reste est ` inserted - insertedWithGeo`). */
  insertedWithGeo: number;
  /** Rows sans geom ni dept (ni CP ni ville exploitables — étudiants/retraités). */
  deptUnknown: number;
  skippedNoIdentity: number;
}

async function streamCsvToStaging(
  filePath: string,
  supabase: SupabaseClient,
  index: CommuneIndex,
): Promise<IngestStreamStats> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });

  const parser = stream.pipe(
    parse({
      delimiter: "|",
      columns: true,
      skip_empty_lines: true,
      // Désactive complètement le mode RFC 4180 — le CSV ANS est pipe-delimited
      // pur où `"` n'est pas un caractère de quoting structurel mais du contenu
      // libre (apostrophes typographiques, transcriptions, etc.). Sans ça, le
      // parser échoue sur `CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE` (1er run
      // 2026-05-09 line 10775, colonne "Complément destinataire").
      quote: false,
      relax_column_count: true,
      trim: true,
      bom: true,
    }),
  );

  let batch: RppsStagingRow[] = [];
  let inserted = 0;
  let insertedWithGeo = 0;
  let deptUnknown = 0;
  let skippedNoIdentity = 0;
  let firstBatch = true;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // RPPS ajoute le cache-miss COLONNE (ex `geom_source` post-ALTER) au
    // cache-miss TABLE géré par défaut — voir PGRST_COLUMN_CACHE_MISS.
    await insertStagingBatchWithRetry(supabase, "rpps_staging", batch, {
      logPrefix: "rpps",
      isFirstBatch: firstBatch,
      extraCacheMissCodes: [PGRST_COLUMN_CACHE_MISS],
    });
    firstBatch = false;
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = parseRppsRecord(record, index);
    if (!parsed.row) {
      skippedNoIdentity++;
      continue;
    }
    batch.push(parsed.row);
    if (parsed.row.geom) insertedWithGeo++;
    else if (!parsed.row.code_departement) deptUnknown++;
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return { inserted, insertedWithGeo, deptUnknown, skippedNoIdentity };
}

type ParsedRppsRow = { row: RppsStagingRow } | { row?: never };

/**
 * Parse une ligne RPPS en row staging. Skip uniquement `no_identity` (rpps_id
 * vide ou nom/prénom manquant). Toutes les autres lignes — y compris celles
 * sans adresse de structure — produisent une row, avec geom NULL si le
 * CP+ville ne match aucune commune. Le post-INSERT
 * `ingest_apply_rpps_finess_enrichment_batch` enrichit ces rows via JOIN
 * FINESS sur `num_finess`.
 */
export function parseRppsRecord(rec: Record<string, string>, index: CommuneIndex): ParsedRppsRow {
  const rppsId = getNonEmpty(rec, COL.RPPS_ID);
  const nom = getNonEmpty(rec, COL.NOM) ?? "";
  const prenom = getNonEmpty(rec, COL.PRENOM) ?? "";
  // Skip si rpps_id manquant OU si nom OU prénom vide. La duplication
  // `nom = prenom` quand l'un manque masquait silencieusement une donnée
  // partielle ; mieux vaut tracker ces lignes en `no_identity` et alerter
  // par le threshold structurel si elles deviennent fréquentes.
  if (!rppsId || !nom || !prenom) return {};

  const codePostalRaw = getNonEmpty(rec, COL.CODE_POSTAL);
  const villeRaw = getNonEmpty(rec, COL.LIBELLE_COMMUNE);
  const matched: IndexedCommune | null = matchCommune(index, codePostalRaw, villeRaw);

  // Reconstruit l'adresse littérale (numéro + type voie + libellé voie). On
  // joint les segments présents avec un espace, on évite "null null null"
  // quand ils sont tous vides.
  const adresseParts = [
    getNonEmpty(rec, COL.NUM_VOIE),
    getNonEmpty(rec, COL.TYPE_VOIE_LIBELLE),
    getNonEmpty(rec, COL.VOIE),
  ].filter((s): s is string => Boolean(s));
  const adresse = adresseParts.length > 0 ? adresseParts.join(" ") : null;

  let geom: string | null = null;
  let geomSource: GeomSource | null = null;
  let codeInsee: string | null = null;
  let codeDept: string | null = null;

  if (matched) {
    geom = `SRID=4326;POINT(${matched.lon} ${matched.lat})`;
    geomSource = GEOM_SOURCES.COMMUNE_CENTROID;
    codeInsee = matched.codeInsee;
    codeDept = matched.codeDepartement;
  } else {
    // Fallback dept : dérive depuis le CP si possible. Pas de match commune
    // → pas de geom (le post-enrichissement FINESS comblera quand num_finess
    // est exploitable). Le dept dérivé est "qualité moyenne" (un CP couvre
    // parfois 2 dept en limite, cf. brief V0.5.1) mais largement suffisant
    // pour `rpps_par_specialite_dept`. NULL si CP absent ou ambigu (Corse).
    codeDept = deriveDeptFromCp(codePostalRaw) ?? null;
  }

  return {
    row: {
      rpps_id: rppsId,
      identifiant_pp: getNonEmpty(rec, COL.IDENTIFIANT_PP),
      civilite: getNonEmpty(rec, COL.CIVILITE_LIBELLE),
      nom,
      prenom,
      profession_code: getNonEmpty(rec, COL.PROFESSION_CODE),
      profession_libelle: getNonEmpty(rec, COL.PROFESSION_LIBELLE),
      categorie_code: getNonEmpty(rec, COL.CATEGORIE_CODE),
      categorie_libelle: getNonEmpty(rec, COL.CATEGORIE_LIBELLE),
      savoir_faire_code: getNonEmpty(rec, COL.SAVOIR_FAIRE_CODE),
      savoir_faire_libelle: getNonEmpty(rec, COL.SAVOIR_FAIRE_LIBELLE),
      mode_exercice_code: getNonEmpty(rec, COL.MODE_EXERCICE_CODE),
      mode_exercice_libelle: getNonEmpty(rec, COL.MODE_EXERCICE_LIBELLE),
      num_finess: getNonEmpty(rec, COL.NUM_FINESS),
      num_finess_ej: getNonEmpty(rec, COL.NUM_FINESS_EJ),
      siret: getNonEmpty(rec, COL.SIRET),
      siren: getNonEmpty(rec, COL.SIREN),
      raison_sociale: getNonEmpty(rec, COL.RAISON_SOCIALE),
      enseigne_commerciale: getNonEmpty(rec, COL.ENSEIGNE),
      secteur_activite_libelle: getNonEmpty(rec, COL.SECTEUR_LIBELLE),
      adresse,
      code_postal: codePostalRaw ? codePostalRaw.trim().slice(0, 5) : null,
      ville: villeRaw,
      code_departement: codeDept,
      code_insee: codeInsee,
      telephone: getNonEmpty(rec, COL.TELEPHONE),
      email: getNonEmpty(rec, COL.EMAIL),
      geom,
      geom_source: geomSource,
      // V0.4.1 lesson : pas de raw JSONB stocké (économise ~70% du poids row
      // sur 2.23M lignes = ~1.5 GB sur Pro tier 8GB). Jamais lu côté tools.
      raw: {},
    },
  };
}

/**
 * Reconstruit (build-new + RENAME atomique) les matviews dépendantes de
 * `rpps` après le swap atomique, via le RPC `ingest_rebuild_rpps_matviews`
 * (1 transaction SQL pour les 3 : `rpps_savoir_faire_stats`,
 * `rpps_count_stats`, `rpps_commune_centroids`).
 *
 * Remplace l'ancien refresh-only : une matview `FROM rpps` suit l'OID de la
 * table. Le swap RENAME (`rpps`→`rpps_previous`→`rpps_previous_OLD`→
 * `DROP CASCADE`) la désynchronisait silencieusement (1er cron) puis la
 * DÉTRUISAIT (2e cron) → `rpps_in_radius` / `densite_professionnels_sante` /
 * `lister_specialites_medicales` down, avalé en "partial" (défaut prouvé
 * prod, /review). `CREATE ... FROM rpps` post-swap résout la table PAR NOM
 * (= la nouvelle) → matviews re-liées au bon OID à CHAQUE cron.
 *
 * Contrat d'erreur (la fonction SQL est transactionnelle = tout-ou-rien) :
 *   - transitoire (lock/timeout/connexions) → rollback → ancienne matview
 *     intacte (juste périmée) : `status="partial"` + reconstruction nommée
 *     dans `error_message`, PAS de throw (retry au prochain cron, aucun
 *     tool down) ;
 *   - structurel (42P01, code SQL inattendu) → throw `IngestError` → catch
 *     de `main` → `status="failed"` + `exit(1)` (LOUD ; fin de l'avalement
 *     silencieux qui masquait une matview cassée).
 *
 * Défaut symétrique Ameli (`ameli_nomenclature_stats`) = backlog P1, masqué
 * fortuitement par `shortCircuitIfSameChecksum` (ancrage :
 * `rpps-matview-rebuild.test.ts`).
 *
 * Exporté pour testabilité unitaire.
 */
// Codes transitoires : `PG_TRANSIENT_REBUILD_CODES` (`src/core/pg-errors.ts`,
// source unique partagée avec `ameli.ts`).

// `appendLogMessage` est désormais exporté depuis `./shared.js` (Phase 2 /
// Tâche 3) — partagé avec `finess.ts` qui consomme aussi `rebuildHostedActivities`.

/**
 * Décision PURE du signal de cohérence post-`ban_join` (testable sans DB ni
 * cron — extraite du bloc 5c pour couverture unitaire). `ban_join` est
 * best-effort : JAMAIS de throw (un échec dur re-bloquerait un run sain —
 * CLAUDE.md « l'ingestion mensuelle n'est JAMAIS bloquée par BAN »). « 0 posé »
 * est AMBIGU : légitime (toutes les lignes éligibles sont de NOUVELLES adresses
 * pas encore en cache, `ban-backfill.mjs` pas relancé) OU pathologique (dérive
 * de parité clé RPC↔cache, OU cache `geocoded_addresses` wipé — classe S-1).
 * Indistinguable sans faux positif → on NE throw pas mais on TRACE TOUJOURS
 * (audit DB via `appendLogMessage`, pas juste un `console.log` éphémère) sur
 * CHACUN des 3 sous-cas anormaux — y compris « cache lisible mais 0 accepté »
 * (le seul qui n'émettait AUCUN signal avant ce correctif /review P1).
 * `cacheErrMessage` défini ⇒ la requête de sanity-check du cache a elle-même
 * échoué ; sinon `cacheAccepted` = nb de lignes `accepted=true` en cache.
 */
export function evaluateBanJoinOutcome(args: {
  banApplied: number;
  banEligible: number;
  cacheAccepted: number;
  cacheErrMessage?: string;
}): { partial: boolean; warn?: string; logMessage?: string } {
  const { banApplied, banEligible, cacheAccepted, cacheErrMessage } = args;
  if (banApplied > 0) return { partial: false };
  if (cacheErrMessage !== undefined) {
    return {
      partial: true,
      warn: `[france-data-mcp][rpps][ban_join] 0 posed; cache sanity check failed (non-blocking): ${cacheErrMessage}`,
      logMessage: `ban_join: 0 posed, cache check failed: ${cacheErrMessage}`,
    };
  }
  if (cacheAccepted > 0) {
    return {
      partial: true,
      warn: `[france-data-mcp][rpps][ban_join] ⚠️ 0 posed over ${banEligible} eligible while geocoded_addresses has ${cacheAccepted} accepted — either all eligible rows are NEW uncached addresses (ban-backfill not re-run: legitimate) OR address-key parity drift RPC↔cache (S-1: investigate). Non-blocking; commune_centroid fallback served.`,
      logMessage: `ban_join: 0 posed / ${banEligible} eligible while cache has ${cacheAccepted} accepted — investigate parity drift vs new-uncached`,
    };
  }
  // 3e sous-cas (MEDIUM-1 /review P1) : cache LISIBLE mais 0 accepté ALORS que
  // des lignes sont éligibles → 1er run pré-backfill (légitime) OU cache
  // `geocoded_addresses` perdu/wipé/RLS (S-1). C'était le SEUL chemin sans
  // aucune trace (console.log éphémère uniquement) — désormais tracé.
  return {
    partial: true,
    warn: `[france-data-mcp][rpps][ban_join] ⚠️ 0 posed over ${banEligible} eligible while geocoded_addresses has 0 accepted — cache empty/wiped or never backfilled (S-1: investigate). Non-blocking; commune_centroid fallback served.`,
    logMessage: `ban_join: 0 posed / ${banEligible} eligible while cache has 0 accepted — cache empty/wiped or pre-backfill`,
  };
}

/**
 * RPC fail-loud du cron, BORNÉE anti-hang. Un `supabase.rpc()` brut sur un
 * socket figé pendrait jusqu'au kill GitHub Actions, SANS `partial` ni
 * `ingest_log` ; ces étapes étant fail-loud, un hang y tue TOUT le cron RPPS
 * mensuel non surveillé (classe que `RPC_READ_TIMEOUT_MS` / step 7 ferment
 * ailleurs, /review P2 silent-failure MEDIUM-1). Timeout OU `{error}` résolu
 * → `IngestError("validate")` fail-loud (le `name="TimeoutError"` reste
 * exclu d'un éventuel retry par `name`, contrat `with-timeout.ts`).
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
        `[france-data-mcp][rpps] ${rpcName} timed out after ${timeoutMs}ms — anti-silent-hang bound, failing loud`,
      );
      throw new IngestError(
        "validate",
        `${errPrefix}: timed out after ${timeoutMs}ms (anti-silent-hang bound)`,
      );
    }
    console.error(`[france-data-mcp][rpps] ${rpcName} threw a non-timeout error, re-raising`);
    throw e;
  }
  if (res.error) {
    throw new IngestError("validate", `${errPrefix}: ${res.error.message}`);
  }
}

export async function rebuildRppsMatviews(
  supabase: SupabaseClient,
  log: IngestLogEntry,
): Promise<void> {
  const start = Date.now();
  const { error } = await supabase.rpc("ingest_rebuild_rpps_matviews");
  const elapsedMs = Date.now() - start;

  if (error) {
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? String(error);
    const detail = `post-swap matview rebuild failed [code=${code ?? "none"}] after ${elapsedMs}ms: ${message}`;

    if (code !== undefined && PG_TRANSIENT_REBUILD_CODES.has(code)) {
      // Transitoire : `ingest_rebuild_rpps_matviews` est transactionnelle →
      // rollback intégral → AUCUNE matview détruite, l'ancienne (peuplée,
      // juste périmée) reste en place. Dégradation bénigne, retry au prochain
      // cron. On NOMME la reconstruction (le statut seul ne dit pas QUOI est
      // dégradé — contrat alerting). IMPORTANT : on NE chaîne PAS le rebuild
      // de `finess_hosted_activities` ci-dessous — il JOIN `rpps` ET dépend
      // implicitement des matviews qu'on vient d'échouer à rafraîchir ; le
      // rebuilder sur un état rpps désynchronisé ne ferait que propager le
      // périmé. Retry intégral au prochain cron.
      console.error(`[rpps] ${detail} — transitoire, ancienne matview préservée (rollback)`);
      log.status = "partial";
      appendLogMessage(log, `post-swap matview rebuild (transient ${code}): ${message}`);
      return;
    }

    // Structurel : NE PAS avaler en "partial" (trou prouvé /review : matview
    // cassée → `rpps_in_radius` down, masqué non bloquant). Throw → catch de
    // `main` → status "failed" + exit(1) = LOUD. Même raisonnement que ci-dessus
    // sur le skip du rebuild hosted : un structurel ici signifie rpps lui-même
    // est dans un état invalide → propager au hosted serait nuisible.
    console.error(`[rpps] ${detail} — STRUCTUREL, échec dur`);
    throw new IngestError("validate", detail, error);
  }

  console.log(`[rpps] ingest_rebuild_rpps_matviews OK in ${elapsedMs}ms`);

  // Phase 2 — `finess_hosted_activities` JOIN `rpps` ET `finess` → suit l'OID
  // des deux → doit être rebuilt post-swap des deux côtés. Hook symétrique
  // côté FINESS dans `scripts/ingest/finess.ts`. Séquence : RPPS matviews
  // D'ABORD (ci-dessus) — sinon on rebuild hosted sur un état rpps périmé.
  // Politique d'erreur (partial sans throw, couche secondaire) dans la
  // fonction partagée — cf. `rebuildHostedActivities` (`./shared.js`).
  await rebuildHostedActivities(supabase, log, "rpps");
}

/**
 * Décision de la sentinelle du repli FINESS 5c-bis (pure, testable sans DB) —
 * jumelle de `evaluateBanJoinOutcome`. Binaire faute de count des éligibles
 * (retiré en revue : un count PostgREST nu hérite du budget 8 s → 57014 sur
 * staging ballonnée) : `iterations >= 2` = au moins UNE page non vide vue, donc
 * des éligibles existaient ; `applied === 0` dans ce cas = régression (cast
 * CHAR(9), `finess.geom` vide, GRANT) → `partial` + trace audit, jamais de
 * throw (données correctes, juste moins précises). `iterations <= 1` = page
 * vide d'emblée = aucun éligible : légitime SUR UN JEU DE TEST, suspect en
 * prod (~70 K attendus) → warn sans `partial`. Une chute PARTIELLE
 * (3 000/53 000) n'est pas détectable sans count — limite assumée, backlog.
 */
export function evaluateFinessFallbackOutcome(args: { applied: number; iterations: number }): {
  partial: boolean;
  warn?: string;
  logMessage?: string;
} {
  const prefix = "[france-data-mcp][rpps][finess_fallback]";
  if (args.iterations <= 1) {
    return {
      partial: false,
      warn: `${prefix} 0 eligible rows seen (empty first page) — suspect en prod (~70 K attendus : geom_source ? num_finess ?), légitime sur un jeu réduit`,
    };
  }
  if (args.applied === 0) {
    const msg =
      "finess_fallback: 0 rows posed on a non-empty eligible set — suspect (finess.geom empty? join cast? GRANT?)";
    return { partial: true, warn: `${prefix} ${msg}`, logMessage: msg };
  }
  return { partial: false };
}

export const __TESTING__ = {
  parseRppsRecord,
  COL,
  rebuildRppsMatviews,
  evaluateBanJoinOutcome,
  evaluateFinessFallbackOutcome,
};

await runIfMain(import.meta.url, main);
