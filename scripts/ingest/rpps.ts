import "./load-env.js";
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import {
  type BanGeocodeResult,
  banLastStatus,
  geocodeAddressesBatch,
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
  atomicSwapTables,
  downloadCsv,
  getLastSuccessChecksum,
  getNonEmpty,
  getUntypedServiceClient,
  insertStagingBatchWithRetry,
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
 * Étape BAN (best-effort) — géocodage adresse fine des rows RPPS restées au
 * centroïde commune ou sans geom. Constantes dédiées, sémantique DISJOINTE des
 * compteurs FINESS (`geoRate`/`matchRate`/`STRUCTURAL_FAIL_THRESHOLD`).
 */
const BAN_GEOCODE_BATCH_SIZE = 10_000;
// Taille d'UN POST à l'endpoint BAN bulk CSV. GATE G6 : à 10 000 lignes/POST
// sous volume soutenu, l'endpoint BAN lâche la connexion (`terminated`) —
// ~220k adresses perdues en un run. 2 000 = POST fiables, échec résiduel
// borné à 2k (re-tentées au run suivant). Jumeau `ban-backfill.mjs` porte
// la MÊME valeur — ne pas désynchroniser. NE concerne QUE le POST BAN ;
// upsert cache + p_limit RPC d'application restent `BAN_GEOCODE_BATCH_SIZE`.
const BAN_BULK_CHUNK = 2_000;
/**
 * Seuil d'acceptation d'un résultat BAN. F3 / leçon audit-P2 : un seuil global
 * 0.5 laisse passer des substitutions `housenumber` erronées (un numéro voisin
 * accepté à tort). Le géocodeur de référence du projet (territoire/geocode.ts)
 * exige >=0.7 par type — on aligne ici sur 0.7, le 0.5 du plan d'origine est
 * SUPERSEDED par F3. (Le client applique aussi un filtre type
 * housenumber/street ; le seuil de score reste la garde principale.)
 */
const BAN_ACCEPT_SCORE = 0.7;
/**
 * Plafond du ratio `apiFailures / chunksTotal` au-delà duquel l'étape est
 * jugée dégradée → `log.status = "partial"`. > 50 % des chunks en échec HTTP =
 * BAN globalement instable sur ce run (distinct d'un "0 résultat" qualité).
 */
const BAN_API_FAILURE_CEILING = 0.5;
/**
 * Cap de tentatives sur une clé `accepted=false` : au-delà, on ne re-soumet
 * plus l'adresse à BAN (adresse durablement non résolue — évite de re-payer
 * un appel chaque mois pour un échec stable). Les clés `accepted=true` sont
 * figées (jamais re-soumises) ; les clés jamais vues sont toujours soumises.
 */
const BAN_MAX_ATTEMPTS = 3;
/**
 * STEP A (stratégie A+B, plan Task 12) — plafond du nombre d'adresses
 * DISTINCTES PAS ENCORE en cache soumises à BAN sur UN run mensuel.
 *
 * Mesuré PHASE 0 (2026-05-16) : ~339 164 adresses distinctes éligibles
 * (> 250k → multi-runs obligatoire). Le backfill one-shot (STEP B,
 * `scripts/ban-backfill.mjs`) remplit le cache vite ; ce plafond est le
 * FILET : si le backfill est interrompu (ou jamais lancé), chaque cron
 * mensuel rattrape au plus N nouvelles adresses et le reste converge run
 * après run via le cache persistant `geocoded_addresses` (les clés résolues
 * y sont figées `accepted=true`, donc filtrées AVANT le cap au run suivant —
 * la "tête" non soumise avance, le backlog draine de façon monotone).
 *
 * Valeur = 120_000 : compromis convergence vs quota BAN. À 120k/run le
 * backlog de ~339k est résorbé en ≈3 runs si le backfill n'a rien fait,
 * tout en restant un volume qu'un seul run mensuel encaisse sans saturer
 * l'API BAN (chunks de 2000, F2 borne chaque requête). Plus haut sature le
 * quota ; plus bas ralentit la convergence sans bénéfice.
 *
 * Le cap ne borne QUE les NOUVELLES soumissions BAN : les lignes déjà
 * cachées (accepted) sont TOUJOURS appliquées via la RPC (le cap n'y touche
 * pas). Le cap est du fonctionnement NORMAL — il ne dégrade JAMAIS le statut.
 */
const BAN_MAX_NEW_PER_RUN = 120_000;
/**
 * F2 — borne par requête chunk passée à `geocodeAddressesBatch`. Un socket
 * BAN figé ne doit pas bloquer indéfiniment le cron mensuel (jusqu'à 120k
 * adresses → chunks de 2000). 90 s : marge confortable pour un gros chunk
 * lent côté BAN sans laisser un hang réel non borné. Le client retry chaque
 * timeout (transitoire) mais CHAQUE tentative est elle-même bornée → temps
 * total borné.
 */
const BAN_REQUEST_TIMEOUT_MS = 90_000;
/**
 * Borne CHAQUE lecture RPC d'énumération d'éligibilité BAN
 * (`rpps_distinct_eligible_keys`). Le code antérieur paginait
 * `rpps_staging` en RAM via `.range()` SANS AUCUN timeout sur les lectures :
 * seuls les appels HTTP BAN étaient bornés (F2). Un socket Supabase figé sur
 * une page d'énumération pendait donc indéfiniment — root cause du hang
 * silencieux de ~30 min observé en prod (la même boucle re-tournée par le
 * cron mensuel). 60 s : marge confortable pour une page keyset server-side
 * (skip-scan borné + index fonctionnel partiel) même sous charge, sans
 * laisser un hang réel non borné. Un dépassement tombe dans le catch
 * best-effort (`log.status="partial"`, jamais de throw, finess_join intact).
 */
const RPC_READ_TIMEOUT_MS = 60_000;

// Borne ANTI-HANG par batch de `runBatchedRpc` au step 7 (application
// cache→staging `ingest_apply_rpps_ban_geocoding_batch`). 120 s = large
// au-dessus d'un batch légitime (statement_timeout serveur ~55 s + réseau)
// → aucun faux `partial` sur un batch lent ; borne en revanche un socket
// figé (sinon hang non borné jusqu'au kill GitHub Actions, sans `partial`
// ni `ingest_log` — même classe que `RPC_READ_TIMEOUT_MS` ferme sur les
// lectures, /review P1 silent-failure MEDIUM-1).
const RPC_BATCH_TIMEOUT_MS = 120_000;

// Bornes ANTI-HANG des RPC fail-loud 5a/5c/5d du cron (mêmes raisons que
// ci-dessus, /review P2 silent-failure MEDIUM-1 : un `supabase.rpc()` brut
// sur socket figé pendrait jusqu'au kill GitHub Actions, et ces étapes sont
// fail-loud → un hang y tue TOUT le cron RPPS sans `partial`/`ingest_log`).
// ANALYZE : statement_timeout serveur 55 s (fix C2) → 120 s côté client.
// BUILD INDEX : statement_timeout serveur 10 min (migration 20260519T100000)
// → 15 min côté client (DOIT excéder la borne serveur sinon un build long
// LÉGITIME serait faussement coupé).
const RPC_ANALYZE_TIMEOUT_MS = 120_000;
const RPC_BUILD_INDEX_TIMEOUT_MS = 900_000;

// Lecture cache via RPC `rpps_geocoded_cache_lookup` (clés en BODY POST, PAS
// `.in()` en URL GET) — batch large : ~670 requêtes → ~34 (incident GATE G5,
// surface d'échec transport séquentiel ÷ ~20). 10k clés ≈ ~0,5 Mo payload,
// sous toute limite body PostgREST. Niveau module par symétrie avec le jumeau
// `ban-backfill.mjs` (ne pas désynchroniser la valeur).
const CACHE_LOOKUP_BATCH = 10_000;

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

    // 5c. BUILD INDEX BAN sur rpps_staging — APRÈS l'enrichment FINESS (données
    // stabilisées) et AVANT le swap. Décision d'archi (doc PostgreSQL
    // « Populating a Database ») : construire les 2 index fonctionnels BAN
    // Unicode-lourds une fois sur données stabilisées, jamais les maintenir
    // pendant l'INSERT 2,24 M / l'UPDATE d'enrichment (= l'AGGRAVANT prouvé
    // du 57014). `rpps_staging` ne sert AUCUNE lecture prod → CREATE INDEX
    // bloquant classique sans impact externe ; les 2 index voyagent dans
    // `rpps` via le RENAME du swap. FAIL-LOUD : sans ces index la RPC
    // d'énumération BAN (5e) full-scanne 2,24 M lignes et timeoute à 60 s →
    // on échoue le run (IngestError) plutôt que de dégrader silencieusement.
    // Wrappé `retryTransient` : un blip transport supabase-js (cron NON
    // surveillé) ne doit pas tuer un run par ailleurs sain. Un échec
    // applicatif revient en `{error}` (pas réessayé) → throw fail-loud.
    {
      // `withTimeout` À L'INTÉRIEUR de la tentative retryTransient : un blip
      // transport est réessayé (exigence G5), mais un socket FIGÉ pendant le
      // build d'index (10 min serveur) rejette `TimeoutError` — exclu du
      // retry par `name` (contrat with-timeout/retry-transient) → propagé,
      // converti ici en IngestError fail-loud (sinon hang muet du cron non
      // surveillé, /review P2 silent-failure MEDIUM-1).
      let buildRes: Awaited<ReturnType<typeof supabase.rpc>>;
      try {
        buildRes = await retryTransient(
          () =>
            withTimeout(
              supabase.rpc("ingest_build_rpps_staging_ban_indexes"),
              RPC_BUILD_INDEX_TIMEOUT_MS,
              "ingest_build_rpps_staging_ban_indexes",
            ),
          "ingest_build_rpps_staging_ban_indexes",
          {
            isRetryableResult: (r: { error?: unknown } | null) =>
              isTransientSupabaseError(r?.error),
          },
        );
      } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") {
          console.error(
            `[france-data-mcp][rpps] ingest_build_rpps_staging_ban_indexes timed out after ${RPC_BUILD_INDEX_TIMEOUT_MS}ms — anti-silent-hang bound, failing loud`,
          );
          throw new IngestError(
            "validate",
            `Failed to build rpps_staging BAN indexes: timed out after ${RPC_BUILD_INDEX_TIMEOUT_MS}ms (anti-silent-hang bound)`,
          );
        }
        throw e;
      }
      const { error: buildIdxError } = buildRes;
      if (buildIdxError) {
        throw new IngestError(
          "validate",
          `Failed to build rpps_staging BAN indexes: ${buildIdxError.message}${missingRpcHint(buildIdxError.message)}`,
        );
      }
    }

    // 5d. RE-ANALYZE rpps_staging — le planner DOIT voir les 2 index
    // fonctionnels BAN neufs (stats fraîches) sinon il les ignore et la RPC
    // d'énumération (5e) retombe sur un full-scan + timeout 60 s au cron.
    // fail-loud (même contrat que 5a) : un ANALYZE raté avant l'énumération
    // est une cause-racine connue du blocker, pas un détail tolérable ici.
    await callRpcFailLoud(
      supabase,
      "ingest_analyze_rpps_staging",
      RPC_ANALYZE_TIMEOUT_MS,
      "Failed to re-ANALYZE rpps_staging after BAN index build",
    );

    // 5e. BAN GEOCODING (best-effort, AVANT le swap : tourne sur rpps_staging
    // qui disparaît au swap). Géocode les rows restées au centroïde commune ou
    // sans geom, via le cache persistant `geocoded_addresses`. Compteurs &
    // seuil DÉDIÉS (disjoints des compteurs FINESS). N'altère JAMAIS
    // `finess_join`. Toute panne (BAN down, RPC/query KO) → log.status
    // "partial" + console.error, sans throw : l'ingestion mensuelle n'est
    // jamais bloquée par BAN. Le step pose éventuellement log.status="partial"
    // AVANT le bloc de finalisation `if (log.status !== "partial")` plus bas
    // qui le préserve (P16).
    await runBanGeocodeStep(supabase, log, "rpps_staging");

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
const TRANSIENT_REBUILD_CODES = new Set(["55P03", "40P01", "57014", "53300"]);

