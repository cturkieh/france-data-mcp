/**
 * Chargement national DVF (Etalab, « Demandes de valeurs foncières
 * géolocalisées ») : sélection des fichiers, lecture en flux, transformation et
 * gardes qui autorisent ou refusent le swap. Orchestration : `dvf.ts`.
 *
 * Module PUR : ni `load-env`, ni client Supabase, y compris en transitif (gardé
 * par un test sur la chaîne d'import). Il s'exécute sans aucun secret, ce qui
 * permet de le prouver sur les vrais fichiers depuis n'importe quel poste.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import { parseRpcCount } from "../../src/core/parse-rpc-count.js";
import { COMMUNE_INSEE_PATTERN } from "../../src/territoire/commune-index.js";
import { IngestError } from "./ingest-error.js";

// ---------------------------------------------------------------------------
// Sélection des fichiers et signature de livraison
// ---------------------------------------------------------------------------

/** Ressource du dataset telle que rendue par l'API data.gouv.fr. */
export interface DvfResource {
  title?: string | null;
  url?: string | null;
  filesize?: number | null;
  last_modified?: string | null;
  checksum?: { type?: string | null; value?: string | null } | null;
}

export interface DvfFile {
  url: string;
  fileName: string;
  year: number;
  /** `null` : fichier d'année pleine (`full-2025.csv.gz`). */
  semester: 1 | 2 | null;
  filesize: number | null;
  /** Vide si l'API n'en publie pas : l'URL, horodatée à chaque dépôt, reste discriminante. */
  checksum: string;
}

/** Ignore `dvf.csv.gz` (fichier unique 5 ans) et les ressources `url` non CSV. */
const DVF_FILE_PATTERN = /^full-(\d{4})(?:-s([12]))?\.csv\.gz$/;

/** Une année pleine finit en décembre : elle se range après ses deux semestres. */
const periodRank = (f: DvfFile): number => f.year * 10 + (f.semester ?? 3);

function fileFromResource(resource: DvfResource): DvfFile | null {
  if (typeof resource.url !== "string") return null;
  let fileName: string;
  try {
    fileName = basename(new URL(resource.url).pathname);
  } catch (err) {
    // Une URL illisible parmi les ressources (documentation, lien cassé) n'est
    // pas un fichier candidat : le compte final de 2 fichiers reste le juge.
    console.error(`[dvf] ressource ignorée, URL illisible « ${resource.url} » :`, err);
    return null;
  }
  const match = DVF_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  return {
    url: resource.url,
    fileName,
    year: Number(match[1]),
    semester: match[2] === "1" ? 1 : match[2] === "2" ? 2 : null,
    filesize: typeof resource.filesize === "number" ? resource.filesize : null,
    checksum: resource.checksum?.value ?? "",
  };
}

/**
 * Les 2 derniers fichiers, du plus ancien au plus récent : cet ordre est aussi
 * celui de lecture, donc celui du « dernière ligne gardée » du dédoublonnage.
 */
export function selectDvfFiles(resources: readonly DvfResource[]): DvfFile[] {
  const sorted = resources
    .map(fileFromResource)
    .filter((f): f is DvfFile => f !== null)
    .sort((a, b) => periodRank(a) - periodRank(b) || (a.url < b.url ? -1 : 1));
  // Même nom déposé deux fois : le dépôt le plus récent (URL horodatée) l'emporte.
  const byName = new Map(sorted.map((f) => [f.fileName, f]));
  const files = [...byName.values()].sort((a, b) => periodRank(a) - periodRank(b));
  if (files.length < 2) {
    throw new IngestError(
      "download",
      `Dataset DVF : ${files.length} fichier(s) full-AAAA[-sN].csv.gz trouvé(s), 2 attendus — fichiers renommés côté Etalab ?`,
    );
  }
  return files.slice(-2);
}

/**
 * Signature de la LIVRAISON, calculée depuis l'API avant tout téléchargement :
 * sha256 de la concaténation triée des `url|checksum`. Stable quel que soit
 * l'ordre des fichiers, et de même longueur que `ingest_log.csv_sha256`.
 */
