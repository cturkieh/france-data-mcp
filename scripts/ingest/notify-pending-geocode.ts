import "./load-env.js";
import { appendFileSync } from "node:fs";
import { getUntypedServiceClient, runIfMain } from "./shared.js";

/**
 * Alerte ops : prévient quand un cron d'ingestion (RPPS / Ameli) vient de poser
 * de nouvelles adresses qui restent à géocoder (BAN), en attendant que le
 * re-géocodage récurrent soit automatisé (backlog P1, `docs/plans/ban-join.md`).
 *
 * Lit la dernière ligne `ingest_log` de la source (le cron vient de l'écrire),
 * décide s'il faut alerter, et expose la décision via `$GITHUB_OUTPUT` — les
 * steps email (Resend) + issue GitHub du workflow consomment `should_notify`.
 *
 * **Best-effort par design** : la notif tourne APRÈS une ingestion déjà réussie
 * (swap fait). Une lecture DB qui échoue ne doit JAMAIS re-marquer le cron en
 * échec → on log LOUD (`console.error`) et on n'alerte pas (`should_notify=false`),
 * sans throw. Le prochain cron retentera.
 */

/** Sources qui posent des adresses BAN (FINESS/CDS n'en posent pas). */
const SOURCES = ["rpps", "ameli"] as const;
type Source = (typeof SOURCES)[number];

/**
 * Arg CLI lisible → valeur RÉELLE de `ingest_log.source` (écrite par les
 * ingesteurs). ⚠️ Ameli logue `"ameli_ps"`, PAS `"ameli"` (cf. `ameli.ts:186`
 * + le step "Open issue on failure" du workflow) : interroger `"ameli"` ne
 * matcherait AUCUNE ligne → faux négatif silencieux (jamais d'alerte).
 */
const DB_SOURCE: Record<Source, string> = { rpps: "rpps", ameli: "ameli_ps" };

/** Sous-ensemble de `IngestLogEntry` (cf. `shared.ts`) lu pour la décision. */
export interface IngestLogTail {
  status?: string | null;
  skip_reason?: string | null;
  /**
   * BIGINT côté Postgres → **PostgREST le sérialise en STRING** (gotcha projet,
   * cf. CLAUDE.md « Top gotchas DB »), malgré un type apparent `number`. La
   * décision coerce via `Number()` + `Number.isFinite` avant toute comparaison.
   */
  ban_to_geocode_distinct?: number | string | null;
  started_at?: string | null;
}

export interface NotifyDecision {
  shouldNotify: boolean;
  /** Compte coercé. 0 quand rien à géocoder OU quand la mesure est indisponible. */
  pending: number;
  /**
   * `true` quand la mesure amont a échoué (`null`) ou est corrompue (non
   * numérique) sur un run POURTANT réussi → alerte DÉGRADÉE (compte inconnu,
   * vérifier la RPC), jamais un faux « tout va bien ». Consommé par l'alerte
   * pour adapter le message.
   */
  measurementUnavailable?: boolean;
  /** Raison lisible (loguée + utile en post-mortem). */
  reason: string;
}

/**
 * Cœur testable : décide s'il faut alerter à partir de la dernière ligne
 * `ingest_log`. N'alerte que sur une **vraie ingestion** — PAS sur un
 * court-circuit « même fichier » (aucune nouvelle adresse posée → re-notifier
 * serait du spam, le résidu a déjà été signalé au dernier vrai run).
 *
 * Distingue trois issues sur un vrai run réussi : (a) compte > 0 → alerte
 * normale ; (b) compte = 0 → silence légitime ; (c) compte `null`/corrompu →
 * alerte DÉGRADÉE. Le cas (c) est load-bearing : `ban_to_geocode_distinct` est
 * mesuré best-effort par le cron (`rpps.ts`/`ameli.ts`) et vaut `null` quand la
 * RPC de mesure a échoué. Le blanchir en `0` (« rien à géocoder ») masquerait
 * une mesure cassée durablement = silence permanent alors que des adresses
 * réelles attendent. Doctrine projet : erreur ≠ pas de résultat.
 */
