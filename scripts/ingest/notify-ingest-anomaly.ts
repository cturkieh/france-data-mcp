import "./load-env.js";
import {
  type FreshnessRowLike,
  INGEST_CADENCE,
  INGEST_SOURCES,
  INGEST_SOURCE_LABEL,
  type IngestSource,
  ageInDays,
  isServedRun,
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
 * SENS INVERSE (2026-09-07, issues #82/#83 restées sans chemin de fermeture) :
 * un run PROUVÉ sain (`healthy: true`) expose `should_close` + la clé
 * `ingest-anomaly,<slug>` SANS type → la composite ferme via `upsert-ops-issue`.
 * « Sain » est une preuve positive (tête servie, dernier run réel non `partial`),
 * pas l'absence d'alerte : un skip `same_checksum` ne re-teste rien. Arbitrage
 * assumé : une anomalie résolue qui RÉCIDIVE rouvre une issue et renvoie un
 * mail — c'est un nouveau signal, pas la fatigue d'une alerte continue.
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
  /** Run `FORCE_REINGEST` : ré-ingestion complète même à fichier identique (skip_reason NULL). */
  forced?: boolean | null;
  /** Empreinte du fichier amont — permet de voir qu'un run forcé n'a rien de neuf. */
  csv_sha256?: string | null;
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

/** Décision sans alerte : aucune anomalie. */
type SilentDecision = DecisionBase & {
  readonly shouldNotify: false;
  readonly anomalies: readonly [];
};

/**
 * Discriminée sur DEUX axes. `shouldNotify` : à notifier (au moins une
 * anomalie) ou non. `healthy` distingue, PARMI les décisions sans alerte, le run
 * PROUVÉ sain (une ligne lue, âge dans la cadence, pas de `partial`) de
 * l'absence de preuve (aucune ligne, lecture impossible) : seule la première
 * autorise la FERMETURE des issues `ingest-anomaly` ouvertes — fermer sur une
 * vigie aveugle serait un faux « résolu ». Littéraux (pas `boolean`) pour que
 * `if (decision.healthy)` narrow seul, sans copie ni intersection.
 */
export type AnomalyDecision =
  | (SilentDecision & { readonly healthy: true })
  | (SilentDecision & { readonly healthy: false })
  | (DecisionBase & {
      readonly shouldNotify: true;
      readonly healthy: false;
      readonly anomalies: readonly [Anomaly, ...Anomaly[]];
    });
export type NotifiableDecision = Extract<AnomalyDecision, { shouldNotify: true }>;
export type HealthyDecision = Extract<AnomalyDecision, { healthy: true }>;
type UnprovenDecision = Extract<AnomalyDecision, { shouldNotify: false; healthy: false }>;

/** Aucune preuve (aucune ligne, lecture impossible) : ni alerte ni fermeture. */
const unprovenDecision = (source: IngestSource, reason: string): UnprovenDecision => ({
  shouldNotify: false,
  healthy: false,
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
  if (!latest) return unprovenDecision(source, "aucune ligne ingest_log trouvée");

  const anomalies: Anomaly[] = [];

  // 1. `partial` sur le run le plus récent.
  if (isServedRun(latest) && latest.status === "partial") {
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
    // « Sain » est une PREUVE positive, pas l'absence d'alerte : un court-circuit
    // `same_checksum` écrit `success` sans re-tester swap, matview ni canary, et
    // la branche `partial` ci-dessus ne lit que la tête. Sans ce garde, un skip
    // après un run `partial` fermerait l'issue `partial` avec un « ✅ résolu »
    // mensonger (revue altitude 2026-09-07). Idem une tête `failed` : le step
    // d'échec dédié alerte, mais rien n'est prouvé sain.
    // Liste BLANCHE (`isServedRun`, statuts sous lesquels la prod a swappé) et
    // non liste noire `failed` : `ingest_log.status` est un VARCHAR sans CHECK,
    // un statut inconnu en tête ne doit jamais valoir « prouvé sain ».
    // Un run FORCÉ ré-ingère le MÊME fichier avec skip_reason NULL : il compte
    // comme ingestion réelle (règle `data_freshness`, intacte) mais ne prouve
    // pas que la source a republié — comparer son sha à l'ingestion réelle
    // précédente (revue silent-failure 2026-09-07 ; le forçage FINESS post-merge
    // du 2026-09-06 aurait fermé une issue « source tarie » avec un « ✅ »).
    const previousReal = lastChange
      ? sorted
          .slice(sorted.indexOf(lastChange) + 1)
          .find((r) => isServedRun(r) && r.skip_reason == null)
      : undefined;
    // …et seulement si cette ingestion précédente est ELLE-MÊME hors cadence :
    // un forçage sur une source fraîchement republiée (3 runs FINESS forcés
    // d'affilée le 2026-09-06) ne masque rien et reste sain.
    const previousRealAge = previousReal ? ageInDays(runEndedAt(previousReal), now) : null;
    const forcedOnSameFile =
      lastChange?.forced === true &&
      lastChange.csv_sha256 != null &&
      lastChange.csv_sha256 === previousReal?.csv_sha256 &&
      (previousRealAge === null || previousRealAge > expectedMaxAgeDays);
    const unproven = !isServedRun(latest)
      ? `tête de statut non servi (${latest.status ?? "absent"})`
      : lastChange?.status === "partial"
        ? "dernier run réel `partial`, non re-testé depuis"
        : forcedOnSameFile
          ? "dernière ingestion réelle FORCÉE sur un fichier amont identique — la source n'a rien republié"
          : null;
    const age = `age=${dataAgeDays ?? "?"}j ≤ ${expectedMaxAgeDays}j, status=${latest.status ?? "?"}`;
    return {
      ...base,
      reason: unproven
        ? `run sans anomalie mais NON prouvé sain (${unproven}) — pas de fermeture (${age})`
        : `run sain (${age})`,
      shouldNotify: false,
      healthy: unproven === null,
      anomalies: [],
    };
  }
  return {
    ...base,
    reason: `anomalie(s) ${anomalies.map((a) => a.kind).join("+")} sur un run réussi`,
    shouldNotify: true,
    healthy: false,
    anomalies: [first, ...rest],
  };
}

/** Label PRIMAIRE des issues de la vigie — clé d'idempotence à l'ouverture ET filtre de fermeture (patron `PENDING_GEOCODE_LABEL`). */
export const INGEST_ANOMALY_LABEL = "ingest-anomaly";

/** Racine des labels d'une source : `[ingest-anomaly, <slug>]`. L'ouverture y AJOUTE les types ; la fermeture s'arrête là (sémantique ET de l'API : couvre `stale`, `partial` et l'escalade `partial+stale`). */
const anomalyIssueLabels = (source: IngestSource): string[] => [
  INGEST_ANOMALY_LABEL,
  INGEST_SOURCE_LABEL[source].toLowerCase(),
];

/** Drapeau par type — `Record` : ajouter un `AnomalyKind` sans son libellé ne compile pas. */
const ANOMALY_FLAG: Record<AnomalyKind, string> = {
  partial: "⚠️ run PARTIAL",
  stale: "⏳ source TARIE",
};

export interface AnomalyMessage {
  readonly subject: string;
  readonly text: string;
  readonly issueTitle: string;
  readonly issueBody: string;
  /** Clé d'idempotence de l'issue : `ingest-anomaly,<slug>,<kind>…` (slug = libellé minuscule, comme les labels des autres alertes). */
  readonly issueLabels: string;
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
    issueTitle: `[${INGEST_ANOMALY_LABEL}] ${label} : ${flags}`,
    issueBody: [
      `Le cron **${label}** (\`ingest_log.source = '${source}'\`) a réussi (code 0) mais la donnée servie présente une anomalie que le step d'échec ne voit pas :`,
      lines,
      "Cette issue est **idempotente** : un nouveau run avec la même anomalie la commente au lieu d'en ouvrir une autre (l'email n'est envoyé qu'à l'ouverture). Elle se **ferme automatiquement** au premier run PROUVÉ sain de la source (donnée dans la cadence ET dernier run réel sans `partial` — un court-circuit « fichier identique » ou un run forcé sur le même fichier ne prouvent rien). La fermer à la main ne fait que masquer une anomalie encore présente — sauf si la cause a été corrigée HORS du cron (matview rebâtie à la main, source retirée).",
      `Run : ${runUrl}`,
    ].join("\n\n"),
    issueLabels: [...anomalyIssueLabels(source), ...kinds].join(","),
  };
}

export interface ResolutionMessage {
  /** Clé de fermeture = `anomalyIssueLabels` SANS type (cf. sa doc). */
  readonly closeLabels: string;
  readonly closeComment: string;
}

/**
 * Wording de la FERMETURE automatique (pendant de `composeAnomalyMessage`) —
 * n'accepte qu'une décision PROUVÉE saine : le type `HealthyDecision` rend la
 * fermeture sur une vigie aveugle (aucune ligne, lecture impossible) non
 * représentable. Preuve prod : les issues #82 (Ameli) et #83 (CDS) « source
 * tarie » du 2026-09-07 n'avaient aucun chemin de fermeture — seul le drain
 * BAN fermait les siennes (`pending-geocode`).
 */
export function composeResolutionMessage(
  source: IngestSource,
  decision: HealthyDecision,
  runUrl: string,
): ResolutionMessage {
  const label = INGEST_SOURCE_LABEL[source];
  return {
    closeLabels: anomalyIssueLabels(source).join(","),
    closeComment: `✅ Cron ${label} (\`ingest_log.source = '${source}'\`) : ${decision.reason} — l'anomalie n'est plus présente, fermeture automatique. Run : ${runUrl}`,
  };
}

/** Nombre de lignes lues : ≥ 2 ans d'Ameli hebdo, largement assez pour retrouver la dernière ingestion réelle. */
const READ_LIMIT = 100;

async function readIngestLogTail(source: IngestSource): Promise<AnomalyLogRow[]> {
  const supabase = getUntypedServiceClient(`notify-anomaly-${source}`);
  const { data, error } = await supabase
    .from("ingest_log")
    .select(
      "started_at, finished_at, status, skip_reason, canary_failures, error_message, github_run_url, forced, csv_sha256",
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

/**
 * Contrat des outputs `$GITHUB_OUTPUT` lus par la composite. `type` (pas
 * `interface`) pour rester affectable à `Record<string, string>`. Les trois
 * membres suivent les trois classes de décision : `should_notify` et
 * `should_close` vrais ENSEMBLE est non représentable (sinon la composite
 * ouvrirait, mailerait puis refermerait dans le même run — alerte auto-annulée).
 */
export type AnomalyOutputs =
  | { readonly should_notify: "false"; readonly should_close: "false" }
  | {
      readonly should_notify: "false";
      readonly should_close: "true";
      readonly close_labels: string;
      readonly close_comment: string;
    }
  | {
      readonly should_notify: "true";
      readonly should_close: "false";
      readonly subject: string;
      readonly text: string;
      readonly issue_title: string;
      readonly issue_body: string;
      readonly issue_labels: string;
    };

/** Outputs « ni alerte ni fermeture » (lecture impossible, aucune ligne, preuve absente). */
const SILENT_OUTPUTS: AnomalyOutputs = { should_notify: "false", should_close: "false" };

/**
 * Traduction PURE décision → outputs (testable sans DB ni env) — pendant de
 * `decideAnomalyNotification`. `foreignProof` : la ligne de tête vient d'un
 * AUTRE run (audit de ce run perdu, `writeIngestLogSuccessSafe`) — alerter
 * reste acceptable (l'anomalie est réelle), FERMER ne l'est pas (un run
 * `partial` dont la ligne est perdue refermerait l'issue de la veille).
 */
export function anomalyOutputs(
  source: IngestSource,
  decision: AnomalyDecision,
  runUrl: string,
  foreignProof = false,
): AnomalyOutputs {
  if (decision.shouldNotify) {
    const msg = composeAnomalyMessage(source, decision, runUrl);
    return {
      should_notify: "true",
      should_close: "false",
      subject: msg.subject,
      text: msg.text,
      issue_title: msg.issueTitle,
      issue_body: msg.issueBody,
      issue_labels: msg.issueLabels,
    };
  }
  if (!decision.healthy || foreignProof) return SILENT_OUTPUTS;
  const done = composeResolutionMessage(source, decision, runUrl);
  return {
    should_notify: "false",
    should_close: "true",
    close_labels: done.closeLabels,
    close_comment: done.closeComment,
  };
}

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
/**
 * PUR : la ligne de tête porte-t-elle l'URL d'un AUTRE run que le nôtre ?
 * Indécidable (hors Actions, ligne sans URL, aucune ligne) ⇒ `false`.
 */
export function headIsForeign(
  rows: readonly AnomalyLogRow[],
  mineRunUrl: string | undefined,
): boolean {
  const head = sortNewestFirst(rows)[0]?.github_run_url;
  return Boolean(mineRunUrl && head && head !== mineRunUrl);
}

/** @returns `true` si la ligne de tête n'est PAS celle de ce run (preuve étrangère). */
function checkBlindSpots(source: IngestSource, rows: readonly AnomalyLogRow[]): boolean {
  if (rows.length === 0) {
    shout(
      "error",
      `[${PREFIX}][${source}] AUCUNE ligne ingest_log alors que le cron vient de réussir — vigie AVEUGLE (slug de source faux ? audit perdu ?)`,
    );
    return false;
  }
  const foreign = headIsForeign(rows, process.env.GITHUB_RUN_URL);
  if (foreign) {
    shout(
      "warning",
      `[${PREFIX}][${source}] la ligne ingest_log la plus récente vient d'un AUTRE run (${sortNewestFirst(rows)[0]?.github_run_url}) — décision prise sur une ligne qui n'est pas celle de ce run`,
    );
  }
  return foreign;
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
    writeGithubOutput(PREFIX, SILENT_OUTPUTS);
    return unprovenDecision(source, "lecture ingest_log impossible");
  }
  const foreign = checkBlindSpots(source, rows);
  // Hors du try de lecture : un bug de décision doit sortir « échec inattendu »
  // (filet top-level), pas « lecture ingest_log impossible » (diagnostic faux).
  const decision = decideAnomalyNotification(source, rows);
  const runUrl = process.env.GITHUB_RUN_URL ?? "(hors GitHub Actions)";
  const kinds = decision.anomalies.map((a) => a.kind).join("+") || "none";
  const line = `[${PREFIX}][${source}] ${decision.reason} (kinds=${kinds}, age=${decision.dataAgeDays ?? "?"}j, skips=${decision.skipsSinceLastRealIngest}, notify=${decision.shouldNotify})`;
  if (decision.shouldNotify) {
    console.error(line);
    for (const a of decision.anomalies) console.log(`::warning::${oneLine(a.detail)}`);
  } else if (!decision.healthy && rows.length > 0) {
    // Anomalie possiblement TOUJOURS là (partial non re-testé, forçage à vide)
    // sans issue ni mail : annotation, sinon cet état peut durer des mois muet.
    shout("warning", line);
  } else {
    console.log(line);
  }
  if (foreign && decision.healthy) {
    shout(
      "warning",
      `[${PREFIX}][${source}] run sain mais preuve venue d'un autre run — fermeture des issues RETENUE`,
    );
  }
  writeGithubOutput(PREFIX, anomalyOutputs(source, decision, runUrl, foreign));
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
      `[${PREFIX}] échec inattendu (best-effort : ni alerte ni fermeture ce run) : ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
});
