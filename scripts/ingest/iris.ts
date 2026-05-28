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
  downloadCsv,
  getLastSuccessChecksum,
  getNonEmpty,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
  isForceReingestEnv,
  runAndRecordCanary,
  runIfMain,
  shortCircuitIfSameChecksum,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
} from "./shared.js";

const execFileAsync = promisify(execFile);

// Phase B — IRIS infracommunal. Cf. docs/plans/iris-infracommunal.md.
// Étape 1/6 : ingestion des contours IGN « CONTOURS-IRIS » 2024 (géo 01/01/2024)
// dans la table `iris`. Les blocs démographiques (RP 2022, FILOSOFI 2021) sont
// ajoutés aux étapes 2-3 dans CE MÊME cron (refresh annuel groupé), chacun avec
// sa propre table + swap atomique.
//
// GÉOMÉTRIE = nouveau pour ce projet : source en GeoPackage Lambert-93 compressé
// .7z. Pipeline : download .7z → 7z extract → ogr2ogr (reprojection 2154→4326 +
// export WKT) → CSV → insert staging en EWKT → swap. ogr2ogr + 7z sont des
// dépendances SYSTÈME (gdal-bin + p7zip) installées par le workflow GitHub Actions
// ET requises localement pour les tests. Choix loader validé : ogr2ogr ne fait QUE
// la conversion/reprojection ; l'écriture DB reste sur le pipeline PostgREST
// `insertStagingBatchWithRetry` éprouvé (cohérence avec les 4 sources existantes,
// pas de connexion Postgres directe). Géométries mesurées : avg ~5,5 Ko, max ~171 Ko
// → batching par OCTETS (vs nb de lignes seul) pour rester sous la limite de payload.

/** Override runtime via env (CI / test). Métropole FXX uniquement (DOM = fast-follow). */
const IRIS_CONTOURS_URL =
  process.env.IRIS_CONTOURS_URL ??
  "https://data.geopf.fr/telechargement/download/CONTOURS-IRIS/CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01/CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01.7z";

/** .7z métropole ~40 Mo ; 30 Mo attrape une troncature de download. */
const MIN_ARCHIVE_BYTES = 30_000_000;

// Bande de cohérence post-parse. Métropole FXX 2024 = 48 569 features
// (14 429 H + 819 A + 321 D + 33 000 Z communes non-irisées). La bande large
// absorbe un millésime à venir sans fausse alerte, mais coupe un parse partiel
// (troncature) ou un changement structurel majeur.
const MIN_ROWS = 40_000;
const MAX_ROWS = 55_000;

/** Nom de la couche dans le GeoPackage IGN (vérifié `ogrinfo` 2026-05-28). */
const GPKG_LAYER = "contours_iris";

/**
 * Batching PostgREST par octets. Une géométrie IRIS pèse ~5,5 Ko en moyenne mais
 * jusqu'à ~171 Ko (communes côtières découpées). On flush au PLUS PETIT de
 * `BATCH_MAX_ROWS` lignes OU `BATCH_MAX_BYTES` cumulés — sans le plafond octets,
 * un lot de 200 grosses géométries dépasserait la limite de payload de la
 * passerelle Supabase (413). 500 Ko laisse une marge confortable même si
 * plusieurs grosses géométries tombent dans le même lot.
 */
const BATCH_MAX_ROWS = 200;
const BATCH_MAX_BYTES = 500_000;

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

