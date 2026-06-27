/**
 * Logging structuré pour l'endpoint MCP public.
 *
 * On émet une ligne JSON par requête MCP (méthode + tool + IP hashée +
 * User-Agent + durée + statut). Vercel capture stdout/stderr et l'affiche
 * tel quel dans `vercel logs`, donc une ligne JSON est directement
 * parsable côté ops (jq, BigQuery, Logs Drain externe).
 *
 * Pas d'IP en clair, pas d'argument tool (les `tools/call` peuvent contenir
 * un nom de commune ou un SIREN — anodin, mais on évite par défaut pour
 * rester safe RGPD). Si tu en as besoin un jour pour debug, ajoute un
 * flag `LOG_TOOL_ARGS=true` plutôt que de l'activer en dur.
 *
 * Push miroir vers Axiom (dataset structuré, recherche/agrégats sur 30j) si
 * `AXIOM_TOKEN` + `AXIOM_DATASET` sont set. Buffer module-level vidé en fin
 * de requête via `flushMcpEventsToAxiom()` (à appeler dans le `finally` du
 * handler root). Fail-soft : Axiom down ou env absente = no-op, jamais throw.
 */

import { waitUntil } from "@vercel/functions";
import type { VercelRequest } from "@vercel/node";
import { onceWarner, prodOnlyConfigWarner } from "./once-warner.js";
import { captureMcpConfigWarning, flushSentry } from "./sentry.js";

export type LogLevel = "info" | "warn" | "error";

/**
 * Contexte partagé d'une requête HTTP MCP, calculé une fois en début de
 * handler et réutilisé sur tous les logs / events Sentry / metrics. Vit ici
 * pour rester source-of-truth — `sentry.ts` et `mcp.ts` l'importent.
 */
export type McpRequestContext = {
  ipHash: string;
  userAgent: string;
};

/**
 * Outcomes possibles d'une requête MCP. Union fermé pour catch les fautes de
 * frappe au compile time et garder l'agrégation BigQuery/jq fiable côté ops.
 */
export type McpOutcome =
  | "success"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "internal_error";

export type McpEventInput = {
  /** JSON-RPC method (`tools/call`, `tools/list`, `initialize`, …). */
  method: string;
  /** Tool name when method === `tools/call`. */
  tool?: string;
  ipHash: string;
  userAgent: string;
  durationMs: number;
  /** HTTP-ish status: 200 OK, 429 rate limited, 400 bad request, 500 error. */
  status: number;
  outcome: McpOutcome;
  /** Optional extra fields (e.g. rate-limit backend, error message). */
  extra?: Record<string, unknown>;
  /** Override default `info` level (warn/error map to console.warn/error). */
  level?: LogLevel;
};

/** Truncate User-Agent to a reasonable length so logs stay scannable. */
const UA_MAX_LEN = 200;

/**
 * Read User-Agent header in a normalised, truncated form. Empty header is
 * reported as `"unknown"` so the field is always present in logs.
 */
export function extractUserAgent(req: VercelRequest): string {
  const ua = req.headers["user-agent"];
  if (typeof ua !== "string" || ua.length === 0) return "unknown";
  return ua.length > UA_MAX_LEN ? `${ua.slice(0, UA_MAX_LEN)}…` : ua;
}

function levelFromStatus(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

/**
 * Construit les champs canoniques d'un event. Le caller fusionne ensuite avec
 * `extra` pour le payload final, en spreadant `{ ...extra, ...canonical }` pour
 * garantir qu'aucune clé custom ne peut écraser `status`, `outcome`, `method`,
 * etc. — c'est le contrat qu'on documente dans `McpEventInput`.
 */
function buildCanonicalRecord(event: McpEventInput): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    component: "mcp-endpoint",
    method: event.method,
    ...(event.tool ? { tool: event.tool } : {}),
    ip_hash: event.ipHash,
    user_agent: event.userAgent,
    duration_ms: event.durationMs,
    status: event.status,
    outcome: event.outcome,
  };
}

