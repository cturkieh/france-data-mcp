/**
 * One-shot warner : flag module-level qui déclenche une action UNE FOIS,
 * avec un point de reset explicite pour permettre la re-émission.
 *
 * Motif V0.9.4 : 4 patterns identiques dupliqués à travers `api/_lib/`
 * (`axiomWarningEmitted`, `bufferOverflowWarned`, `breakerOpenWarned`,
 * `saltWarningEmitted`). Chacun a la même mécanique flag + reset, mais
 * la conditional et le payload diffèrent (env check, status code, etc.).
 *
 * Pourquoi accepter un payload variable via `warn(action)` plutôt qu'une
 * action fixe au constructor :
 *  - `breakerOpenWarned` a besoin de logger le `lastStatus` qui varie à
 *    chaque trip
 *  - le caller garde le contrôle de la conditional (env check, niveau
 *    de log warn vs error, captureMcpConfigWarning vs juste console.warn)
 *  - le helper reste pur "flag once" sans coupler la mécanique au contenu
 *
 * Pourquoi pas un simple boolean module-level :
 *  - centralise la mécanique → un reset oublié au cool-down expiré (cf.
 *    bug catché en V0.9.3 sur `breakerOpenWarned`) devient impossible à
 *    reproduire (tests `reset()` ciblés)
 *  - testable en isolation : un warner par caller, reset explicite au
 *    `beforeEach`, pas de fuite entre tests
 *  - exhausitivité : grep `onceWarner(` liste tous les warns one-shot
 *    du projet (alors qu'un flag boolean est invisible à grep simple)
 */

export interface OnceWarner {
  /**
   * Exécute `action` si pas encore déclenché depuis le dernier reset.
   * No-op sinon. `action` est appelé synchronousement et son éventuelle
   * exception n'est PAS catchée (le caller décide du fail-soft).
   */
  warn(action: () => void): void;
  /**
   * Reset le flag : un futur `warn(action)` ré-exécute `action`. Utile
   * pour un breaker qui se réarme après cool-down ou un test isolation.
   */
  reset(): void;
  /** True si `warn` a été déclenché depuis le dernier reset. */
  hasWarned(): boolean;
}

export function onceWarner(): OnceWarner {
  let warned = false;
  return {
    warn(action: () => void): void {
      if (warned) return;
      // Set flag AVANT l'action — si action throw, on ne veut PAS re-trigger
      // au prochain appel et inonder les logs avec la même erreur. Test
      // couvert dans once-warner.test.ts ("exception dans action n'est pas
      // catchée"). Un futur reviewer pourrait être tenté de "set on success"
      // — c'est précisément ce qu'on veut éviter.
      warned = true;
      action();
    },
    reset(): void {
      warned = false;
    },
    hasWarned(): boolean {
      return warned;
    },
  };
}

/**
 * One-shot warner spécialisé "env var manquante en trafic réel" (production
 * + preview Vercel). Couple onceWarner + le gate prod/preview + le couple
 * `console.error` + `captureMcpConfigWarning` Sentry. No-op en `test` /
 * `development` (CI, dev local) pour ne pas polluer les logs.
 *
 * Motif V0.9.4 : duplication identique de `warnMissingSaltOnce` et
 * `warnMissingAxiomOnce` (mêmes 4 lignes : env check, return, flag,
 * `console.error` + `captureMcpConfigWarning`). Ce helper rend le pattern
 * mécanique au lieu d'être discipline humaine ("aligné avec X").
 *
 * Le code Sentry doit rester stable dans le temps (utilisé comme
 * fingerprint groupé) — un changement de code = nouvelle issue Sentry.
 */
export interface ProdOnlyConfigWarner {
  /**
   * Émet le warn (console.error + Sentry) si on est en production ou preview,
   * et seulement la 1ère fois depuis le dernier reset. No-op sinon.
   */
  warn(): void;
  /** Reset : permet de re-émettre. Utile pour les tests d'isolation. */
  reset(): void;
  /** True si le warn a déjà été émis depuis le dernier reset. */
  hasWarned(): boolean;
}

export function prodOnlyConfigWarner(
  code: string,
  message: string,
  captureFn: (code: string, message: string) => void,
): ProdOnlyConfigWarner {
  const inner = onceWarner();
  return {
    warn(): void {
      const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "";
      if (env !== "production" && env !== "preview") return;
      inner.warn(() => {
        console.error(`[france-data-mcp] ${message}`);
        captureFn(code, message);
      });
    },
    reset(): void {
      inner.reset();
    },
    hasWarned(): boolean {
      return inner.hasWarned();
    },
  };
}