export function dvfDeliverySignature(files: readonly Pick<DvfFile, "url" | "checksum">[]): string {
  const parts = files.map((f) => `${f.url}|${f.checksum}`).sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Lecture en flux
// ---------------------------------------------------------------------------

/** Les seules colonnes lues sur les 40 du fichier (objets plus légers, parseur plus rapide). */
export const DVF_COLUMNS = [
  "id_mutation",
  "date_mutation",
  "nature_mutation",
  "valeur_fonciere",
  "code_commune",
  "type_local",
  "surface_reelle_bati",
  "surface_terrain",
  "longitude",
  "latitude",
] as const;

const WANTED_COLUMNS: ReadonlySet<string> = new Set(DVF_COLUMNS);

function selectColumns(header: string[], label: string): (string | false)[] {
  const missing = DVF_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new IngestError(
      "pre_validate",
      `${label} : colonnes attendues absentes de l'en-tête : [${missing.join(", ")}]. Reçu : [${header.slice(0, 10).join(", ")}…]`,
    );
  }
  return header.map((c) => (WANTED_COLUMNS.has(c) ? c : false));
}

/**
 * Lit un `.csv.gz` en flux. `pipeline` propage l'erreur de n'importe quel maillon
 * jusqu'au parseur : avec un `.pipe()` nu, un `.gz` tronqué laisserait l'itérateur
 * finir normalement et rendrait un jeu partiel en silence.
 */
