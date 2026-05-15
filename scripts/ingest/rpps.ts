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
import { deriveDeptFromCp } from "../../src/territoire/dept-codes.js";
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
  runBatchedRpc,
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
 * quand la row est enrichie via JOIN sur `num_finess`. NULL = pas de geom.
 *
 * Const exporté pour servir de source unique de vérité (TS + SQL + tests).
 */
export const GEOM_SOURCES = {
  COMMUNE_CENTROID: "commune_centroid",
  FINESS_JOIN: "finess_join",
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

    // 6. ATOMIC SWAP
    await atomicSwapTables({ prodTable: "rpps" });

    // 6b. REFRESH MATERIALIZED VIEWS post-swap. Les matviews `rpps_count_stats`
    // (V0.8.3) et `rpps_savoir_faire_stats` (V0.8.2) pré-agrègent les comptages
    // RPPS pour servir `densite_professionnels_sante` (compare_national) et
    // `lister_specialites_medicales` en <50 ms. Sans REFRESH après l'ingest
    // mensuel, elles dérivent silencieusement vs la prod (= les tools retournent
    // des stats du mois précédent). CONCURRENTLY car les deux ont un UNIQUE
    // INDEX et sont consultées par des requêtes anon en parallèle — un REFRESH
    // non-concurrent poserait un AccessExclusiveLock bloquant.
    //
    // Erreur ici ne bloque PAS la prod (le swap est déjà commit), on log et on
    // capture en ingest_log pour observabilité. Sentry côté MCP attrapera la
    // matview vide (sentinelle SQLSTATE P0002 dans count_rpps).
    await refreshRppsMatviews(supabase, log);

    // 6c. CANARY POST-SWAP. Cibles seedées dans la migration `_canary_seed_rpps`
    // (placeholders à valider post 1er run prod — log warn non-bloquant si
    // tous missing tant que les vrais IDNPS référents n'ont pas remplacé les
    // placeholders).
    await runAndRecordCanary(supabase, "rpps", log, "rpps");

    // IMPORTANT : préserver un éventuel `status: "partial"` posé par
    // `refreshRppsMatviews` (V0.9). `runAndRecordCanary` actuel ne pose pas
    // "partial" — il remplit seulement `canary_failures`. Si un futur change
    // y ajoute "partial", ce check le préserve aussi. Écraser inconditionnel-
    // lement masquerait un incident d'observabilité (régression V0.9 Passe 1).
    if (log.status !== "partial") {
      log.status = "success";
    }
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

  // PGRST204 = column not found in schema cache (ex: `geom_source` ajouté
  // récemment), PGRST205 = table not found. Les deux signalent le même
  // phénomène — PostgREST n'a pas encore propagé le NOTIFY 'reload schema'
  // posté par la RPC SECURITY DEFINER. Retry exponentiel couvre les 2.
  const isSchemaCacheMiss = (err: { code?: string } | null): boolean =>
    err?.code === "PGRST204" || err?.code === "PGRST205";

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
 * Refresh des matviews dépendantes de la table `rpps` après swap atomique.
 *
 * Trois matviews à refresh :
 *   - `rpps_savoir_faire_stats` (V0.8.2) → `lister_specialites_medicales`
 *   - `rpps_count_stats` (V0.8.3) → `densite_professionnels_sante` (compare_national)
 *   - `rpps_commune_centroids` (V0.10.2) → `rpps_in_radius` (pré-résolution
 *     rayon ; sans refresh, les centroïdes restent figés au mois précédent
 *     → un PS d'une commune nouvellement peuplée serait invisible au rayon)
 *
 * Best-effort : le swap est déjà commit, on n'annule pas la prod si REFRESH
 * échoue. Cas de fail attendus :
 *   - statement_timeout : ne devrait pas arriver côté service_role (timeout
 *     bien plus élevé que côté anon), mais on log au cas où.
 *   - lock conflict : query anon massive en cours sur la matview pendant
 *     REFRESH CONCURRENTLY → retry possible, ici on accepte l'échec.
 *   - relation does not exist : env dev sans matview (migration pas appliquée).
 *
 * Tous les fails sont console.error + marquent le log entry "partial" pour
 * surfacer côté dashboard. La sentinelle SQLSTATE P0002 dans `count_rpps`
 * (matview vide) catchera de toute façon une matview cassée côté MCP via Sentry.
 *
 * Exporté pour testabilité unitaire.
 */
export async function refreshRppsMatviews(
  supabase: SupabaseClient,
  log: IngestLogEntry,
): Promise<void> {
  const matviews = [
    "rpps_savoir_faire_stats",
    "rpps_count_stats",
    "rpps_commune_centroids",
  ] as const;
  const failures: string[] = [];

  for (const matview of matviews) {
    const start = Date.now();
    const { error } = await supabase.rpc("ingest_refresh_matview", {
      p_matview: matview,
    });
    const elapsedMs = Date.now() - start;

    if (error) {
      console.error(
        `[rpps] REFRESH MATERIALIZED VIEW ${matview} failed [code=${error.code ?? "none"}] after ${elapsedMs}ms: ${error.message}`,
      );
      failures.push(`${matview} (${error.code ?? "no_code"}: ${error.message})`);
      continue;
    }

    console.log(`[rpps] REFRESH MATERIALIZED VIEW ${matview} CONCURRENTLY OK in ${elapsedMs}ms`);
  }

  if (failures.length > 0) {
    log.status = "partial";
    const previousMsg = log.error_message ? `${log.error_message}; ` : "";
    log.error_message = `${previousMsg}post-swap matview refresh failed: ${failures.join(", ")}`;
  }
}

export const __TESTING__ = { parseRppsRecord, COL, refreshRppsMatviews };

await runIfMain(import.meta.url, main);
