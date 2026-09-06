import "./load-env.js";
import {
  type FreshnessRowLike,
  INGEST_CADENCE,
  INGEST_SOURCES,
  INGEST_SOURCE_LABEL,
  type IngestSource,
  ageInDays,
  isFailedRun,
  lastDataChange,
  runEndedAt,
  sortNewestFirst,
} from "../../src/storage/ingest-log.js";
import {
  CANARY_RPC_ERROR,
  getUntypedServiceClient,
  oneLine,
  runIfMain,
  writeGithubOutput,
} from "./shared.js";

/**
 * Vigie post-cron « run vert mais donnée malade » (backlog FINESS phase 2,
 * item 8). Deux anomalies qu'un cron en code 0 ne signale à personne :
 *
 *   1. **`partial`** — swap réussi, couche secondaire en échec (canary
 *      manquant, matview non reconstruite). Preuve prod : le canary FINESS
 *      `130786049` a échoué à chaque run du 2026-05-15 au 2026-09-01 sans
 *      qu'aucune alerte ne parte (le workflow n'alertait que sur `failure()`).
 *   2. **source tarie** — la source enchaîne des court-circuits `same_checksum`
 *      au-delà de sa cadence attendue : la donnée servie vieillit alors que
 *      chaque run est `success`. Preuve prod : le CSV DREES FINESS est mort le
 *      2026-07-20, quatre mois de skips verts avant qu'on le voie.
 *
 * MÊME règle que `data_freshness` — pas « la même en esprit », les mêmes
 * fonctions (`lastDataChange`, `ageInDays`, `INGEST_CADENCE`) importées de
 * `src/storage/ingest-log.ts` : le témoin exposé au caller MCP et l'alerte ne
 * peuvent pas diverger.
 *
 * Lit `ingest_log` (le cron vient d'écrire sa ligne), décide, expose la
 * décision et le wording via `$GITHUB_OUTPUT` — la composite
 * `.github/actions/notify-ingest-anomaly` ouvre/commente une issue idempotente
 * (clé = source + types d'anomalie : une escalade `stale` → `partial+stale`
 * ouvre une NOUVELLE issue) et n'envoie l'email qu'à l'OUVERTURE ou si le canal
 * issue a échoué — jamais sur un simple commentaire (une source gelée le reste
 * des semaines : un mail par cron serait la fatigue d'alerte que la vigie
 * existe pour éviter).
 *
 * **Best-effort par design** : tourne APRÈS un cron réussi. Une lecture DB
 * qui échoue ne doit JAMAIS re-marquer le cron en échec → annotation
 * `::error::` (visible sur la page du run, pas seulement dans le log),
 * `should_notify=false`, exit 0. Le prochain cron retentera.
 */

export type AnomalyKind = "partial" | "stale";

/** Sous-ensemble de `IngestLogEntry` lu pour la décision. */
export interface AnomalyLogRow extends FreshnessRowLike {
  /** `TEXT[]` côté Postgres : un tableau peut porter des éléments NULL. */
  canary_failures?: (string | null)[] | null;
  error_message?: string | null;
  github_run_url?: string | null;
}

/** Une anomalie = son type ET son wording, appariés par construction. */
export interface Anomaly {
  readonly kind: AnomalyKind;
  readonly detail: string;
}

interface DecisionBase {
  /** Raison lisible (loguée + utile en post-mortem). */
  readonly reason: string;
  /** Âge de la donnée servie (jours) depuis la dernière ingestion réelle ; null si aucune / illisible. */
  readonly dataAgeDays: number | null;
  readonly expectedMaxAgeDays: number;
  /** Runs court-circuités (`skip_reason` posé) DEPUIS la dernière ingestion réelle (un `failed` intercalé compte à part). */
  readonly skipsSinceLastRealIngest: number;
}

/** Discriminée : une décision « à notifier » porte AU MOINS une anomalie, une décision saine aucune. */
export type AnomalyDecision =
  | (DecisionBase & { readonly shouldNotify: false; readonly anomalies: readonly [] })
  | (DecisionBase & {
      readonly shouldNotify: true;
      readonly anomalies: readonly [Anomaly, ...Anomaly[]];
    });