export function decidePendingNotification(row: IngestLogTail | null): NotifyDecision {
  if (!row) {
    return { shouldNotify: false, pending: 0, reason: "aucune ligne ingest_log trouvée" };
  }
  if (row.status === "failed") {
    // Le run lui-même a échoué → déjà couvert par le step "Open issue on
    // failure" dédié ; la mesure n'est de toute façon pas fiable.
    return {
      shouldNotify: false,
      pending: 0,
      reason: "run failed — alerte couverte par le step échec dédié",
    };
  }

  // BIGINT côté Postgres → STRING via PostgREST (gotcha projet) : coercer.
  const raw = row.ban_to_geocode_distinct;
  const pending = raw == null ? Number.NaN : Number(raw);

  if (row.skip_reason === "same_checksum") {
    return {
      shouldNotify: false,
      pending: Number.isFinite(pending) ? pending : 0,
      reason: "court-circuit même fichier — aucune nouvelle adresse posée",
    };
  }

  // Vrai run réussi à partir d'ici.
  if (!Number.isFinite(pending)) {
    return {
      shouldNotify: true,
      pending: 0,
      measurementUnavailable: true,
      reason: `mesure ban_to_geocode indisponible (reçu ${JSON.stringify(raw)}) sur un run réussi — comptage impossible, vérifier la RPC de mesure`,
    };
  }
  if (pending <= 0) {
    return { shouldNotify: false, pending, reason: "aucune adresse en attente de géocodage" };
  }
  return {
    shouldNotify: true,
    pending,
    reason: `${pending} adresses à géocoder après une vraie ingestion`,
  };
}

async function readLatestIngestLog(source: Source): Promise<IngestLogTail | null> {
  const supabase = getUntypedServiceClient(`notify-${source}`);
  const { data, error } = await supabase
    .from("ingest_log")
    .select("status, skip_reason, ban_to_geocode_distinct, started_at")
    .eq("source", DB_SOURCE[source])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`lecture ingest_log (source=${source}) échouée: ${error.message}`);
  }
  return (data as IngestLogTail | null) ?? null;
}

/**
 * Écrit les paires clé=valeur dans `$GITHUB_OUTPUT` (no-op hors Actions).
 * Best-effort : un échec d'écriture est logué LOUD mais ne throw pas — la
 * panne ne doit pas masquer la décision déjà calculée (cf. M2).
 */
function writeGithubOutput(entries: Record<string, string>): void {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    console.warn(
      "[notify-pending-geocode] GITHUB_OUTPUT absent — outputs non écrits (run hors GitHub Actions ?)",
    );
    return;
  }
  const payload = `${Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  try {
    appendFileSync(out, payload);
  } catch (err) {
    console.error(
      "[notify-pending-geocode] écriture $GITHUB_OUTPUT échouée — l'alerte downstream sera skippée:",
      err,
    );
  }
}

/** Orchestration I/O best-effort — ne throw jamais (cron déjà réussi). */
export async function runNotifyCheck(source: Source): Promise<NotifyDecision> {
  let decision: NotifyDecision;
  try {
    const row = await readLatestIngestLog(source);
    decision = decidePendingNotification(row);
  } catch (err) {
    // Lecture impossible (panne DB transitoire). Contradictoire avec un cron
    // qui vient de réussir → on ne spamme pas d'alerte, mais on log LOUD ; le
    // prochain cron retentera. Distinct du cas `null` en DB (mesure RPC
    // échouée → alerte dégradée, géré dans decidePendingNotification).
    console.error(
      `[notify-pending-geocode][${source}] lecture ingest_log impossible (best-effort, pas d'alerte):`,
      err,
    );
    decision = { shouldNotify: false, pending: 0, reason: "lecture ingest_log impossible" };
  }
  const line =
    `[notify-pending-geocode][${source}] ${decision.reason} ` +
    `(pending=${decision.pending}, notify=${decision.shouldNotify})`;
  // Mesure indisponible sur un run réussi = anomalie → LOUD, pas un log info.
  if (decision.measurementUnavailable) {
    console.error(line);
  } else {
    console.log(line);
  }
  writeGithubOutput({
    pending: String(decision.pending),
    should_notify: String(decision.shouldNotify),
    measurement_unavailable: String(decision.measurementUnavailable === true),
    source_label: source.toUpperCase(),
  });
  return decision;
}

export function parseSourceArg(argv: readonly string[]): Source {
  const arg = argv[2];
  // Dérivé de SOURCES (pas de littéral en dur) : ajouter une source = 1 seul
  // endroit à toucher, SOURCES/DB_SOURCE/parser ne peuvent pas diverger.
  if (SOURCES.includes(arg as Source)) {
    return arg as Source;
  }
  throw new Error(
    `usage: notify-pending-geocode <${SOURCES.join("|")}> (reçu: ${JSON.stringify(arg)})`,
  );
}

await runIfMain(import.meta.url, async () => {
  // Filet top-level (M2) : toute exception non prévue (arg invalide,
  // appendFileSync, etc.) est loguée LOUD et n'échoue PAS le step — sinon le
  // crash serait avalé silencieusement par le `continue-on-error` du workflow
  // (run vert, aucune alerte, aucune trace). exit 0 explicite.
  try {
    const source = parseSourceArg(process.argv);
    await runNotifyCheck(source);
  } catch (err) {
    console.error("[notify-pending-geocode] échec inattendu (best-effort, pas d'alerte):", err);
  }
});
