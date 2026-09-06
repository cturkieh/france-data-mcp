/**
 * Warn 1-shot : le message est émis (console.warn) à la PREMIÈRE occurrence,
 * puis tu jusqu'au `reset()`. Sert aux signaux de drift de contrat lus par
 * ligne (RPC qui ne renvoie plus une colonne, valeur hors vocabulaire) — un
 * warn par ligne noierait le log quand un caller boucle sur 1 000 résultats,
 * zéro warn cacherait la panne.
 *
 * Source UNIQUE du patron côté lib (revue 2026-09-06) : il vivait en quatre
 * copies (flag module + reset exporté + garde) dans `ameli-db.ts`,
 * `query-metadata.ts` ×2 et `finess-db.ts`, chacune avec son
 * `_resetXForTesting` à appeler dans chaque `beforeEach` — un reset oublié
 * rendait un test vert par accident. Fabrique à CLOSURE, comme
 * `api/_lib/once-warner.ts` (couche endpoint, action libre) : pas de clé en
 * chaîne libre, donc ni collision entre modules ni faute de frappe muette
 * entre le warn et son reset — le module appelant exporte `warner.reset`.
 */
export interface WarnOnce {
  /** Émet `message` si pas encore émis depuis le dernier reset. `true` si émis. */
  warn(message: string): boolean;
  /** Réarme : un futur `warn` émet de nouveau. Test-only en pratique. */
  reset(): void;
  /** `true` si un warn a été émis depuis le dernier reset. */
  hasWarned(): boolean;
}

export function createWarnOnce(): WarnOnce {
  let warned = false;
  return {
    warn(message: string): boolean {
      if (warned) return false;
      warned = true;
      console.warn(message);
      return true;
    },
    reset(): void {
      warned = false;
    },
    hasWarned(): boolean {
      return warned;
    },
  };
}
