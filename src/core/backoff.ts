// Primitives de backoff exponentiel + jitter, partagées par les boucles de
// retry (`http.ts` fetchJson, `ban-bulk-client.ts` timeout F2). Helpers purs,
// stateless — utilitaire interne, NON ré-exporté depuis `index.ts` (aucun
// consommateur externe ; les copies privées d'origine n'étaient pas exportées).

/** Attend `ms` millisecondes. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jitter aléatoire borné [0, 250) ms — désynchronise les retries concurrents. */
export function jitter(): number {
  return Math.floor(Math.random() * 250);
}

/**
 * Délai de backoff exponentiel pour la tentative `attempt` (0-indexé) :
 * `baseDelayMs * 2^attempt + jitter()`. Sémantique identique aux ex-copies
 * inline (formule, pas la valeur aléatoire — `jitter()` est `Math.random()`).
 */
export function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt + jitter();
}
