// One-shot, idempotent BAN backfill (stratégie A+B, STEP B).
//
// Remplit À L'AVANCE le cache persistant `geocoded_addresses` pour les ~339k
// adresses distinctes éligibles (mesure PHASE 0 2026-05-16), HORS de la
// fenêtre du cron mensuel. CACHE-ONLY : n'écrit JAMAIS `rpps`/`rpps_staging` —
// l'application cache→rpps se fait à l'ingestion via la RPC. Pairé
// avec le filet `BAN_MAX_NEW_PER_RUN` du cron (STEP A) : un backfill
// interrompu converge quand même run après run via ce même cache.
//
// IDEMPOTENT : un re-run saute les clés déjà cachées (accepted=true figées,
// accepted=false au-delà du cap d'attempts — SAUF rejet PÉRIMÉ d'une règle plus
// stricte, re-soumis une fois, cf. `isStaleRejection`) → un 2e run ne re-géocode ~rien.
//
// Lancement manuel :
//   tsx scripts/ban-backfill.mjs [--max N]
// (mêmes env que les ingesters : SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY ;
//  pattern client miroir de `scripts/ingest/shared.ts:getUntypedServiceClient`).
//
// Observabilité (best-effort) : préfixe [ban-backfill] ; les apiFailures du
// client BAN sont comptés et exposés (jamais un arrêt silencieux ayant fait
// une fraction tout en rapportant un succès — la classe de bug combattue).

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  banLastStatus,
  geocodeAddressesBatch,
  hasGateFields,
  isStaleRejection,
  parseRpcCount,
  withTimeout,
} from "../src/core/index.ts";
import {
  isTransientSupabaseError,
  missingRpcHint,
  retryTransient,
} from "../src/core/retry-transient.ts";

// Énumération keyset SERVER-SIDE : la clé d'adresse est calculée
// CÔTÉ SQL par `rpps_distinct_eligible_keys` (parité octet-à-octet avec
// `normalizeAddressKey` 3-arg garantie par le HARD GATE) et consommée
// telle quelle — le backfill NE recalcule PLUS la clé en JS (UNIQUE source de
// vérité SQL). Invariant cap-agnostic (anti-S-1) : on termine UNIQUEMENT sur
// une page VIDE et on avance `after` sur la DERNIÈRE clé reçue. La RPC garantit
// au plus `p_limit` lignes ; si le serveur en renvoie MOINS que `KEYSET_PAGE`
// (cap PostgREST `config.toml:max_rows` < KEYSET_PAGE, cf. CLAUDE.md
// "PostgREST max_rows"), on NE DOIT JAMAIS `break` sur
// `rows.length < KEYSET_PAGE` : ce serait la classe de panne totale
// silencieuse S-1 (troncature ~99,7 % rapportée en "success").
// `ban-backfill.mjs` était la référence cap-agnostic
// documentée pour la pagination ; il est désormais lui-même sur la RPC keyset.
const KEYSET_PAGE = 1000;
// Batch des upserts cache + (cron) p_limit RPC d'application. PAS le chunk
// BAN (voir BAN_BULK_CHUNK) — dissocié au GATE G6 : ces deux-là vont en DB,
// 10k y est sain ; seul le POST BAN souffrait.
const BAN_GEOCODE_BATCH_SIZE = 10_000;
// Taille de chunk d'UN POST à l'endpoint BAN bulk CSV. GATE G6 : à 10 000
// lignes/POST sous volume soutenu, l'endpoint BAN lâche la connexion
// (`terminated`) — 22 chunks perdus = ~220k adresses non géocodées en un run.
// 2 000 : POST nettement plus fiables, et un échec résiduel ne coûte que
// 2k adresses (re-tentées au re-run idempotent), pas 10k. Jumeau `rpps.ts`
// porte la MÊME valeur — ne pas désynchroniser.
const BAN_BULK_CHUNK = 2_000;
// Plancher d'acceptation BAN — 0.5 (sémantique « upgrade vs centroïde commune »,
// la garantie de précision vient du `result_type` côté `ACCEPTED_PRECISION_TYPES`
// dans `src/core/ban-bulk-client.ts`). Preuve empirique + réfutation de l'ancien
// « JAMAIS 0.5 » (leçon audit-P2) : `docs/plans/ban-join.md`.
const BAN_ACCEPT_SCORE = 0.5;
// F2 : borne par requête chunk passée au client BAN — un socket BAN figé ne
// doit pas bloquer indéfiniment un job de 339k rows. Le client retry chaque
// timeout (transitoire) mais CHAQUE tentative est elle-même bornée.
const BAN_REQUEST_TIMEOUT_MS = 90_000;
// Cap de tentatives sur une clé `accepted=false` : au-delà, l'adresse est
// durablement non résolue → on ne la re-soumet plus (le cron ne géocode plus
// depuis la refonte `ban_join` : ce backfill est le SEUL émetteur BAN ; les RPC de
// jauge `rpps_measure_ban_to_geocode` / Ameli encodent le même `>= 3`, cf. note
// de la migration 20260905T180000). Les `accepted=true` sont FIGÉES (jamais
// re-soumises) ; les clés jamais vues toujours soumises.
const BAN_MAX_ATTEMPTS = 3;
// REJET PÉRIMÉ : règle et type de ligne dans `src/core/geocoded-cache-row.ts`
// (`isStaleRejection`, TYPÉE et testée — ce `.mjs` n'est pas sous `tsc`). Ici
// seulement les paramètres : seuil courant + plafond de ré-soumission = UNE
// tentative au-delà du cap (convergence par construction ; prod 2026-09-05 :
// aucune clé au-delà de 3 tentatives → no-op sur le lot actuel de 9 305).
const BAN_STALE_RESUBMIT_CAP = BAN_MAX_ATTEMPTS + 1;
const STALE_OPTS = { scoreThreshold: BAN_ACCEPT_SCORE, resubmitCap: BAN_STALE_RESUBMIT_CAP };
// Lecture cache par RPC `rpps_geocoded_cache_lookup` (clés en BODY POST, PAS
// `.in()` en URL GET). Batch large : ~670 requêtes (chunks 500) → ~34
// (incident GATE G5 — 3 runs prod morts `fetch failed` sur la phase cache,
// surface d'échec transport séquentiel divisée par ~20). 10k clés ≈ ~0,5 Mo
// de payload JSON, très en dessous de toute limite de body PostgREST
// (immunisé contre la limite d'URL GET qui motive ce correctif).
const CACHE_LOOKUP_BATCH = 10_000;
// Cadence du log de progression (nb de clés traitées entre 2 logs).
const PROGRESS_EVERY = 20_000;
/**
 * Borne CHAQUE lecture RPC d'énumération d'éligibilité BAN
 * (`rpps_distinct_eligible_keys`). Le code antérieur paginait la table
 * source en RAM via `.range()` SANS AUCUN timeout sur les lectures : seuls
 * les appels HTTP BAN étaient bornés (F2). Un socket Supabase figé sur une
 * page d'énumération pendait donc indéfiniment — root cause du hang
 * silencieux multi-minutes (la même classe de boucle re-tournée par le cron
 * mensuel). 60 s : marge confortable pour une page keyset
 * server-side (DISTINCT ON + index fonctionnel partiel) même sous charge,
 * sans laisser un hang réel non borné. Un dépassement REJETTE (fail-loud :
 * contrat backfill = throw, PAS le best-effort du cron).
 */