export type NotifiableDecision = Extract<AnomalyDecision, { shouldNotify: true }>;

const noAnomaly = (source: IngestSource, reason: string): AnomalyDecision => ({
  shouldNotify: false,
  anomalies: [],
  reason,
  dataAgeDays: null,
  expectedMaxAgeDays: INGEST_CADENCE[source].maxAgeDays,
  skipsSinceLastRealIngest: 0,
});

/**
 * Cœur testable. `rows` = lignes `ingest_log` de la source (ordre indifférent,
 * trié en interne). Un `failed` en tête ne saute que la branche `partial` (le
 * step d'échec dédié couvre le run raté, il ne dit RIEN de l'âge de la donnée).
 */
export function decideAnomalyNotification(
  source: IngestSource,
  rows: readonly AnomalyLogRow[],
  now: number = Date.now(),
): AnomalyDecision {
  const expectedMaxAgeDays = INGEST_CADENCE[source].maxAgeDays;
  const sorted = sortNewestFirst(rows);
  const latest = sorted[0];
  if (!latest) return noAnomaly(source, "aucune ligne ingest_log trouvée");

  const anomalies: Anomaly[] = [];

  // 1. `partial` sur le run le plus récent.
  if (!isFailedRun(latest) && latest.status === "partial") {
    const rawCanary = latest.canary_failures;
    const canary = Array.isArray(rawCanary)
      ? rawCanary.filter((v): v is string => typeof v === "string")
      : [];
    const why: string[] = [];
    if (rawCanary != null && !Array.isArray(rawCanary)) {
      why.push(
        `canary_failures illisible (${JSON.stringify(rawCanary)}) — contrat ingest_log changé ?`,
      );
    }
    if (canary.length > 0) {
      why.push(
        canary.includes(CANARY_RPC_ERROR)
          ? "vérification canary indisponible (RPC en erreur)"
          : `canary manquant après le swap : ${canary.join(", ")}`,
      );
    }
    if (latest.error_message) why.push(latest.error_message);
    anomalies.push({
      kind: "partial",
      detail: `Run PARTIAL : le swap a réussi mais une couche secondaire a échoué (${why.length > 0 ? why.join(" ; ") : "détail absent — lire la ligne ingest_log"}). La donnée servie est à jour, un tool dérivé (matview, canary) peut être dégradé jusqu'au prochain run.`,
    });
  }

  // 2. Source tarie : âge depuis la dernière ingestion RÉELLE (règle partagée).
  const { row: lastChange, skipsSince } = lastDataChange(sorted);
  const dataAgeDays = lastChange ? ageInDays(runEndedAt(lastChange), now) : null;
  if (lastChange === null) {
    anomalies.push({
      kind: "stale",
      detail: `Source tarie : aucune ingestion RÉELLE sur les ${sorted.length} derniers runs (${skipsSince} court-circuits « fichier amont identique »). La donnée servie n'a pas d'âge mesurable — vérifier la publication amont.`,
    });
  } else if (dataAgeDays === null || dataAgeDays < 0) {
    // Horodatage illisible ou dans le futur = anomalie de la ligne elle-même,
    // pas un « tout va bien » (un âge négatif passerait le `>` sans bruit).
    anomalies.push({
      kind: "stale",
      detail: `Source tarie ? Horodatage ${dataAgeDays === null ? "illisible" : "dans le futur"} sur la dernière ingestion réelle (${JSON.stringify(runEndedAt(lastChange))}) — âge de la donnée inconnu, vérifier ingest_log.`,
    });
  } else if (dataAgeDays > expectedMaxAgeDays) {
    anomalies.push({
      kind: "stale",
      detail: `Source tarie : la donnée servie a ${dataAgeDays} jours (dernière ingestion réelle le ${runEndedAt(lastChange).slice(0, 10)}), au-delà des ${expectedMaxAgeDays} jours attendus (${INGEST_CADENCE[source].hint}). ${skipsSince} run(s) court-circuité(s) « fichier amont identique » en statut success depuis — la publication amont est probablement gelée ou arrêtée (cf. CSV DREES FINESS, mort le 2026-07-20 et vu quatre mois plus tard).`,
    });
  }

  const base: DecisionBase = {
    reason: "",
    dataAgeDays,
    expectedMaxAgeDays,
    skipsSinceLastRealIngest: skipsSince,
  };
  const [first, ...rest] = anomalies;
  if (first === undefined) {
    return {
      ...base,
      reason: `run sain (age=${dataAgeDays ?? "?"}j ≤ ${expectedMaxAgeDays}j, status=${latest.status ?? "?"})`,
      shouldNotify: false,
      anomalies: [],
    };
  }
  return {
    ...base,
    reason: `anomalie(s) ${anomalies.map((a) => a.kind).join("+")} sur un run réussi`,
    shouldNotify: true,
    anomalies: [first, ...rest],
  };
}

