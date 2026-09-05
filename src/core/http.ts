/**
 * HTTP helper avec retry exponentiel et respect du header `retry-after`.
 *
 * Conçu pour les API publiques françaises qui :
 *  - retournent HTTP 429 avec un header `retry-after` en secondes,
 *  - peuvent bannir une IP en cas de spam (DINUM API Entreprise → bannissement 12h non-révocable),
 *  - apprécient un User-Agent identifiable pour pouvoir contacter en cas d'usage anormal.
 */

import { backoffDelayMs, jitter, sleep } from "./backoff.js";
import type { RateLimitOptions } from "./types.js";

export const DEFAULT_USER_AGENT =
  "france-data-mcp/0.1.0 (+https://github.com/cturkieh/france-data-mcp)";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RateLimitExceededError extends HttpError {
  constructor(url: string, retryAfter: number) {
    super(`Rate limit exceeded after retries on ${url} (retry-after: ${retryAfter}s)`, 429, url);
    this.name = "RateLimitExceededError";
  }
}

/**
 * Sémantique « statut HTTP amont transitoire = réessayer a du sens » :
 * 429 (rate limit, respecte retry-after) + 5xx (panne serveur passagère).
 * Source unique consommée par le retry de `fetchJson` ET par le message
 * d'erreur caller-facing (`api/mcp.ts`) — sinon 3 copies à garder synchrones.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

type FetchJsonOptions = RateLimitOptions & {
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Boucle de retry partagée par `fetchJson` et `fetchText`.
 *
 * - Sur 429 : respecte `retry-after` (secondes) si présent, sinon backoff exponentiel.
 * - Sur 5xx : backoff exponentiel.
 * - Sur 4xx (sauf 429) : throw `HttpError` immédiatement (erreur logique, pas un retry).
 * - `accept` : valeur du header `Accept` (`application/json` pour JSON, `text/csv` pour CSV…).
 * - `parseBody(response)` : extrait le corps de réponse `2xx`. Peut throw (ex.
 *   `response.json()` → `SyntaxError` sur un body non-JSON) : une telle erreur
 *   est retentée comme une panne transitoire (cf. commentaire P3 ci-dessous).
 *   Pour `fetchText`, `response.text()` ne peut pas produire de `SyntaxError`
 *   donc ce chemin reste inerte — comportement identique préservé.
 */
async function fetchWithRetry<T>(
  url: string,
  accept: string,
  parseBody: (response: Response) => Promise<T>,
  options: FetchJsonOptions,
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    userAgent = DEFAULT_USER_AGENT,
    headers = {},
    signal,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: accept,
          "User-Agent": userAgent,
          ...headers,
        },
        signal,
      });

      if (response.ok) {
        return await parseBody(response);
      }

      if (response.status === 429) {
        // Défaut 5 s quand l'amont ne dit rien (cf. `parseRetryAfterSeconds`).
        const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after")) ?? 5;
        if (attempt === maxRetries) {
          throw new RateLimitExceededError(url, retryAfter);
        }
        await sleep(retryAfter * 1000 + jitter());
        continue;
      }

      if (response.status >= 500 && response.status < 600 && attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt, baseDelayMs));
        continue;
      }

      const body = await response.text().catch((bodyErr: unknown) => {
        console.warn(
          `[france-data-mcp] failed to read response body for ${url}: ${(bodyErr as Error).message}`,
        );
        return undefined;
      });
      throw new HttpError(
        `HTTP ${response.status} on ${url}`,
        response.status,
        url,
        body?.slice(0, 500),
      );
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err as Error;
      // Une SyntaxError du JSON parser = l'API a renvoyé un body non-JSON
      // (HTML d'erreur, page de maintenance, 502 proxy intermédiaire…). C'est
      // le plus souvent TRANSITOIRE côté amont (geo.api.gouv.fr renvoie une
      // page d'erreur HTML lors d'un pic puis re-sert du JSON) : on retry comme
      // un 5xx au lieu d'échouer vite (post-mortem P3 — l'ancien "le retry ne
      // servira à rien" était faux et masquait des pannes transitoires
      // récupérables). Borné par maxRetries comme tout le reste.
      if (lastError instanceof SyntaxError) {
        const isFinalAttempt = attempt === maxRetries;
        const log = isFinalAttempt ? console.error : console.warn;
        log(
          `[france-data-mcp] invalid JSON response from ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`,
        );
        if (isFinalAttempt) break;
        await sleep(backoffDelayMs(attempt, baseDelayMs));
        continue;
      }
      // Si le caller a annulé via AbortSignal, ne pas tenter de retry — un
      // signal déjà aborté ne peut plus être ré-utilisé. Sans ce shortcircuit,
      // les 3 retries restants se feraient contre `signal.aborted=true` avec
      // attentes setTimeout cumulées qui dépasseraient le timeout caller.
      // Log différencié : "vraie" AbortError (signal.aborted ET err name match)
      // vs erreur réseau survenue juste avant l'abort (race) — sans ça, un
      // ENOTFOUND in-flight pourrait être silencé sous le label "abort".
      if (lastError.name === "AbortError") {
        console.warn(`[france-data-mcp] fetch aborted (caller signal) on ${url}`);
        throw lastError;
      }
      if (signal?.aborted) {
        console.warn(
          `[france-data-mcp] fetch aborted on ${url} (signal already aborted) — last error: ${lastError.message}`,
        );
        throw lastError;
      }
      const isFinalAttempt = attempt === maxRetries;
      const log = isFinalAttempt ? console.error : console.warn;
      log(
        `[france-data-mcp] network error on ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`,
      );
      if (isFinalAttempt) break;
      await sleep(backoffDelayMs(attempt, baseDelayMs));
    }
  }

  console.error(`[france-data-mcp] giving up on ${url} after ${maxRetries + 1} attempts`);
  throw lastError ?? new Error(`Unknown failure fetching ${url}`);
}