/**
 * code_iris = dept(2) + commune(3) + iris(4). Le dept est 2 chiffres OU
 * exactement `2A`/`2B` (Corse) — la lettre n'apparaît QUE dans ce cas, jamais
 * ailleurs (un `7A…` serait un column shift, pas un vrai code).
 */
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
  try {
    // 1. DOWNLOAD .7z + dernier checksum success en parallèle (RTT économisé).
    const [downloaded, lastSha] = await Promise.all([
      downloadCsv(IRIS_CONTOURS_URL, "contours-iris.7z"),
      getLastSuccessChecksum("iris"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    if (await shortCircuitIfSameChecksum(log, lastSha, downloaded.sha256, "iris", force)) return;

    // 2. PRE-VALIDATE (taille seule — source binaire .7z, pas de header CSV).
    if (downloaded.sizeBytes < MIN_ARCHIVE_BYTES) {
      throw new IngestError(
        "pre_validate",
        `Archive size ${downloaded.sizeBytes} below minimum ${MIN_ARCHIVE_BYTES} (suspected truncated download)`,
      );
    }

    // 3. EXTRACT .7z → GeoPackage, puis ogr2ogr → CSV WKT reprojeté 4326.
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-ingest-"));
    const gpkgPath = await extractGeoPackage(downloaded.filePath, workDir);
    const csvPath = path.join(workDir, "iris-wkt.csv");
    await convertGpkgToWktCsv(gpkgPath, csvPath);

    // 4. CREATE STAGING + attendre le reload du schema-cache PostgREST.
    const supabase = getUntypedServiceClient("iris");
    const { error: stagingErr } = await supabase.rpc("ingest_create_iris_staging");
    if (stagingErr) {
      throw new IngestError("copy", `Failed to create iris_staging table: ${stagingErr.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PGRST_RELOAD_WAIT_MS));

    // 5. STREAM CSV → STAGING (insert EWKT, batching par octets).
    const stats = await streamContoursToStaging(csvPath, supabase);
    log.row_count = stats.inserted;

    // 6. VALIDATE COHERENCE.
    if (stats.inserted < MIN_ROWS) {
      throw new IngestError(
        "validate",
        `Row count ${stats.inserted} below minimum ${MIN_ROWS} — suspected partial parse (truncated CSV or ogr2ogr failure)`,
      );
    }
    if (stats.inserted > MAX_ROWS) {
      throw new IngestError(
        "validate",
        `Row count ${stats.inserted} above maximum ${MAX_ROWS} — suspected upstream format change`,
      );
    }
    // Anomalies de parse — DEUX causes à seuils/diagnostics SÉPARÉS (ne jamais
    // fusionner : un faux diagnostic « column shift » sur une géométrie vide
    // enverrait l'ops chercher au mauvais endroit). Dénominateur = total traité.
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
      // `geom` est NOT NULL et tout IRIS a un contour → une géométrie vide est
      // un signal FORT (ogr2ogr partiel, reprojection ratée, WKT dans une autre
      // colonne). Tolérance plus stricte que bad_code (0,5 %).
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

    // 7. ATOMIC SWAP iris_staging → iris.
    await atomicSwapTables({ prodTable: "iris" });

    // 8. CANARY post-swap (non-bloquant — pas de cibles iris seedées tant que la
    // 1re ingestion n'a pas confirmé des codes stables ; retourne vide = OK).
    await runAndRecordCanary(supabase, "iris", log, "iris");

    if (log.status !== "partial") log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLogSuccessSafe(log, "iris");
    const elapsedSec = (Date.now() - new Date(startedAt).getTime()) / 1000;
    console.log(`[iris] success: ${stats.inserted} IRIS ingérés en ${elapsedSec}s`);
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
    log.error_message = ingestErr.message;
    log.finished_at = new Date().toISOString();
    await writeIngestLogFailureFallback(log, "iris");
    console.error(`[iris] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  } finally {
    // Best-effort cleanup du workdir temporaire (GeoPackage 159 Mo + CSV 261 Mo).
    if (workDir) {
      try {
        await fsp.rm(workDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[iris] cleanup workdir failed (non-bloquant): ${String(e)}`);
      }
    }
  }
}

/**
 * Extrait l'archive .7z dans `destDir` et retourne le chemin du `.gpkg`. La
 * livraison IGN imbrique le GeoPackage dans une arborescence profonde
 * (CONTOURS-IRIS/1_DONNEES.../...) → recherche récursive du premier `.gpkg`.
 */
async function extractGeoPackage(archivePath: string, destDir: string): Promise<string> {
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
  const gpkg = await findFirstByExt(destDir, ".gpkg");
  if (!gpkg) {
    throw new IngestError(
      "pre_validate",
      `Aucun .gpkg trouvé dans l'archive extraite (${destDir})`,
    );
  }
  return gpkg;
}

/**
 * ogr2ogr : GeoPackage Lambert-93 → CSV avec géométrie en WKT reprojetée 4326.
 * `-t_srs EPSG:4326` (source RGF93/Lambert-93 auto-détectée depuis le .gpkg),
 * `-lco GEOMETRY=AS_WKT` (1ère colonne = WKT), `-lco SEPARATOR=COMMA`.
 * Header attendu : `geometrie,cleabs,code_insee,nom_commune,iris,code_iris,nom_iris,type_iris`.
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
      // 64 Mo : le CSV part dans un FICHIER (pas stdout), mais ogr2ogr est
      // bavard sur stderr (1 warning/géométrie réparée × ~48,6 K features). Un
      // maxBuffer trop juste ferait rejeter `ENOBUFS` un run pourtant réussi sur
      // disque → faux « ogr2ogr absent ». 64 Mo absorbe le bruit stderr.
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

interface ContoursStreamStats {
  inserted: number;
  skippedBadCode: number;
  skippedEmptyGeom: number;
}

/** Discriminé : une ligne mappée OU une raison de skip (anomalie comptée). */
type ParsedContour =
  | { row: IrisStagingRow; skip?: never }
  | { row?: never; skip: "bad_code" | "empty_geom" };

/**
 * Mappe une ligne CSV ogr2ogr (header
 * `geometrie,cleabs,code_insee,nom_commune,iris,code_iris,nom_iris,type_iris`)
 * vers une row staging. PURE (testable sans DB ni I/O). Skippe — en comptant —
 * un `code_iris` non conforme (CODE_IRIS_RE) ou une géométrie vide : sur une
 * source IGN aussi propre, l'un OU l'autre signale un column shift / changement
 * de schéma, jamais un cas normal. La géométrie est préfixée `SRID=4326;` (EWKT)
 * car ogr2ogr `-lco GEOMETRY=AS_WKT` produit du WKT nu (SRID 0) que le cast vers
 * `geometry(MultiPolygon, 4326)` rejetterait sans le SRID explicite.
 */
function mapContourRecord(record: Record<string, string>): ParsedContour {
  const codeIris = (record.code_iris ?? "").trim();
  const wkt = (record.geometrie ?? "").trim();
  if (!CODE_IRIS_RE.test(codeIris)) return { skip: "bad_code" };
  if (wkt.length === 0) return { skip: "empty_geom" };
  return {
    row: {
      code_iris: codeIris,
      // DÉRIVÉ de code_iris (déjà validé CODE_IRIS_RE) — JAMAIS la colonne CSV
      // `code_insee` : garantit l'invariant code_commune == left(code_iris,5)
      // (vérifié prod, commune_mismatch=0) ET supprime un chemin silencieux —
      // un `code_insee` absent (column shift) produirait `''`, accepté par la
      // colonne CHAR(5) NOT NULL en `'     '` → clé de raccord vide ingérée
      // sans erreur. La dérivation rend ce cas impossible.
      code_commune: codeIris.slice(0, 5),
      // getNonEmpty (shared) plutôt qu'un helper local : il strip en plus les
      // control-chars résiduels du CSV (\r\n\t) qui casseraient le JSON de
      // l'insert PostgREST — pertinent sur des libellés INSEE/IGN bruts.
      libelle: getNonEmpty(record, "nom_iris"),
      type_iris: getNonEmpty(record, "type_iris"),
      geom: `SRID=4326;${wkt}`,
    },
  };
}

async function streamContoursToStaging(
  csvPath: string,
  supabase: SupabaseClient,
): Promise<ContoursStreamStats> {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const parser = stream.pipe(
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
      if (batch.length >= BATCH_MAX_ROWS || batchBytes >= BATCH_MAX_BYTES) {
        await flush();
      }
      continue;
    }
    // Switch EXHAUSTIF (garde `never`) : compteurs distincts par cause — un
    // futur 3e `skip` sans compteur dédié serait une erreur de compilation
    // (discipline finess.ts). Fusionner les causes diluerait l'`empty_geom`
    // sous le seuil/message « column shift » du `bad_code` (diagnostic faux).
    // Le discriminant est assigné à une variable locale AVANT le switch : TS ne
    // narrow PAS en `never` au default à travers un accès de propriété
    // (`parsed.skip`) — même contrainte que finess.ts.
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

/** Recherche récursive du premier fichier portant l'extension `ext` (insensible casse). */
async function findFirstByExt(dir: string, ext: string): Promise<string | null> {
  // Tri par nom : `readdir` ne garantit aucun ordre → sélection stable/auditable
  // si l'archive contenait un jour > 1 .gpkg (annexe, journal). FXX n'en a qu'un.
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFirstByExt(full, ext);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith(ext.toLowerCase())) {
      return full;
    }
  }
  return null;
}

/** Surface de test (cf. convention `__TESTING__` de finess.ts). */
export const __TESTING__ = {
  mapContourRecord,
  CODE_IRIS_RE,
  BATCH_MAX_ROWS,
  BATCH_MAX_BYTES,
  MIN_ROWS,
  MAX_ROWS,
};

runIfMain(import.meta.url, main);
