import "./load-env.js";
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
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
 */

const RPPS_CSV_URL =
  process.env.RPPS_CSV_URL ??
  "https://www.data.gouv.fr/api/1/datasets/r/fffda7e9-0ea2-4c35-bba0-4496f3af935d";

/** ~803 Mo CSV en steady state. 600 Mo floor catche les troncations sans
 * faux positif sur une variation mensuelle classique (±5%). */
const MIN_SIZE_BYTES = 600_000_000;
/**
 * Volumétrie cible : 2 230 K lignes (annoncé ANS au 2026-05-05). Bounds larges
 * (1.8M – 2.6M) pour absorber la croissance organique du référentiel sans
 * trigger faux. Au-dessus de 2.6M : suspicion changement de format ANS.
 */
const MIN_ROWS = 1_800_000;
const MAX_ROWS = 2_600_000;

/**
 * Insertions par batch. 1000 (vs 500 Ameli) car le volume est 4× plus grand
 * et le payload row est comparable — économise 2200 round-trips Supabase
 * sur l'ingestion complète. Reste sous le 65 KB postgrest hard limit.
 */
const BATCH_SIZE = 1_000;

const SAMPLE_CAP = 200;
/** Tolérance unmatched-locality (idem Ameli). */
const UNMATCHED_LOCALITY_THRESHOLD = 0.08;
/** Tolérance fail structurel (idem Ameli). */
const STRUCTURAL_FAIL_THRESHOLD = 0.01;

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
  code_departement: string;
  code_insee: string | null;
  telephone: string | null;
  email: string | null;
  geom: string | null;
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
    const [downloaded, lastSha] = await Promise.all([
      downloadCsv(RPPS_CSV_URL, "rpps-personne-activite.txt"),
      getLastSuccessChecksum("rpps"),
    ]);
    log.csv_size_bytes = downloaded.sizeBytes;
    log.csv_sha256 = downloaded.sha256;

    if (await shortCircuitIfSameChecksum(log, lastSha, downloaded.sha256, "rpps")) return;

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
      throw new IngestError(
        "copy",
        `Failed to create rpps_staging table: ${stagingErr.message}`,
      );
    }
    // Pas de sleep avant le 1er INSERT : `flush()` retry sur PGRST205 (schema
    // cache miss) avec backoff exponentiel — couvre déjà le cas. Plus le
    // `NOTIFY pgrst, 'reload schema'` posté par la RPC SECURITY DEFINER.

    const stats = await streamCsvToStaging(downloaded.filePath, supabase, communeIndex);
    log.row_count = stats.inserted;

    // 5. VALIDATE COHERENCE
    console.log(
      `[rpps] insert summary: inserted=${stats.inserted}, no_identity=${stats.skippedNoIdentity}, no_locality=${stats.skippedNoLocality}, unmatched_locality=${stats.skippedUnmatchedLocality}`,
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
    if (denominator === 0) {
      throw new IngestError(
        "validate",
        `Pipeline produced zero parser events. Refuse to swap an empty table into prod.`,
      );
    }
    const rateOf = (failures: number) => failures / denominator;

    const structuralFailures = stats.skippedNoIdentity + stats.skippedNoLocality;
    const structuralRate = rateOf(structuralFailures);
    const unmatchedRate = rateOf(stats.skippedUnmatchedLocality);

    if (structuralFailures > 0) {
      console.warn(
        `[rpps] structural skips: ${stats.skippedNoIdentity} no_identity, ${stats.skippedNoLocality} no_locality (${fmt(structuralRate)} of total)`,
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
        `[rpps] unmatched localities: ${stats.skippedUnmatchedLocality} (${fmt(unmatchedRate)}). Top: ${topUnmatched}`,
      );
      if (stats.unmatchedDistinctKeysDropped > 0) {
        console.warn(
          `[rpps] sample cap saturated: ${stats.unmatchedDistinctKeysDropped} distinct unmatched (cp,ville) keys not tracked.`,
        );
      }
      if (unmatchedRate > UNMATCHED_LOCALITY_THRESHOLD) {
        throw new IngestError(
          "validate",
          `Unmatched-locality rate ${fmt(unmatchedRate)} above ${fmt(UNMATCHED_LOCALITY_THRESHOLD)} — likely INSEE commune drift`,
        );
      }
    }

    // 6. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "rpps" });

    // 6b. CANARY POST-SWAP. Cibles seedées dans la migration `_canary_seed_rpps`
    // (placeholders à valider post 1er run prod — log warn non-bloquant si
    // tous missing tant que les vrais IDNPS référents n'ont pas remplacé les
    // placeholders).
    await runAndRecordCanary(supabase, "rpps", log, "rpps");

    log.status = "success";
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    const elapsedSec = (new Date(log.finished_at).getTime() - new Date(startedAt).getTime()) / 1000;
    console.log(`[rpps] success: ${stats.inserted} rows ingested in ${elapsedSec}s`);
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
    log.error_message = ingestErr.message;
    log.finished_at = new Date().toISOString();
    await writeIngestLog(log);
    console.error(`[rpps][ingest_log_fallback] ${safeSerializeIngestLog(log)}`);
    console.error(`[rpps] FAILED at ${ingestErr.phase}: ${ingestErr.message}`);
    process.exit(1);
  }
}

