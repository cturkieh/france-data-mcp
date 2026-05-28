import "./load-env.js";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import {
  IngestError,
  type IngestLogEntry,
  atomicSwapTables,
  computeSha256Buffer,
  downloadCsv,
  getLastSuccessChecksum,
  getNonEmpty,
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

const execFileAsync = promisify(execFile);

// Phase B — IRIS infracommunal. Cf. docs/plans/iris-infracommunal.md.
// Cron annuel UNIFIÉ ingérant 4 blocs, chacun dans sa table avec swap atomique
// INDÉPENDANT :
//   1. Contours IGN « CONTOURS-IRIS » 2024 → table `iris` (polygones).
//   2. RP 2022 base population (âge + CSP)   → table `iris_population`.
//   3. RP 2022 couples-familles-ménages      → table `iris_familles`.
//   4. FILOSOFI 2021 revenu disponible       → table `iris_revenu` (couverture
//      PARTIELLE : communes ≥5000 hab → ~16K IRIS, LEFT JOIN obligatoire).
//
// CHECKSUM COMBINÉ : un seul `ingest_log.source = 'iris'` + un sha combiné des
// 4 fichiers sources → court-circuit ssi AUCUN n'a changé. Refresh annuel donc
// re-ingérer les 4 quand un seul change est acceptable (et 1 seule ligne
// `data_freshness`). PAS de matview FROM ces tables → pas de bombe OID ; les
// stats sont jointes à `iris` sur code_iris au query-time (profil_iris).
//
// GÉOMÉTRIE (bloc 1) = ogr2ogr (reproj Lambert-93→4326 + WKT) + 7z, dépendances
// SYSTÈME (gdal-bin + p7zip). 7z décompresse AUSSI les .zip INSEE (blocs 2-4).

const IRIS_CONTOURS_URL =
  process.env.IRIS_CONTOURS_URL ??
  "https://data.geopf.fr/telechargement/download/CONTOURS-IRIS/CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01/CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01.7z";
const IRIS_POP_URL =
  process.env.IRIS_POP_URL ??
  "https://www.insee.fr/fr/statistiques/fichier/8647014/base-ic-evol-struct-pop-2022_csv.zip";
const IRIS_FAMILLES_URL =
  process.env.IRIS_FAMILLES_URL ??
  "https://www.insee.fr/fr/statistiques/fichier/8647008/base-ic-couples-familles-menages-2022_csv.zip";
const IRIS_REVENU_URL =
  process.env.IRIS_REVENU_URL ??
  "https://www.insee.fr/fr/statistiques/fichier/8229323/BASE_TD_FILO_IRIS_2021_DISP_CSV.zip";

/** .7z métropole ~40 Mo / zips RP ~20 Mo ; seuils anti-troncature de download. */
const MIN_CONTOURS_BYTES = 30_000_000;
const MIN_RP_ZIP_BYTES = 5_000_000;

// Bande de cohérence post-parse, commune aux 3 blocs : tous ~48,6 K (contours)
// à ~49,3 K (RP métropole) lignes. Large pour absorber un futur millésime,
// mais coupe un parse partiel / un changement structurel.
const MIN_ROWS = 40_000;
const MAX_ROWS = 55_000;

// FILOSOFI = couverture PARTIELLE (communes ≥5000 hab) → ~16K IRIS seulement
// (16 027 mesurés), bande propre bien plus basse que les 3 autres blocs.
const FILO_MIN_ROWS = 10_000;
const FILO_MAX_ROWS = 25_000;
/** zip FILOSOFI ~0,9 Mo (CSV 2,3 Mo) — bien plus petit que les zips RP. */
const MIN_FILO_ZIP_BYTES = 300_000;

/** Nom de la couche dans le GeoPackage IGN (vérifié `ogrinfo` 2026-05-28). */
const GPKG_LAYER = "contours_iris";

/** Délimiteur des CSV INSEE RP (point-virgule). */
const RP_DELIMITER = ";";

/**
 * Batching PostgREST par OCTETS pour le bloc contours : géométrie ~5,5 Ko en
 * moyenne, jusqu'à ~171 Ko → flush au plus petit de N lignes / octets cumulés
 * (sinon 413). Les blocs stats (petites lignes numériques) batchent par lignes.
 */
const GEOM_BATCH_MAX_ROWS = 200;
const GEOM_BATCH_MAX_BYTES = 500_000;
const STATS_BATCH_ROWS = 500;

/** Pause après NOTIFY pgrst pour que le 1er insert trouve la table (leçon FINESS V0.2). */
const PGRST_RELOAD_WAIT_MS = 2000;

interface IrisStagingRow {
  code_iris: string;
  code_commune: string;
  libelle: string | null;
  type_iris: string | null;
  /** EWKT — PostGIS caste sur la colonne `geometry(MultiPolygon, 4326)` à l'insert. */
  geom: string;
}

/** code_iris = dept(2) + commune(3) + iris(4). Dept = 2 chiffres OU `2A`/`2B` (Corse). */
const CODE_IRIS_RE = /^(?:[0-9]{2}|2[AB])[0-9]{7}$/u;

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const force = isForceReingestEnv(process.env.FORCE_REINGEST);
  const log: IngestLogEntry = {
    source: "iris",
    started_at: startedAt,
    status: "failed",
    csv_url: IRIS_CONTOURS_URL,
    github_run_url: process.env.GITHUB_RUN_URL,
  };

  let workDir: string | null = null;
  // Blocs déjà swappés en prod (chaque ingest* swappe AVANT de retourner). Lu
  // par le catch : si un bloc tardif échoue après ≥1 swap, l'audit DOIT dire
  // quelles tables sont déjà à jour (sinon `failed` nu = « rien n'a bougé »
  // trompeur sur une désync de millésime inter-tables).
  const swappedBlocks: string[] = [];
  try {
    // 1. DOWNLOAD des 4 sources + dernier checksum success, en parallèle.
    const [contours, pop, familles, revenu, lastSha] = await Promise.all([
      downloadCsv(IRIS_CONTOURS_URL, "contours-iris.7z"),
      downloadCsv(IRIS_POP_URL, "iris-pop.zip"),
      downloadCsv(IRIS_FAMILLES_URL, "iris-familles.zip"),
      downloadCsv(IRIS_REVENU_URL, "iris-revenu.zip"),
      getLastSuccessChecksum("iris"),
    ]);

    // Checksum COMBINÉ ordonné (contours|pop|familles|revenu) : court-circuit ssi
    // les 4 sont byte-identiques au dernier success.
    const combinedSha = computeSha256Buffer(
      Buffer.from(`${contours.sha256}|${pop.sha256}|${familles.sha256}|${revenu.sha256}`),
    );
    log.csv_size_bytes = contours.sizeBytes + pop.sizeBytes + familles.sizeBytes + revenu.sizeBytes;
    log.csv_sha256 = combinedSha;

    if (await shortCircuitIfSameChecksum(log, lastSha, combinedSha, "iris", force)) return;

    // Pré-validation taille (sources binaires / zippées).
    assertMinSize(contours.sizeBytes, MIN_CONTOURS_BYTES, "contours .7z");
    assertMinSize(pop.sizeBytes, MIN_RP_ZIP_BYTES, "RP population .zip");
    assertMinSize(familles.sizeBytes, MIN_RP_ZIP_BYTES, "RP familles .zip");
    assertMinSize(revenu.sizeBytes, MIN_FILO_ZIP_BYTES, "FILOSOFI revenu .zip");

    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-ingest-"));
    const supabase = getUntypedServiceClient("iris");

    // ── BLOC 1 — contours → iris ─────────────────────────────────────────────
    const contoursCount = await ingestContours(contours.filePath, workDir, supabase);
    swappedBlocks.push("iris");
    log.row_count = contoursCount;

    // ── BLOC 2 — RP population (âge + CSP) → iris_population ──────────────────
    const popCount = await ingestStatsCsv(pop.filePath, workDir, supabase, {
      block: "pop",
      stagingRpc: "ingest_create_iris_population_staging",
      stagingTable: "iris_population_staging",
      prodTable: "iris_population",
      expectedHeaders: POP_EXPECTED_HEADERS,
      minRows: MIN_ROWS,
      maxRows: MAX_ROWS,
      map: mapPopRecord,
    });
    swappedBlocks.push("iris_population");

    // ── BLOC 3 — RP couples-familles-ménages → iris_familles ─────────────────
    const famCount = await ingestStatsCsv(familles.filePath, workDir, supabase, {
      block: "familles",
      stagingRpc: "ingest_create_iris_familles_staging",
      stagingTable: "iris_familles_staging",
      prodTable: "iris_familles",
      expectedHeaders: FAMILLES_EXPECTED_HEADERS,
      minRows: MIN_ROWS,
      maxRows: MAX_ROWS,
      map: mapFamillesRecord,
    });
    swappedBlocks.push("iris_familles");

    // ── BLOC 4 — FILOSOFI 2021 revenu → iris_revenu (couverture PARTIELLE) ────
    const revenuCount = await ingestStatsCsv(revenu.filePath, workDir, supabase, {
      block: "revenu",
      stagingRpc: "ingest_create_iris_revenu_staging",
      stagingTable: "iris_revenu_staging",
      prodTable: "iris_revenu",
      expectedHeaders: FILO_EXPECTED_HEADERS,
      minRows: FILO_MIN_ROWS,
      maxRows: FILO_MAX_ROWS,
      map: mapRevenuRecord,
    });
    swappedBlocks.push("iris_revenu");

    // CANARY post-swap (non-bloquant) — cible la table `iris` (contours).
    await runAndRecordCanary(supabase, "iris", log, "iris");

    if (log.status !== "partial") log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "iris");
    const elapsedSec = (Date.now() - new Date(startedAt).getTime()) / 1000;
    console.log(
      `[iris] success: contours=${contoursCount} pop=${popCount} familles=${famCount} revenu=${revenuCount} en ${elapsedSec}s`,
    );
  } catch (err) {
    console.error("[iris] ingestion failed:", err);
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
    // Audit HONNÊTE : si des blocs ont déjà swappé, le dire — un `failed` nu
    // masquerait une désync de millésime (tables swappées N + table échouée N-1).
    // Le prochain run répare tout (checksum combiné changé → ré-ingestion).
    log.error_message =
      swappedBlocks.length > 0
        ? `${ingestErr.message} — ATTENTION ${swappedBlocks.length} bloc(s) DÉJÀ swappé(s) en prod [${swappedBlocks.join(", ")}] : désync de millésime possible jusqu'au prochain run (qui réingère TOUS les blocs via le checksum combiné)`
        : ingestErr.message;
    log.finished_at = new Date().toISOString();
    await writeIngestLogFailureFallback(log, "iris");
    console.error(`[iris] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  } finally {
    if (workDir) {
      try {
        await fsp.rm(workDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[iris] cleanup workdir failed (non-bloquant): ${String(e)}`);
      }
    }
  }
}