const RPC_READ_TIMEOUT_MS = 60_000;

/**
 * Construit le client service-role (mêmes env que les ingesters). Isolé pour
 * que `runBanBackfill` reste testable avec un client stubé.
 */
function buildServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "[ban-backfill] missing env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Descripteur par source : table LIVE d'éligibilité + les 2 RPC jumelles
 * (énumération skip-scan + count backstop S-1). Le cache `geocoded_addresses`
 * est PARTAGÉ (clé = adresse normalisée) → la lecture cache (`rpps_geocoded_
 * cache_lookup`) reste commune aux 2 sources, hors de ce descripteur. Ajouter
 * une source = une entrée ici + ses 2 RPC en base (migration). RPPS reste le
 * défaut (back-compat : `runBanBackfill(client, {})` inchangé).
 */
export const SOURCES = {
  rpps: {
    table: "rpps",
    // Énumération KEYSET SUR `id` (PK) — ROBUSTE sans index BAN sur la table LIVE.
    // 2 dead-ends prouvés prod 2026-06-05 : (a) keyset sur la CLÉ exige un index BAN
    // (orphelin au swap, build-via-RPC = cap passerelle 60 s) ; (b) passe unique =
    // ~147k évals de la clé Unicode (~880 µs) en 1 requête > 55 s. Le keyset sur la
    // PK borne le nb d'évals/page (~5000 → 4,4 s, MESURÉ) → coût constant, sûr.
    // Curseur = `id`. Cf. rpps_eligible_rows_after_id (migration keyset).
    enumRpc: "rpps_eligible_rows_after_id",
    cursorParam: "p_after_id",
    cursorField: "id",
    cursorInit: 0,
    countRpc: "rpps_count_ban_eligible_rows",
  },
  ameli: {
    table: "annuaire_ameli",
    // Énumération KEYSET SUR `id` (PK) — jumeau RPPS, ROBUSTE sans index BAN sur la
    // table LIVE. Remplace le keyset sur la clé d'adresse (`ameli_distinct_eligible_
    // keys`), qui exigeait l'index `ameli_staging_ban_eligible_normkey*` sur
    // `annuaire_ameli` — ORPHÉLINÉ à chaque swap du cron hebdo (recréation manuelle
    // avant chaque drain). La PK suffit → plus AUCUN index à entretenir. Curseur =
    // `id`. Cf. ameli_eligible_rows_after_id (migration keyset) + docs/plans/
    // automatisation-backfill-ban.md.
    enumRpc: "ameli_eligible_rows_after_id",
    cursorParam: "p_after_id",
    cursorField: "id",
    cursorInit: 0,
    countRpc: "ameli_count_ban_eligible_rows",
  },
  finess: {
    table: "finess",
    // FINESS phase 2 (item 1, migration 20260906T120000) : résiduel SANS point
    // après le repli `previous_ingest` (établissements nouveaux, ~5 K). Pas
    // d'id bigint : la PK est `num_finess` CHAR(9) → curseur TEXTE renvoyé
    // sous son nom (sentinelle NULL, cf. `assertSourcesValid` : seul `id` est
    // numérique). Adresse = `voie` seule (porte déjà numéro + type).
    // Aucun index à entretenir : ~5 K éligibles sur 105 K, seq scan borné.
    enumRpc: "finess_eligible_rows_after_id",
    cursorParam: "p_after_id",
    cursorField: "num_finess",
    cursorInit: null,
    countRpc: "finess_count_ban_eligible_rows",
  },
};