/** Drapeau par type — `Record` : ajouter un `AnomalyKind` sans son libellé ne compile pas. */
const ANOMALY_FLAG: Record<AnomalyKind, string> = {
  partial: "⚠️ run PARTIAL",
  stale: "⏳ source TARIE",
};

export interface AnomalyMessage {
  subject: string;
  text: string;
  issueTitle: string;
  issueBody: string;
  /** Clé d'idempotence de l'issue : `ingest-anomaly,<slug>,<kind>…` (slug = libellé minuscule, comme les labels des autres alertes). */
  issueLabels: string;
}

/** Wording unique (email + issue) — n'accepte qu'une décision à notifier (un sujet vide est non représentable). */
export function composeAnomalyMessage(
  source: IngestSource,
  decision: NotifiableDecision,
  runUrl: string,
): AnomalyMessage {
  const label = INGEST_SOURCE_LABEL[source];
  const kinds = [...new Set(decision.anomalies.map((a) => a.kind))];
  const flags = kinds.map((k) => ANOMALY_FLAG[k]).join(" + ");
  const lines = decision.anomalies.map((a) => `- ${a.detail}`).join("\n");
  return {
    subject: `[france-data-mcp] ${label} : ${flags}`,
    text: `Le cron ${label} (ingest_log.source='${source}') a RÉUSSI mais présente une anomalie :\n${lines}\n\nRun : ${runUrl}`,
    issueTitle: `[ingest-anomaly] ${label} : ${flags}`,
    issueBody: [
      `Le cron **${label}** (\`ingest_log.source = '${source}'\`) a réussi (code 0) mais la donnée servie présente une anomalie que le step d'échec ne voit pas :`,
      lines,
      "Cette issue est **idempotente** : un nouveau run avec la même anomalie la commente au lieu d'en ouvrir une autre (l'email n'est envoyé qu'à l'ouverture). Elle se ferme à la main une fois la cause traitée (publication amont relancée, canary corrigé).",
      `Run : ${runUrl}`,
    ].join("\n\n"),
    issueLabels: ["ingest-anomaly", label.toLowerCase(), ...kinds].join(","),
  };
}

/** Nombre de lignes lues : ≥ 2 ans d'Ameli hebdo, largement assez pour retrouver la dernière ingestion réelle. */
const READ_LIMIT = 100;

async function readIngestLogTail(source: IngestSource): Promise<AnomalyLogRow[]> {
  const supabase = getUntypedServiceClient(`notify-anomaly-${source}`);
  const { data, error } = await supabase
    .from("ingest_log")
    .select(
      "started_at, finished_at, status, skip_reason, canary_failures, error_message, github_run_url",
    )
    .eq("source", source)
    .order("started_at", { ascending: false })
    .limit(READ_LIMIT);
  if (error) {
    throw new Error(`lecture ingest_log (source=${source}) échouée: ${error.message}`);
  }
  return (data ?? []) as AnomalyLogRow[];
}

const PREFIX = "notify-ingest-anomaly";

/** Annotation GitHub (page du run) + stderr : « LOUD » ne veut rien dire dans un log de 50 000 lignes. */
function shout(level: "error" | "warning", msg: string): void {
  console.error(msg);
  console.log(`::${level}::${oneLine(msg)}`);
}

/**
 * Deux conditions qui ne devraient jamais arriver sur un cron qui vient de
 * réussir, et qui signifient « la vigie regarde à côté » : aucune ligne
 * (slug de source faux, secret manquant → vigie morte à vie) ou une ligne
 * de tête venue d'un AUTRE run (ligne de ce run perdue par
 * `writeIngestLogSuccessSafe`, dispatch concurrent). Criées, jamais en info.
 */