function assertMinSize(actual: number, min: number, label: string): void {
  if (actual < min) {
    throw new IngestError(
      "pre_validate",
      `${label} size ${actual} below minimum ${min} (suspected truncated download)`,
    );
  }
}

// ── BLOC 1 : contours ──────────────────────────────────────────────────────

async function ingestContours(
  archivePath: string,
  workDir: string,
  supabase: SupabaseClient,
): Promise<number> {
  const dir = path.join(workDir, "contours");
  await extractArchive(archivePath, dir);
  const gpkg = await findFirst(dir, (n) => n.endsWith(".gpkg"));
  if (!gpkg) {
    throw new IngestError("pre_validate", `Aucun .gpkg trouvé dans l'archive extraite (${dir})`);
  }
  const csvPath = path.join(workDir, "iris-wkt.csv");
  await convertGpkgToWktCsv(gpkg, csvPath);

  const { error } = await supabase.rpc("ingest_create_iris_staging");
  if (error) {
    throw new IngestError("copy", `Failed to create iris_staging table: ${error.message}`);
  }
  await waitForSchemaReload();

  const stats = await streamContoursToStaging(csvPath, supabase);
  assertRowBand(stats.inserted, "contours", MIN_ROWS, MAX_ROWS);

  // Anomalies de parse — DEUX causes à seuils/diagnostics SÉPARÉS (ne jamais
  // fusionner : un faux « column shift » sur une géométrie vide égarerait l'ops).
  const processed = stats.inserted + stats.skippedBadCode + stats.skippedEmptyGeom;
  if (stats.skippedBadCode > 0) {
    const rate = stats.skippedBadCode / processed;
    console.warn(
      `[iris] ${stats.skippedBadCode} lignes à code_iris invalide ignorées (${(rate * 100).toFixed(2)}%)`,
    );
    if (rate > 0.01) {
      throw new IngestError(
        "validate",
        `Invalid code_iris rate ${(rate * 100).toFixed(2)}% above 1% — likely IGN schema change (column shift sur code_iris)`,
      );
    }
  }
  if (stats.skippedEmptyGeom > 0) {
    // `geom` NOT NULL + tout IRIS a un contour → géométrie vide = signal FORT
    // (ogr2ogr partiel, reprojection ratée, WKT déplacé). Tolérance stricte 0,5 %.
    const rate = stats.skippedEmptyGeom / processed;
    console.warn(
      `[iris] ${stats.skippedEmptyGeom} lignes à géométrie vide ignorées (${(rate * 100).toFixed(2)}%)`,
    );
    if (rate > 0.005) {
      throw new IngestError(
        "validate",
        `Empty-geometry rate ${(rate * 100).toFixed(2)}% above 0.5% — ogr2ogr conversion partielle, couche/SRID source incorrects, ou WKT déplacé`,
      );
    }
  }

  await atomicSwapTables({ prodTable: "iris" });
  return stats.inserted;
}

