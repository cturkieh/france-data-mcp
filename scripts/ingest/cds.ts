import "./load-env.js";
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { CDS_TYPE_ETAB } from "../../src/sante/cds-db.js";
import {
  type CommuneIndex,
  type IndexedCommune,
  buildCommuneIndex,
  matchCommune,
  parentCommuneInsee,
} from "../../src/territoire/commune-index.js";
import { fetchAllCommunes } from "../../src/territoire/communes.js";
import {
  IngestError,
  type IngestLogEntry,
  assertStagingRowBand,
  atomicSwapTables,
  downloadCsv,
  getLastRealIngestRowCount,
  getLastSuccessChecksum,
  getNonEmpty,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
  preValidateFile,
  runAndRecordCanary,
  runIfMain,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
} from "./shared.js";

// CSV CDS officiel CNAM via data.gouv. Le slug `annuaire-sante-ameli` est
// stable, mais le resource id rotate à chaque regénération hebdo — on pointe
// le latest-resource alias data.gouv. Override via CDS_CSV_URL env var pour
// bisecter une régression upstream.
const CDS_CSV_URL =
  process.env.CDS_CSV_URL ??
  "https://www.data.gouv.fr/api/1/datasets/r/767470ac-dcf9-4110-97b6-cb2be3b59ba2";

/** ~3 Mo CSV. 1.5 Mo floor catche les troncatures sans rater les variations
 * hebdo (CSV peut perdre/gagner ~500 lignes selon les ouvertures/fermetures). */
const MIN_SIZE_BYTES = 1_500_000;

/**
 * Volume cible : ~3 K CDS uniques (CSV dénormalisé par profession exercée
 * = ~8-15K lignes brutes). Bounds 2 K – 5 K post-déduplication par etab_finess.
 *
 * Justification du floor 2K : 5 % des CDS attendus en France selon les
 * publications CNAM 2025. En dessous = troncature CSV ou bug de groupement.
 */
const MIN_CDS = 2_000;
const MAX_CDS = 5_000;

const BATCH_SIZE = 500;

/** Distinct (cp,ville) keys tracked dans le top-N report (memory bound). */
const SAMPLE_CAP = 200;

/**
 * Threshold max d'unmatched_locality. Calibré relativement bas (5 %) car
 * le CSV CDS est plus propre que celui Ameli PS (CSV CNAM curaté plutôt
 * que dump bulk). Au-delà = drift INSEE / régression CSV upstream.
 */
const UNMATCHED_LOCALITY_THRESHOLD = 0.05;

/**
 * Threshold max d'anomalies structurelles (etab_finess invalide, raison
 * sociale vide, CP+ville tous deux manquants). Doit être quasi-zéro sur
 * un CSV CNAM curaté ; 1 % laisse passer une poignée de lignes sales.
 */
const STRUCTURAL_FAIL_THRESHOLD = 0.01;

/**
 * Taux max de booléens en fallback (valeur ni "true" ni "false"). Au-delà =
 * bascule de schéma CNAM probable (`true/false` → `1/0`) : on REFUSE le swap
 * plutôt que de publier une table où `accepte_carte_vitale` est massivement
 * faux (donnée santé métier différenciante). 1 % tolère quelques lignes
 * sales sans hairtrigger ; un drift réel est à ~100 %.
 */
const BOOLEAN_FALLBACK_THRESHOLD = 0.01;

/**
 * Plancher de l'index FINESS chargé pour la résolution commune. La table
 * `finess` prod compte ~80-95K établissements (sync bimestrielle DREES). En
 * dessous = table vide / stale / RLS qui bloque le service_role. Sans ce
 * garde, un index vide ferait silencieusement basculer 100 % des CDS sur le
 * fallback `(cp, ville)` — donc échec en cascade sur les adresses CEDEX —
 * avec un diagnostic trompeur "unmatched_locality" au lieu de "FINESS stale".
 * Calé à 70K (et non 50K) : le steady-state réel est ~80-95K, un plancher
 * trop bas tolère une perte silencieuse de ~45 % avant de crier.
 */
const MIN_FINESS_INDEX = 70_000;

/**
 * Taux max de lignes `finess` fetchées mais sans `code_insee` exploitable.
 * Au-delà = table `finess` partiellement géocodée / colonne INSEE renommée
 * upstream → l'index serait silencieusement sous-dimensionné (et passerait
 * MIN_FINESS_INDEX si la perte est < ~25 %), produisant le diagnostic
 * trompeur "unmatched_locality / CDS source" au lieu de "finess stale".
 * Quasi-zéro attendu (code_insee est NOT NULL dans le schéma `finess`).
 */
const FINESS_NULL_INSEE_THRESHOLD = 0.02;

