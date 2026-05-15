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
  preValidateFile,
  runAndRecordCanary,
  runIfMain,
  safeSerializeIngestLog,
  shortCircuitIfSameChecksum,
  writeIngestLog,
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
    const [downloaded, lastSha] = await Promise.all([
      downloadCsv(CDS_CSV_URL, "annuaire-sante-ameli-cds.csv"),
      getLastSuccessChecksum("cds"),
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

    const stats = await streamCsvAndInsert(downloaded.filePath, supabase, communeIndex);
    log.row_count = stats.inserted;

    // 5. VALIDATE COHERENCE
    console.log(
      `[cds] insert summary: inserted=${stats.inserted}, raw_rows=${stats.rawRows}, no_finess=${stats.skippedNoFiness}, no_locality=${stats.skippedNoLocality}, unmatched_locality=${stats.skippedUnmatchedLocality}`,
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
          `Unmatched-locality rate ${fmt(unmatchedRate)} above ${fmt(UNMATCHED_LOCALITY_THRESHOLD)} — likely INSEE commune drift; refresh geo.api.gouv index or update CDS source`,
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
    await writeIngestLog(log);
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
    // Émettre le fallback stderr AVANT writeIngestLog : si la DB est la cause
    // racine de l'échec (cas le plus fréquent), getIngestLogClient/insert peut
    // throw et court-circuiterait tout ce qui suit, faisant disparaître la
    // seule trace structurée que le script auto-issue grep. Ordre = survie.
    console.error(`[cds][ingest_log_fallback] ${safeSerializeIngestLog(log)}`);
    console.error(`[cds] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    try {
      await writeIngestLog(log);
    } catch (logErr) {
      // writeIngestLog catch déjà les erreurs Supabase formatées ; un throw ici
      // = getIngestLogClient (env absente) ou exception réseau brute. On le
      // signale sans laisser une UnhandledRejection avaler le process.exit(1).
      console.error(
        `[cds] writeIngestLog threw (DB likely the root cause): ${logErr instanceof Error ? logErr.message : String(logErr)}`,
      );
    }
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
  /** Lignes CSV avec CP+ville mais commune introuvable dans geo.api. Drift upstream. */
  skippedUnmatchedLocality: number;
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
  let unmatchedDistinctKeysDropped = 0;
  // Comptage du drift booléen : numérateur (fallbacks) + dénominateur
  // (lignes ayant atteint le boolean-parse, soit 2 booléens / ligne acc).
  let booleanParseFallbacks = 0;
  let booleanParsedLines = 0;
  const unmatchedSampleCounts = new Map<string, number>();

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    rawRows++;
    const parsed = parseCdsRecord(record, index);
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

  // Insert batched. Aligné sur ameli.ts : seul le 1er batch retry sur
  // schema-cache miss PostgREST (PGRST205) — le 2s sleep amont couvre le cas
  // courant, le retry est le 2e filet sous load. Les batchs suivants ne
  // retry pas (la table est forcément en cache une fois le 1er passé).
  const isSchemaCacheMiss = (err: { code?: string } | null): boolean => err?.code === "PGRST205";
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const isFirstBatch = i === 0;
    const maxAttempts = isFirstBatch ? 4 : 1;
    let lastErr: { message: string; code?: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const wait = 2000 * attempt;
        console.warn(`[cds] schema cache miss, retry ${attempt}/${maxAttempts - 1} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
      const { error } = await supabase.from("centres_sante_staging").insert(batch);
      if (!error) {
        lastErr = null;
        break;
      }
      lastErr = error;
      if (!isSchemaCacheMiss(error)) break;
    }
    if (lastErr) {
      console.error("[cds] insert into centres_sante_staging failed:", lastErr);
      throw new IngestError(
        "copy",
        `Insert into centres_sante_staging failed [code=${lastErr.code ?? "none"}]: ${lastErr.message}`,
        lastErr,
      );
    }
    inserted += batch.length;
  }

  return {
    inserted,
    rawRows,
    skippedNoFiness,
    skippedNoLocality,
    skippedUnmatchedLocality,
    unmatchedSampleCounts,
    unmatchedDistinctKeysDropped,
    booleanParseFallbacks,
    booleanParsedLines,
  };
}

type SkipReason = "no_finess" | "no_locality" | "unmatched_locality";

type ParsedCdsRow =
  | {
      acc: CdsAccumulator;
      /** Nombre de booléens (0..2) tombés en fallback faute de "true"/"false". */
      booleanFallbacks: number;
      skipReason?: never;
      sampleKey?: never;
    }
  | {
      acc?: never;
      booleanFallbacks?: never;
      skipReason: Exclude<SkipReason, "unmatched_locality">;
      sampleKey?: never;
    }
  | { acc?: never; booleanFallbacks?: never; skipReason: "unmatched_locality"; sampleKey: string };

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
export function parseCdsRecord(rec: Record<string, string>, index: CommuneIndex): ParsedCdsRow {
  const etabFinessRaw = getNonEmpty(rec, "etab_finess");
  if (!etabFinessRaw) return { skipReason: "no_finess" };
  // Defense-in-depth : trim + validate 9 digits exact. Préserve les leading
  // zeros (le CSV est string-typed, mais un futur preprocessor JS pourrait
  // les perdre via Number conversion).
  const etabFiness = etabFinessRaw.trim();
  if (!NUM_FINESS_PATTERN.test(etabFiness)) return { skipReason: "no_finess" };

  const codePostalRaw = getNonEmpty(rec, "coordonnees_code_postal");
  const villeRaw = getNonEmpty(rec, "coordonnees_ville");
  if (!codePostalRaw || !villeRaw) return { skipReason: "no_locality" };

  const matched: IndexedCommune | null = matchCommune(index, codePostalRaw, villeRaw);
  if (!matched) {
    return {
      skipReason: "unmatched_locality",
      sampleKey: `${codePostalRaw}|${villeRaw}`,
    };
  }

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
  return { acc, booleanFallbacks };
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