/**
 * GET une URL et parse la réponse JSON, avec retry exponentiel sur 429 et 5xx.
 *
 * - Sur 429 : respecte `retry-after` (secondes) si présent, sinon backoff exponentiel.
 * - Sur 5xx : backoff exponentiel.
 * - Sur 4xx (sauf 429) : throw immédiatement (erreur logique, pas un retry).
 * - User-Agent par défaut identifie la lib et le repo (pour traçabilité).
 */
export function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  return fetchWithRetry<T>(
    url,
    "application/json",
    (response) => response.json() as Promise<T>,
    options,
  );
}

/**
 * GET une URL et retourne la réponse en texte brut, avec EXACTEMENT la même
 * politique de retry/backoff/429/timeout que `fetchJson`. Conçu pour les
 * endpoints CSV (geo-DVF) — sans ça, un 429/5xx amont sur le téléchargement
 * commune produisait un échec sec (raw `fetch`, zéro retry).
 *
 * `response.text()` ne peut pas produire de `SyntaxError` : le chemin de retry
 * "body non-parsable" de la boucle partagée reste donc inerte ici (un body
 * texte est toujours lisible) — seuls 429/5xx/réseau déclenchent un retry.
 */
export function fetchText(url: string, options: FetchJsonOptions = {}): Promise<string> {
  const accept = options.headers?.Accept ?? options.headers?.accept ?? "text/csv, text/plain, */*";
  return fetchWithRetry<string>(url, accept, (response) => response.text(), options);
}

/**
 * Lit un header `retry-after` (entier de secondes OU HTTP-date RFC 7231 §7.1.3) et
 * le rend en SECONDES ∈ ]0, maxSeconds], ou `null` quand le header est absent, une
 * date déjà passée (= « maintenant »), ou illisible. Header PRÉSENT mais illisible,
 * ou écrêté par le plafond → `console.warn` (une dégradation amont n'est jamais
 * muette ; un plafond qui mord = retry potentiellement prématuré sur un service
 * public). Plafond 60 s par défaut : si une API exige plus, on préfère échouer (et
 * laisser le caller gérer) plutôt que bloquer un handler MCP. Chaque caller choisit
 * SON défaut sur `null` (5 s pour `fetchJson`, barème 2/4/8 s pour le client BAN
 * bulk). Source unique : ne pas ré-implémenter la lecture du header ailleurs.
 */
export function parseRetryAfterSeconds(header: string | null, maxSeconds = 60): number | null {
  if (header === null) return null;
  const raw = header.trim();
  let seconds: number;
  if (/^\d+$/.test(raw)) {
    seconds = Number.parseInt(raw, 10);
  } else {
    // `parseInt` seul lirait « 21 Oct 2025 … » comme 21 s et « 1e3 » comme 1 s.
    const dateMs = Date.parse(raw);
    if (!Number.isFinite(dateMs)) {
      console.warn(
        `[france-data-mcp] retry-after header unreadable (${JSON.stringify(raw.slice(0, 40))}) — caller default applies`,
      );
      return null;
    }
    seconds = Math.ceil((dateMs - Date.now()) / 1000);
  }
  if (seconds <= 0) return null;
  if (seconds > maxSeconds) {
    console.warn(
      `[france-data-mcp] retry-after ${seconds}s capped to ${maxSeconds}s — retry may be premature`,
    );
    return maxSeconds;
  }
  return seconds;
}
