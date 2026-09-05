// Retry borné sur les ÉCHECS TRANSPORT TRANSITOIRES d'une op async arbitraire
// (typiquement un appel `supabase-js` : `.rpc()`, `.from().select()`,
// `.from().upsert()`). Réutilise les primitives de `backoff.ts` (mêmes
// exponentiel + jitter que `http.ts` / `ban-bulk-client.ts`).
//
// POURQUOI (incident GATE V0.11.0 G5, 2026-05-18) : un run long
// (`ban-backfill.mjs` ~339k adresses, cron RPPS mensuel NON surveillé) mourait
// sur UN seul blip réseau (`TypeError: fetch failed` undici, `ECONNRESET`…)
// alors que le côté BAN, lui, retry déjà (`http.ts`). Asymétrie de robustesse.
//
// ⚠️ DEUX MODES DE DÉFAILLANCE TRANSPORT — les DEUX doivent être retentés
// (leçon empirique GATE G5 : la 1ʳᵉ implémentation ne couvrait QUE le rejet et
// l'incident s'est reproduit À L'IDENTIQUE) :
//   1. `op()` REJETTE (throw) — certains chemins supabase-js / undici.
//   2. `op()` RÉSOUT `{ data:null, error }` où `error.message` porte la
//      signature transport (PROUVÉ en prod : `.from().select()` sur un
//      `fetch failed` ne throw PAS, il résout `{ error:{ message:
//      "TypeError: fetch failed" } }`). `retryTransient` DOIT donc inspecter
//      AUSSI le résultat résolu via `isRetryableResult`.
//
// FAIL-LOUD PRÉSERVÉ : une erreur APPLICATIVE (RPC invalide, contrainte, RLS)
// revient aussi en `{ error }` résolu — mais son message NE matche PAS
// l'allow-list transport ci-dessous → non retentée → le `if (error) throw`
// caller tire fail-loud comme avant. C'est l'ALLOW-LIST stricte (pas une
// deny-list) qui rend sûr le retry-sur-`{error}`-résolu. Timeout anti-hang
// `withTimeout` (`name="TimeoutError"`) et `AbortError` EXCLUS du chemin rejet.
//
// POLITIQUE VOLONTAIREMENT DISTINCTE de `http.ts` (NON factorisable, choix) :
// `http.ts` retry en DENY-LIST implicite (il a une couche `HttpError` pour
// pré-filtrer). `supabase-js` n'a pas cet équivalent → ALLOW-LIST stricte ici.
// 3ᵉ boucle de backoff de la même famille (`http.ts:fetchJson`,
// `ban-bulk-client.ts:postChunk`) ; toutes sciemment séparées.

import { backoffDelayMs, sleep } from "./backoff.js";

// Fragments (minuscule) signant un échec réseau RÉCUPÉRABLE en réessayant.
// Cherchés dans le message de l'erreur (rejet) OU de l'objet `{ error }`
// supabase résolu. Volontairement explicite (pas un fourre-tout).
const TRANSIENT_NEEDLES = [
  "fetch failed", // undici générique (l'incident G5)
  "econnreset",
  "etimedout",
  "econnrefused",
  "eai_again", // résolution DNS transitoire
  "enotfound", // DNS ; borné par maxRetries (si permanent → throw quand même)
  "socket hang up",
  "other side closed", // reset keep-alive undici
  // socket undici terminé en vol ; matche aussi Postgres 57P01
  // "terminating connection / terminated by administrator" — toléré ET sûr :
  // le backfill est idempotent et tout est borné par maxRetries (au pire
  // 4 tentatives puis throw fail-loud).
  "terminated",
  "und_err", // codes internes undici (UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT…)
  "connect timeout",
  // PAS de "network" nu : trop large (un message applicatif PostgREST/RPC
  // contenant le mot serait faussement réessayé). Les signatures réseau réelles
  // sont déjà couvertes par les codes/undici ci-dessus.
];

function matchesTransientNeedle(haystack: string): boolean {
  const hay = haystack.toLowerCase();
  return TRANSIENT_NEEDLES.some((n) => hay.includes(n));
}

/**
 * `true` si `err` est un rejet (throw) TRANSPORT transitoire (réseau) sensé
 * d'être réessayé. `false` pour : non-Error, AbortError, timeout anti-hang
 * `withTimeout`, et toute erreur applicative.
 */
export function isTransientTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Annulation explicite : ne JAMAIS retry (signal déjà consommé).
  if (err.name === "AbortError") return false;
  // Timeout anti-hang de `withTimeout` : exclu par `name` DÉDIÉ
  // (`ban-backfill.mjs`/`rpps.ts` posent `err.name = "TimeoutError"`) —
  // couplage ROBUSTE, pas le texte. Un hang réel DOIT rester fail-loud
  // (jamais réessayé 4× = 4 min de hang masqué). Fallback regex défensif.
  if (err.name === "TimeoutError") return false;
  if (/timed out after \d+ms/.test(err.message)) return false;

  const cause = (err as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? cause.message : "";
  const causeCode =
    cause && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : "";
  return matchesTransientNeedle(`${err.message} ${causeMsg} ${causeCode}`);
}

/**
 * `true` si l'objet `error` d'un résultat `supabase-js` RÉSOLU
 * (`{ data:null, error }`) porte une signature TRANSPORT transitoire.
 * `supabase-js` `.from().select()/.upsert()` n'EST PAS garanti de rejeter sur
 * un échec réseau : il résout `{ error:{ message:"TypeError: fetch failed",
 * details, code, hint } }` (PROUVÉ en prod, GATE G5). Une erreur APPLICATIVE
 * (`permission denied`, `duplicate key`, contrainte) arrive aussi ici mais ne
 * matche PAS l'allow-list → non retentée → fail-loud préservé.
 *
 * Scan de SURFACE (`message`/`details`/`code`/`hint`) volontaire : PostgREST
 * APLATIT l'échec transport dans `message` (G5 prouvé : `"TypeError: fetch
 * failed"`), il n'y a pas de `cause` imbriquée à la `Error.cause` du chemin
 * throw. Si un jour supabase exposait `{ cause }`, l'étendre ici (asymétrie
 * assumée vs `isTransientTransportError` tant que non observé).
 */