/**
 * Concatène `msg` à `log.error_message` en PRÉSERVANT l'existant (`a; b`).
 * Un échec/note antérieur ne doit jamais être écrasé silencieusement
 * (observabilité background : l'audit `ingest_log` doit cumuler les causes).
 */
function appendLogMessage(log: IngestLogEntry, msg: string): void {
  const prev = log.error_message ? `${log.error_message}; ` : "";
  log.error_message = `${prev}${msg}`;
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

  if (!error) {
    console.log(`[rpps] ingest_rebuild_rpps_matviews OK in ${elapsedMs}ms`);
    return;
  }

  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? String(error);
  const detail = `post-swap matview rebuild failed [code=${code ?? "none"}] after ${elapsedMs}ms: ${message}`;

  if (code !== undefined && TRANSIENT_REBUILD_CODES.has(code)) {
    // Transitoire : `ingest_rebuild_rpps_matviews` est transactionnelle →
    // rollback intégral → AUCUNE matview détruite, l'ancienne (peuplée,
    // juste périmée) reste en place. Dégradation bénigne, retry au prochain
    // cron. On NOMME la reconstruction (le statut seul ne dit pas QUOI est
    // dégradé — contrat alerting).
    console.error(`[rpps] ${detail} — transitoire, ancienne matview préservée (rollback)`);
    log.status = "partial";
    appendLogMessage(log, `post-swap matview rebuild (transient ${code}): ${message}`);
    return;
  }

  // Structurel : NE PAS avaler en "partial" (trou prouvé /review : matview
  // cassée → `rpps_in_radius` down, masqué non bloquant). Throw → catch de
  // `main` → status "failed" + exit(1) = LOUD.
  console.error(`[rpps] ${detail} — STRUCTUREL, échec dur`);
  throw new IngestError("validate", detail, error);
}