/** Emit a single structured log line + enqueue pour push Axiom (si configuré). */
export function logMcpEvent(event: McpEventInput): void {
  const canonical = buildCanonicalRecord(event);
  const extra = event.extra ?? {};
  const payload = { ...extra, ...canonical };
  const line = serializeSafe(payload, canonical);
  const level = event.level ?? levelFromStatus(event.status);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  enqueueAxiomEvent(payload);
}

/**
 * Fail-soft sur payload non-sérialisable (objet circulaire dans `extra`) :
 * on retombe sur les champs canoniques seuls plutôt que de throw et perdre
 * toute la ligne. La shape dégradée reste cohérente avec la shape normale.
 */
function serializeSafe(
  payload: Record<string, unknown>,
  canonicalOnly: Record<string, unknown>,
): string {
  try {
    return JSON.stringify(payload);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[france-data-mcp] logMcpEvent: payload non-serialisable: ${reason}`);
    return JSON.stringify({ ...canonicalOnly, log_serialize_error: reason });
  }
}

/* ------------------------------------------------------------------ */
/* Axiom push (logs miroir pour recherche/agrégats sur 30j)           */
/* ------------------------------------------------------------------ */

/** Event au format Axiom : exige `_time` (ISO 8601) que la plateforme utilise pour indexer. */
type AxiomEvent = Record<string, unknown> & { _time: string };

/**
 * Buffer module-level d'events à envoyer en batch à Axiom. Rempli par
 * `enqueueAxiomEvent` (appelée par `logMcpEvent`), vidé par `flushMcpEventsToAxiom`
 * (à appeler dans le `finally` du handler root). On garde un cap dur pour éviter
 * qu'une instance Vercel chaude qui n'aurait jamais reçu de flush (cas pathologique)
 * accumule indéfiniment en mémoire.
 */
const axiomBuffer: AxiomEvent[] = [];
const AXIOM_BUFFER_MAX = 500;
/**
 * Plafond de l'ingest Axiom. Depuis que le flush est déporté en arrière-plan
 * via `waitUntil` côté handler (cf. `api/mcp.ts`), ce timeout ne pèse PLUS sur
 * la latence client — c'est un plafond *background* borné par le timeout de la
 * fonction Vercel. Relevé de 1.5s à 5s pour absorber les handshakes TLS lents
 * du POST cross-Atlantique (Vercel EU → `api.axiom.co` US), cause prouvée des
 * `Axiom ingest error: timeout` qui jetaient ~1 event/requête. Reste largement
 * sous le `maxDuration` de la fonction (60s pour `/mcp`, cf. `vercel.json`) pour
 * ne jamais tronquer le flush par le haut.
 */
const AXIOM_INGEST_TIMEOUT_MS = 5000;
const AXIOM_DEFAULT_HOST = "api.axiom.co";

/**
 * Circuit breaker Axiom — coupe l'ingest après N erreurs 4xx consécutives
 * pour ne pas spammer Sentry + Axiom quand le token est révoqué, le dataset
 * supprimé, ou le scope insuffisant. Reset au premier succès. Les 5xx (panne
 * temporaire Axiom) n'incrémentent PAS le compteur — ils sont transients et
 * on retry au prochain flush.
 *
 * Seuil 5 erreurs : assez bas pour réagir vite à une misconfig (token expiré
 * remarqué en ~5 requêtes), assez haut pour ne pas tripper sur un 4xx isolé
 * (load balancer transient, request mal formée corrigée au flush suivant).
 *
 * Cool-down 5 min : laisse le temps à un humain de corriger sans retries
 * infinis. Au-delà, on retente — si la misconfig persiste, le breaker
 * re-tripp et émet à nouveau le warn (état figé tant que la cause n'est pas
 * résolue).
 */
const AXIOM_BREAKER_THRESHOLD = 5;
const AXIOM_BREAKER_COOL_DOWN_MS = 5 * 60 * 1000;
let consecutive4xxCount = 0;
let breakerOpenUntilMs = 0;
const breakerOpenWarner = onceWarner();

/**
 * Retourne le host Axiom effectif : valeur de `AXIOM_HOST` (trimée) si set
 * non-vide, sinon `api.axiom.co` (région US par défaut). Exporté pour que
 * `healthz` puisse exposer la même valeur que celle utilisée à l'ingest réel.
 */
export function getAxiomHost(): string {
  return process.env.AXIOM_HOST?.trim() || AXIOM_DEFAULT_HOST;
}

const bufferOverflowWarner = onceWarner();

function enqueueAxiomEvent(payload: Record<string, unknown>): void {
  if (axiomBuffer.length >= AXIOM_BUFFER_MAX) {
    axiomBuffer.shift();
    bufferOverflowWarner.warn(() => {
      console.warn(
        `[france-data-mcp] Axiom buffer overflow (>${AXIOM_BUFFER_MAX} events sans flush) — drop du plus ancien. Indique soit un trafic burst soit un flush jamais déclenché. Investiguer le finally du handler root.`,
      );
    });
  }
  // Axiom indexe les events par `_time` (ISO 8601). On réutilise le `ts` canonique.
  const ts = typeof payload.ts === "string" ? payload.ts : new Date().toISOString();
  axiomBuffer.push({ ...payload, _time: ts });
}

/**
 * Flush le buffer vers Axiom en un seul POST. Appelée dans le `finally` du
 * handler root, en parallèle de `flushSentry` via `Promise.allSettled`.
 *
 * **Latence client** : ZÉRO — `scheduleObservabilityFlush` (ci-dessous) déporte
 * cet appel en arrière-plan via `waitUntil`, hors du chemin de réponse. L'`await`
 * interne ne borne donc que la tâche de fond, jamais la réponse client.
 *
 * No-op si `AXIOM_TOKEN`/`AXIOM_DATASET` absent (dev local marche sans).
 * Fail-soft : tout échec réseau ou 4xx/5xx Axiom est loggué en warn et drop.
 * On ne retry PAS — sur serverless, les retries augmentent la latence et la
 * complexité sans bénéfice (un event perdu n'est pas critique pour observabilité).
 *
 * Host configurable via `AXIOM_HOST` (default `api.axiom.co` = région US).
 * Pour un dataset en région EU, utiliser `api.eu.axiom.co` — cohérence avec
 * la localisation des données promise dans PRIVACY.md.
 */
export async function flushMcpEventsToAxiom(): Promise<void> {
  if (axiomBuffer.length === 0) return;
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) {
    // Drop silencieux : pas configuré = dev local OU env vars oubliées. Le
    // warn dédié pour "AXIOM_TOKEN absent en prod" est porté par
    // `axiomMissingWarner` (gate prod/preview + Sentry one-shot).
    axiomBuffer.length = 0;
    axiomMissingWarner.warn();
    return;
  }
  // Circuit breaker OPEN : drop le buffer sans tenter de fetch. Évite de
  // spammer Axiom (un fetch HTTP par flush) + Sentry (un event par fetch raté)
  // quand la misconfig persiste. Voir `AXIOM_BREAKER_COOL_DOWN_MS`.
  if (Date.now() < breakerOpenUntilMs) {
    axiomBuffer.length = 0;
    return;
  }
  // Cool-down expiré : reset les flags one-shot pour permettre la
  // re-émission du warn si la misconfig persiste après cool-down. Sans ce
  // reset, l'état "figé tant que la cause n'est pas résolue" annoncé par
  // la JSDoc breaker serait silencieux après le 1er trip.
  if (breakerOpenUntilMs > 0) {
    breakerOpenUntilMs = 0;
    breakerOpenWarner.reset();
    // V0.9.4 — signal ops Vercel Logs que le breaker se réarme. Pas de
    // Sentry (l'event d'origine `axiom_circuit_breaker_open` est suffisant
    // côté alerting ; ce log est purement informatif côté logs ingest).
    console.warn(
      "[france-data-mcp] axiom_circuit_breaker_closed: cool-down expired, retrying flush",
    );
  }
  const host = getAxiomHost();
  const batch = axiomBuffer.splice(0);
  try {
    const res = await fetch(`https://${host}/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(AXIOM_INGEST_TIMEOUT_MS),
    });
    if (res.ok) {
      // Succès : reset le compteur et le warn one-shot (laisse re-déclencher
      // si la misconfig revient plus tard sur la même instance).
      consecutive4xxCount = 0;
      breakerOpenWarner.reset();
    } else {
      let body = "";
      try {
        body = await res.text();
      } catch (bodyErr) {
        const bodyReason = bodyErr instanceof Error ? bodyErr.message : String(bodyErr);
        console.warn(`[france-data-mcp] Axiom ingest body unreadable: ${bodyReason}`);
      }
      console.warn(`[france-data-mcp] Axiom ingest HTTP ${res.status}: ${body.slice(0, 200)}`);
      registerAxiomFailure(res.status);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[france-data-mcp] Axiom ingest error: ${reason}`);
    // Network error (fetch reject) = pas un signal de misconfig — transient,
    // pas d'incrément breaker. Cohérent avec le traitement des 5xx.
  }
}

/**
 * Warn one-shot (gaté prod/preview) émis si le déport `waitUntil` du flush
 * échoue au runtime. Hors Vercel le throw est ATTENDU et bénin → silencieux ;
 * en prod/preview il signale une régression (`@vercel/functions` indisponible,
 * ou un puits qui throw) faisant tomber le flush en fire-and-forget.
 */
const flushDegradedWarner = onceWarner();

/**
 * Point d'entrée UNIQUE du flush d'observabilité, appelé par le `finally` du
 * handler root (`api/mcp.ts`). Encapsule ICI (et pas dans le handler protocole)
 * la liste des puits + le déport `waitUntil` + le fail-soft : ajouter un puits
 * d'observabilité = éditer cette fonction, pas le handler.
 *
 * Déporte le flush (Sentry + Axiom) en arrière-plan via `waitUntil` de
 * `@vercel/functions` : la réponse HTTP du handler part AVANT que le flush
 * démarre, et la lambda Vercel reste vivante jusqu'à sa résolution (borné par
 * `maxDuration`, 60s pour `/mcp`). **Latence client = ZÉRO.**
 *
 * Modèle précédent : `await Promise.allSettled([...])` bloquant dans le
 * `finally`, qui couplait la latence client au timeout Axiom (1.5s) et jetait
 * l'event au-delà — corrigé en déportant le flush hors du chemin de réponse.
 *
 * **Ne throw JAMAIS** (appelée dans un `finally`) : construction des puits ET
 * `waitUntil` sont dans le `try`, donc même un puits futur qui throw à la
 * construction est avalé ici plutôt que de masquer le résultat de la requête.
 * Fail-soft : `waitUntil` throw faute de contexte hors runtime Vercel (vitest,
 * `vercel dev`) → on draine en fire-and-forget (`flush` est un `allSettled`, il
 * ne reject jamais → `void flush` suffit). L'alerte one-shot ne sort qu'en
 * prod/preview, où un échec est une vraie régression.
 */
export function scheduleObservabilityFlush(): void {
  let flush: Promise<unknown> | undefined;
  try {
    // Construction EAGER (les deux puits démarrent ici) PUIS déport — le tout
    // DANS le try : cette fonction est appelée dans le `finally` du handler,
    // elle ne doit jamais remonter (masquerait le résultat + casserait
    // l'invariant "100% des 500 capturés Sentry").
    flush = Promise.allSettled([flushSentry(), flushMcpEventsToAxiom()]);
    waitUntil(flush);
  } catch (err) {
    // ATTENDU en dev/test (waitUntil sans contexte de requête). En prod/preview
    // = régression qui perdrait les events → alerte console.error + Sentry,
    // one-shot, gatée prod pour ne pas polluer les logs locaux (doctrine
    // error-handling "zéro silence"). `err` voyage dans le message (actionnable).
    const reason = err instanceof Error ? err.message : String(err);
    const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "";
    if (env === "production" || env === "preview") {
      flushDegradedWarner.warn(() => {
        const message = `flush observabilité dégradé en fire-and-forget (${reason}) — events potentiellement perdus, investiguer @vercel/functions.`;
        console.error(`[france-data-mcp] ${message}`);
        captureMcpConfigWarning("observability_flush_degraded", message);
      });
    }
    // `flush` (allSettled) ne reject jamais → `void` draine ce qui a été
    // construit sans `.catch` swallow (undefined si la construction a throw).
    if (flush) void flush;
  }
}

/**
 * Comptabilise une réponse HTTP non-2xx d'Axiom dans le circuit breaker. Les
 * 4xx (auth/scope/dataset) signalent une misconfig persistante — on coupe.
 * Les 5xx (panne temporaire Axiom) sont transients — on retry au prochain
 * flush sans toucher au compteur.
 */
function registerAxiomFailure(status: number): void {
  // Hors 4xx (5xx, ou status exotique 1xx/3xx) : transient, pas d'incrément.
  if (status < 400 || status >= 500) return;
  consecutive4xxCount += 1;
  if (consecutive4xxCount < AXIOM_BREAKER_THRESHOLD) return;
  breakerOpenUntilMs = Date.now() + AXIOM_BREAKER_COOL_DOWN_MS;
  consecutive4xxCount = 0;
  warnBreakerOpenOnce(status);
}

function warnBreakerOpenOnce(lastStatus: number): void {
  breakerOpenWarner.warn(() => {
    const coolDownMin = AXIOM_BREAKER_COOL_DOWN_MS / 60_000;
    const message = `Axiom circuit breaker OPEN — pause ingest pendant ${coolDownMin} min après ${AXIOM_BREAKER_THRESHOLD} erreurs 4xx consécutives (dernier=${lastStatus}). Vérifier AXIOM_TOKEN (révoqué/expiré ?), AXIOM_DATASET (existe ?) et les scopes du token.`;
    console.error(`[france-data-mcp] ${message}`);
    captureMcpConfigWarning("axiom_circuit_breaker_open", message);
  });
}

/**
 * Émet UN warn par instance Vercel si Axiom n'est pas configuré en production.
 * Symétrique à `saltMissingWarner` côté rate-limit (même mécanique via
 * `prodOnlyConfigWarner`) : sans ce signal, un oubli d'env var Axiom =
 * dégrade silencieusement la rétention 30j promise par PRIVACY.md.
 */
const axiomMissingWarner = prodOnlyConfigWarner(
  "missing_axiom_config",
  "AXIOM_TOKEN ou AXIOM_DATASET absent — logs détaillés non persistés au-delà de la fenêtre Vercel Runtime Logs. PRIVACY.md rétention 30j non tenue.",
  captureMcpConfigWarning,
);

/**
 * Test-only : reset complet de l'état module Axiom (buffer + flags one-shot
 * warn + circuit breaker). À appeler dans `beforeEach`/`afterEach` pour
 * isoler chaque test.
 */
export function __resetAxiomStateForTesting(): void {
  axiomBuffer.length = 0;
  axiomMissingWarner.reset();
  bufferOverflowWarner.reset();
  flushDegradedWarner.reset();
  consecutive4xxCount = 0;
  breakerOpenUntilMs = 0;
  breakerOpenWarner.reset();
}

/** Test-only : taille du buffer pour les assertions de tests. */
export function __getAxiomBufferLengthForTesting(): number {
  return axiomBuffer.length;
}

/**
 * Test-only : état du circuit breaker (compteur 4xx, instant de réouverture,
 * flag one-shot warn). Exposé pour les assertions de tests sans casser
 * l'encapsulation runtime.
 */
export function __getAxiomBreakerStateForTesting(): {
  consecutive4xx: number;
  openUntilMs: number;
  warned: boolean;
} {
  return {
    consecutive4xx: consecutive4xxCount,
    openUntilMs: breakerOpenUntilMs,
    warned: breakerOpenWarner.hasWarned(),
  };
}