/** Discriminé : une ligne mappée OU une raison de skip (anomalie comptée). */
type ParsedContour =
  | { row: IrisStagingRow; skip?: never }
  | { row?: never; skip: "bad_code" | "empty_geom" };

/**
 * Mappe une ligne CSV ogr2ogr → row staging. PURE. Skippe (en comptant) un
 * `code_iris` non conforme ou une géométrie vide. `code_commune` est DÉRIVÉ de
 * code_iris (jamais la colonne CSV `code_insee`) : garantit l'invariant
 * code_commune == left(code_iris,5) et supprime un chemin de clé vide silencieux
 * (un code_insee absent produirait `''`, accepté par CHAR(5) NOT NULL). EWKT
 * `SRID=4326;` car le WKT nu d'ogr2ogr est SRID 0 (cast rejeté sinon).
 */
function mapContourRecord(record: Record<string, string>): ParsedContour {
  const codeIris = (record.code_iris ?? "").trim();
  const wkt = (record.geometrie ?? "").trim();
  if (!CODE_IRIS_RE.test(codeIris)) return { skip: "bad_code" };
  if (wkt.length === 0) return { skip: "empty_geom" };
  return {
    row: {
      code_iris: codeIris,
      code_commune: codeIris.slice(0, 5),
      libelle: getNonEmpty(record, "nom_iris"),
      type_iris: getNonEmpty(record, "type_iris"),
      geom: `SRID=4326;${wkt}`,
    },
  };
}