export function isTransientSupabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { message?: unknown; details?: unknown; code?: unknown; hint?: unknown };
  const parts = [e.message, e.details, e.code, e.hint].filter(
    (p): p is string => typeof p === "string",
  );
  if (parts.length === 0) return false;
  return matchesTransientNeedle(parts.join(" "));
}

/**
 * Indice ACTIONNABLE (suffixe à concaténer à un message d'erreur fail-loud) si
 * `message` signale une fonction RPC absente du schema-cache PostgREST. En
 * prod la cause n°1 est une **migration T-format NON appliquée** : la CLI
 * supabase SKIPPE les fichiers `YYYYMMDDThhmmss_` (contrainte projet connue) —
 * sans cet indice, un opérateur perd du temps sur un `Could not find the
 * function ...` brut dans `ingest_log`. Chaîne vide si non concerné.
 */
export function missingRpcHint(message: string): string {
  return /could not find the function|does not exist|schema cache/i.test(message)
    ? " — une migration RPC T-format n'est peut-être pas appliquée en prod" +
        " (la CLI supabase SKIPPE les migrations YYYYMMDDThhmmss_ ; appliquer via SQL Editor/psql)"
    : "";
}

/**
 * Exécute `op()` avec retry borné backoff exponentiel (`backoffDelayMs`,
 * jusqu'à `maxRetries`). Réessaie si :
 *   - `op()` REJETTE et `isTransientTransportError(err)` ; OU
 *   - `op()` RÉSOUT une valeur et `isRetryableResult(value)` (typiquement
 *     `(r) => isTransientSupabaseError(r?.error)`).
 * `op` est rappelée À NEUF à chaque tentative (un builder `supabase-js` est
 * lazy : requête fraîche, jamais une promesse déjà réglée). Sur erreur NON
 * transitoire OU épuisement des retries : THROW la dernière erreur inchangée
 * (chemin rejet) ou RETOURNE la dernière valeur telle quelle (chemin
 * `{error}` résolu) — dans les deux cas le caller voit EXACTEMENT ce qu'il
 * verrait sans le wrapper (message FATAL / `if (error) throw` préservés).
 */
export async function retryTransient<T>(
  // `PromiseLike` (pas `Promise`) : un builder supabase-js (`.rpc()`,
  // `.from().select()/.upsert()`) est un thenable lazy, pas une `Promise`
  // structurelle — `await` l'accepte, le typage doit l'accepter aussi (même
  // choix que `withTimeout(p: PromiseLike<T>)`).
  op: () => PromiseLike<T>,
  label: string,
  opts: {
    maxRetries?: number;
    baseDelayMs?: number;
    onRetry?: () => void;
    isRetryableResult?: (value: T) => boolean;
  } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 500, onRetry, isRetryableResult } = opts;
  const retryWarnLine = (attempt: number, reason: string): string =>
    `[france-data-mcp] transient error on ${label} ` +
    `(attempt ${attempt + 1}/${maxRetries + 1}): ${reason} — retrying`;
  // Raison lisible pour le chemin `{ error }` résolu : le message de l'erreur
  // quand la valeur en porte un (supabase-js), sinon un libellé générique —
  // `isRetryableResult` décide (transport, 57014…), le warn dit POURQUOI.
  const resolvedReason = (value: unknown): string => {
    const msg = (value as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof msg === "string" && msg.length > 0
      ? `supabase resolved a retryable error: ${msg}`
      : "supabase resolved a retryable error";
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let value: T;
    try {
      value = await op();
    } catch (err) {
      lastError = err;
      // Non transitoire OU dernière tentative : re-throw INCHANGÉ — fail-loud
      // (le caller logge `FATAL`). Sinon : retry tracé `console.warn` ici même
      // (zéro catch silencieux — soit ce `throw`, soit ce `warn`).
      if (!isTransientTransportError(err) || attempt === maxRetries) throw err;
      onRetry?.();
      console.warn(retryWarnLine(attempt, err instanceof Error ? err.message : String(err)));
      await sleep(backoffDelayMs(attempt, baseDelayMs));
      continue;
    }
    // Résolu : un échec transport peut revenir en `{ error }` (PAS un throw).
    if (isRetryableResult?.(value)) {
      if (attempt < maxRetries) {
        onRetry?.();
        console.warn(retryWarnLine(attempt, resolvedReason(value)));
        await sleep(backoffDelayMs(attempt, baseDelayMs));
        continue;
      }
      // Épuisement sur le chemin résolu : le caller reçoit la valeur telle
      // quelle (son `if (error)` décide), mais l'abandon est tracé ICI — sinon
      // une relance épuisée est indistinguable d'un échec sans relance dans
      // les logs (grep « gave up »).
      console.warn(
        `[france-data-mcp] gave up on ${label} after ${maxRetries + 1} attempts: ${resolvedReason(value)}`,
      );
    }
    // Non transitoire, OU dernière tentative : retourne tel quel (le caller
    // déstructure `{ data, error }` et son `if (error) throw` tire fail-loud).
    return value;
  }
  // Inatteignable (la boucle throw/return au dernier attempt) — garde-fou typage.
  throw lastError ?? new Error(`retryTransient: unknown failure on ${label}`);
}