export async function* streamDvfCsvGz(filePath: string): AsyncGenerator<Record<string, string>> {
  const label = basename(filePath);
  const parser = parse({
    delimiter: ",",
    columns: (header: string[]) => selectColumns(header, label),
    skip_empty_lines: true,
    bom: true,
  });
  // `pipeline` peut rejeter avant que le `await done` ci-dessous soit atteint :
  // le `.catch` évite un `unhandledRejection`, l'erreur est relue en sortie.
  let pipelineError: unknown;
  const done = pipeline(createReadStream(filePath), createGunzip(), parser).catch((err) => {
    console.error(`[dvf] ${label} : flux interrompu :`, err);
    pipelineError = err;
  });
  try {
    for await (const record of parser) yield record as Record<string, string>;
    await done;
    if (pipelineError !== undefined) throw pipelineError;
  } catch (err) {
    console.error(`[dvf] ${label} : lecture abandonnée :`, err);
    if (err instanceof IngestError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new IngestError("pre_validate", `${label} : lecture interrompue (${reason})`, err);
  }
}

/** Enchaîne les fichiers dans l'ordre donné (cf. `selectDvfFiles`). */
export async function* streamDvfFiles(
  filePaths: readonly string[],
): AsyncGenerator<Record<string, string>> {
  for (const filePath of filePaths) yield* streamDvfCsvGz(filePath);
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

/**
 * Ligne de `dvf_mutations_staging`. Colonnes explicites : jamais `geog`, générée
 * par Postgres, qui rejetterait toute écriture.
 */
export interface DvfStagingRow {
  id_mutation: string;
  date_mutation: string;
  nature_mutation: string | null;
  valeur_fonciere: number | null;
  code_commune: string;
  type_local: string;
  surface_reelle_bati: number | null;
  surface_terrain: number | null;
  prix_m2: number | null;
  longitude: number;
  latitude: number;
}

export interface DvfAggregate {
  rows: DvfStagingRow[];
  lignesLues: number;
  sansCoords: number;
  sansDate: number;
  invalides: number;
  /** Ni prix au m², ni terrain : aucun tool ne lit ces lignes. */
  inutiles: number;
  doublons: number;
  horsFenetre: number;
  /** `AAAA-MM`, cf. `publishedLastMonth`. `null` si aucune ligne n'a survécu. */
  lastMonth: string | null;
  /** Dans la fenêtre gardée. */
  rowsByMonth: ReadonlyMap<string, number>;
  /** Dans la fenêtre gardée. */
  rowsByCommune: ReadonlyMap<string, number>;
  avecPrix: number;
  avecTerrain: number;
  medianPrixM2: number | null;
}

/** Types de locaux pour lesquels un prix au m² a un sens (même règle que `parseDvfCsv`). */
const BUILT_TYPES: ReadonlySet<string> = new Set(["Maison", "Appartement"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Un jour impossible (`2025-02-30`) ferait échouer tout un lot à l'insertion, 20 min après le départ. */
function isInsertableDate(date: string): boolean {
  if (!DATE_PATTERN.test(date) || date < "1900") return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

/**
 * Mois le plus récent portant au moins 50 % des lignes du mois le plus fourni.
 * Jamais un max sur une ligne isolée : une seule vente mal datée de 2030 ferait
 * glisser toute la fenêtre vers le futur et viderait la table.
 */
function publishedLastMonth(rowsByMonth: ReadonlyMap<string, number>): string | null {
  let fullest = 0;
  for (const n of rowsByMonth.values()) if (n > fullest) fullest = n;
  let last: string | null = null;
  for (const [month, n] of rowsByMonth) {
    if (n * 2 >= fullest && (last === null || month > last)) last = month;
  }
  return last;
}

/** Les 12 mois finissant à `lastMonth` inclus, du plus ancien au plus récent. */
export function dvfWindowMonths(lastMonth: string): string[] {
  const year = Number(lastMonth.slice(0, 4));
  const month = Number(lastMonth.slice(5, 7));
  return Array.from({ length: 12 }, (_, i) => {
    const total = year * 12 + (month - 1) - (11 - i);
    const m = String((total % 12) + 1).padStart(2, "0");
    return `${Math.floor(total / 12)}-${m}`;
  });
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

/**
 * Ordre total sur la clé de dédoublonnage. Les fichiers source ne sont pas triés
 * par commune (1,1 million de retours en arrière mesurés) : charger dans cet ordre
 * range physiquement la table, les lignes d'un même quartier partagent leurs pages
 * et une recherche par rayon lit beaucoup moins de blocs disque.
 */
function compareRows(a: DvfStagingRow, b: DvfStagingRow): number {
  if (a.code_commune !== b.code_commune) return a.code_commune < b.code_commune ? -1 : 1;
  if (a.date_mutation !== b.date_mutation) return a.date_mutation < b.date_mutation ? -1 : 1;
  if (a.id_mutation !== b.id_mutation) return a.id_mutation < b.id_mutation ? -1 : 1;
  if (a.type_local !== b.type_local) return a.type_local < b.type_local ? -1 : 1;
  return 0;
}

/**
 * Applique les règles de `parseDvfCsv` (`src/immobilier/dvf.ts`) au flux national,
 * puis le filtre utile, le dédoublonnage, la fenêtre de 12 mois et le tri final.
 * Fenêtre ancrée sur la DONNÉE : aucune horloge ici, le résultat ne dépend que des
 * fichiers.
 */
export async function aggregateDvfRecords(
  records: AsyncIterable<Record<string, string>> | Iterable<Record<string, string>>,
): Promise<DvfAggregate> {
  // Dédoublonnage APRÈS le filtre utile, dernière ligne gardée : même clé que la PK
  // historique. Le biais de cette règle sur les ventes à plusieurs lots du même type
  // est mesuré et assumé pour l'instant.
  const byKey = new Map<string, DvfStagingRow>();
  let lignesLues = 0;
  let sansCoords = 0;
  let sansDate = 0;
  let invalides = 0;
  let inutiles = 0;
  let utiles = 0;

  // ~550 dates distinctes pour des millions de lignes : le verdict n'est calculé
  // qu'une fois, et chaque ligne partage la même chaîne en mémoire.
  const knownDates = new Map<string, string | null>();

  for await (const rec of records) {
    lignesLues++;
    const longitude = Number.parseFloat(rec.longitude ?? "");
    const latitude = Number.parseFloat(rec.latitude ?? "");
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      sansCoords++;
      continue;
    }
    const rawDate = (rec.date_mutation ?? "").trim();
    if (rawDate === "") {
      sansDate++;
      continue;
    }
    let date = knownDates.get(rawDate);
    if (date === undefined) {
      date = isInsertableDate(rawDate) ? rawDate : null;
      knownDates.set(rawDate, date);
    }
    const id = (rec.id_mutation ?? "").trim();
    const commune = (rec.code_commune ?? "").trim();
    if (
      id === "" ||
      date === null ||
      !COMMUNE_INSEE_PATTERN.test(commune) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    ) {
      invalides++;
      continue;
    }

    const valeur = Number.parseFloat(rec.valeur_fonciere ?? "");
    const surfaceBati = Number.parseFloat(rec.surface_reelle_bati ?? "");
    const surfaceTerrain = Number.parseFloat(rec.surface_terrain ?? "");
    const typeLocal = (rec.type_local ?? "").trim();

    const prixM2 =
      BUILT_TYPES.has(typeLocal) &&
      Number.isFinite(surfaceBati) &&
      surfaceBati > 0 &&
      Number.isFinite(valeur)
        ? valeur / surfaceBati
        : null;
    const terrain = Number.isFinite(surfaceTerrain) && surfaceTerrain > 0 ? surfaceTerrain : null;
    if (prixM2 === null && terrain === null) {
      inutiles++;
      continue;
    }

    utiles++;
    byKey.set(`${id}|${commune}|${date}|${typeLocal}`, {
      id_mutation: id,
      date_mutation: date,
      nature_mutation: rec.nature_mutation ?? null,
      valeur_fonciere: Number.isFinite(valeur) ? valeur : null,
      code_commune: commune,
      type_local: typeLocal,
      surface_reelle_bati: Number.isFinite(surfaceBati) && surfaceBati > 0 ? surfaceBati : null,
      surface_terrain: terrain,
      prix_m2: prixM2,
      longitude,
      latitude,
    });
  }

  const allByMonth = new Map<string, number>();
  for (const row of byKey.values()) {
    const month = row.date_mutation.slice(0, 7);
    allByMonth.set(month, (allByMonth.get(month) ?? 0) + 1);
  }
  const lastMonth = publishedLastMonth(allByMonth);
  const window = new Set(lastMonth === null ? [] : dvfWindowMonths(lastMonth));

  const rows: DvfStagingRow[] = [];
  const rowsByMonth = new Map<string, number>();
  const rowsByCommune = new Map<string, number>();
  const prix: number[] = [];
  let avecTerrain = 0;
  for (const row of byKey.values()) {
    const month = row.date_mutation.slice(0, 7);
    if (!window.has(month)) continue;
    rows.push(row);
    rowsByMonth.set(month, (rowsByMonth.get(month) ?? 0) + 1);
    rowsByCommune.set(row.code_commune, (rowsByCommune.get(row.code_commune) ?? 0) + 1);
    if (row.prix_m2 !== null) prix.push(row.prix_m2);
    if (row.surface_terrain !== null) avecTerrain++;
  }
  const doublons = utiles - byKey.size;
  const horsFenetre = byKey.size - rows.length;
  byKey.clear();
  rows.sort(compareRows);

  return {
    rows,
    lignesLues,
    sansCoords,
    sansDate,
    invalides,
    inutiles,
    doublons,
    horsFenetre,
    lastMonth,
    rowsByMonth,
    rowsByCommune,
    avecPrix: prix.length,
    avecTerrain,
    medianPrixM2: medianOf(prix),
  };
}

// ---------------------------------------------------------------------------
// Gardes avant swap
// ---------------------------------------------------------------------------

// Calibrées sur la mesure du 2026-11-06 (`full-2025` + `full-2026-s1`). Pas de
// `assertStagingRowBand` : le marché bouge de 19 %/an (2,57 M → 2,08 M lignes
// mesurées entre 2022 et 2023), une bande relative de −10 % sonnerait à tort.
// `shared.ts` le prévoit : une source à churn fort a SA bande, c'est celle-ci.

/** Mesuré : 1 609 828. */
export const MIN_ROWS = 1_100_000;
export const MAX_ROWS = 2_400_000;
/** Mesuré : 32 635. */
export const MIN_COMMUNES = 29_000;
export const MAX_COMMUNES = 35_500;
/** Mesuré : 2 650 €/m². */
export const MIN_MEDIAN_PRIX_M2 = 1_500;
export const MAX_MEDIAN_PRIX_M2 = 5_000;
/** Part du mois le plus fourni exigée de chaque mois de la fenêtre. Mesuré : 58 % au minimum. */
export const MIN_MONTH_SHARE = 0.3;
export const MAX_INVALID_RATE = 0.001;
/** Mesuré : 1,2 % à 3,8 %. */
export const MAX_NO_COORDS_RATE = 0.15;
/** Retard maximal du dernier mois sur l'horloge, en mois, avant de déclarer la source tarie. */
export const MAX_LAST_MONTH_LAG = 12;

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Les 45 arrondissements de Paris, Lyon et Marseille (mesuré : 45/45). */
export const PLM_ARRONDISSEMENTS: readonly string[] = [
  ...range(75101, 75120),
  ...range(69381, 69389),
  ...range(13201, 13216),
];

/** Codes ville : DVF n'y porte aucune vente (mesuré : 0), tout est aux arrondissements. */
export const PLM_CODES_VILLE: readonly string[] = ["75056", "69123", "13055"];

/** Throw `IngestError("validate")` au premier refus : aucun swap sur un fichier suspect. */
export function validateDvfAggregate(agg: DvfAggregate): void {
  const fail = (msg: string): never => {
    throw new IngestError("validate", `${msg} Swap refusé.`);
  };
  if (agg.lignesLues === 0) fail("Aucune ligne lue : fichiers vides ou parseur cassé.");

  const invalidRate = agg.invalides / agg.lignesLues;
  if (invalidRate > MAX_INVALID_RATE) {
    fail(
      `${agg.invalides}/${agg.lignesLues} lignes invalides (${(invalidRate * 100).toFixed(3)} % > ${MAX_INVALID_RATE * 100} %) : colonne renommée ou format changé.`,
    );
  }
  const noCoordsRate = agg.sansCoords / agg.lignesLues;
  if (noCoordsRate > MAX_NO_COORDS_RATE) {
    fail(
      `${agg.sansCoords}/${agg.lignesLues} lignes sans coordonnées (${(noCoordsRate * 100).toFixed(1)} % > ${MAX_NO_COORDS_RATE * 100} %) : géolocalisation Etalab dégradée.`,
    );
  }
  if (agg.rows.length < MIN_ROWS || agg.rows.length > MAX_ROWS) {
    fail(`${agg.rows.length} lignes gardées hors [${MIN_ROWS}, ${MAX_ROWS}].`);
  }
  const communes = agg.rowsByCommune.size;
  if (communes < MIN_COMMUNES || communes > MAX_COMMUNES) {
    fail(`${communes} communes hors [${MIN_COMMUNES}, ${MAX_COMMUNES}] : fichier amputé.`);
  }
  const absents = PLM_ARRONDISSEMENTS.filter((c) => !agg.rowsByCommune.has(c));
  if (absents.length > 0) {
    fail(`Arrondissements sans aucune ligne : ${absents.join(", ")} (mesuré : 45/45 présents).`);
  }
  const villes = PLM_CODES_VILLE.filter((c) => agg.rowsByCommune.has(c));
  if (villes.length > 0) {
    fail(
      `Lignes sur les codes ville ${villes.join(", ")} (mesuré : 0) : découpage arrondissements changé.`,
    );
  }

  const last = agg.lastMonth ?? fail("Aucun mois valide rencontré.");
  const counts = dvfWindowMonths(last).map((m) => [m, agg.rowsByMonth.get(m) ?? 0] as const);
  const fullest = Math.max(...counts.map(([, n]) => n));
  const thin = counts.filter(([, n]) => n < fullest * MIN_MONTH_SHARE);
  if (thin.length > 0) {
    const detail = thin.map(([m, n]) => `${m}=${n}`).join(", ");
    fail(
      `Mois absents ou trop maigres sous ${MIN_MONTH_SHARE * 100} % du mois le plus fourni (${fullest}) : ${detail}.`,
    );
  }

  const median = agg.medianPrixM2;
  if (median === null || median < MIN_MEDIAN_PRIX_M2 || median > MAX_MEDIAN_PRIX_M2) {
    fail(
      `Médiane nationale ${median ?? "absente"} €/m² hors [${MIN_MEDIAN_PRIX_M2}, ${MAX_MEDIAN_PRIX_M2}] : colonne décalée ou unité changée.`,
    );
  }
}

/**
 * Source tarie ? Rend la raison (→ run `partial`, pas `failed`, comme Sit@del : la
 * vigie ouvre une issue idempotente, un échec mensuel rouvrirait une alerte à chaque
 * cron) ou `null` si le dernier mois reste dans la cadence.
 */
export function staleDvfReason(lastMonth: string, now: Date): string | null {
  const year = Number(lastMonth.slice(0, 4));
  const month = Number(lastMonth.slice(5, 7));
  const lag = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month);
  if (lag <= MAX_LAST_MONTH_LAG) return null;
  return `source tarie : dernier mois publié ${lastMonth} = ${lag} mois de retard (> ${MAX_LAST_MONTH_LAG}) : livraison DVF figée côté DGFiP/Etalab`;
}

/**
 * La table n'a pas de clé primaire : un lot rejoué après une réponse perdue se
 * dupliquerait sans erreur. Ce compte est le filet, il précède le swap. BIGINT :
 * PostgREST peut le rendre en string, `parseRpcCount` couvre les deux formes.
 */
export function assertDvfStagingCount(rawCount: unknown, expected: number): number {
  let count: number;
  try {
    count = parseRpcCount(rawCount, "ingest_analyze_dvf_mutations_staging");
  } catch (err) {
    console.error("[dvf] compte de la staging illisible :", err);
    throw new IngestError("validate", err instanceof Error ? err.message : String(err), err);
  }
  if (count !== expected) {
    throw new IngestError(
      "validate",
      `dvf_mutations_staging contient ${count} lignes, ${expected} insérées attendues (lot dupliqué ou perdu). Swap refusé.`,
    );
  }
  return count;
}

/** Un dry-run laisse la prod intacte et n'écrit pas `success` : dans le cron, il passerait pour un cron vert. */
export function assertDvfDryRunAllowed(dryRun: boolean, githubEventName: string | undefined): void {
  if (dryRun && githubEventName === "schedule") {
    throw new IngestError(
      "validate",
      "DVF_DRY_RUN refusé sur un déclenchement `schedule` : un dry-run ne doit jamais passer pour un cron vert.",
    );
  }
}