interface ContoursStreamStats {
  inserted: number;
  skippedBadCode: number;
  skippedEmptyGeom: number;
}

async function streamContoursToStaging(
  csvPath: string,
  supabase: SupabaseClient,
): Promise<ContoursStreamStats> {
  const parser = fs.createReadStream(csvPath, { encoding: "utf8" }).pipe(
    parse({
      delimiter: ",",
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }),
  );

  let batch: IrisStagingRow[] = [];
  let batchBytes = 0;
  let inserted = 0;
  let skippedBadCode = 0;
  let skippedEmptyGeom = 0;
  let firstBatch = true;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertStagingBatchWithRetry(supabase, "iris_staging", batch, {
      logPrefix: "iris",
      isFirstBatch: firstBatch,
    });
    firstBatch = false;
    inserted += batch.length;
    batch = [];
    batchBytes = 0;
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = mapContourRecord(record);
    if (parsed.row) {
      batch.push(parsed.row);
      batchBytes += parsed.row.geom.length;
      if (batch.length >= GEOM_BATCH_MAX_ROWS || batchBytes >= GEOM_BATCH_MAX_BYTES) {
        await flush();
      }
      continue;
    }
    // Switch EXHAUSTIF (garde `never`) : compteurs distincts par cause. Le
    // discriminant est sorti en variable locale AVANT le switch — TS ne narrow
    // pas en `never` au default via un accès de propriété (contrainte finess.ts).
    const reason = parsed.skip;
    switch (reason) {
      case "bad_code":
        skippedBadCode++;
        break;
      case "empty_geom":
        skippedEmptyGeom++;
        break;
      default: {
        const _exhaustive: never = reason;
        throw new Error(`unreachable skip reason: ${String(_exhaustive)}`);
      }
    }
  }
  await flush();
  return { inserted, skippedBadCode, skippedEmptyGeom };
}

