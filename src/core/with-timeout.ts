/**
 * Course une promesse contre un timeout. À l'expiration, rejette une `Error`
 * dont `name = "TimeoutError"`.
 *
 * INVARIANT LOAD-BEARING : le `name = "TimeoutError"` signe le contrat
 * anti-hang consommé par `retry-transient.ts:isTransientTransportError` — un
 * hang réel ne DOIT JAMAIS être réessayé (sinon 4×ms de hang masqué).
 * L'exclusion du retry se fait par `name`, PAS par le texte du message.
 * Ce module est l'UNIQUE source de ce contrat (jadis tripliqué dans
 * `scripts/ingest/rpps.ts` et `scripts/ban-backfill.mjs` — dérive
 * silencieuse possible d'un jumeau). Le timer est toujours nettoyé
 * (`finally`) pour ne pas garder l'event loop éveillé ni fuiter de handle.
 */
export function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
