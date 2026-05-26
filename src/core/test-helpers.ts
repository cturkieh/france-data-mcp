/**
 * Helpers de test partagés entre les `*.test.ts` du projet.
 *
 * Pas exposé publiquement (rien d'utile en runtime) — mais exporté pour
 * éviter la duplication entre `http.test.ts`, `retry-transient.test.ts`, etc.
 */

import { vi } from "vitest";

/**
 * Exécute une promesse dans un contexte `vi.useFakeTimers()` en drainant tous
 * les timers enregistrés (les `await sleep(...)` internes des helpers retry /
 * backoff). Le caller est responsable d'appeler `vi.useFakeTimers()` AVANT et
 * `vi.useRealTimers()` après — généralement via un bloc try/finally.
 *
 * Pourquoi ce pattern : on attache le handler de `p` AVANT de dérouler les
 * timers. Sinon une promesse rejetée pendant le drain `runAllTimersAsync`
 * déclenche un `unhandledrejection` (le `then` final attendrait après le
 * drain, trop tard). Le tracking via `.then(ok, err)` consomme la résolution
 * dès qu'elle arrive et permet de re-throw proprement ensuite.
 *
 * Pattern initialement défini inline dans `retry-transient.test.ts` (V0.8) ;
 * extrait ici pour réutilisation par `http.test.ts` (V0.20+) sans dépendance
 * de test-à-test.
 */
export async function runWithFakeTimers<T>(p: Promise<T>): Promise<T> {
  const tracked = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  await vi.runAllTimersAsync();
  const r = await tracked;
  if (r.ok) return r.v;
  throw r.e;
}