// ── BLOCS 2-3 : stats CSV (RP population / familles) ─────────────────────────

// Mapping champ DB → colonne CSV INSEE. SOURCE UNIQUE pilotant (1) le type de
// row, (2) le parseur (itération), (3) `expectedHeaders` de preValidateFile.
// Garantit qu'AUCUNE colonne lue n'échappe à la validation de header → ferme le
// trou « renommage INSEE d'une colonne non-sentinelle → parseNum(undefined)=null
// massif silencieux » (finding HIGH revue étape 2). Ajouter une colonne ici la
// propage automatiquement au type, au parseur ET au garde-fou header.
const POP_COLUMNS = {
  pop_total: "P22_POP",
  pop_0_14: "P22_POP0014",
  pop_15_29: "P22_POP1529",
  pop_30_44: "P22_POP3044",
  pop_45_59: "P22_POP4559",
  pop_60_74: "P22_POP6074",
  pop_75p: "P22_POP75P",
  pop_65p: "P22_POP65P", // agrégat INSEE distinct (pas dérivé des tranches)
  pop_15p: "C22_POP15P", // dénominateur des parts CSP
  csp_agriculteurs: "C22_POP15P_STAT_GSEC11_21",
  csp_artisans_comm: "C22_POP15P_STAT_GSEC12_22",
  csp_cadres: "C22_POP15P_STAT_GSEC13_23",
  csp_prof_interm: "C22_POP15P_STAT_GSEC14_24",
  csp_employes: "C22_POP15P_STAT_GSEC15_25",
  csp_ouvriers: "C22_POP15P_STAT_GSEC16_26",
  csp_retraites: "C22_POP15P_STAT_GSEC32",
  csp_autres: "C22_POP15P_STAT_GSEC40",
} as const;

const FAMILLES_COLUMNS = {
  menages_total: "C22_MEN",
  couples_avec_enfants: "C22_MENCOUPAENF",
  couples_sans_enfants: "C22_MENCOUPSENF",
  familles_monoparentales: "C22_MENFAMMONO",
} as const;