function checkBlindSpots(source: IngestSource, rows: readonly AnomalyLogRow[]): void {
  if (rows.length === 0) {
    shout(
      "error",
      `[${PREFIX}][${source}] AUCUNE ligne ingest_log alors que le cron vient de réussir — vigie AVEUGLE (slug de source faux ? audit perdu ?)`,
    );
    return;
  }
  const mine = process.env.GITHUB_RUN_URL;
  const head = sortNewestFirst(rows)[0]?.github_run_url;
  if (mine && head && head !== mine) {
    shout(
      "warning",
      `[${PREFIX}][${source}] la ligne ingest_log la plus récente vient d'un AUTRE run (${head}) — décision prise sur une ligne qui n'est pas celle de ce run`,
    );
  }
}

/** Orchestration I/O best-effort — ne throw jamais (cron déjà réussi). */
export async function runAnomalyCheck(source: IngestSource): Promise<AnomalyDecision> {
  let rows: AnomalyLogRow[];
  try {
    rows = await readIngestLogTail(source);
  } catch (err) {
    // Lecture impossible (panne DB transitoire, secret absent) : pas d'alerte
    // mais une ANNOTATION — un secret renommé rendrait sinon la vigie muette
    // à vie sur les 5 crons, en `console.log` de niveau info.
    shout(
      "error",
      `[${PREFIX}][${source}] lecture ingest_log impossible (best-effort, pas d'alerte ce run) : ${err instanceof Error ? err.message : String(err)}`,
    );
    writeGithubOutput(PREFIX, { should_notify: "false" });
    return noAnomaly(source, "lecture ingest_log impossible");
  }
  checkBlindSpots(source, rows);
  // Hors du try de lecture : un bug de décision doit sortir « échec inattendu »
  // (filet top-level), pas « lecture ingest_log impossible » (diagnostic faux).
  const decision = decideAnomalyNotification(source, rows);
  const kinds = decision.anomalies.map((a) => a.kind).join("+") || "none";
  const line = `[${PREFIX}][${source}] ${decision.reason} (kinds=${kinds}, age=${decision.dataAgeDays ?? "?"}j, skips=${decision.skipsSinceLastRealIngest}, notify=${decision.shouldNotify})`;
  if (!decision.shouldNotify) {
    console.log(line);
    writeGithubOutput(PREFIX, { should_notify: "false" });
    return decision;
  }
  console.error(line);
  for (const a of decision.anomalies) console.log(`::warning::${oneLine(a.detail)}`);
  const msg = composeAnomalyMessage(
    source,
    decision,
    process.env.GITHUB_RUN_URL ?? "(hors GitHub Actions)",
  );
  writeGithubOutput(PREFIX, {
    should_notify: "true",
    subject: msg.subject,
    text: msg.text,
    issue_title: msg.issueTitle,
    issue_body: msg.issueBody,
    issue_labels: msg.issueLabels,
  });
  return decision;
}

export function parseSourceArg(argv: readonly string[]): IngestSource {
  const arg = argv[2];
  // Valeur RÉELLE de `ingest_log.source` (⚠️ Ameli logue `ameli_ps`), dérivée
  // de la liste unique `INGEST_SOURCES` — pas de mapping parallèle à faire dériver.
  if (INGEST_SOURCES.includes(arg as IngestSource)) return arg as IngestSource;
  throw new Error(
    `usage: notify-ingest-anomaly <${INGEST_SOURCES.join("|")}> (reçu: ${JSON.stringify(arg)})`,
  );
}

await runIfMain(import.meta.url, async () => {
  // Filet top-level : toute exception non prévue est ANNOTÉE et n'échoue PAS
  // le step — sinon le crash serait avalé par le `continue-on-error` du
  // workflow (run vert, aucune alerte, aucune trace). exit 0 explicite.
  try {
    await runAnomalyCheck(parseSourceArg(process.argv));
  } catch (err) {
    shout(
      "error",
      `[${PREFIX}] échec inattendu (best-effort, pas d'alerte) : ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
});
