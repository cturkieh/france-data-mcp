/**
 * HTTP helper avec retry exponentiel et respect du header `retry-after`.
 *
 * Conçu pour les API publiques françaises qui :
 *  - retournent HTTP 429 avec un header `retry-after` en secondes,
 *  - peuvent bannir une IP en cas de spam (DINUM API Entreprise → bannissement 12h non-révocable),
 *  - apprécient un User-Agent identifiable pour pouvoir contacter en cas d'usage anormal.
 */

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

type FetchJsonOptions = RateLimitOptions & {
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * GET une URL et parse la réponse JSON, avec retry exponentiel sur 429 et 5xx.
 *
 * - Sur 429 : respecte `retry-after` (secondes) si présent, sinon backoff exponentiel.
 * - Sur 5xx : backoff exponentiel.
 * - Sur 4xx (sauf 429) : throw immédiatement (erreur logique, pas un retry).
 * - User-Agent par défaut identifie la lib et le repo (pour traçabilité).
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
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
          Accept: "application/json",
          "User-Agent": userAgent,
          ...headers,
        },
        signal,
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (attempt === maxRetries) {
          throw new RateLimitExceededError(url, retryAfter);
        }
        await sleep(retryAfter * 1000 + jitter());
        continue;
      }

      if (response.status >= 500 && response.status < 600 && attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt + jitter());
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
      // Une SyntaxError du JSON parser veut dire que l'API a renvoyé un body non-JSON
      // (HTML d'erreur, page de maintenance…). Le retry ne servira à rien — on échoue vite.
      if (lastError instanceof SyntaxError) {
        console.error(`[france-data-mcp] invalid JSON response from ${url}: ${lastError.message}`);
        throw lastError;
      }
      const isFinalAttempt = attempt === maxRetries;
      const log = isFinalAttempt ? console.error : console.warn;
      log(
        `[france-data-mcp] network error on ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`,
      );
      if (isFinalAttempt) break;
      await sleep(baseDelayMs * 2 ** attempt + jitter());
    }
  }

  console.error(`[france-data-mcp] giving up on ${url} after ${maxRetries + 1} attempts`);
  throw lastError ?? new Error(`Unknown failure fetching ${url}`);
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 5;
  // Cap à 60 s : si une API exige une attente plus longue, on préfère échouer
  // (et laisser le caller gérer) plutôt que bloquer un handler MCP/serveur.
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60);
  // Format HTTP-date (RFC 7231 §7.1.3) : "Wed, 21 Oct 2015 07:28:00 GMT"
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    const deltaSec = Math.ceil((dateMs - Date.now()) / 1000);
    if (deltaSec > 0) return Math.min(deltaSec, 60);
  }
  return 5;
}

function jitter(): number {
  return Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
