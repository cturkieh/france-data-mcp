import "./load-env.js";
import * as fs from "node:fs";
import { parse } from "csv-parse";
import {
  MOIS_PAR_AN,
  SITADEL_TYPE_LGT_TOTAL,
  SITADEL_YEARS_BACK,
} from "../../src/immobilier/sitadel.js";
import { COMMUNE_INSEE_PATTERN } from "../../src/territoire/commune-index.js";
import {
  IngestError,
  type IngestLogEntry,
  appendLogMessage,
  assertStagingRowBand,
  atomicSwapTables,
  downloadCsv,
  getLastRealIngestRowCount,
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

// Sit@del — logements autorisés/commencés, séries mensuelles communales (SDES,
// API DiDo). Cf. docs/plans/sitadel-ingestion.md pour les mesures du 2026-09-21.
//
// Le fichier national COMPLET fait 29 M lignes / ~1,3 Go (tous types de
// logement depuis 2013) → on laisse DiDo filtrer côté serveur : « Tous
// Logements » (les sous-types double-compteraient) + fenêtre glissante. Mesuré :
// 2,34 M lignes / 107 Mo / 97 s sur 6 années, puis agrégation en 1,7 s. Depuis
// qu'on demande une 7e année de marge (cf. `buildSitadelUrl`) : 2,76 M lignes,
// 636 mois en double, 133 s de run complet (mesuré 2026-09-22).
export const DIDO_DATAFILE_URL =
  "https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles/577a8a66-4157-4787-b00a-031b61afea61/csv";

/** Filtré serveur : 107 Mo mesurés. 50 Mo de plancher = troncature franche. */
const MIN_SIZE_BYTES = 50_000_000;

/**
 * Communes attendues : 34 945 à 34 969 selon l'année (mesuré 2026-09-21, la
 * baisse suit les fusions de communes). Bande large mais qui refuse un fichier
 * amputé d'une région ou un changement de maille (arrondissements, EPCI).
 */
const MIN_COMMUNES = 33_000;
const MAX_COMMUNES = 37_000;

/**
 * Logements autorisés France entière sur une année PLEINE : 336 671 (2024) à
 * 488 672 (2022) mesurés. Hors [150 K, 900 K] = colonne décalée, unité changée
 * ou filtre « Tous Logements » cassé (les sous-types doubleraient le total).
 */
const MIN_NATIONAL_AUT_FULL_YEAR = 150_000;
const MAX_NATIONAL_AUT_FULL_YEAR = 900_000;

/** Part max de lignes illisibles (code INSEE, année, mois ou compte invalide). */
const STRUCTURAL_FAIL_THRESHOLD = 0.001;

/**
 * Retard max du dernier mois publié, en mois. SDES publie le mois M vers la fin
 * de M+1 (mesuré : juillet 2026 servi le 21 septembre). Au-delà de 4 mois la
 * série est figée côté source (leçon FINESS/DREES : une source tarie ne doit
 * jamais passer pour un succès). Verdict `partial`, PAS `failed` : on publie
 * quand même le fichier (il peut porter des révisions des mois passés), et la
 * vigie `notify-ingest-anomaly` ouvre UNE issue idempotente — un `failed`
 * mensuel rouvrirait une issue et un email à chaque cron, indéfiniment.
 */
const MAX_LAST_MONTH_LAG = 4;

/**
 * Plafond de (commune, année, mois) vus plus d'une fois. Mesuré : 504 sur
 * 2,34 M (communes fusionnées recodées sous un même INSEE). C'est le SEUL témoin
 * d'une série republiée en double par le SDES : les totaux doubleraient alors
 * que volume, communes, `mois_couverts` (OR de bits) et même la bande nationale
 * (336 K × 2 = 673 K < 900 K) resteraient verts. 10× le mesuré.
 */
const MAX_DUPLICATE_MONTHS = 5_000;

/** Lignes illisibles : 0 mesuré. Au-delà de ce nombre le run est `partial`. */
const INVALID_ROWS_PARTIAL = 100;

/**
 * Part max de lignes (commune, année PLEINE) n'ayant pas leurs 12 mois. Mesuré :
 * 0 sur 174 780. Un fichier amputé de mois en milieu de série passerait TOUTES
 * les autres gardes en sous-comptant en silence — c'est la raison d'être de
 * `mois_couverts`. 1 % tolère des communes créées en cours d'année.
 */
const INCOMPLETE_FULL_YEAR_THRESHOLD = 0.01;

const BATCH_SIZE = 5_000;

/**
 * On demande UNE ANNÉE DE PLUS que la fenêtre stockée : la fenêtre est ancrée
 * sur le dernier mois PUBLIÉ, pas sur l'horloge (cf. `aggregateSitadelRecords`).
 * Le SDES publie le mois M vers fin M+1 → en janvier et février l'année civile
 * courante n'existe pas encore dans le flux. Une fenêtre calée sur l'horloge
 * perdrait une étiquette d'année le 10 janvier (−17 % de lignes) :
 * `assertStagingRowBand` refuserait le swap deux crons de suite, chaque année.
 */
export function buildSitadelUrl(currentYear: number): string {
  const params = new URLSearchParams({
    withColumnName: "true",
    TYPE_LGT: `eq:${SITADEL_TYPE_LGT_TOTAL}`,
    ANNEE: `gte:${currentYear - SITADEL_YEARS_BACK - 1}`,
  });
  return `${DIDO_DATAFILE_URL}?${params.toString()}`;
}

export interface SitadelStagingRow {
  code_insee: string;
  annee: number;
  log_aut: number;
  log_com: number;
  mois_couverts: number;
}

/** Ligne en cours d'agrégation : la ligne de sortie + le bitmask des mois vus (bit m-1). */
type Accumulator = Omit<SitadelStagingRow, "mois_couverts"> & { months: number };

export interface SitadelAggregate {
  rows: SitadelStagingRow[];
  rawRows: number;
  /** Lignes d'un autre TYPE_LGT (le filtre serveur a cessé d'opérer). */
  skippedOtherType: number;
  skippedInvalid: number;
  /**
   * Lignes (commune, année, mois) vues plus d'une fois — communes fusionnées
   * recodées sous un même INSEE (~20/an mesurés). SOMMÉES, comme le faisait
   * l'appel live : c'est la parité, pas une anomalie.
   */
  duplicateMonths: number;
  communes: number;
  /**
   * Dernier mois PUBLIÉ, ex. `{ annee: 2026, mois: 7 }` : le plus récent porté
   * par au moins la moitié des lignes du mois le plus fourni. Jamais un max sur
   * une ligne isolée — un seul permis mal daté (`ANNEE=2030`) déplacerait la
   * fenêtre, ferait juger 2026 « année pleine amputée » et rendrait muette la
   * garde « source tarie » (retard négatif).
   */
  lastMonth: { annee: number; mois: number } | null;
  /** Lignes agrégées hors fenêtre `[lastMonth.annee − 5, lastMonth.annee]`, non stockées. */
  outOfWindowRows: number;
  nationalAutByYear: Map<number, number>;
}

const COUNT_PATTERN = /^[0-9]+$/;

const popcount12 = (mask: number): number => {
  let n = 0;
  for (let m = 0; m < 12; m++) if (mask & (1 << m)) n++;
  return n;
};

/**
 * Agrège un flux de lignes DiDo en (commune, année). Pur (testable sans
 * fichier) : `streamSitadelCsv` n'est que l'adaptateur csv-parse.
 */
export async function aggregateSitadelRecords(
  records: AsyncIterable<Record<string, string>> | Iterable<Record<string, string>>,
): Promise<SitadelAggregate> {
  const acc = new Map<string, Accumulator>();
  let rawRows = 0;
  let skippedOtherType = 0;
  let skippedInvalid = 0;
  let duplicateMonths = 0;
  /** Lignes brutes par mois, clé `annee * 100 + mois`. */
  const rowsByMonth = new Map<number, number>();

  for await (const rec of records) {
    rawRows++;
    if ((rec.TYPE_LGT ?? "") !== SITADEL_TYPE_LGT_TOTAL) {
      skippedOtherType++;
      continue;
    }
    const insee = (rec.CODE_INSEE ?? "").trim();
    const annee = Number(rec.ANNEE);
    const mois = Number(rec.MOIS);
    const autRaw = (rec.LOG_AUT ?? "").trim();
    const comRaw = (rec.LOG_COM ?? "").trim();
    if (
      !COMMUNE_INSEE_PATTERN.test(insee) ||
      !Number.isInteger(annee) ||
      annee < 2000 ||
      annee > 2100 ||
      !Number.isInteger(mois) ||
      mois < 1 ||
      mois > 12 ||
      !COUNT_PATTERN.test(autRaw) ||
      !COUNT_PATTERN.test(comRaw)
    ) {
      skippedInvalid++;
      continue;
    }
    const aut = Number(autRaw);
    const com = Number(comRaw);
    const key = `${insee}|${annee}`;
    const bit = 1 << (mois - 1);
    const existing = acc.get(key);
    if (existing) {
      if (existing.months & bit) duplicateMonths++;
      existing.log_aut += aut;
      existing.log_com += com;
      existing.months |= bit;
    } else {
      acc.set(key, { code_insee: insee, annee, log_aut: aut, log_com: com, months: bit });
    }
    const monthKey = annee * 100 + mois;
    rowsByMonth.set(monthKey, (rowsByMonth.get(monthKey) ?? 0) + 1);
  }

  const fullest = Math.max(0, ...rowsByMonth.values());
  const publishedKeys = [...rowsByMonth].filter(([, n]) => n * 2 >= fullest).map(([k]) => k);
  const lastKey = publishedKeys.length > 0 ? Math.max(...publishedKeys) : null;
  const lastMonth =
    lastKey === null ? null : { annee: Math.floor(lastKey / 100), mois: lastKey % 100 };

  // Communes et totaux nationaux DÉRIVÉS de l'agrégat (210 K lignes), pas
  // recalculés sur chacune des 2,34 M lignes brutes.
  const communes = new Set<string>();
  const nationalAutByYear = new Map<number, number>();
  const rows: SitadelStagingRow[] = [];
  let outOfWindowRows = 0;
  for (const { months, ...row } of acc.values()) {
    // Fenêtre ancrée sur la DONNÉE : volume stable toute l'année civile.
    if (
      lastMonth &&
      (row.annee > lastMonth.annee || row.annee < lastMonth.annee - SITADEL_YEARS_BACK)
    ) {
      outOfWindowRows++;
      continue;
    }
    rows.push({ ...row, mois_couverts: popcount12(months) });
    communes.add(row.code_insee);
    nationalAutByYear.set(row.annee, (nationalAutByYear.get(row.annee) ?? 0) + row.log_aut);
  }
  // Ordre déterministe : deux ingestions du même fichier → mêmes lots.
  rows.sort((x, y) =>
    x.code_insee === y.code_insee ? x.annee - y.annee : x.code_insee < y.code_insee ? -1 : 1,
  );

  return {
    rows,
    rawRows,
    skippedOtherType,
    skippedInvalid,
    duplicateMonths,
    communes: communes.size,
    lastMonth,
    outOfWindowRows,
    nationalAutByYear,
  };
}

/**
 * Série figée côté SDES ? Rend la raison (→ run `partial`), ou `null` si le
 * dernier mois publié est dans la cadence. Pur, `now` injecté pour le test.
 */
export function staleSeriesReason(
  last: NonNullable<SitadelAggregate["lastMonth"]>,
  now: Date,
): string | null {
  const lag = (now.getUTCFullYear() - last.annee) * 12 + (now.getUTCMonth() + 1 - last.mois);
  if (lag <= MAX_LAST_MONTH_LAG) return null;
  return `source tarie : dernier mois publié ${last.annee}-${String(last.mois).padStart(2, "0")} = ${lag} mois de retard (> ${MAX_LAST_MONTH_LAG}) — série Sit@del figée côté SDES`;
}

/**
 * Gardes STRUCTURELLES avant swap, pures, calibrées sur les mesures du
 * 2026-09-21. Throw `IngestError("validate")` au premier refus.
 */
export function validateSitadelAggregate(agg: SitadelAggregate): void {
  function fail(msg: string): never {
    throw new IngestError("validate", msg);
  }
  if (agg.rawRows === 0) {
    fail("Aucune ligne lue (rawRows=0) — réponse DiDo vide ou parser cassé. Swap refusé.");
  }
  if (agg.skippedOtherType > 0) {
    fail(
      `${agg.skippedOtherType} lignes d'un autre TYPE_LGT que « ${SITADEL_TYPE_LGT_TOTAL} » — le filtre serveur DiDo n'opère plus (syntaxe changée ?). Swap refusé : volume et durée ne sont plus ceux mesurés.`,
    );
  }
  const invalidRate = agg.skippedInvalid / agg.rawRows;
  if (invalidRate > STRUCTURAL_FAIL_THRESHOLD) {
    fail(
      `${agg.skippedInvalid}/${agg.rawRows} lignes illisibles (${(invalidRate * 100).toFixed(3)} % > ${STRUCTURAL_FAIL_THRESHOLD * 100} %) — colonne renommée ou format changé côté DiDo.`,
    );
  }
  if (agg.duplicateMonths > MAX_DUPLICATE_MONTHS) {
    fail(
      `${agg.duplicateMonths} (commune, année, mois) vus plus d'une fois (mesuré : 504, plafond ${MAX_DUPLICATE_MONTHS}) — série republiée en double : tous les totaux seraient multipliés sans qu'aucune autre bande ne bouge.`,
    );
  }
  if (agg.communes < MIN_COMMUNES || agg.communes > MAX_COMMUNES) {
    fail(
      `${agg.communes} communes hors [${MIN_COMMUNES}, ${MAX_COMMUNES}] — fichier amputé ou maille changée (arrondissements, EPCI).`,
    );
  }
  const last = agg.lastMonth ?? fail("Aucun mois valide rencontré.");
  // Années PLEINES uniquement (strictement avant celle du dernier mois publié).
  for (const [annee, aut] of agg.nationalAutByYear) {
    if (annee >= last.annee) continue;
    if (aut < MIN_NATIONAL_AUT_FULL_YEAR || aut > MAX_NATIONAL_AUT_FULL_YEAR) {
      fail(
        `Logements autorisés France ${annee} = ${aut} hors [${MIN_NATIONAL_AUT_FULL_YEAR}, ${MAX_NATIONAL_AUT_FULL_YEAR}] — colonne décalée ou double-comptage des sous-types.`,
      );
    }
  }
  const fullYearRows = agg.rows.filter((r) => r.annee < last.annee);
  const incomplete = fullYearRows.filter((r) => r.mois_couverts < MOIS_PAR_AN).length;
  if (incomplete > fullYearRows.length * INCOMPLETE_FULL_YEAR_THRESHOLD) {
    fail(
      `${incomplete}/${fullYearRows.length} lignes d'année pleine sans leurs 12 mois (> ${INCOMPLETE_FULL_YEAR_THRESHOLD * 100} %) — mois manquants en milieu de série : les totaux annuels seraient sous-comptés en silence.`,
    );
  }
}

function streamSitadelCsv(filePath: string): AsyncIterable<Record<string, string>> {
  return fs.createReadStream(filePath, { encoding: "utf8" }).pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }),
  ) as AsyncIterable<Record<string, string>>;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const url = buildSitadelUrl(startedAt.getUTCFullYear());
  const log: IngestLogEntry = {
    source: "sitadel",
    started_at: startedAt.toISOString(),
    status: "failed",
    csv_url: url,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  try {
    // 1. DOWNLOAD (~100 s) + références du dernier run en parallèle.
    const force = isForceReingestEnv(process.env.FORCE_REINGEST);
    const [downloaded, lastSha, referenceRows] = await Promise.all([
      downloadCsv(url, "sitadel-logements-communes.csv"),
      getLastSuccessChecksum("sitadel"),
      getLastRealIngestRowCount("sitadel"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    if (await shortCircuitIfSameChecksum(log, lastSha, downloaded.sha256, "sitadel", force)) return;

    // 2. PRE-VALIDATE
    await preValidateFile(downloaded.filePath, {
      minSizeBytes: MIN_SIZE_BYTES,
      expectedHeaderColumns: ["ANNEE", "MOIS", "CODE_INSEE", "TYPE_LGT", "LOG_AUT", "LOG_COM"],
      delimiter: ";",
    });

    // 3. AGRÉGATION en mémoire (~210 K lignes finales) + gardes AVANT toute écriture.
    const agg = await aggregateSitadelRecords(streamSitadelCsv(downloaded.filePath));
    const last = agg.lastMonth;
    console.log(
      `[sitadel] agrégé : raw=${agg.rawRows}, lignes commune×année=${agg.rows.length}, communes=${agg.communes}, invalides=${agg.skippedInvalid}, mois_en_double=${agg.duplicateMonths}, hors_fenêtre=${agg.outOfWindowRows}, dernier_mois=${last ? `${last.annee}-${String(last.mois).padStart(2, "0")}` : "aucun"}`,
    );
    validateSitadelAggregate(agg);
    assertStagingRowBand(agg.rows.length, referenceRows, "sitadel");

    // 4. STAGING
    const supabase = getUntypedServiceClient("sitadel");
    const { error: stagingErr } = await supabase.rpc("ingest_create_sitadel_logements_staging");
    if (stagingErr) {
      throw new IngestError(
        "copy",
        `Failed to create sitadel_logements_staging table: ${stagingErr.message}`,
        stagingErr,
      );
    }
    // PostgREST recharge son cache de schéma ; le retry du 1er lot est le 2e filet.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    let inserted = 0;
    for (let i = 0; i < agg.rows.length; i += BATCH_SIZE) {
      const batch = agg.rows.slice(i, i + BATCH_SIZE);
      await insertStagingBatchWithRetry(supabase, "sitadel_logements_staging", batch, {
        logPrefix: "sitadel",
        isFirstBatch: i === 0,
      });
      inserted += batch.length;
    }
    log.row_count = inserted;

    // 5. SWAP + canary (canary manquant → `partial`, cf. runAndRecordCanary).
    await atomicSwapTables({ prodTable: "sitadel_logements" });
    await runAndRecordCanary(supabase, "sitadel", log, "sitadel");

    // Sous le seuil de refus mais non nul : le mesuré sain est 0, donc TOUTE
    // ligne jetée atteint l'audit `ingest_log` (pas seulement stdout).
    if (agg.skippedInvalid > 0) {
      appendLogMessage(log, `${agg.skippedInvalid} lignes illisibles ignorées (mesuré sain : 0)`);
      if (agg.skippedInvalid > INVALID_ROWS_PARTIAL) log.status = "partial";
    }

    // `last` non nul ici : `validateSitadelAggregate` a refusé « aucun mois ».
    const stale = last ? staleSeriesReason(last, startedAt) : null;
    if (stale) {
      log.status = "partial";
      appendLogMessage(log, stale);
      console.warn(`[sitadel] ${stale} — run marqué partial (swap fait)`);
    }

    if (log.status !== "partial") log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "sitadel");
    const elapsedSec = (new Date(log.finished_at).getTime() - startedAt.getTime()) / 1000;
    console.log(`[sitadel] ${log.status}: ${inserted} lignes en ${elapsedSec}s`);
  } catch (err) {
    console.error("[sitadel] ingestion failed:", err);
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
    await writeIngestLogFailureFallback(log, "sitadel");
    console.error(`[sitadel] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

await runIfMain(import.meta.url, main);