// FILOSOFI 2021 « disponible » (BASE_TD_FILO_IRIS_2021_DISP). Revenus en € (entiers),
// taux de pauvreté en % (décimale VIRGULE — cf. parseNum).
const FILO_COLUMNS = {
  revenu_median: "DISP_MED21",
  revenu_d1: "DISP_D121",
  revenu_d9: "DISP_D921",
  taux_pauvrete: "DISP_TP6021",
} as const;

type IrisPopulationRow = { code_iris: string } & Record<keyof typeof POP_COLUMNS, number | null>;
type IrisFamillesRow = { code_iris: string } & Record<keyof typeof FAMILLES_COLUMNS, number | null>;
type IrisRevenuRow = { code_iris: string } & Record<keyof typeof FILO_COLUMNS, number | null>;

/** Discriminé (comme `ParsedContour`) : row mappée OU skip COMPTÉ (jamais avalé). */
type StatsParsed<T> = { row: T; skip?: never } | { row?: never; skip: "bad_code" };

/** Header attendu par bloc = IRIS + TOUTES les colonnes lues (source = COLUMN_MAP). */
const POP_EXPECTED_HEADERS = ["IRIS", ...Object.values(POP_COLUMNS)];
const FAMILLES_EXPECTED_HEADERS = ["IRIS", ...Object.values(FAMILLES_COLUMNS)];
const FILO_EXPECTED_HEADERS = ["IRIS", ...Object.values(FILO_COLUMNS)];

function parseNumericColumns<F extends string>(
  record: Record<string, string>,
  columns: Record<F, string>,
): Record<F, number | null> {
  const out = {} as Record<F, number | null>;
  for (const field of Object.keys(columns) as F[]) {
    out[field] = parseNum(record[columns[field]]);
  }
  return out;
}

/** Mappe une ligne RP via un COLUMN_MAP. Skip (COMPTÉ) si `IRIS` non conforme. */
function mapStatsRecord<F extends string>(
  record: Record<string, string>,
  columns: Record<F, string>,
): StatsParsed<{ code_iris: string } & Record<F, number | null>> {
  const codeIris = (record.IRIS ?? "").trim();
  if (!CODE_IRIS_RE.test(codeIris)) return { skip: "bad_code" };
  return { row: { code_iris: codeIris, ...parseNumericColumns(record, columns) } };
}

function mapPopRecord(record: Record<string, string>): StatsParsed<IrisPopulationRow> {
  return mapStatsRecord(record, POP_COLUMNS);
}

function mapFamillesRecord(record: Record<string, string>): StatsParsed<IrisFamillesRow> {
  return mapStatsRecord(record, FAMILLES_COLUMNS);
}

function mapRevenuRecord(record: Record<string, string>): StatsParsed<IrisRevenuRow> {
  return mapStatsRecord(record, FILO_COLUMNS);
}

/**
 * Parse une valeur numérique INSEE → number | null. Vide / non numérique = null
 * (cellule légitimement absente — secret statistique). Gère le séparateur
 * décimal VIRGULE : le RP utilise le point (692.108) MAIS FILOSOFI utilise la
 * virgule française (19,0 ; 0,55) → on normalise `,`→`.` (les fichiers INSEE
 * IRIS n'ont jamais de séparateur de milliers, donc pas de collision). Sans ça,
 * toutes les valeurs décimales FILOSOFI tomberaient à null SILENCIEUSEMENT.
 * Un column-shift massif reste attrapé en amont par preValidateFile (header) +
 * la bande de lignes ; un code_iris non conforme par le compteur de skip.
 */