/**
 * Taux max de CDS dont le `finess.code_insee` existe mais est absent de
 * l'index commune geo.api.gouv (orphan). Distinct de la latence DREES
 * (FINESS pas encore dans la table) : un orphan = vrai désalignement de
 * codification INSEE (fusion de communes, arrondissement non replié,
 * commune sans centre droppée par geo.api). Post-fold arrondissement, ce
 * taux doit être ~0 ; au-delà = le fallback `(cp, ville)` géocode peut-être
 * faux en silence (adresses CEDEX) → on refuse le swap. 1 % tolère le
 * résidu légitime (≈ communes sans centre droppées à l'index).
 */
const ORPHAN_INSEE_THRESHOLD = 0.01;

/**
 * Charge l'index `num_finess → code_insee` depuis la table `finess` déjà
 * ingérée. Sert de résolution commune AUTORITAIRE pour les CDS : tout CDS
 * est un établissement FINESS, et le géocodage DREES (reprojeté Lambert 93 →
 * WGS84 à l'ingestion FINESS) est fiable, contrairement au couple
 * `(code_postal, ville)` du CSV CNAM qui charrie des adresses CEDEX
 * (`DIJON CEDEX` / CP CEDEX `21078`) non matchables contre geo.api.gouv.
 *
 * On ne sélectionne QUE `num_finess, code_insee` (colonnes texte) : pas de
 * `geom`, donc pas de sérialisation hex EWKB PostgREST à gérer. Le centroïde
 * commune est ensuite résolu via `communeIndex.byInsee`.
 *
 * Pagination explicite par `range()` : PostgREST plafonne à 1000 lignes/req.
 */
async function buildFinessInseeMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  const PAGE = 1000;
  const map = new Map<string, string>();
  // Compteurs discriminés (convention repo : jamais un compteur générique).
  // `fetched` = dénominateur du seuil de drop ; `map.size` n'en diffère que
  // par les lignes droppées (num_finess/code_insee nuls). Le fold
  // arrondissement → commune est appliqué côté lookup (parseCdsRecord), pas
  // ici : l'index conserve le code_insee FINESS brut.
  let fetched = 0;
  let droppedNullFiness = 0;
  let droppedNullInsee = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("finess")
      .select("num_finess, code_insee")
      .range(from, from + PAGE - 1);
    if (error) {
      throw new IngestError(
        "pre_validate",
        `FINESS index load failed [code=${error.code ?? "none"}]: ${error.message}`,
        error,
      );
    }
    const rows = (data ?? []) as { num_finess: string; code_insee: string | null }[];
    for (const r of rows) {
      fetched++;
      // CHAR(9)/CHAR(5) prod : PostgREST renvoie le pad d'espaces → trim.
      const nf = r.num_finess?.trim();
      const insee = r.code_insee?.trim();
      if (!nf) {
        droppedNullFiness++;
        continue;
      }
      if (!insee) {
        droppedNullInsee++;
        continue;
      }
      map.set(nf, insee);
    }
    if (rows.length < PAGE) break;
  }
  console.log(
    `[cds] FINESS index: fetched=${fetched}, indexed=${map.size}, dropped(null_finess=${droppedNullFiness}, null_insee=${droppedNullInsee})`,
  );
  // Seuil sur le RATIO de drop (pas la taille finale) : une colonne INSEE
  // partiellement nulle peut laisser `map.size > MIN_FINESS_INDEX` tout en
  // étant un signal de corruption upstream — on refuse plutôt que de
  // produire le diagnostic trompeur "unmatched_locality / CDS source".
  const nullInseeRate = fetched === 0 ? 0 : droppedNullInsee / fetched;
  if (nullInseeRate > FINESS_NULL_INSEE_THRESHOLD) {
    throw new IngestError(
      "pre_validate",
      `FINESS index: ${droppedNullInsee}/${fetched} rows have null code_insee (${(nullInseeRate * 100).toFixed(2)}% > ${(FINESS_NULL_INSEE_THRESHOLD * 100).toFixed(2)}%) — table 'finess' partially geocoded or INSEE column renamed upstream. CDS commune resolution pivots on it; refuse to swap with a silently undersized index.`,
    );
  }
  if (map.size < MIN_FINESS_INDEX) {
    throw new IngestError(
      "pre_validate",
      `FINESS index too small (${map.size} < ${MIN_FINESS_INDEX}) — table 'finess' empty/stale or service_role blocked by RLS. CDS commune resolution pivots on it; refuse to swap a mis-geocoded table.`,
    );
  }
  return map;
}

/**
 * Groupe de toutes les lignes CSV partageant le même etab_finess. Aggrégé
 * en RAM pendant le stream (volume ~3K × ~200 bytes = ~600 KB → safe).
 *
 * Métadonnées (raison_sociale, adresse, type_etab_*, accepte_*) prises sur
 * la PREMIÈRE ligne rencontrée pour ce FINESS — toutes les lignes du même
 * etab_finess les répètent à l'identique selon spec CNAM.
 */
