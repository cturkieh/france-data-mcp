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
// accepted=false au-delà du cap d'attempts) → un 2e run ne re-géocode ~rien.
//
// Lancement manuel :
//   tsx scripts/ban-backfill.mjs [--max N]
// (mêmes env que les ingesters : SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY ;
//  pattern client miroir de `scripts/ingest/shared.ts:getUntypedServiceClient`).
//
// Observabilité (best-effort) : préfixe [ban-backfill] ; les apiFailures du
// client BAN sont comptés et exposés (jamais un arrêt silencieux ayant fait
// une fraction tout en rapportant un succès — la classe de bug combattue).

import { createClient } from "@supabase/supabase-js";
import {
  banLastStatus,
  geocodeAddressesBatch,
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
// durablement non résolue → on ne la re-soumet plus (identique au cron
// `BAN_MAX_ATTEMPTS` de `scripts/ingest/rpps.ts`). Les `accepted=true` sont
// FIGÉES (jamais re-soumises) ; les clés jamais vues toujours soumises.
const BAN_MAX_ATTEMPTS = 3;
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
 * Backfill cache-only, idempotent.
 *
 * Fail-loud BY DESIGN : une erreur (ou un timeout) de lecture d'éligibilité
 * en cours d'énumération keyset RPC throw et AVORTE tout le run (pas de
 * `partial` best-effort comme le cron) — un re-run reprend à moindre coût via
 * le cache persistant.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ maxNew?: number, sourceTable?: string }} [opts]
 *   - maxNew : borne le nb de NOUVELLES adresses distinctes soumises ce run
 *     (slice déterministe de la tête triée → permet de lancer en tranches ;
 *     un re-run reprend où il en est via le cache). Défaut : illimité.
 *   - sourceTable : table d'éligibilité, passée en `p_source_table` à
 *     `rpps_distinct_eligible_keys` (validée par le whitelist SQL ;
 *     hors-whitelist → erreur RPC → throw, contrat fail-loud). Défaut
 *     `"rpps"` (table LIVE peuplée entre deux runs ; `rpps_staging` n'existe
 *     que PENDANT l'ingestion, donc un backfill standalone DOIT lire `rpps`).
 * @returns {Promise<{ totalEligibleDistinct:number, geocoded:number,
 *   skippedCached:number, accepted:number, rejected:number, unresolved:number,
 *   contractBreached:number, apiFailures:number, transientRetries:number,
 *   remaining:number }>}
 */
export async function runBanBackfill(supabase, opts = {}) {
  const maxNew =
    typeof opts.maxNew === "number" && Number.isFinite(opts.maxNew) && opts.maxNew > 0
      ? Math.floor(opts.maxNew)
      : Number.POSITIVE_INFINITY;
  const sourceTable = opts.sourceTable ?? "rpps";

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
  let after = null;
  let pageCount = 0;
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
  // source — pas 3 littéraux à garder synchrones).
  const RPC_LABEL = "rpps_distinct_eligible_keys";
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
            p_after: after,
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
      if (!distinctKeyInputs.has(r.address_key)) {
        distinctKeyInputs.set(r.address_key, {
          adresse: r.adresse ?? "",
          codePostal: r.code_postal ?? "",
          codeInsee: r.code_insee ?? "",
        });
      }
    }
    after = rows[rows.length - 1].address_key;
    pageCount++;
    const keyMultiple = Math.floor(distinctKeyInputs.size / PROGRESS_EVERY);
    if (keyMultiple > loggedKeyMultiple) {
      loggedKeyMultiple = keyMultiple;
      console.log(
        `[ban-backfill] eligibility enumeration: ${distinctKeyInputs.size} distinct keys / ${pageCount} pages`,
      );
    }
  }
  // Pas de `.sort()` : la RPC + le keyset garantissent déjà l'ordre croissant
  // global des clés. Le SEUL tri de service est le tri attempt-first plus bas
  // (l.~190) — un re-tri lexicographique ici l'écraserait. Un re-run partiel
  // (--max) reste déterministe : les clés cachées au run précédent sont
  // filtrées AVANT le slice → la tête avance, le backlog draine de façon
  // monotone.
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
  const COUNT_LABEL = "rpps_count_ban_eligible_rows";
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

  const keysToSubmit = [];
  let skippedCached = 0;
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
    } else {
      skippedCached++;
    }
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

  if (keysToSubmit.length === 0) {
    console.log(
      `[ban-backfill] nothing to do: ${totalEligibleDistinct} distinct eligible / ${skippedCached} already cached (frozen or attempt-capped) / ${transientRetries} transient_retries — idempotent no-op`,
    );
    return {
      totalEligibleDistinct,
      geocoded: 0,
      skippedCached,
      accepted: 0,
      rejected: 0,
      unresolved: 0,
      contractBreached: 0,
      apiFailures: 0,
      transientRetries,
      remaining,
    };
  }

  console.log(
    `[ban-backfill] ${keysToSubmit.length} addresses to geocode / ${skippedCached} already cached / ${totalEligibleDistinct} distinct eligible${
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

    geocoded += sliceKeys.length;
    console.log(
      `[ban-backfill] ${Math.min(i + PROGRESS_EVERY, keysToSubmit.length)}/${keysToSubmit.length} done (${accepted} accepted / ${rejected} rejected_low_score / ${unresolved} unresolved / ${contractBreached} contract_breach_downgrades / ${apiFailures} api_failures so far)`,
    );
  }

  console.log(
    `[ban-backfill] DONE: ${geocoded} geocoded / ${skippedCached} cached / ${accepted} accepted / ${rejected} rejected_low_score / ${unresolved} unresolved / ${contractBreached} contract_breach_downgrades / ${apiFailures} api_failures / ${transientRetries} transient_retries${
      remaining > 0 ? ` / ${remaining} deferred (re-run to continue)` : ""
    }`,
  );

  return {
    totalEligibleDistinct,
    geocoded,
    skippedCached,
    accepted,
    rejected,
    unresolved,
    contractBreached,
    apiFailures,
    transientRetries,
    remaining,
  };
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
  const maxNew = parseMaxArg(process.argv.slice(2));
  runBanBackfill(buildServiceClient(), maxNew ? { maxNew } : {})
    .then((r) => {
      // Sortie non-zéro si un backlog reste (CI/scripts peuvent re-lancer).
      process.exitCode = r.remaining > 0 ? 2 : 0;
    })
    .catch((err) => {
      console.error(`[ban-backfill] FATAL: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