function parseNum(raw: string | undefined): number | null {
  // replaceAll (intent explicite « , = décimale ») : une valeur à >1 virgule
  // donnerait de toute façon NaN→null (dégrade vers null, JAMAIS un nombre faux).
  const v = (raw ?? "").trim().replaceAll(",", ".");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface StatsCsvConfig<T> {
  block: string;
  stagingRpc: string;
  stagingTable: string;
  prodTable: string;
  expectedHeaders: string[];
  minRows: number;
  maxRows: number;
  map: (record: Record<string, string>) => StatsParsed<T>;
}

/**
 * Ingestion générique d'un CSV stats RP (download déjà fait) : extract .zip →
 * data CSV (pas `meta_`) → preValidate header (attrape un column-shift LOUD) →
 * staging → stream/insert → bande de cohérence → swap atomique. Retourne le
 * nombre de lignes insérées.
 */
async function ingestStatsCsv<T extends object>(
  zipPath: string,
  workDir: string,
  supabase: SupabaseClient,
  cfg: StatsCsvConfig<T>,
): Promise<number> {
  const dir = path.join(workDir, cfg.block);
  await extractArchive(zipPath, dir);
  // Le .zip INSEE contient le CSV data + un `meta_*.CSV` (dictionnaire) à
  // exclure. CASSE-INSENSIBLE : les fichiers INSEE sont en `.CSV` MAJUSCULE
  // (le `.gpkg` IGN était minuscule, d'où le bug initial sur `.endsWith(".csv")`).
  const csvPath = await findFirst(dir, (n) => {
    const lower = n.toLowerCase();
    return lower.endsWith(".csv") && !lower.startsWith("meta");
  });
  if (!csvPath) {
    throw new IngestError("pre_validate", `Aucun CSV data (hors meta_) dans ${dir}`);
  }
  // Validation de header : un renommage / column-shift INSEE échoue ICI (LOUD)
  // au lieu de produire des colonnes silencieusement NULL en aval.
  await preValidateFile(csvPath, {
    minSizeBytes: 1_000_000,
    expectedHeaderColumns: cfg.expectedHeaders,
    delimiter: RP_DELIMITER,
  });

  const { error } = await supabase.rpc(cfg.stagingRpc);
  if (error) {
    throw new IngestError("copy", `Failed to create ${cfg.stagingTable}: ${error.message}`);
  }
  await waitForSchemaReload();

  const { inserted, skippedBadCode } = await streamStatsToStaging(csvPath, supabase, cfg);
  assertRowBand(inserted, cfg.block, cfg.minRows, cfg.maxRows);

  // Skips COMPTÉS + seuillés (parité avec le bloc contours) : un column-shift
  // PARTIEL sur la colonne `IRIS` (quelques milliers de lignes non conformes)
  // garderait `inserted` dans la bande → swap d'une table AMPUTÉE en status
  // success. Le seuil 1 % lève LOUD avec le bon diagnostic, jamais avalé.
  if (skippedBadCode > 0) {
    const rate = skippedBadCode / (inserted + skippedBadCode);
    console.warn(
      `[iris:${cfg.block}] ${skippedBadCode} lignes à colonne IRIS non conforme ignorées (${(rate * 100).toFixed(2)}%)`,
    );
    if (rate > 0.01) {
      throw new IngestError(
        "validate",
        `[${cfg.block}] Invalid IRIS rate ${(rate * 100).toFixed(2)}% above 1% — likely column shift sur la colonne IRIS`,
      );
    }
  }

  await atomicSwapTables({ prodTable: cfg.prodTable });
  return inserted;
}

async function streamStatsToStaging<T extends object>(
  csvPath: string,
  supabase: SupabaseClient,
  cfg: StatsCsvConfig<T>,
): Promise<{ inserted: number; skippedBadCode: number }> {
  const parser = fs.createReadStream(csvPath, { encoding: "utf8" }).pipe(
    parse({
      delimiter: RP_DELIMITER,
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }),
  );

  let batch: T[] = [];
  let inserted = 0;
  let skippedBadCode = 0;
  let firstBatch = true;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertStagingBatchWithRetry(supabase, cfg.stagingTable, batch, {
      logPrefix: `iris:${cfg.block}`,
      isFirstBatch: firstBatch,
    });
    firstBatch = false;
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = cfg.map(record);
    if (parsed.skip) {
      // COMPTÉ (pas `continue` muet) : seuillé en aval pour attraper un column
      // shift sur la colonne IRIS — cf. ingestStatsCsv.
      skippedBadCode++;
      continue;
    }
    batch.push(parsed.row);
    if (batch.length >= STATS_BATCH_ROWS) await flush();
  }
  await flush();
  return { inserted, skippedBadCode };
}