/**
 * Garde-fou STRUCTUREL fail-loud du descripteur `SOURCES` : un descripteur de
 * source mal formé (champ oublié pour une future source, cursorInit incohérent)
 * provoquerait une MIS-PAGINATION SILENCIEUSE (`after = undefined` → 1ʳᵉ page en
 * boucle, ou clés ratées). On exige les 6 champs + un cursorInit COHÉRENT avec le
 * type du curseur. Doctrine : une config cassée doit être BRUYANTE au démarrage,
 * jamais un drain partiel sous le radar. Exporté pour être testé directement
 * (`ban-backfill.test.ts`) sans dépendre d'un re-chargement de module.
 *
 * @param {Record<string, Record<string, unknown>>} sources
 */
export function assertSourcesValid(sources) {
  for (const [name, cfg] of Object.entries(sources)) {
    for (const k of ["table", "enumRpc", "cursorParam", "cursorField", "cursorInit", "countRpc"]) {
      if (!(k in cfg)) {
        throw new Error(
          `[ban-backfill] SOURCES.${name} : champ "${k}" manquant (mis-pagination silencieuse)`,
        );
      }
    }
    // Couple cursorField ↔ cursorInit (PAS cursorInit en isolation) : la sentinelle
    // DOIT être strictement < toute valeur réelle du TYPE du curseur — 0 pour un
    // curseur numérique sur la PK `id`, null pour un curseur texte (clé). Un
    // découplage (`cursorField:"id"` + `cursorInit:null`) passerait un garde isolé
    // mais enverrait `p_after_id: null` en 1ʳᵉ page → 1ʳᵉ page fausse = panne S-1.
    const expectedInit = cfg.cursorField === "id" ? 0 : null;
    if (cfg.cursorInit !== expectedInit) {
      throw new Error(
        `[ban-backfill] SOURCES.${name} : cursorField=${JSON.stringify(cfg.cursorField)} exige cursorInit=${JSON.stringify(expectedInit)} (sentinelle < toute valeur réelle du type du curseur), reçu ${JSON.stringify(cfg.cursorInit)}`,
      );
    }
  }
}

// Exécution fail-loud immédiate au chargement du module (avant tout run).
assertSourcesValid(SOURCES);

/**
 * Backfill cache-only, idempotent.
 *
 * Fail-loud BY DESIGN : une erreur (ou un timeout) de lecture d'éligibilité
 * en cours d'énumération keyset RPC throw et AVORTE tout le run (pas de
 * `partial` best-effort comme le cron) — un re-run reprend à moindre coût via
 * le cache persistant.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ maxNew?: number, source?: "rpps"|"ameli"|"finess", sourceTable?: string }} [opts]
 *   - maxNew : borne le nb de NOUVELLES adresses distinctes soumises ce run
 *     (slice déterministe de la tête triée → permet de lancer en tranches ;
 *     un re-run reprend où il en est via le cache). Défaut : illimité.
 *   - source : "rpps" (défaut) | "ameli" | "finess" — sélectionne la table LIVE + les 2
 *     RPC jumelles (énumération + count) via `SOURCES`. Le cache visé est le
 *     MÊME pour les deux (partagé par clé d'adresse normalisée).
 *   - sourceTable : SURCHARGE explicite de la table d'éligibilité, passée en
 *     `p_source_table` aux RPC (validée par le whitelist SQL ; hors-whitelist →
 *     throw, contrat fail-loud). Défaut = la table LIVE de `source`. Permet de
 *     viser une staging (`rpps_staging`/`annuaire_ameli_staging`) en test ; un
 *     backfill standalone DOIT lire la table LIVE (la staging n'existe que
 *     PENDANT l'ingestion).
 * @returns {Promise<{ totalEligibleDistinct:number, geocoded:number,
 *   skippedCached:number, staleResubmitted:number, staleDeferred:number,
 *   staleDetectionEnabled:boolean, staleRerejected:number, accepted:number, rejected:number, unresolved:number,
 *   banChunksByHost:Record<string,number>, banHostSwitches:number, banRateLimitRetries:number,
 *   contractBreached:number, apiFailures:number, transientRetries:number,
 *   remaining:number }>}
 */
