/**
 * Diagnostic context attached to errors thrown by tool handlers, surfaced
 * in Sentry events without leaking PII.
 *
 * Pourquoi :
 *  - La lib (`src/`) ne peut pas dépendre de Sentry (règle OSS — voir
 *    CLAUDE.md projet).
 *  - Le catch root dans `api/mcp.ts` n'a pas le détail des params d'un tool
 *    spécifique (il voit juste l'erreur générique remontée).
 *  - Sans context, un timeout SQL 57014 sur `professionnels_par_specialite_dept`
 *    arrive dans Sentry sans indiquer le département, la pagination, ni les
 *    filtres — diagnostic à l'aveugle (cf. Sentry FRANCE-DATA-MCP-3, V0.9.4).
 *
 * Comment :
 *  - Le handler tool catch l'erreur, attache un context anonymisé (booléens
 *    pour les filtres, valeurs énumérables pour le département/pagination),
 *    et re-throw.
 *  - `captureMcpError` lit ce context et le push dans le scope Sentry.
 *  - Aucune valeur PII (nom, prénom, adresse) ne doit JAMAIS entrer ici.
 *
 * Double garantie anti-leak :
 *  1. La clé est un Symbol — invisible à `JSON.stringify`, `Object.keys`,
 *     `getOwnPropertyNames`, et la plupart des sérialiseurs (Sentry SDK
 *     n'inspecte pas `getOwnPropertySymbols` par défaut).
 *  2. La propriété est non-enumerable — défense-in-depth si un sérialiseur
 *     listait quand même les symbols.
 */

const ERROR_CONTEXT_KEY = Symbol.for("mcp.query_context");

/**
 * Shape du context diagnostic : objet plain (record string → unknown),
 * pas d'array (Sentry `setContext` attend un object — un array produirait
 * une indexation corrompue). Marqué readonly pour signaler que le context
 * attaché ne doit pas être muté après coup (utiliser un nouveau attach).
 */
export type ErrorContext = Readonly<Record<string, unknown>>;

/**
 * Attache un context diagnostic à une erreur avant re-throw.
 *
 * Comportement :
 *  - No-op si `err` n'est pas un objet (string, number, undefined).
 *  - **Écrase intégralement** le context précédent en cas d'appels multiples
 *    (NO merge). Si tu veux enrichir progressivement, lis avec
 *    `extractErrorContext`, fusionne côté caller, puis ré-attache le résultat.
 *
 * Generic `<T extends ErrorContext>` : permet au caller de passer un type
 * fermé per-tool (ex: `AmeliQueryErrorContext`) sans intersection avec
 * `Readonly<Record<string, unknown>>` qui ouvrirait la porte aux champs PII
 * via excess-property holes côté object literal.
 */
export function attachErrorContext<T extends ErrorContext>(err: unknown, context: T): void {
  if (err === null || typeof err !== "object") return;
  Object.defineProperty(err, ERROR_CONTEXT_KEY, {
    value: context,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/**
 * Lit le context diagnostic attaché à une erreur, ou undefined si absent.
 * Utilisé par `captureMcpError` pour enrichir le scope Sentry.
 *
 * Rejet defensive :
 *  - valeur absente, null, ou non-objet → undefined
 *  - array → undefined (Sentry `setContext` attend un object plain ;
 *    un array attaché par erreur via `as any` corromprait l'indexation)
 */
export function extractErrorContext(err: unknown): ErrorContext | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const value = (err as { [ERROR_CONTEXT_KEY]?: unknown })[ERROR_CONTEXT_KEY];
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return undefined;
  return value as ErrorContext;
}