// ── Helpers partagés ─────────────────────────────────────────────────────────

function assertRowBand(inserted: number, block: string, min: number, max: number): void {
  if (inserted < min) {
    throw new IngestError(
      "validate",
      `[${block}] Row count ${inserted} below minimum ${min} — suspected partial parse (truncated CSV or conversion failure)`,
    );
  }
  if (inserted > max) {
    throw new IngestError(
      "validate",
      `[${block}] Row count ${inserted} above maximum ${max} — suspected upstream format change`,
    );
  }
}

function waitForSchemaReload(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PGRST_RELOAD_WAIT_MS));
}

/** Extrait une archive (.7z ou .zip) dans `destDir` via 7z (p7zip). */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync("7z", ["x", "-y", `-o${destDir}`, archivePath], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[iris] 7z extraction failed for ${archivePath}:`, err);
    throw new IngestError(
      "pre_validate",
      `7z extraction failed (p7zip installé ? PATH ?): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/**
 * ogr2ogr : GeoPackage Lambert-93 → CSV avec géométrie en WKT reprojetée 4326.
 * `-t_srs EPSG:4326` (source auto-détectée), `-lco GEOMETRY=AS_WKT` (1ère
 * colonne = WKT), `-lco SEPARATOR=COMMA`. Header attendu :
 * `geometrie,cleabs,code_insee,nom_commune,iris,code_iris,nom_iris,type_iris`.
 */
async function convertGpkgToWktCsv(gpkgPath: string, csvPath: string): Promise<void> {
  try {
    await execFileAsync(
      "ogr2ogr",
      [
        "-f",
        "CSV",
        csvPath,
        gpkgPath,
        GPKG_LAYER,
        "-t_srs",
        "EPSG:4326",
        "-lco",
        "GEOMETRY=AS_WKT",
        "-lco",
        "SEPARATOR=COMMA",
      ],
      // 64 Mo : le CSV part dans un FICHIER (pas stdout), mais ogr2ogr est bavard
      // sur stderr (1 warning/géométrie réparée × ~48,6 K). Un maxBuffer trop
      // juste ferait rejeter ENOBUFS un run pourtant réussi → faux « gdal absent ».
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    console.error(`[iris] ogr2ogr conversion failed for ${gpkgPath}:`, err);
    throw new IngestError(
      "pre_validate",
      `ogr2ogr conversion failed (gdal-bin installé ? PATH ?): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!fs.existsSync(csvPath)) {
    throw new IngestError("pre_validate", `ogr2ogr n'a pas produit le CSV attendu (${csvPath})`);
  }
}

/** Recherche récursive du premier fichier satisfaisant `predicate(nom)` (tri stable par nom). */
async function findFirst(
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFirst(full, predicate);
      if (found) return found;
    } else if (predicate(entry.name)) {
      return full;
    }
  }
  return null;
}

/** Surface de test (cf. convention `__TESTING__` de finess.ts). */
export const __TESTING__ = {
  mapContourRecord,
  mapPopRecord,
  mapFamillesRecord,
  mapRevenuRecord,
  parseNum,
  CODE_IRIS_RE,
  POP_COLUMNS,
  FAMILLES_COLUMNS,
  FILO_COLUMNS,
  POP_EXPECTED_HEADERS,
  FAMILLES_EXPECTED_HEADERS,
  FILO_EXPECTED_HEADERS,
  GEOM_BATCH_MAX_ROWS,
  GEOM_BATCH_MAX_BYTES,
  MIN_ROWS,
  MAX_ROWS,
};

runIfMain(import.meta.url, main);
