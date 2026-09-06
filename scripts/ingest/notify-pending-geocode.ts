import "./load-env.js";
import { INGEST_SOURCE_LABEL, type IngestSource } from "../../src/storage/ingest-log.js";
import { getUntypedServiceClient, oneLine, runIfMain, writeGithubOutput } from "./shared.js";

/**
 * Alerte ops : signale quand un cron d'ingestion (RPPS / Ameli) vient de poser
 * de nouvelles adresses restant à géocoder (BAN). Le re-géocodage est désormais
 * AUTOMATISÉ (drain BAN en `workflow_run` post-cron, cf.
 * `ban-backfill-{rpps,ameli}.yml`) : l'alerte normale est INFORMATIVE (résidu
 * auto-géocodé, aucune action requise) ; seule la mesure indisponible reste une
 * vraie anomalie actionnable.
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

/**
 * Sources qui posent des adresses BAN (FINESS/CDS n'en posent pas).
 *
 * EXPORTÉ : `workflows-alerting.test.ts` s'en sert pour exiger que CHAQUE
 * source signalée ici ait un appelant de drain BAN (`ban-backfill-<source>.yml`)
 * — sans quoi une issue `pending-geocode` s'ouvrirait sans jamais être ni
 * drainée ni fermée.
 */
export const SOURCES = ["rpps", "ameli"] as const;
type Source = (typeof SOURCES)[number];

/**
 * Arg CLI lisible → valeur RÉELLE de `ingest_log.source` (écrite par les
 * ingesteurs). ⚠️ Ameli logue `"ameli_ps"`, PAS `"ameli"` (cf. `ameli.ts:186`
 * + le step "Open issue on failure" du workflow) : interroger `"ameli"` ne
 * matcherait AUCUNE ligne → faux négatif silencieux (jamais d'alerte).
 */
const DB_SOURCE: Record<Source, IngestSource> = { rpps: "rpps", ameli: "ameli_ps" };

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
    reason: `${pending} adresses en attente de géocodage automatique (drain BAN à suivre) après une vraie ingestion`,
  };
}

export interface PendingMessage {
  subject: string;
  text: string;
  issueTitle: string;
  issueBody: string;
  /** Commentaire posé sur l'issue déjà ouverte (idempotence, `upsert-ops-issue`). */
  issueComment: string;
}

/**
 * Wording unique (email + issue), composé ici et TESTÉ — plus dans un step bash
 * du YAML (un heredoc multi-ligne y a déjà cassé le parse de la composite, ce
 * que le test de câblage textuel ne voyait pas). Deux registres : mesure amont
 * indisponible = message DÉGRADÉ (surtout pas « 0 adresses », trompeur) ;
 * résidu normal = INFORMATIF (le drain BAN auto géocode, aucune action manuelle).
 */
export function composePendingMessage(
  source: Source,
  decision: NotifyDecision,
  runUrl: string,
): PendingMessage {
  const label = INGEST_SOURCE_LABEL[DB_SOURCE[source]];
  if (decision.measurementUnavailable) {
    const body = `Le cron ${label} a RÉUSSI mais la **mesure** du nombre d'adresses à géocoder (BAN) a échoué (RPC de mesure). Comptage INCONNU — vérifier la RPC de mesure et que le drain BAN auto a bien tourné.`;
    return {
      subject: `[france-data-mcp] ${label} : ⚠️ mesure des adresses à géocoder indisponible`,
      text: `${body.replaceAll("**", "")} Run : ${runUrl}`,
      issueTitle: `[pending-geocode] ${label} : ⚠️ mesure des adresses à géocoder indisponible`,
      issueBody: `${body}\n\nRun : ${runUrl}`,
      issueComment: `⚠️ Mesure des adresses ${label} à géocoder INDISPONIBLE (RPC de mesure échouée) — comptage inconnu, vérifier le cron.\n\nRun : ${runUrl}`,
    };
  }
  const n = decision.pending;
  return {
    subject: `[france-data-mcp] ${label} : ${n} adresses en attente de géocodage auto`,
    text: `Le cron ${label} a ingéré de nouvelles données. ${n} adresses distinctes seront géocodées AUTOMATIQUEMENT au prochain drain BAN (déclenché tout seul après ce cron). Aucune action requise. Si ce compte ne baisse pas sur plusieurs cycles, le drain auto est peut-être cassé : vérifier les workflows « Backfill BAN ». Run : ${runUrl}`,
    issueTitle: `[pending-geocode] ${label} : adresses en attente de géocodage automatique`,
    issueBody: [
      `Le cron ${label} a ingéré de nouvelles données. **${n}** adresses distinctes seront géocodées **automatiquement** au prochain drain BAN (déclenché en \`workflow_run\` après ce cron — cf. \`ban-backfill-${source}.yml\`).`,
      "✅ Aucune action manuelle requise.",
      "Cette issue est une **trace de surveillance** : si le compte ne baisse pas sur plusieurs cycles, le drain auto est peut-être cassé — vérifier les workflows « Backfill BAN ».",
      `Run : ${runUrl}`,
    ].join("\n\n"),
    issueComment: `🔄 Mise à jour : **${n}** adresses ${label} en attente de géocodage automatique (drain BAN auto à suivre).\n\nRun : ${runUrl}`,
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
  // Mesure indisponible sur un run réussi = anomalie → annotation GitHub
  // (page du run) AVANT l'écriture des outputs : si celle-ci échoue, la trace
  // dégradée survit.
  if (decision.measurementUnavailable) {
    console.error(line);
    console.log(`::warning::${oneLine(line)}`);
  } else {
    console.log(line);
  }
  const outputs: Record<string, string> = {
    pending: String(decision.pending),
    should_notify: String(decision.shouldNotify),
    measurement_unavailable: String(decision.measurementUnavailable === true),
  };
  if (decision.shouldNotify) {
    const msg = composePendingMessage(
      source,
      decision,
      process.env.GITHUB_RUN_URL ?? "(hors GitHub Actions)",
    );
    Object.assign(outputs, {
      subject: msg.subject,
      text: msg.text,
      issue_title: msg.issueTitle,
      issue_body: msg.issueBody,
      issue_comment: msg.issueComment,
    });
  }
  writeGithubOutput("notify-pending-geocode", outputs);
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