interface CdsAccumulator {
  etab_finess: string;
  etab_raison_sociale: string;
  accepte_carte_vitale: boolean;
  accepte_apcv: boolean;
  type_etab_code: string;
  type_etab_libelle: string;
  telephone: string | null;
  voie: string | null;
  complement_voie: string | null;
  lieu_dit: string | null;
  code_postal: string;
  ville: string;
  code_departement: string;
  code_insee: string | null;
  geom: string | null;
  /**
   * Map specialite_code → libelle. Map plutôt que array pour dédupliquer
   * naturellement le code (le même code peut apparaître 2× sur des lignes
   * voisines selon spec CNAM).
   */
  specialites: Map<string, string>;
}

interface CdsStagingRow {
  etab_finess: string;
  etab_raison_sociale: string;
  accepte_carte_vitale: boolean;
  accepte_apcv: boolean;
  specialites_codes: string[];
  specialites_libelles: string[];
  type_etab_code: string;
  type_etab_libelle: string;
  telephone: string | null;
  voie: string | null;
  complement_voie: string | null;
  lieu_dit: string | null;
  code_postal: string;
  ville: string;
  code_departement: string;
  code_insee: string | null;
  /** EWKT — PostGIS auto-cast geometry(Point, 4326). `null` si commune unmatched. */
  geom: string | null;
  raw: Record<string, never>;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const log: IngestLogEntry = {
    source: "cds",
    started_at: startedAt,
    status: "failed",
    csv_url: CDS_CSV_URL,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    // 1. DOWNLOAD + last checksum en parallèle. Le CSV CDS est petit (~3 Mo)
    // mais regenerated hebdo → un build sans changement clinique produit
    // souvent un CSV byte-identique. Skip économise COPY/VALIDATE/SWAP.
    const [downloaded, lastSha, referenceRows] = await Promise.all([
      downloadCsv(CDS_CSV_URL, "annuaire-sante-ameli-cds.csv"),
      getLastSuccessChecksum("cds"),
      getLastRealIngestRowCount("cds"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    if (await shortCircuitIfSameChecksum(log, lastSha, downloaded.sha256, "cds")) return;

    // 2. PRE-VALIDATE colonnes attendues. Le schéma CDS est plus stable que
    // celui Ameli PS (curaté CNAM) ; on whitelist les 6 colonnes load-bearing.
    await preValidateFile(downloaded.filePath, {
      minSizeBytes: MIN_SIZE_BYTES,
      // CSV CDS : delimiter `;` (WHY BOM : cf. commentaire `bom:` du parser).
      expectedHeaderColumns: [
        "etab_finess",
        "etab_raison_sociale",
        "etab_carte_vitale",
        "specialite_code",
        "type_etab_code",
        "coordonnees_code_postal",
      ],
      delimiter: ";",
    });

    // 3. BUILD COMMUNE INDEX (geo.api.gouv). Wrap pour attribuer un échec
    // à `pre_validate` au lieu de `download` (meilleur diagnostic).
    console.log("[cds] fetching all communes for geocoding…");
    let communes: Awaited<ReturnType<typeof fetchAllCommunes>>;
    try {
      communes = await fetchAllCommunes();
    } catch (err) {
      console.error("[cds] fetchAllCommunes failed:", err);
      throw new IngestError(
        "pre_validate",
        `geo.api.gouv fetchAllCommunes failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    const communeIndex = buildCommuneIndex(communes);
    console.log(
      `[cds] commune index built: ${communes.length} communes, ${communeIndex.byCpAndName.size} (cp,nom) keys`,
    );

    // 4. CREATE STAGING + STREAM
    const supabase = getUntypedServiceClient("cds");
    const { error: stagingErr } = await supabase.rpc("ingest_create_centres_sante_staging");
    if (stagingErr) {
      throw new IngestError(
        "copy",
        `Failed to create centres_sante_staging table: ${stagingErr.message}`,
      );
    }
    // 2s sleep : PostgREST poll schema-change cache. Le retry dans flush()
    // est la 2e ligne de défense pour les misses sous load.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Index FINESS num_finess → code_insee (résolution commune autoritaire,
    // contourne le bruit CEDEX du couple (cp, ville) CSV CNAM). Construit
    // APRÈS la création staging : la table `finess` prod est indépendante,
    // mais on garde l'ordre download → validate → index pour un diagnostic
    // d'échec attribué à la bonne phase.
    console.log("[cds] loading FINESS num_finess → code_insee index…");
    const finessInseeMap = await buildFinessInseeMap(supabase);
    console.log(`[cds] FINESS index loaded: ${finessInseeMap.size} num_finess entries`);

    const stats = await streamCsvAndInsert(
      downloaded.filePath,
      supabase,
      communeIndex,
      finessInseeMap,
    );
    log.row_count = stats.inserted;

    // 5. VALIDATE COHERENCE
    console.log(
      `[cds] insert summary: inserted=${stats.inserted}, raw_rows=${stats.rawRows}, no_finess=${stats.skippedNoFiness}, no_locality=${stats.skippedNoLocality}, unmatched_locality=${stats.skippedUnmatchedLocality}`,
    );
    console.log(
      `[cds] commune resolution: via_finess=${stats.resolvedViaFiness}, fallback_drees_lag=${stats.resolvedViaFallbackDreesLag}, fallback_orphan_insee=${stats.resolvedViaOrphanInsee}`,
    );

    // Garde explicite "total skip" : diagnostic non ambigu indépendant de la
    // valeur de MIN_CDS. Si toutes les lignes ont été skippées (ex: colonne
    // `etab_finess` renommée → 100 % no_finess), `inserted === 0` alors que
    // `rawRows > 0`. Sans ce garde le message serait "below minimum / partial
    // parse" (trompeur — ce n'est pas un parse partiel, c'est un rename total).
    if (stats.inserted === 0 && stats.rawRows > 0) {
      throw new IngestError(
        "validate",
        `Zero CDS accumulated despite rawRows=${stats.rawRows} — total skip, likely upstream column rename (etab_finess?) or format change. Refuse to swap an empty table.`,
      );
    }
    if (stats.inserted < MIN_CDS) {
      throw new IngestError(
        "validate",
        `CDS count ${stats.inserted} below minimum ${MIN_CDS} — suspected partial parse`,
      );
    }
    if (stats.inserted > MAX_CDS) {
      throw new IngestError(
        "validate",
        `CDS count ${stats.inserted} above maximum ${MAX_CDS} — suspected format change (CNAM dénormalisation modifiée?)`,
      );
    }
    // Bande RELATIVE à la dernière ingestion réelle : CDS n'avait AUCUN
    // plancher calibré sur le réel (2 000 pour ~2 500 centres).
    assertStagingRowBand(stats.inserted, referenceRows, "cds");

    const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
    // Denominator = lignes brutes CSV (skip uniques + groupées CDS uniques).
    // Évite division par zéro défensive (cf. lesson Ameli V0.4 belt-and-braces).
    const denominator = stats.rawRows;
    if (denominator === 0) {
      throw new IngestError(
        "validate",
        "Pipeline produced zero parser events (rawRows=0). Likely upstream parser regression — refuse to swap an empty table into prod.",
      );
    }
    const rateOf = (failures: number) => failures / denominator;

    const structuralFailures = stats.skippedNoFiness + stats.skippedNoLocality;
    const structuralRate = rateOf(structuralFailures);
    const unmatchedRate = rateOf(stats.skippedUnmatchedLocality);

    if (structuralFailures > 0) {
      console.warn(
        `[cds] structural skips: ${stats.skippedNoFiness} no_finess, ${stats.skippedNoLocality} no_locality (${fmt(structuralRate)} of raw rows)`,
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
        `[cds] unmatched localities: ${stats.skippedUnmatchedLocality} (${fmt(unmatchedRate)}). Top: ${topUnmatched}`,
      );
      if (stats.unmatchedDistinctKeysDropped > 0) {
        console.warn(
          `[cds] sample cap saturated: ${stats.unmatchedDistinctKeysDropped} distinct unmatched (cp,ville) keys not tracked.`,
        );
      }
      if (unmatchedRate > UNMATCHED_LOCALITY_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Unmatched-locality rate ${fmt(unmatchedRate)} above ${fmt(UNMATCHED_LOCALITY_THRESHOLD)} — these CDS are absent from the FINESS table (DREES sync lag) AND their (cp, ville) is not matchable via fallback (CEDEX address, typo, or geo.api.gouv drift). Check FINESS ingestion freshness first, then the CDS source format.`,
        );
      }
    }

    // Garde drift booléen : 2 booléens parsés / ligne acc. Un taux de fallback
    // élevé = bascule de schéma CNAM (`true/false` → `1/0`) → on refuse le
    // swap plutôt que de publier `accepte_carte_vitale` massivement faux.
    // Non couvert par STRUCTURAL_FAIL_THRESHOLD (les lignes ne sont pas
    // skippées). `booleanParsedLines === 0` impossible ici (MIN_CDS déjà
    // validé > 0 plus haut) mais on garde la division défensive.
    const booleanChecks = stats.booleanParsedLines * 2;
    if (booleanChecks > 0 && stats.booleanParseFallbacks > 0) {
      const booleanFallbackRate = stats.booleanParseFallbacks / booleanChecks;
      console.warn(
        `[cds] boolean fallbacks: ${stats.booleanParseFallbacks}/${booleanChecks} (${fmt(booleanFallbackRate)})`,
      );
      if (booleanFallbackRate > BOOLEAN_FALLBACK_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Boolean fallback rate ${fmt(booleanFallbackRate)} above ${fmt(BOOLEAN_FALLBACK_THRESHOLD)} — suspected CNAM schema drift on etab_carte_vitale/etab_apcv (true/false → 1/0?). Refuse to swap a table with massively wrong carte_vitale data.`,
        );
      }
    }

    // Garde orphan-INSEE : un FINESS présent dont le code_insee est absent
    // de l'index commune est tombé en fallback `(cp, ville)` — qui peut mal
    // géocoder une adresse CEDEX en silence. Quasi-zéro attendu post-fold
    // arrondissement ; un taux élevé = désalignement de codification INSEE
    // (fusion de communes, geo.api.gouv drift) → on refuse le swap. Distinct
    // de fallback_drees_lag (bénin, non thresholdé). Dénominateur = CDS
    // uniques résolus (= stats.inserted), pas rawRows.
    const resolvedTotal =
      stats.resolvedViaFiness + stats.resolvedViaFallbackDreesLag + stats.resolvedViaOrphanInsee;
    if (stats.resolvedViaOrphanInsee > 0 && resolvedTotal > 0) {
      const orphanRate = stats.resolvedViaOrphanInsee / resolvedTotal;
      console.warn(
        `[cds] orphan-insee fallbacks: ${stats.resolvedViaOrphanInsee}/${resolvedTotal} (${fmt(orphanRate)})`,
      );
      if (orphanRate > ORPHAN_INSEE_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Orphan-INSEE rate ${fmt(orphanRate)} above ${fmt(ORPHAN_INSEE_THRESHOLD)} — ${stats.resolvedViaOrphanInsee} CDS have a FINESS code_insee absent from the geo.api.gouv commune index (arrondissement not folded, INSEE commune fusion, or geo.api drift). The (cp, ville) fallback may silently mis-geocode CEDEX addresses. Refuse to swap.`,
        );
      }
    }

    // 6. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "centres_sante" });

    // 6b. CANARY POST-SWAP — non-bloquant (swap déjà commité). Aucune cible
    // 'cds' seedée tant que les vrais etab_finess notoires ne sont pas
    // connus → le RPC retourne [] (canary inactif sans bruit, cf. migration
    // 20260515T010200). Activera réellement après _canary_cds_real_seeds.
    await runAndRecordCanary(supabase, "cds", log, "cds");

    // SUCCESS
    log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "cds");
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(
      `[cds] success: ${stats.inserted} CDS ingested (raw=${stats.rawRows}) in ${elapsedSec}s`,
    );
  } catch (err) {
    console.error("[cds] ingestion failed:", err);
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
    await writeIngestLogFailureFallback(log, "cds");
    console.error(`[cds] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

interface CdsStreamStats {
  /** Nombre de CDS uniques insérés en staging (post-groupement par etab_finess). */
  inserted: number;
  /** Nombre total de lignes CSV consommées (avant dédup). */
  rawRows: number;
  /** Lignes CSV sans etab_finess valide (9 chiffres). Anomalie structurelle. */
  skippedNoFiness: number;
  /** Lignes CSV sans CP ni ville. Anomalie structurelle. */
  skippedNoLocality: number;
  /**
   * Lignes CSV dont la commune n'a pu être résolue ni via le pivot FINESS
   * ni via le fallback `(cp, ville)`. Signal d'un CDS absent de la table
   * FINESS (latence DREES) ET d'une adresse non matchable (CEDEX, typo).
   */
  skippedUnmatchedLocality: number;
  /** CDS dont la commune a été résolue via le pivot FINESS (chemin nominal). */
  resolvedViaFiness: number;
  /** CDS résolus via fallback `(cp, ville)` car FINESS absent (latence DREES, bénin). */
  resolvedViaFallbackDreesLag: number;
  /**
   * CDS résolus via fallback alors que le FINESS est PRÉSENT mais son
   * code_insee est orphelin de l'index commune. Anomalie thresholdée
   * (`ORPHAN_INSEE_THRESHOLD`) : le fallback peut mal géocoder une CEDEX.
   */
  resolvedViaOrphanInsee: number;
  unmatchedSampleCounts: Map<string, number>;
  unmatchedDistinctKeysDropped: number;
  /** Total de booléens tombés en fallback (ni "true" ni "false"). */
  booleanParseFallbacks: number;
  /** Lignes ayant atteint le boolean-parse (2 booléens chacune = dénominateur). */
  booleanParsedLines: number;
}

const NUM_FINESS_PATTERN = /^\d{9}$/;

async function streamCsvAndInsert(
  filePath: string,
  supabase: SupabaseClient,
  index: CommuneIndex,
  finessInseeMap: Map<string, string>,
): Promise<CdsStreamStats> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });

  const parser = stream.pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      // CDS CSV n'a pas de BOM (différent d'Ameli PS qui en a un). `bom: true`
      // strip le BOM si présent — safe à laisser activé.
      bom: true,
    }),
  );

  // Aggregator par etab_finess. Volume max ~3K CDS × ~200 bytes = ~600 KB.
  const accumulators = new Map<string, CdsAccumulator>();
  let rawRows = 0;
  let skippedNoFiness = 0;
  let skippedNoLocality = 0;
  let skippedUnmatchedLocality = 0;
  // Compté par CDS unique (1ère occurrence de l'etab_finess), pas par ligne
  // brute : resolvedVia est une propriété de l'établissement, constante sur
  // toutes ses lignes spécialité.
  let resolvedViaFiness = 0;
  let resolvedViaFallbackDreesLag = 0;
  let resolvedViaOrphanInsee = 0;
  let unmatchedDistinctKeysDropped = 0;
  // Comptage du drift booléen : numérateur (fallbacks) + dénominateur
  // (lignes ayant atteint le boolean-parse, soit 2 booléens / ligne acc).
  let booleanParseFallbacks = 0;
  let booleanParsedLines = 0;
  const unmatchedSampleCounts = new Map<string, number>();

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    rawRows++;
    const parsed = parseCdsRecord(record, index, finessInseeMap);
    if (parsed.acc) {
      booleanParseFallbacks += parsed.booleanFallbacks;
      booleanParsedLines++;
      const existing = accumulators.get(parsed.acc.etab_finess);
      if (existing) {
        // CDS déjà vu : merge specialités. Métadonnées identiques par contrat
        // CNAM — on ne re-vérifie pas (économie compute, lesson V0.4).
        for (const [code, libelle] of parsed.acc.specialites) {
          existing.specialites.set(code, libelle);
        }
      } else {
        accumulators.set(parsed.acc.etab_finess, parsed.acc);
        if (parsed.resolvedVia === "finess") resolvedViaFiness++;
        else if (parsed.resolvedVia === "fallback_orphan_insee") resolvedViaOrphanInsee++;
        else resolvedViaFallbackDreesLag++;
      }
    } else {
      const reason = parsed.skipReason;
      switch (reason) {
        case "no_finess":
          skippedNoFiness++;
          break;
        case "no_locality":
          skippedNoLocality++;
          break;
        case "unmatched_locality": {
          skippedUnmatchedLocality++;
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
  }

  // Convert accumulators → staging rows. Tri stable specialites_codes pour
  // déduplication idempotente (deux ingestions du même CSV doivent produire
  // le même array — sinon comparaisons inter-runs cassent).
  const rows: CdsStagingRow[] = [];
  for (const acc of accumulators.values()) {
    const sortedCodes = [...acc.specialites.keys()].sort();
    rows.push({
      etab_finess: acc.etab_finess,
      etab_raison_sociale: acc.etab_raison_sociale,
      accepte_carte_vitale: acc.accepte_carte_vitale,
      accepte_apcv: acc.accepte_apcv,
      specialites_codes: sortedCodes,
      // Aligner libellés sur l'ordre des codes triés — sinon `codes[i]`
      // ne correspond plus à `libelles[i]` côté lecture.
      specialites_libelles: sortedCodes.map((c) => acc.specialites.get(c) ?? ""),
      type_etab_code: acc.type_etab_code,
      type_etab_libelle: acc.type_etab_libelle,
      telephone: acc.telephone,
      voie: acc.voie,
      complement_voie: acc.complement_voie,
      lieu_dit: acc.lieu_dit,
      code_postal: acc.code_postal,
      ville: acc.ville,
      code_departement: acc.code_departement,
      code_insee: acc.code_insee,
      geom: acc.geom,
      raw: {},
    });
  }

  // Insert batched : retry schema-cache miss factorisé dans shared.ts
  // (`insertStagingBatchWithRetry`) — seul le 1er batch retry.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await insertStagingBatchWithRetry(supabase, "centres_sante_staging", batch, {
      logPrefix: "cds",
      isFirstBatch: i === 0,
    });
    inserted += batch.length;
  }

  return {
    inserted,
    rawRows,
    skippedNoFiness,
    skippedNoLocality,
    skippedUnmatchedLocality,
    resolvedViaFiness,
    resolvedViaFallbackDreesLag,
    resolvedViaOrphanInsee,
    unmatchedSampleCounts,
    unmatchedDistinctKeysDropped,
    booleanParseFallbacks,
    booleanParsedLines,
  };
}

type SkipReason = "no_finess" | "no_locality" | "unmatched_locality";

/**
 * Voie de résolution de la commune (code_insee/dept/geom) :
 *  - `finess` : pivot FINESS (nominal)
 *  - `fallback_drees_lag` : FINESS absent de la table (latence sync DREES) →
 *    fallback `(cp, ville)`. Bénin.
 *  - `fallback_orphan_insee` : FINESS présent mais son code_insee est absent
 *    de l'index commune (désalignement codification) → fallback `(cp, ville)`,
 *    potentiellement mal géocodé sur adresse CEDEX. Anomalie, thresholdée.
 */
type ResolvedVia = "finess" | "fallback_drees_lag" | "fallback_orphan_insee";

type ParsedCdsRow =
  | {
      acc: CdsAccumulator;
      /** Nombre de booléens (0..2) tombés en fallback faute de "true"/"false". */
      booleanFallbacks: number;
      /** Pivot FINESS (nominal) ou fallback texte `(cp, ville)`. */
      resolvedVia: ResolvedVia;
      skipReason?: never;
      sampleKey?: never;
    }
  | {
      acc?: never;
      booleanFallbacks?: never;
      resolvedVia?: never;
      skipReason: Exclude<SkipReason, "unmatched_locality">;
      sampleKey?: never;
    }
  | {
      acc?: never;
      booleanFallbacks?: never;
      resolvedVia?: never;
      skipReason: "unmatched_locality";
      sampleKey: string;
    };

/**
 * Parse 1 ligne CSV CDS en accumulator (1 row par etab_finess). Le caller
 * merge les accumulators du même etab_finess (specialités). Failures
 * structurelles → skipReason countable + threshold-aborted.
 *
 * Pitfall CSV CNAM (cf. recherche agent V0.10) :
 *   - `etab_finess` 9 chars avec leading zeros : forcer `string` (csv-parse
 *     ne convertit pas en number par défaut, mais defense-in-depth).
 *   - Code 125 (CDS dentaire) deprecated : stocké tel quel, normalisation
 *     côté caller MCP si pertinent.
 *   - `etab_carte_vitale` / `etab_apcv` : "true" / "false" texte → BOOLEAN.
 *     Toute autre valeur (vide, "1", "yes") → false par défaut + warn ?
 *     Décision V0.10 : strict — `null`/empty → ingest échoue (anomalie),
 *     "true"/"false" only.
 */
export function parseCdsRecord(
  rec: Record<string, string>,
  index: CommuneIndex,
  // Défaut = Map vide → chemin fallback `(cp, ville)`. Sucre de test
  // uniquement : la prod passe TOUJOURS un index explicite via
  // `streamCsvAndInsert`, et `buildFinessInseeMap`/MIN_FINESS_INDEX garde
  // contre un index réellement vide en amont.
  finessInseeMap: Map<string, string> = new Map(),
): ParsedCdsRow {
  const etabFinessRaw = getNonEmpty(rec, "etab_finess");
  if (!etabFinessRaw) return { skipReason: "no_finess" };
  // Defense-in-depth : trim + validate 9 digits exact. Préserve les leading
  // zeros (le CSV est string-typed, mais un futur preprocessor JS pourrait
  // les perdre via Number conversion).
  const etabFiness = etabFinessRaw.trim();
  if (!NUM_FINESS_PATTERN.test(etabFiness)) return { skipReason: "no_finess" };

  // CP + ville restent requis : le schéma `centres_sante` impose
  // `code_postal CHAR(5) NOT NULL` + `ville TEXT NOT NULL` (adresse réelle
  // du centre, affichée côté MCP). Le pivot FINESS ne sert qu'à fiabiliser
  // le géocodage (code_insee/dept/geom), pas à suppléer l'adresse.
  const codePostalRaw = getNonEmpty(rec, "coordonnees_code_postal");
  const villeRaw = getNonEmpty(rec, "coordonnees_ville");
  if (!codePostalRaw || !villeRaw) return { skipReason: "no_locality" };

  // Résolution commune : 1) pivot FINESS autoritaire (tout CDS est un
  // établissement FINESS au géocodage DREES fiable, immunisé contre les
  // adresses CEDEX) → 2) fallback texte `(cp, ville)`. Le fallback est
  // discriminé : FINESS absent de la table (latence DREES, bénin) vs
  // code_insee FINESS orphelin de l'index commune (désalignement, anomalie
  // thresholdée car le fallback peut mal géocoder une adresse CEDEX).
  // Fold arrondissement → commune parente : finess porte l'INSEE
  // arrondissement (75112 = Paris 12e) que geo.api.gouv `/communes` n'expose
  // pas (il ne connaît que 75056). Sans ce fold, 100 % des CDS de Paris /
  // Lyon / Marseille (où ils sont les plus concentrés) ratent le pivot.
  const inseeFromFiness = finessInseeMap.get(etabFiness);
  const finessMatch: IndexedCommune | null = inseeFromFiness
    ? (index.byInsee.get(parentCommuneInsee(inseeFromFiness)) ?? null)
    : null;
  const matched = finessMatch ?? matchCommune(index, codePostalRaw, villeRaw);
  if (!matched) {
    return {
      skipReason: "unmatched_locality",
      sampleKey: `${codePostalRaw}|${villeRaw}`,
    };
  }
  let resolvedVia: ResolvedVia;
  if (finessMatch) resolvedVia = "finess";
  else if (inseeFromFiness) resolvedVia = "fallback_orphan_insee";
  else resolvedVia = "fallback_drees_lag";

  // Boolean parsing : une régression schema CNAM (bascule "true"/"false" →
  // "1"/"0") doit faire ÉCHOUER le swap, pas produire des `false` silencieux.
  // `parseStrictBoolean` signale chaque fallback ; le total est thresholdé
  // dans `main()` (BOOLEAN_FALLBACK_THRESHOLD) AVANT le swap atomique.
  const carteVitale = parseStrictBoolean(rec, "etab_carte_vitale");
  const apcv = parseStrictBoolean(rec, "etab_apcv");
  const booleanFallbacks = (carteVitale.isFallback ? 1 : 0) + (apcv.isFallback ? 1 : 0);

  const specialiteCode = getNonEmpty(rec, "specialite_code") ?? "_unknown_";
  const specialiteLibelle = getNonEmpty(rec, "specialite_libelle") ?? "Spécialité non renseignée";

  const typeEtabCode = getNonEmpty(rec, "type_etab_code") ?? CDS_TYPE_ETAB.STANDARD;
  const typeEtabLibelle = getNonEmpty(rec, "type_etab_libelle") ?? "Centre de santé";

  const geom = `SRID=4326;POINT(${matched.lon} ${matched.lat})`;

  const acc: CdsAccumulator = {
    etab_finess: etabFiness,
    etab_raison_sociale: getNonEmpty(rec, "etab_raison_sociale") ?? "Centre de santé",
    accepte_carte_vitale: carteVitale.value,
    accepte_apcv: apcv.value,
    type_etab_code: typeEtabCode,
    type_etab_libelle: typeEtabLibelle,
    telephone: getNonEmpty(rec, "coordonnees_num_tel"),
    voie: getNonEmpty(rec, "coordonnees_voie"),
    complement_voie: getNonEmpty(rec, "coordonnees_complement"),
    lieu_dit: getNonEmpty(rec, "coordonnees_lieu_dit"),
    // CHAR(5) prod : trim avant slice pour éviter pad-storage de " 7500" → "75001".
    code_postal: codePostalRaw.trim().slice(0, 5),
    ville: villeRaw,
    code_departement: matched.codeDepartement,
    code_insee: matched.codeInsee,
    geom,
    specialites: new Map([[specialiteCode, specialiteLibelle]]),
  };
  return { acc, booleanFallbacks, resolvedVia };
}

/**
 * Parse strict d'un boolean CSV CNAM. "true" / "false" only (case-insensitive).
 *
 * `isFallback: true` quand la valeur n'est NI "true" NI "false" (vide, "1",
 * "0", "oui", null). On retourne `false` par sécurité MAIS on signale le
 * fallback : le caller agrège ces fallbacks et `main()` REFUSE LE SWAP si le
 * taux dépasse `BOOLEAN_FALLBACK_THRESHOLD`. Sans ce comptage, une bascule
 * de schéma CNAM `true/false` → `1/0` produirait 100 % de CDS avec
 * `accepte_carte_vitale=false` (donnée santé métier différenciante corrompue)
 * SANS déclencher `STRUCTURAL_FAIL_THRESHOLD` (les lignes ne sont pas
 * skippées) — le silent failure exact que la règle CLAUDE.md interdit.
 */
function parseStrictBoolean(
  rec: Record<string, string>,
  key: string,
): { value: boolean; isFallback: boolean } {
  const raw = getNonEmpty(rec, key);
  if (raw === null) return { value: false, isFallback: true };
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return { value: true, isFallback: false };
  if (normalized === "false") return { value: false, isFallback: false };
  console.warn(
    `[cds] parseStrictBoolean(${key}): unexpected value "${raw}" — defaulting to false (CNAM schema drift? thresholded before swap)`,
  );
  return { value: false, isFallback: true };
}

export const __TESTING__ = { parseCdsRecord, parseStrictBoolean };

await runIfMain(import.meta.url, main);