/**
 * Une ligne renvoyée par la RPC `rpps_distinct_eligible_keys`. La clé
 * d'adresse est calculée CÔTÉ SERVEUR (parité octet-à-octet avec
 * `normalizeAddressKey` 3-arg, prouvée par le HARD GATE de parité +
 * son test d'intégration). Le cron consomme `address_key` tel quel — il NE
 * recalcule PLUS la clé en JS (UNIQUE source de vérité SQL).
 */
interface DistinctKeyRow {
  address_key: string;
  adresse: string | null;
  code_postal: string | null;
  code_insee: string | null;
}

/** Une ligne du cache `geocoded_addresses` pour la décision de re-soumission. */
interface CachedAddressRow {
  address_key: string;
  accepted: boolean;
  ban_attempt_count: number;
}

/**
 * Étape 5e — Géocodage BAN best-effort sur `sourceTable` AVANT le swap.
 *
 * `sourceTable` ('rpps' | 'rpps_staging') voyage tel quel dans les RPC
 * `rpps_count_ban_eligible_rows` / `rpps_distinct_eligible_keys` (whitelist
 * CASE EXPLICITE côté SQL — hors whitelist ⇒ EXCEPTION, jamais de lignes
 * silencieuses). Le cron mensuel le câble à `'rpps_staging'` (la table en
 * cours d'ingestion, qui disparaît au swap : les coords précises voyagent
 * dans `rpps` via le RENAME). `ingest_analyze_rpps_staging` (interne 0) et
 * `ingest_apply_rpps_ban_geocoding_batch` (7) sont staging-only par contrat
 * SQL — pas de param table. La re-ANALYZE 5d a déjà rafraîchi le planner
 * AVANT cet appel ; l'ANALYZE interne (0) reste un best-effort idempotent
 * (jamais fatal) qui préserve la parité de logique interne avec le jumeau
 * one-shot `ban-backfill.mjs`.
 *
 * Pipeline interne (énumération CÔTÉ SERVEUR via RPC keyset skip-scan,
 * remplace la pagination full-RAM `.range()` pathologique) :
 *  0. `ingest_analyze_rpps_staging` (best-effort) AVANT toute énumération :
 *     rafraîchit les stats planner (dont les index fonctionnels partiels
 *     d'éligibilité) — sans stats fraîches la RPC d'énumération full-scanne
 *     et timeoute à 60 s sur le cron. Un échec ANALYZE = warn toléré (stats
 *     éventées ralentissent seulement), JAMAIS un abort.
 *  1. `rpps_count_ban_eligible_rows` → nb de LIGNES éligibles
 *     (`geom_source='commune_centroid'` OU `geom IS NULL AND adresse IS NOT
 *     NULL`) — `finess_join` JAMAIS éligible (exclu par le predicate SQL).
 *  2. `rpps_distinct_eligible_keys` keyset-paginée : énumère les clés
 *     DISTINCTES. La clé est calculée CÔTÉ SERVEUR (parité octet-à-octet avec
 *     `normalizeAddressKey` 3-arg garantie par le HARD GATE) — le cron
 *     NE recalcule PLUS la clé en JS (UNIQUE source de vérité SQL).
 *  3. Une adresse partagée par N praticiens = 1 clé distincte = 1 appel BAN.
 *  4. Filtre les clés à soumettre : `accepted=true` figées (jamais re-soumises),
 *     `accepted=false` seulement sous `BAN_MAX_ATTEMPTS`, clés jamais vues
 *     toujours soumises. STEP A : la liste triée est PLAFONNÉE à
 *     `BAN_MAX_NEW_PER_RUN` (filet de convergence si le backfill one-shot
 *     STEP B est interrompu) — backlog loggé, statut NON dégradé par le cap.
 *  5. `geocodeAddressesBatch` (seuil F3 0.7, F2 `requestTimeoutMs`).
 *  6. Upsert TOUS les `results` dans `geocoded_addresses` (acceptés avec coords ;
 *     non résolus en `accepted=false`, `ban_attempt_count+1`, `ban_last_status`).
 *  7. `runBatchedRpc(ingest_apply_rpps_ban_geocoding_batch)` avec
 *     `expectedTotal = eligibleRowCount` (P15 : nb de ROWS staging éligibles,
 *     PAS le nb d'adresses distinctes — sinon la garde anti-divergence de
 *     `runBatchedRpc` déclencherait un faux "did not converge").
 *  8. Seuil dédié `BAN_API_FAILURE_CEILING` : si le ratio
 *     `apiFailures / chunksTotal` le dépasse = panne API → `log.status="partial"`.
 *     Non-résolu/low-score seuls = qualité, NE basculent PAS partial.
 *
 * Best-effort : TOUTE exception (BAN down, RPC/query KO) est catchée,
 * `console.error("[france-data-mcp][rpps][ban_geocode_fallback] …")` AVANT tout
 * `writeIngestLog`, `log.status="partial"`, PAS de throw, `finess_join` jamais
 * touché. Distinction stricte : non-résolu/low-score = qualité (PAS partial en
 * soi) ; ratio `apiFailures/chunksTotal > BAN_API_FAILURE_CEILING` = panne API
 * → partial. Exporté pour testabilité unitaire.
 */