interface IngestStreamStats {
  inserted: number;
  skippedNoIdentity: number;
  skippedNoLocality: number;
  skippedUnmatchedLocality: number;
  unmatchedSampleCounts: Map<string, number>;
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
      delimiter: "|",
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }),
  );

  let batch: RppsStagingRow[] = [];
  let inserted = 0;
  let skippedNoIdentity = 0;
  let skippedNoLocality = 0;
  let skippedUnmatchedLocality = 0;
  let unmatchedDistinctKeysDropped = 0;
  const unmatchedSampleCounts = new Map<string, number>();
  let firstBatch = true;

  const isSchemaCacheMiss = (err: { code?: string } | null): boolean => err?.code === "PGRST205";

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const maxAttempts = firstBatch ? 4 : 1;
    let lastErr: { message: string; code?: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const wait = 2000 * attempt;
        console.warn(`[rpps] schema cache miss, retry ${attempt}/3 in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
      const { error } = await supabase.from("rpps_staging").insert(batch);
      if (!error) {
        lastErr = null;
        break;
      }
      lastErr = error;
      if (!isSchemaCacheMiss(error)) break;
    }
    firstBatch = false;
    if (lastErr) {
      console.error("[rpps] insert into rpps_staging failed:", lastErr);
      throw new IngestError(
        "copy",
        `Insert into rpps_staging failed [code=${lastErr.code ?? "none"}]: ${lastErr.message}`,
        lastErr,
      );
    }
    inserted += batch.length;
    batch = [];
  };

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const parsed = parseRppsRecord(record, index);
    if (parsed.row) {
      batch.push(parsed.row);
    } else {
      const reason = parsed.skipReason;
      switch (reason) {
        case "no_identity":
          skippedNoIdentity++;
          break;
        case "no_locality":
          skippedNoLocality++;
          break;
        case "unmatched_locality": {
          skippedUnmatchedLocality++;
          // sampleKey est non-optional dans la branche unmatched_locality du
          // discriminated union (pas besoin de garde supplémentaire).
          const { sampleKey } = parsed;
          const current = unmatchedSampleCounts.get(sampleKey);
          if (current !== undefined || unmatchedSampleCounts.size < SAMPLE_CAP) {
            unmatchedSampleCounts.set(sampleKey, (current ?? 0) + 1);
          } else {
            unmatchedDistinctKeysDropped++;
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
    skippedNoIdentity,
    skippedNoLocality,
    skippedUnmatchedLocality,
    unmatchedSampleCounts,
    unmatchedDistinctKeysDropped,
  };
}

type SkipReason = "no_identity" | "no_locality" | "unmatched_locality";

type ParsedRppsRow =
  | { row: RppsStagingRow; skipReason?: never; sampleKey?: never }
  | { row?: never; skipReason: Exclude<SkipReason, "unmatched_locality">; sampleKey?: never }
  | { row?: never; skipReason: "unmatched_locality"; sampleKey: string };

/**
 * Parse une ligne RPPS en row staging. Les ratés non-bloquants (manque
 * d'identité, locality unmatched, etc.) sont retournés comme skipReason
 * pour que le caller threshold-aborte le run global si trop fréquents.
 */
export function parseRppsRecord(
  rec: Record<string, string>,
  index: CommuneIndex,
): ParsedRppsRow {
  const rppsId = getNonEmpty(rec, COL.RPPS_ID);
  const nom = getNonEmpty(rec, COL.NOM) ?? "";
  const prenom = getNonEmpty(rec, COL.PRENOM) ?? "";
  // Skip si rpps_id manquant OU si nom OU prénom vide. La duplication
  // `nom = prenom` quand l'un manque masquait silencieusement une donnée
  // partielle ; mieux vaut tracker ces lignes en `no_identity` et alerter
  // par le threshold structurel si elles deviennent fréquentes.
  if (!rppsId || !nom || !prenom) return { skipReason: "no_identity" };

  const codePostalRaw = getNonEmpty(rec, COL.CODE_POSTAL);
  const villeRaw = getNonEmpty(rec, COL.LIBELLE_COMMUNE);
  if (!codePostalRaw && !villeRaw) return { skipReason: "no_locality" };

  const matched: IndexedCommune | null = matchCommune(index, codePostalRaw, villeRaw);
  if (!matched) {
    return {
      skipReason: "unmatched_locality",
      sampleKey: `${codePostalRaw ?? "?"}|${villeRaw ?? "?"}`,
    };
  }

  // Reconstruit l'adresse littérale (numéro + type voie + libellé voie). On
  // joint les segments présents avec un espace, on évite "null null null"
  // quand ils sont tous vides.
  const adresseParts = [
    getNonEmpty(rec, COL.NUM_VOIE),
    getNonEmpty(rec, COL.TYPE_VOIE_LIBELLE),
    getNonEmpty(rec, COL.VOIE),
  ].filter((s): s is string => Boolean(s));
  const adresse = adresseParts.length > 0 ? adresseParts.join(" ") : null;

  const geom = `SRID=4326;POINT(${matched.lon} ${matched.lat})`;

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
      code_departement: matched.codeDepartement,
      code_insee: matched.codeInsee,
      telephone: getNonEmpty(rec, COL.TELEPHONE),
      email: getNonEmpty(rec, COL.EMAIL),
      geom,
      // V0.4.1 lesson : pas de raw JSONB stocké (économise ~70% du poids row
      // sur 2.23M lignes = ~1.5 GB sur Pro tier 8GB). Jamais lu côté tools.
      raw: {},
    },
  };
}

export const __TESTING__ = { parseRppsRecord, COL };

await runIfMain(import.meta.url, main);