export async function runBanBackfill(supabase, opts = {}) {
  const maxNew =
    typeof opts.maxNew === "number" && Number.isFinite(opts.maxNew) && opts.maxNew > 0
      ? Math.floor(opts.maxNew)
      : Number.POSITIVE_INFINITY;
  // Résolution de la source : table LIVE + RPC jumelles. `source` inconnue =
  // throw (fail-loud : un appel mal câblé doit être BRUYANT, jamais un no-op).
  const sourceKey = opts.source ?? "rpps";
  const srcCfg = SOURCES[sourceKey];
  if (!srcCfg) {
    throw new Error(
      `[ban-backfill] unknown source ${JSON.stringify(sourceKey)} (expected: ${Object.keys(SOURCES).join("|")})`,
    );
  }
  const sourceTable = opts.sourceTable ?? srcCfg.table;

  // (1)+(2)+(3) Énumération keyset SERVER-SIDE des clés DISTINCTES éligibles
  // via `rpps_distinct_eligible_keys` (remplace la pagination
  // full-RAM `.range()` pathologique). Éligible = centroïde commune OU (pas de
  // geom ET adresse présente) — predicate appliqué CÔTÉ SQL. Le backfill ne
  // touche jamais la table source ; il pré-cache juste les clés.
  //
  // La clé `address_key` est calculée CÔTÉ SQL (parité octet-à-octet avec
  // `normalizeAddressKey` 3-arg garantie par le HARD GATE + son test
  // d'intégration) — le backfill NE recalcule PLUS la clé en JS : UNIQUE
  // source de vérité SQL (le piège de panne totale silencieuse 4-arg `ville`
  // n'existe plus). La RPC btrim déjà adresse/code_postal/code_insee (trim
  // parité-correct) → on consomme `r.adresse ?? ""` etc. tel quel, pas de
  // re-`.trim()` JS.
  //
  // INVARIANT cap-agnostic (anti-S-1) : break UNIQUEMENT sur page VIDE, et
  // `after` = DERNIÈRE clé reçue (jamais `if (rows.length < KEYSET_PAGE)
  // break` — classe S-1, cf. CLAUDE.md "PostgREST max_rows"). `sourceTable`
  // (défaut `"rpps"`) est passé en `p_source_table` : le whitelist SQL le
  // valide ; une valeur hors-whitelist → erreur RPC → throw, ce qui EST le
  // contrat fail-loud correct du backfill (≠ best-effort du cron). Chaque
  // lecture est BORNÉE par `withTimeout` (fail-loud : un dépassement throw,
  // PAS un statut "partial").
  const distinctKeyInputs = new Map();
  // Curseur keyset GÉNÉRIQUE : RPPS et Ameli énumèrent par `id` (PK bigint,
  // `cursorInit: 0`), FINESS par `num_finess` (PK CHAR(9), curseur TEXTE,
  // `cursorInit: null`). Le mécanisme est PARAMÉTRÉ (`srcCfg.cursorParam`/
  // `cursorField`/`cursorInit`, garde-fou de chargement `assertSourcesValid`).
  // Le client déduplique TOUJOURS par `address_key` (les 3 RPC le renvoient) ;
  // le curseur ne sert qu'à paginer.
  let after = srcCfg.cursorInit;
  let pageCount = 0;
  // F-1 (silent-failure review) : compte les lignes éligibles à clé vide/nulle,
  // SKIPPÉES (cf. boucle) — signalées LOUD en fin d'énumération, jamais avalées.
  let emptyKeyRows = 0;
  // MEDIUM-6 (review P1) : agrège les retries transport ABSORBÉS sur tout le
  // run. Un blip isolé est un `console.warn` ; une dégradation réseau chronique
  // SOUS le seuil d'épuisement (le run frôle la panne en continu mais réussit)
  // doit être SYNTHÉTISÉE dans le résumé et l'objet de retour (parité avec
  // `apiFailures`), sinon rapportée silencieusement en succès.
  let transientRetries = 0;
  const countRetry = () => {
    transientRetries++;
  };
  // Options retryTransient communes aux 4 appels Supabase : agrégation des
  // retries + détection d'un échec transport revenu en `{ error }` RÉSOLU
  // (supabase-js ne throw PAS toujours — incident G5 prouvé en prod).
  const retryOpts = {
    onRetry: countRetry,
    isRetryableResult: (r) => isTransientSupabaseError(r?.error),
  };
  // Cadence dérivée de PROGRESS_EVERY ("clés entre 2 logs") : log au franchissement
  // de chaque multiple, indépendant de KEYSET_PAGE (pas de couplage implicite).
  let loggedKeyMultiple = 0;
  // Nom de la RPC d'énumération : string load-bearing réutilisée pour le label
  // withTimeout, le label retryTransient et le message d'erreur (une seule
  // source — pas 3 littéraux à garder synchrones). Dérivé de la source.
  const RPC_LABEL = srcCfg.enumRpc;
  for (;;) {
    // Chaque tentative est INDÉPENDAMMENT bornée par `withTimeout` : un hang
    // réel (socket figé) → rejet `TimeoutError` NON transitoire → throw
    // (contrat anti-hang fail-loud intact) ; un blip transport
    // (`fetch failed`…) → `retryTransient` réessaie avec backoff (incident G5).
    const { data, error } = await retryTransient(
      () =>
        withTimeout(
          supabase.rpc(RPC_LABEL, {
            p_source_table: sourceTable,
            [srcCfg.cursorParam]: after,
            p_limit: KEYSET_PAGE,
          }),
          RPC_READ_TIMEOUT_MS,
          RPC_LABEL,
        ),
      RPC_LABEL,
      retryOpts,
    );
    if (error) {
      throw new Error(`[ban-backfill] ${RPC_LABEL} failed: ${error.message}`);
    }
    const rows = data ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      // F-1 : une clé vide/nulle (ex. commune_centroid à adresse NULL → clé
      // dégénérée) collapserait N lignes distinctes en UNE entrée Map → drain
      // PARTIEL sous le radar du backstop S-1 (distinctKeys.length ≥ 1). On SKIP +
      // compte (jamais géocodable sans adresse) ; warn LOUD après la boucle.
      if (!r.address_key) {
        emptyKeyRows++;
        continue;
      }
      if (!distinctKeyInputs.has(r.address_key)) {
        distinctKeyInputs.set(r.address_key, {
          adresse: r.adresse ?? "",
          codePostal: r.code_postal ?? "",
          codeInsee: r.code_insee ?? "",
        });
      }
    }
    // Garde curseur (revue 2026-09-06, prouvé par harnais) : sans lui, un
    // `cursorField` qui ne nomme pas une colonne de la RETURNS TABLE donne
    // `after = undefined` → JSON.stringify DROPPE `p_after_id` → PostgREST
    // applique le DEFAULT de la signature → 1re page en boucle jusqu'au kill
    // du job (30 min), SANS log de progression (le compteur de clés plafonne).
    // La colonne curseur est une PK NOT NULL : undefined/null = divergence
    // descripteur ↔ RETURNS TABLE, jamais une donnée légitime.
    const lastRow = rows[rows.length - 1];
    const nextAfter = lastRow[srcCfg.cursorField];
    if (nextAfter === undefined || nextAfter === null) {
      throw new Error(
        `[ban-backfill] ${RPC_LABEL} : colonne curseur "${srcCfg.cursorField}" absente/NULL de la dernière ligne (colonnes reçues : ${Object.keys(lastRow).join(", ")}) — SOURCES et la RETURNS TABLE ont divergé (S-1 : pagination en boucle)`,
      );
    }
    // Monotonie stricte : un curseur qui n'avance pas = même boucle, autre cause
    // (ORDER BY et prédicat keyset désaccordés).
    if (after !== srcCfg.cursorInit && !(nextAfter > after)) {
      throw new Error(
        `[ban-backfill] ${RPC_LABEL} : curseur non strictement croissant (${JSON.stringify(after)} → ${JSON.stringify(nextAfter)}) — ORDER BY et prédicat keyset désaccordés`,
      );
    }
    after = nextAfter;
    pageCount++;
    const keyMultiple = Math.floor(distinctKeyInputs.size / PROGRESS_EVERY);
    if (keyMultiple > loggedKeyMultiple) {
      loggedKeyMultiple = keyMultiple;
      console.log(
        `[ban-backfill] eligibility enumeration: ${distinctKeyInputs.size} distinct keys / ${pageCount} pages`,
      );
    }
  }
  if (emptyKeyRows > 0) {
    console.warn(
      `[ban-backfill] ${emptyKeyRows} ligne(s) éligible(s) à address_key vide/nulle — non géocodables (adresse source manquante), SKIPPÉES`,
    );
  }
  // Pas de `.sort()` ici : l'ORDRE d'énumération suit le curseur (`id` pour les 2
  // sources) et n'est PAS load-bearing — l'ordre de SERVICE déterministe est
  // posé par le tri attempt-first plus bas (`keysToSubmit.sort`, tie-break
  // `address_key` total + stable), INDÉPENDANT de l'ordre d'arrivée. Un re-run
  // partiel (--max) reste déterministe : les clés cachées au run précédent sont
  // filtrées AVANT le slice → la tête avance, le backlog draine de façon monotone.
  const distinctKeys = [...distinctKeyInputs.keys()];
  const totalEligibleDistinct = distinctKeys.length;

  // Backstop RUNTIME anti-S-1 (review P1 HIGH 2 — parité avec
  // `rpps.ts:990`) : le count dit qu'il EXISTE des lignes éligibles mais
  // l'énumération n'a produit AUCUNE clé distincte ⇒ dérive prédicat/index,
  // index BAN absent/invalide, ou guard `p_limit < 1` renvoyant un set vide.
  // Sans ce filet, `distinctKeys=[]` tombe sur le no-op « nothing to do »
  // qui retourne exit 0 « success » avec geocoded:0 = signature EXACTE de la
  // panne TOTALE silencieuse S-1 (le point unique de panne de cette feature).
  // Le backfill est fail-loud → throw (≠ best-effort `partial` du cron).
  const COUNT_LABEL = srcCfg.countRpc;
  const { data: countData, error: countError } = await retryTransient(
    () =>
      withTimeout(
        supabase.rpc(COUNT_LABEL, { p_source_table: sourceTable }),
        RPC_READ_TIMEOUT_MS,
        COUNT_LABEL,
      ),
    COUNT_LABEL,
    retryOpts,
  );
  if (countError) {
    throw new Error(`[ban-backfill] ${COUNT_LABEL} failed: ${countError.message}`);
  }
  // Garde de forme STRICTE AVANT coercition (parité avec le jumeau cron
  // `rpps.ts` — review P2). `Number(null)`, `Number("")`, `Number("  ")`,
  // `Number("0x0")`, `Number([])` valent tous `0` FINI : sans ce garde une
  // régression de contrat du count se faufilerait en no-op « success » à
  // 0 ligne au lieu d'échouer bruyamment (classe S-1). Seuls un `number` ou
  // une string décimale-entière (`"339000"`, `"0"`) sont des sérialisations
  // PostgREST légitimes d'un `RETURNS BIGINT`.
  const eligibleRowCount = parseRpcCount(countData, `[ban-backfill] ${COUNT_LABEL}`);
  if (eligibleRowCount > 0 && distinctKeys.length === 0) {
    throw new Error(
      `[ban-backfill] ${RPC_LABEL} returned ZERO distinct keys while ${COUNT_LABEL}=${eligibleRowCount} > 0 — predicate/index drift or missing/invalid BAN index (S-1 silent-failure backstop)`,
    );
  }

  // (4) Lire le cache pour ces clés (chunké). Skip : accepted=true FIGÉES,
  // accepted=false au-delà du cap d'attempts. Idempotence : un 2e run trouve
  // tout en cache → 0 clé à soumettre.
  const cached = new Map();
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
        `[ban-backfill] rpps_geocoded_cache_lookup failed: ${error.message}${missingRpcHint(error.message)}`,
      );
    }
    for (const c of data ?? []) cached.set(c.address_key, c);
  }

  // Garde de CONTRAT (fenêtre push-code ↔ apply-migration, T-format prod-only) :
  // sans les 3 champs de gate (`20260905T180000`), la détection des rejets périmés
  // serait un no-op SILENCIEUX (« 0 stale » indiscernable de « rien de périmé »).
  let staleDetectionEnabled = true;
  for (const c of cached.values()) {
    if (hasGateFields(c)) break;
    staleDetectionEnabled = false;
    console.warn(
      `[ban-backfill] rpps_geocoded_cache_lookup renvoie des lignes SANS champs de gate (ex. ${c.address_key}) — migration 20260905T180000 non appliquée : détection des rejets périmés DÉSACTIVÉE ce run`,
    );
    break;
  }

  const keysToSubmit = [];
  let skippedCached = 0;
  // Rejets périmés (cf. `isStaleRejection`, core) — comptés APRÈS la borne --max sur
  // la liste réellement soumise (ils sont à attempts=3 donc en QUEUE de tri : un
  // canari --max les diffère tous, et le dire est la seule chose honnête).
  const staleKeys = new Set();
  for (const key of distinctKeys) {
    const c = cached.get(key);
    if (c === undefined) {
      keysToSubmit.push(key);
      continue;
    }
    if (c.accepted) {
      skippedCached++;
      continue;
    }
    if (c.ban_attempt_count < BAN_MAX_ATTEMPTS) {
      keysToSubmit.push(key);
      continue;
    }
    if (staleDetectionEnabled && isStaleRejection(c, STALE_OPTS)) {
      staleKeys.add(key);
      keysToSubmit.push(key);
      continue;
    }
    skippedCached++;
  }

  // Ordre de service : `(ban_attempt_count ASC, address_key ASC)` — une clé
  // jamais vue a un attempt implicite 0. Les clés JAMAIS TENTÉES (attempt 0)
  // sont donc TOUJOURS servies AVANT les retries de clés déjà rejetées (même
  // garantie que `rpps.ts:runBanGeocodeStep`). Sans ça (tri lexicographique
  // pur), une distribution pathologique de clés bas-triées durablement non
  // résolues pouvait DIFFÉRER la queue jamais-vue de jusqu'à
  // `BAN_MAX_ATTEMPTS` runs. La convergence est inchangée (tout ce qui n'est
  // pas soumis ce run reste éligible+non caché → repris au run suivant) ;
  // l'ordre reste DÉTERMINISTE (tie-break `address_key` total et STABLE).
  const attemptOf = (key) => cached.get(key)?.ban_attempt_count ?? 0;
  keysToSubmit.sort((a, b) => {
    const da = attemptOf(a);
    const db = attemptOf(b);
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Borne --max : slice DÉTERMINISTE de la tête triée (le reste sera repris à
  // un prochain run via le cache — jamais perdu).
  let remaining = 0;
  if (keysToSubmit.length > maxNew) {
    remaining = keysToSubmit.length - maxNew;
    keysToSubmit.length = maxNew;
  }
  let staleResubmitted = 0;
  for (const key of keysToSubmit) if (staleKeys.has(key)) staleResubmitted++;
  const staleDeferred = staleKeys.size - staleResubmitted;
  if (staleDeferred > 0) {
    console.warn(
      `[ban-backfill] ${staleDeferred} rejet(s) périmé(s) NON re-soumis ce run (--max ${maxNew} : les clés à attempts=${BAN_MAX_ATTEMPTS} sont en queue de tri) — relancer SANS --max pour les drainer`,
    );
  }

  if (keysToSubmit.length === 0) {
    console.log(
      `[ban-backfill] nothing to do: ${totalEligibleDistinct} distinct eligible / ${skippedCached} already cached (frozen or attempt-capped) / ${transientRetries} transient_retries — idempotent no-op`,
    );
    return {
      totalEligibleDistinct,
      geocoded: 0,
      skippedCached,
      staleResubmitted,
      staleDeferred,
      staleDetectionEnabled,
      staleRerejected: 0,
      accepted: 0,
      rejected: 0,
      unresolved: 0,
      contractBreached: 0,
      apiFailures: 0,
      transientRetries,
      banChunksByHost: {},
      banHostSwitches: 0,
      banRateLimitRetries: 0,
      remaining,
    };
  }

  console.log(
    `[ban-backfill] ${keysToSubmit.length} addresses to geocode (${staleResubmitted} stale rejections resubmitted) / ${skippedCached} already cached / ${totalEligibleDistinct} distinct eligible${
      remaining > 0 ? ` / ${remaining} deferred (--max ${maxNew})` : ""
    }`,
  );

  // (5) Géocoder par tranches PROGRESS_EVERY pour un log de progression
  // observable (X/Y done) ET pour borner la mémoire d'un job 339k. Chaque
  // tranche est upsertée immédiatement → un re-run après interruption reprend
  // exactement où il s'est arrêté (cache déjà rempli pour les tranches faites).
  let geocoded = 0;
  let accepted = 0;
  let rejected = 0;
  let unresolved = 0;
  // Rejet périmé re-soumis et RE-rejeté sous la règle COURANTE : la BAN a évolué
  // depuis mai (score désormais < seuil, ou plus résolu du tout — 1er drain prod
  // 2026-09-05 : 83/8 616, dont 56 sous le seuil et 27 irrésolus), plus rarement
  // un résultat inexploitable (coords invalides). Isolé du `rejected` ordinaire pour
  // que l'ops voie la part du lot périmé qui ne se récupère pas.
  let staleRerejected = 0;
  // Observabilité multi-hôte du client BAN (cf. `BanGeocodeBatchOutcome`).
  const banChunksByHost = {};
  let banHostSwitches = 0;
  let banRateLimitRetries = 0;
  // S-3 parité avec `rpps.ts:runBanGeocodeStep` : compteur DÉDIÉ au downgrade
  // défensif d'un `accepted=true` à coords NULL (RUPTURE DE CONTRAT du client
  // BAN). Le noyer dans `rejected` masquerait un signal de bug client sous des
  // rejets d'adresse routiniers. Distinct aussi d'un apiFailure (HTTP a réussi).
  let contractBreached = 0;
  let apiFailures = 0;
  const nowIso = () => new Date().toISOString();

  for (let i = 0; i < keysToSubmit.length; i += PROGRESS_EVERY) {
    const sliceKeys = keysToSubmit.slice(i, i + PROGRESS_EVERY);
    const rowsForBan = sliceKeys.map((key) => {
      const inp = distinctKeyInputs.get(key);
      return {
        key,
        adresse: inp?.adresse ?? "",
        codePostal: inp?.codePostal ?? "",
        codeInsee: inp?.codeInsee ?? "",
      };
    });

    const outcome = await geocodeAddressesBatch(rowsForBan, {
      chunkSize: BAN_BULK_CHUNK,
      scoreThreshold: BAN_ACCEPT_SCORE,
      requestTimeoutMs: BAN_REQUEST_TIMEOUT_MS,
    });
    apiFailures += outcome.apiFailures;
    banHostSwitches += outcome.hostSwitches;
    banRateLimitRetries += outcome.rateLimitRetries;
    for (const [h, n] of Object.entries(outcome.chunksByHost)) {
      banChunksByHost[h] = (banChunksByHost[h] ?? 0) + n;
    }

    // Upsert TOUS les results — mêmes semantics que `runBanGeocodeStep` :
    // accepté → coords + accepted=true ; non résolu → accepted=false,
    // ban_attempt_count+1, ban_last_status. Garde défensive : un accepted=true
    // à coords NULL (rupture de contrat client BAN, distinct d'un apiFailure)
    // est downgradé plutôt que de laisser le CHECK constraint throw.
    const upserts = [];
    for (const [key, res] of outcome.results) {
      const prevAttempts = cached.get(key)?.ban_attempt_count ?? 0;
      const isUnresolved = res.lat === null && res.lon === null && res.resultScore === null;
      let acc = res.accepted;
      let lat = res.lat;
      let lon = res.lon;
      let breached = false;
      if (acc && (lat === null || lon === null)) {
        console.error(
          `[ban-backfill] accepted=true with NULL coords for key="${key}" — downgrading to accepted=false (BAN-client contract breach, not an apiFailure)`,
        );
        acc = false;
        lat = null;
        lon = null;
        breached = true;
      }
      if (acc) accepted++;
      else if (breached) contractBreached++;
      else if (isUnresolved) unresolved++;
      else rejected++;
      if (!acc && staleKeys.has(key)) staleRerejected++;
      upserts.push({
        address_key: key,
        lat: acc ? lat : null,
        lon: acc ? lon : null,
        result_score: res.resultScore,
        result_type: res.resultType,
        accepted: acc,
        ban_attempt_count: prevAttempts + 1,
        ban_last_status: banLastStatus(acc, isUnresolved),
        geocoded_at: nowIso(),
      });
    }

    for (let j = 0; j < upserts.length; j += BAN_GEOCODE_BATCH_SIZE) {
      const batch = upserts.slice(j, j + BAN_GEOCODE_BATCH_SIZE);
      const { error } = await retryTransient(
        () => supabase.from("geocoded_addresses").upsert(batch, { onConflict: "address_key" }),
        "geocoded_addresses upsert",
        retryOpts,
      );
      if (error) {
        throw new Error(`[ban-backfill] geocoded_addresses upsert failed: ${error.message}`);
      }
    }

    // Clés réellement TRAITÉES (une entrée par clé envoyée d'un chunk réussi) — pas
    // la taille de la tranche, qui compterait les chunks en apiFailure.
    geocoded += outcome.results.size;
    console.log(
      `[ban-backfill] ${Math.min(i + PROGRESS_EVERY, keysToSubmit.length)}/${keysToSubmit.length} done (${accepted} accepted / ${rejected} rejected_low_score / ${unresolved} unresolved / ${contractBreached} contract_breach_downgrades / ${apiFailures} api_failures so far)`,
    );
  }

  if (staleRerejected > 0) {
    console.warn(
      `[ban-backfill] ${staleRerejected} rejet(s) périmé(s) re-soumis et RE-rejeté(s) sous la règle courante (BAN : score désormais < seuil ou adresse irrésolue ; rarement coords invalides) — plafond BAN_STALE_RESUBMIT_CAP atteint, plus jamais re-soumis`,
    );
  }
  console.log(
    `[ban-backfill] DONE: ${geocoded} geocoded / ${staleResubmitted} stale_rejections_resubmitted${staleDeferred > 0 ? ` (${staleDeferred} deferred by --max)` : ""}${staleRerejected > 0 ? ` (${staleRerejected} re-rejected)` : ""} / ${skippedCached} cached / ${accepted} accepted / ${rejected} rejected_low_score / ${unresolved} unresolved / ${contractBreached} contract_breach_downgrades / ${apiFailures} api_failures / ${transientRetries} transient_retries / ban_hosts=${JSON.stringify(banChunksByHost)} host_switches=${banHostSwitches} rate_limit_retries=${banRateLimitRetries}${
      remaining > 0 ? ` / ${remaining} deferred (re-run to continue)` : ""
    }`,
  );

  return {
    totalEligibleDistinct,
    geocoded,
    staleRerejected,
    banChunksByHost,
    banHostSwitches,
    banRateLimitRetries,
    skippedCached,
    staleResubmitted,
    staleDeferred,
    staleDetectionEnabled,
    accepted,
    rejected,
    unresolved,
    contractBreached,
    apiFailures,
    transientRetries,
    remaining,
  };
}

/**
 * Compteurs du run exposés au workflow (`$GITHUB_OUTPUT`), déjà tous présents
 * dans le log `DONE:` — ce n'est qu'un second média, lisible par un STEP.
 * Consommés par `ban-backfill.yml` : le step « Close pending-geocode issue »
 * ne ferme QUE si `remaining === "0"` (file réellement vidée, jamais un canari)
 * et compose son commentaire avec `processed` / `accepted` / `finished_at`.
 *
 * `finished_at` est déjà formaté (UTC, minute) : GitHub Actions n'a aucune
 * fonction de date en expression, composer la ligne côté YAML est impossible.
 *
 * @param {{geocoded?: number, accepted?: number, remaining?: number}} result Retour de `runBanBackfill`.
 * @param {Date} [now] Injectable pour le test.
 * @returns {Record<string, string>}
 */
export function banBackfillOutputs(result, now = new Date()) {
  return {
    processed: String(result.geocoded ?? 0),
    accepted: String(result.accepted ?? 0),
    remaining: String(result.remaining ?? 0),
    finished_at: `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  };
}

/**
 * Écrit les outputs dans `$GITHUB_OUTPUT` (heredoc à délimiteur ALÉATOIRE,
 * même geste que `scripts/ingest/shared.ts:writeGithubOutput` — dupliqué et
 * PAS importé : ce script est un `.mjs` autonome, sa seule dépendance TS est
 * `src/core`). Best-effort : hors CI (variable absente) ou canal mort, on log
 * LOUD et on continue — le drain, lui, a réussi ; c'est la fermeture d'issue
 * en aval qui sera simplement skippée (garde `remaining == '0'`).
 *
 * Pas de garde anti-collision de délimiteur ici (contrairement à `shared.ts`) :
 * les valeurs sont des ENTIERS et une date formatée, jamais du texte libre venu
 * de la base — `banBackfillOutputs` est la seule fabrique de ces valeurs.
 *
 * @param {Record<string, string>} entries
 */
export function writeGithubOutput(entries) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    console.warn(
      "[ban-backfill] GITHUB_OUTPUT absent — outputs non écrits (run hors GitHub Actions ?)",
    );
    return;
  }
  const delim = `__BAN_${randomUUID()}__`;
  const payload = Object.entries(entries)
    .map(([k, v]) => `${k}<<${delim}\n${v}\n${delim}\n`)
    .join("");
  try {
    appendFileSync(out, payload);
  } catch (err) {
    const msg = `[ban-backfill] écriture $GITHUB_OUTPUT échouée — la fermeture d'issue en aval sera skippée: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    console.log(`::error::${msg}`);
  }
}

/**
 * Parse `--source rpps|ameli|finess` depuis argv (tolère `--source=ameli`). Défaut
 * `"rpps"`. Une valeur hors `SOURCES` → throw (fail-loud : un drainage mal
 * ciblé doit être BRUYANT, jamais silencieusement redirigé sur RPPS).
 */
function parseSourceArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v;
    if (a === "--source") v = argv[i + 1];
    else if (a?.startsWith("--source=")) v = a.slice("--source=".length);
    else continue;
    if (!v || !(v in SOURCES)) {
      throw new Error(
        `[ban-backfill] --source invalide ${JSON.stringify(v)} (attendu: ${Object.keys(SOURCES).join("|")})`,
      );
    }
    return v;
  }
  return "rpps";
}