export async function runBanGeocodeStep(
  supabase: SupabaseClient,
  log: IngestLogEntry,
  sourceTable: "rpps" | "rpps_staging",
): Promise<void> {
  try {
    // MEDIUM-6 (review P1) : agrège les retries transport ABSORBÉS sur tout le
    // step. Une dégradation réseau chronique sous le seuil d'épuisement doit
    // être SYNTHÉTISÉE (résumé + audit trail ingest_log), pas seulement une
    // pluie de `console.warn` éparses — sinon un step qui frôle la panne en
    // continu est rapporté propre. Parité avec `apiFailures`.
    let transientRetries = 0;
    const countRetry = () => {
      transientRetries++;
    };
    // Options retryTransient communes aux 4 appels Supabase du step : agrège
    // les retries + détecte un échec transport revenu en `{ error }` RÉSOLU
    // (supabase-js ne throw PAS toujours — incident G5 prouvé en prod).
    const retryOpts = {
      onRetry: countRetry,
      isRetryableResult: (r: { error?: unknown } | null) => isTransientSupabaseError(r?.error),
    };
    // (0) ANALYZE rpps_staging AVANT toute énumération. Rafraîchit les stats
    // planner (dont les index fonctionnels partiels d'éligibilité) — sans
    // stats fraîches la RPC d'énumération full-scanne et timeoute à 60 s sur
    // le cron mensuel. Best-effort STRICT : un échec ANALYZE = warn toléré
    // (stats éventées ralentissent seulement l'énumération), JAMAIS un abort
    // (avorter tout le step sur un hoquet d'ANALYZE serait pire). C'est le
    // SEUL non-fatal toléré ici ; tout le reste reste fatal (catch best-effort).
    // 5d a déjà re-ANALYZE en amont (fail-loud) ; ce 2e ANALYZE idempotent
    // préserve la parité de logique interne avec le jumeau `ban-backfill.mjs`.
    {
      const { error: analyzeError } = await supabase.rpc("ingest_analyze_rpps_staging");
      if (analyzeError) {
        console.warn(
          `[france-data-mcp][rpps][ban_geocode] ANALYZE rpps_staging failed (continuing with possibly stale planner stats): ${analyzeError.message}`,
        );
      }
    }

    // (1) Compte de LIGNES éligibles via RPC server-side (predicate
    // byte-identique à l'énumération + à `ingest_apply_rpps_ban_geocoding_batch`).
    // `finess_join` JAMAIS éligible (exclu par le predicate SQL). P15 : c'est
    // le nb de ROWS staging éligibles — câblé tel quel en `expectedTotal` de
    // `runBatchedRpc` plus bas, JAMAIS `distinctKeys.length` (les lignes se
    // dédoublonnent en MOINS de clés ; un expectedTotal sous-évalué
    // déclencherait un faux "did not converge").
    // retryTransient (review P1 CRITIQUE 1) : absorbe un blip transport
    // supabase-js (`fetch failed`) sur le cron NON surveillé ; withTimeout
    // borne un hang (`TimeoutError` exclu du retry → throw → catch best-effort
    // `partial`, pas un hang mensuel jusqu'au kill GH Actions).
    const { data: countData, error: countError } = await retryTransient(
      () =>
        withTimeout(
          supabase.rpc("rpps_count_ban_eligible_rows", { p_source_table: sourceTable }),
          RPC_READ_TIMEOUT_MS,
          "rpps_count_ban_eligible_rows",
        ),
      "rpps_count_ban_eligible_rows",
      retryOpts,
    );
    if (countError) {
      throw new Error(`rpps_count_ban_eligible_rows failed: ${countError.message}`);
    }
    // BIGINT : PostgREST le renvoie en `number` (ou string décimale pour de
    // très grandes valeurs, ex. "339000"). Discipline fail-loud, calquée sur
    // `shared.ts:runBatchedRpc` (`typeof data !== "number"`) : on REJETTE
    // EXPLICITEMENT les formes non-count AVANT toute coercition, parce que
    // `Number(null)`, `Number("")`, `Number("  ")`, `Number("0x0")`,
    // `Number("0b0")`, `Number([])` valent tous `0` FINI — sans ce garde, une
    // régression de contrat se faufilerait en early-return success-shaped
    // "0 ligne" au lieu d'échouer bruyamment. PRÉCISÉMENT, rejeté fail-loud :
    //  - `null` ;
    //  - string vide `""` ;
    //  - type ≠ number ET ≠ string ;
    //  - string NON décimale-entière (regex `^\s*\d+\s*$` non satisfaite) :
    //    couvre `"  "`, `"\n"`, `"0x0"`, `"0b0"`, `"1e3"`, `"NaN"`, `"-5"`
    //    (un count est un entier non signé ; négatif/hex/binaire/notation
    //    scientifique/whitespace-seul ne sont JAMAIS une sérialisation
    //    PostgREST légitime d'un `RETURNS BIGINT`).
    // Encore valide → passe à la coercition `Number(...)` ci-dessous :
    //  - un `number` (fini ou non — le garde `Number.isFinite` suivant tranche) ;
    //  - une string décimale-entière (`"339000"`, et le vrai zéro `"0"`).
    // Le SEUL vrai zéro légitime (`0` ou `"0"`) ⇒ early-return success-shaped
    // BYTE-IDENTIQUE plus bas (PAS une régression : rien à géocoder).
    // Reste dans le try du cron → catch best-effort (status partial), JAMAIS
    // un throw hors de runBanGeocodeStep.
    const eligibleRowCount = parseRpcCount(countData, "rpps_count_ban_eligible_rows");
    if (eligibleRowCount === 0) {
      console.log(
        "[rpps] BAN geocoding: 0 new / 0 cached / 0 accepted / 0 rejected_low_score / 0 unresolved / 0 contract_breach_downgrades / 0 api_failures / 0 rows_applied",
      );
      return;
    }

    // (2)+(3) Énumération keyset des clés DISTINCTES via RPC server-side. La
    // clé `address_key` est calculée CÔTÉ SERVEUR (parité octet-à-octet avec
    // `normalizeAddressKey` 3-arg garantie par le HARD GATE + son test
    // d'intégration) — le cron NE recalcule PLUS la clé en JS : UNIQUE source
    // de vérité SQL. INVARIANT cap-agnostic (anti-S-1) : on termine
    // UNIQUEMENT sur une page VIDE et on avance `after` sur la DERNIÈRE clé
    // reçue. La RPC garantit clés strictement croissantes + au plus `p_limit`
    // lignes ; si le serveur en renvoie MOINS que `KEYSET_PAGE` (cap
    // PostgREST `config.toml:max_rows` < KEYSET_PAGE, cf. CLAUDE.md "PostgREST
    // max_rows"), on NE DOIT JAMAIS `break` sur `rows.length < KEYSET_PAGE` :
    // ce serait la classe de panne totale silencieuse S-1 (troncature ~99.7%
    // rapportée en "success"). Le `!has` est défensif (la RPC garantit déjà
    // l'unicité). Chaque lecture est BORNÉE par `withTimeout` (le code
    // antérieur n'avait AUCUN timeout sur les lectures — root cause du hang
    // silencieux ~30 min). Un dépassement → catch best-effort.
    const KEYSET_PAGE = 1000;
    const distinctKeyInputs = new Map<
      string,
      { adresse: string; codePostal: string; codeInsee: string }
    >();
    let after: string | null = null;
    let pageCount = 0;
    for (;;) {
      const { data, error } = await retryTransient(
        () =>
          withTimeout(
            supabase.rpc("rpps_distinct_eligible_keys", {
              p_source_table: sourceTable,
              p_after: after,
              p_limit: KEYSET_PAGE,
            }),
            RPC_READ_TIMEOUT_MS,
            "rpps_distinct_eligible_keys",
          ),
        "rpps_distinct_eligible_keys",
        retryOpts,
      );
      if (error) {
        throw new Error(`rpps_distinct_eligible_keys failed: ${error.message}`);
      }
      const rows = (data ?? []) as DistinctKeyRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        if (!distinctKeyInputs.has(r.address_key)) {
          distinctKeyInputs.set(r.address_key, {
            adresse: r.adresse ?? "",
            codePostal: r.code_postal ?? "",
            codeInsee: r.code_insee ?? "",
          });
        }
      }
      // INVARIANT PORTANT (load-bearing, PAS incident) : `last` est PROUVÉ
      // toujours défini ici — le `if (rows.length === 0) break` ci-dessus
      // garantit `rows.length > 0`, donc `rows[rows.length - 1]` existe ;
      // le `if (last === undefined) break` n'est qu'une garde de typage
      // `noUncheckedIndexedAccess`, mécaniquement INATTEIGNABLE.
      // ⚠️ NE PAS reformuler cette branche comme « cas sûr » : SI un futur
      // refactor la rendait atteignable (ex. break déplacé/supprimé), elle
      // terminerait l'énumération AVANT d'avoir paginé toutes les clés, puis
      // runBatchedRpc n'appliquerait que le sous-ensemble déjà en cache en
      // rapportant un succès — c'est une troncature SILENCIEUSE de classe S-1
      // (perte de clés non géocodées présentée comme run réussi). Le break
      // ici (plutôt que garder le même `after` → boucle infinie) évite le
      // hang, mais l'unique garantie d'absence de troncature est
      // l'INATTEIGNABILITÉ prouvée ci-dessus : c'est un invariant porteur à
      // préserver, pas une commodité.
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      after = last.address_key;
      pageCount++;
      if (pageCount % 20 === 0) {
        console.log(
          `[rpps] BAN eligibility enumeration: ${distinctKeyInputs.size} distinct keys / ${pageCount} pages`,
        );
      }
    }
    // Pas de `.sort()` : le cron n'a jamais trié ici (le tri attempt-first
    // plus bas reste l'unique tri). La RPC renvoie déjà les clés en ordre
    // croissant par keyset, mais aucun consommateur ne dépend de cet ordre.
    const distinctKeys = [...distinctKeyInputs.keys()];

    // Backstop RUNTIME anti-S-1 : le count dit qu'il EXISTE des lignes
    // éligibles, mais l'énumération n'a produit AUCUNE clé distincte. C'est
    // mécaniquement impossible si prédicat/index sont cohérents (toute ligne
    // éligible porte une clé d'adresse) → soit une dérive d'expression/prédicat,
    // soit un index BAN absent/invalide rendant la query de saut toujours-vide.
    // Le guard `predicate-parity` est STATIQUE (textuel) ; ceci est son pendant
    // RUNTIME. On échoue BRUYAMMENT (→ catch best-effort du step : status
    // `partial` + error_message persisté dans l'audit trail ingest_log +
    // console.error ; pas de Sentry direct en lib, convention repo) plutôt
    // que de rapporter "0 new / 0 rows_applied" en succès = panne TOTALE
    // silencieuse de classe S-1.
    if (eligibleRowCount > 0 && distinctKeys.length === 0) {
      throw new Error(
        `rpps_distinct_eligible_keys returned ZERO distinct keys while rpps_count_ban_eligible_rows=${eligibleRowCount} > 0 — predicate/index drift or missing/invalid BAN index (S-1 silent-failure backstop)`,
      );
    }

    // (4) Lecture du cache via RPC `rpps_geocoded_cache_lookup` (clés en BODY
    // POST, PAS `.in()` en URL GET) — cf. `CACHE_LOOKUP_BATCH` (module).
    const cached = new Map<string, CachedAddressRow>();
    for (let i = 0; i < distinctKeys.length; i += CACHE_LOOKUP_BATCH) {
      const slice = distinctKeys.slice(i, i + CACHE_LOOKUP_BATCH);
      const { data, error } = await retryTransient(
        () =>
          withTimeout(
            supabase.rpc("rpps_geocoded_cache_lookup", { p_keys: slice }),
            RPC_READ_TIMEOUT_MS,
            "rpps_geocoded_cache_lookup",
          ),
        "rpps_geocoded_cache_lookup",
        retryOpts,
      );
      if (error) {
        throw new Error(
          `rpps_geocoded_cache_lookup failed: ${error.message}${missingRpcHint(error.message)}`,
        );
      }
      for (const c of (data ?? []) as CachedAddressRow[]) {
        cached.set(c.address_key, c);
      }
    }

    // Clés à soumettre : jamais vues, OU accepted=false sous le cap. Les
    // accepted=true sont FIGÉES (jamais re-soumises).
    const keysToSubmit: string[] = [];
    let cachedFrozen = 0;
    for (const key of distinctKeys) {
      const c = cached.get(key);
      if (c === undefined) {
        keysToSubmit.push(key);
        continue;
      }
      if (c.accepted) {
        cachedFrozen++;
        continue;
      }
      if (c.ban_attempt_count < BAN_MAX_ATTEMPTS) {
        keysToSubmit.push(key);
      } else {
        cachedFrozen++;
      }
    }

    // STEP A — plafond par run, FILET de convergence si le
    // backfill one-shot (STEP B) est interrompu. On NE soumet à BAN qu'au
    // plus `BAN_MAX_NEW_PER_RUN` adresses distinctes pas-encore-résolues.
    //
    // Ordre de service : `(ban_attempt_count ASC, address_key ASC)` — une clé
    // jamais vue a un attempt implicite 0. Les clés JAMAIS TENTÉES (attempt 0)
    // sont donc TOUJOURS servies AVANT les retries de clés déjà rejetées.
    // Sans ça (tri lexicographique pur), une distribution pathologique de clés
    // bas-triées durablement non résolues pouvait DIFFÉRER la queue jamais-vue
    // de jusqu'à `BAN_MAX_ATTEMPTS` runs (la même tête bas-triée re-soumise
    // run après run jusqu'à épuisement du cap d'attempts, retardant d'autant
    // les adresses neuves). Trier d'abord par attempt count élimine ce
    // tail-deferral SANS effet de bord : la convergence est inchangée (tout ce
    // qui n'est pas soumis ce run reste éligible+non caché → resélectionné),
    // l'ordre reste DÉTERMINISTE (le tie-break `address_key` est total et
    // STABLE entre deux runs). Les clés soumises sont upsertées dans
    // `geocoded_addresses` (accepted=true → FIGÉES, ou ban_attempt_count++) :
    // au run suivant elles QUITTENT `keysToSubmit` (cache accepted ou cap
    // atteint) → la tête avance, le backlog décroît strictement.
    const attemptOf = (key: string): number => cached.get(key)?.ban_attempt_count ?? 0;
    keysToSubmit.sort((a, b) => {
      const da = attemptOf(a);
      const db = attemptOf(b);
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const backlogBeforeCap = keysToSubmit.length;
    let banBacklogRemaining = 0;
    if (keysToSubmit.length > BAN_MAX_NEW_PER_RUN) {
      banBacklogRemaining = keysToSubmit.length - BAN_MAX_NEW_PER_RUN;
      keysToSubmit.length = BAN_MAX_NEW_PER_RUN; // slice déterministe de la tête triée
      // Backlog observable : K = adresses distinctes éligibles non soumises
      // CE run (rattrapées aux runs suivants via le cache). Le cap est du
      // fonctionnement NORMAL → ne touche PAS `log.status`.
      console.log(
        `[rpps] BAN backlog: ${banBacklogRemaining} addresses remaining (cap ${BAN_MAX_NEW_PER_RUN}/run, ${backlogBeforeCap} eligible-uncached this run)`,
      );
    }

    // (5) Appel BAN sur les clés à soumettre uniquement.
    const rowsForBan = keysToSubmit.map((key) => {
      const inp = distinctKeyInputs.get(key);
      // `inp` toujours défini (key vient de distinctKeyInputs.keys()).
      return {
        key,
        adresse: inp?.adresse ?? "",
        codePostal: inp?.codePostal ?? "",
        codeInsee: inp?.codeInsee ?? "",
      };
    });

    let banResults = new Map<string, BanGeocodeResult>();
    let apiFailures = 0;
    let chunksTotal = 0;
    if (rowsForBan.length > 0) {
      const outcome = await geocodeAddressesBatch(rowsForBan, {
        chunkSize: BAN_BULK_CHUNK,
        scoreThreshold: BAN_ACCEPT_SCORE,
        // F2 : borne chaque requête chunk (un socket BAN figé ne doit pas
        // bloquer indéfiniment le cron mensuel — même filet que le backfill).
        requestTimeoutMs: BAN_REQUEST_TIMEOUT_MS,
      });
      banResults = outcome.results;
      apiFailures = outcome.apiFailures;
      chunksTotal = outcome.chunksTotal;
    }

    // (6) Upsert TOUS les results. Acceptés → coords + accepted=true. Non
    // résolus → accepted=false, ban_attempt_count+1, ban_last_status. Garde
    // défensive R4 : un accepted=true à coords NULL (contrat client garantit
    // l'inverse, mais on ne laisse pas le CHECK throw) → downgrade
    // accepted=false + log, distinct d'un apiFailure.
    let acceptedCount = 0;
    let rejectedLowScore = 0;
    let unresolvedCount = 0;
    // S-3 : compteur DÉDIÉ au downgrade défensif R4 (accepted=true à coords
    // NULL = RUPTURE DE CONTRAT du client BAN). Le noyer dans
    // `rejectedLowScore` masquerait un signal de bug client sous des rejets
    // d'adresse routiniers. Distinct aussi d'un apiFailure (HTTP a réussi).
    let contractBreachDowngrades = 0;
    const nowIso = new Date().toISOString();
    const upserts: Array<{
      address_key: string;
      lat: number | null;
      lon: number | null;
      result_score: number | null;
      result_type: string | null;
      accepted: boolean;
      ban_attempt_count: number;
      ban_last_status: string;
      geocoded_at: string;
    }> = [];
    for (const [key, res] of banResults) {
      const prevAttempts = cached.get(key)?.ban_attempt_count ?? 0;
      const isUnresolved = res.lat === null && res.lon === null && res.resultScore === null;
      let accepted = res.accepted;
      let lat = res.lat;
      let lon = res.lon;
      let contractBreached = false;
      if (accepted && (lat === null || lon === null)) {
        // Rupture de contrat client (PAS un apiFailure) : le client garantit
        // accepted ⇒ coords non-null. On downgrade plutôt que laisser le
        // CHECK constraint throw et casser l'upsert de tout le batch.
        console.error(
          `[france-data-mcp][rpps][ban_geocode] accepted=true with NULL coords for key="${key}" — downgrading to accepted=false (BAN-client contract breach, not an apiFailure)`,
        );
        accepted = false;
        lat = null;
        lon = null;
        contractBreached = true;
      }
      if (accepted) {
        acceptedCount++;
      } else if (contractBreached) {
        // S-3 : bucket dédié — surface le bug client, JAMAIS confondu avec un
        // rejet d'adresse routinier (rejectedLowScore) ni un unresolved.
        contractBreachDowngrades++;
      } else if (isUnresolved) {
        unresolvedCount++;
      } else {
        // Résolu mais non accepté (score < seuil ou type hors housenumber/
        // street) — qualité, PAS une panne API.
        rejectedLowScore++;
      }
      upserts.push({
        address_key: key,
        lat: accepted ? lat : null,
        lon: accepted ? lon : null,
        result_score: res.resultScore,
        result_type: res.resultType,
        accepted,
        ban_attempt_count: prevAttempts + 1,
        ban_last_status: banLastStatus(accepted, isUnresolved),
        geocoded_at: nowIso,
      });
    }

    for (let i = 0; i < upserts.length; i += BAN_GEOCODE_BATCH_SIZE) {
      const slice = upserts.slice(i, i + BAN_GEOCODE_BATCH_SIZE);
      const { error } = await retryTransient(
        () =>
          supabase
            .from("geocoded_addresses")
            .upsert(slice as never[], { onConflict: "address_key" }),
        "geocoded_addresses upsert",
        retryOpts,
      );
      if (error) {
        throw new Error(`geocoded_addresses upsert failed: ${error.message}`);
      }
    }

    // (7) Application cache → staging. expectedTotal = `eligibleRowCount` =
    // nb de ROWS staging éligibles (du count RPC `rpps_count_ban_eligible_rows`),
    // P15 : JAMAIS `distinctKeys.length` (les lignes se dédoublonnent en MOINS
    // de clés ; `distinctKeys.length` sous-évaluerait `maxIterations` dans
    // `runBatchedRpc` → faux "did not converge" alors que la RPC applique
    // correctement plus de batches que ceil(distinctKeys/batch)+5).
    const { totalUpdated: rowsApplied, iterations } = await runBatchedRpc(
      supabase,
      "ingest_apply_rpps_ban_geocoding_batch",
      { p_limit: BAN_GEOCODE_BATCH_SIZE },
      eligibleRowCount,
      BAN_GEOCODE_BATCH_SIZE,
      RPC_BATCH_TIMEOUT_MS,
    );

    // (8) Seuil dédié : trop de chunks BAN en échec HTTP = panne API → partial.
    // Non-résolu/low-score seuls = qualité, NE bascule PAS partial.
    if (chunksTotal > 0 && apiFailures / chunksTotal > BAN_API_FAILURE_CEILING) {
      log.status = "partial";
      appendLogMessage(
        log,
        `BAN geocoding degraded: ${apiFailures}/${chunksTotal} chunks failed (> ${(BAN_API_FAILURE_CEILING * 100).toFixed(0)}%)`,
      );
    }
    // MEDIUM-6 (review P2) : une dégradation réseau CHRONIQUE sous le seuil
    // d'épuisement (retries absorbés, run par ailleurs OK) ne franchit aucun
    // seuil → resterait invisible hors stdout GH Actions éphémère. On la
    // PERSISTE dans l'audit trail DB (`ingest_log.error_message`) SANS forcer
    // `partial` (le run a réussi) — le libellé est explicitement INFORMATIF,
    // pas une erreur. Respecte CLAUDE.md « observabilité background : audit
    // trail DB pour cron, pas juste console.log ».
    if (transientRetries > 0) {
      appendLogMessage(
        log,
        `[info] BAN geocoding absorbed ${transientRetries} transient transport retries (network degraded, sub-threshold — not an error)`,
      );
    }

    console.log(
      `[rpps] BAN geocoding: ${keysToSubmit.length} new / ${cachedFrozen} cached / ${acceptedCount} accepted / ${rejectedLowScore} rejected_low_score / ${unresolvedCount} unresolved / ${contractBreachDowngrades} contract_breach_downgrades / ${apiFailures} api_failures / ${transientRetries} transient_retries / ${rowsApplied} rows_applied (${iterations} batches, ${eligibleRowCount} eligible rows)`,
    );
  } catch (err) {
    // Best-effort : on NE throw JAMAIS. console.error AVANT tout
    // writeIngestLog (le caller appelle writeIngestLog plus tard), status
    // "partial" (préservé par le bloc de finalisation plus bas, P16).
    // finess_join jamais touché (la RPC le garantit, le step n'écrit pas
    // staging directement). Rows non géocodées restent commune_centroid/NULL.
    console.error(
      `[france-data-mcp][rpps][ban_geocode_fallback] BAN geocoding step failed (best-effort, ingestion continues): ${err instanceof Error ? err.message : String(err)}`,
    );
    log.status = "partial";
    appendLogMessage(
      log,
      `BAN geocoding step failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const __TESTING__ = {
  parseRppsRecord,
  COL,
  rebuildRppsMatviews,
  runBanGeocodeStep,
  BAN_MAX_NEW_PER_RUN,
};

await runIfMain(import.meta.url, main);