/** Parse `--max N` depuis argv (tolère `--max=N`). */
function parseMaxArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") {
      const v = Number(argv[i + 1]);
      return Number.isFinite(v) && v > 0 ? v : undefined;
    }
    if (a?.startsWith("--max=")) {
      const v = Number(a.slice("--max=".length));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    }
  }
  return undefined;
}

// Entrypoint : exécuté uniquement quand lancé directement (jamais à l'import
// par le test). Pas de wiring CI/cron — script jeté, lancé manuellement.
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const maxNew = parseMaxArg(argv);
  const source = parseSourceArg(argv);
  console.log(`[ban-backfill] source=${source}${maxNew ? ` --max ${maxNew}` : ""}`);
  runBanBackfill(buildServiceClient(), { source, ...(maxNew ? { maxNew } : {}) })
    .then((r) => {
      // Compteurs exposés au STEP appelant (fermeture auto de l'issue
      // `pending-geocode`) AVANT le code de sortie : un exit 2 canari doit
      // publier `remaining > 0`, c'est ce qui INTERDIT la fermeture.
      writeGithubOutput(banBackfillOutputs(r));
      // Sortie non-zéro si le drain n'est pas COMPLET, pour que le bouton CI ne
      // mente PAS « vert = 100 % géocodé » (F-2 silent-failure review) :
      //  3 = des chunks BAN ont échoué (apiFailures) → re-run (idempotent, reprend
      //      via le cache non écrit pour ces chunks) ;
      //  2 = backlog --max restant (tranche volontaire) → re-run pour continuer ;
      //  0 = drain complet.
      if (r.apiFailures > 0) process.exitCode = 3;
      else if (r.remaining > 0) process.exitCode = 2;
      else process.exitCode = 0;
    })
    .catch((err) => {
      console.error(`[ban-backfill] FATAL: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
