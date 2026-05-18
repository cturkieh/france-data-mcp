import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTransientSupabaseError,
  isTransientTransportError,
  missingRpcHint,
  retryTransient,
} from "./retry-transient.js";

// `retryTransient` dort entre tentatives via `backoff.ts:sleep` (setTimeout).
// Faux timers : on attache le handler de `p` AVANT de dérouler les timers
// (sinon unhandledrejection pendant le drain), puis `runAllTimersAsync` épuise
// tous les backoffs (y compris ceux enchaînés par les `await`).
async function runWithFakeTimers<T>(p: Promise<T>): Promise<T> {
  const tracked = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  await vi.runAllTimersAsync();
  const r = await tracked;
  if (r.ok) return r.v;
  throw r.e;
}

describe("isTransientTransportError", () => {
  it("vrai pour un undici `TypeError: fetch failed` (l'incident G5 exact)", () => {
    expect(isTransientTransportError(new TypeError("fetch failed"))).toBe(true);
  });

  it("vrai quand la cause porte un code réseau transitoire (ECONNRESET / ETIMEDOUT / EAI_AGAIN)", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]) {
      const err = new TypeError("fetch failed");
      // undici attache la cause réelle dans err.cause
      (err as { cause?: unknown }).cause = Object.assign(new Error("socket"), { code });
      expect(isTransientTransportError(err)).toBe(true);
    }
  });

  it("vrai pour `other side closed` / `terminated` (reset keep-alive undici)", () => {
    expect(isTransientTransportError(new Error("terminated"))).toBe(true);
    const e = new TypeError("fetch failed");
    (e as { cause?: unknown }).cause = new Error("other side closed");
    expect(isTransientTransportError(e)).toBe(true);
  });

  it("FAUX pour une erreur logique applicative (jamais un retry — masquerait un vrai bug)", () => {
    expect(isTransientTransportError(new Error("invalid input syntax for type"))).toBe(false);
    expect(isTransientTransportError(new Error("permission denied for table"))).toBe(false);
  });

  it("FAUX pour un timeout signé `name=TimeoutError` (exclusion ROBUSTE par name, pas par texte — contrat anti-hang)", () => {
    const e = new Error("anything at all, even no 'timed out' substring");
    e.name = "TimeoutError";
    expect(isTransientTransportError(e)).toBe(false);
  });

  it("FAUX pour le timeout `withTimeout` aussi via le fallback regex (appelant ne posant pas le name)", () => {
    expect(
      isTransientTransportError(new Error("rpps_distinct_eligible_keys timed out after 60000ms")),
    ).toBe(false);
  });

  it("FAUX pour une AbortError (annulation explicite, pas un blip réseau)", () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    expect(isTransientTransportError(e)).toBe(false);
  });

  it("FAUX pour un non-Error (string / null / undefined)", () => {
    expect(isTransientTransportError("fetch failed")).toBe(false);
    expect(isTransientTransportError(null)).toBe(false);
    expect(isTransientTransportError(undefined)).toBe(false);
  });
});

describe("isTransientSupabaseError (échec transport revenu en `{error}` RÉSOLU — incident G5)", () => {
  it("vrai pour l'objet error supabase exact de l'incident G5 (`message: TypeError: fetch failed`)", () => {
    expect(isTransientSupabaseError({ message: "TypeError: fetch failed" })).toBe(true);
  });

  it("vrai si la signature transport est dans details/code/hint (pas que message)", () => {
    expect(isTransientSupabaseError({ message: "", code: "ECONNRESET" })).toBe(true);
    expect(isTransientSupabaseError({ details: "und_err_socket" })).toBe(true);
  });

  it("FAUX pour une erreur APPLICATIVE supabase (fail-loud préservé : jamais réessayée)", () => {
    expect(isTransientSupabaseError({ message: "permission denied for table rpps" })).toBe(false);
    expect(
      isTransientSupabaseError({ message: "duplicate key value violates unique constraint" }),
    ).toBe(false);
    expect(isTransientSupabaseError({ code: "23505", message: "conflict" })).toBe(false);
  });

  it("FAUX pour null / non-objet / objet sans champ string", () => {
    expect(isTransientSupabaseError(null)).toBe(false);
    expect(isTransientSupabaseError(undefined)).toBe(false);
    expect(isTransientSupabaseError("fetch failed")).toBe(false);
    expect(isTransientSupabaseError({})).toBe(false);
    expect(isTransientSupabaseError({ message: 42 })).toBe(false);
  });
});

describe("missingRpcHint (actionnabilité migration T-format)", () => {
  it("indice non vide sur les signatures PostgREST de fonction absente", () => {
    for (const m of [
      "Could not find the function public.rpps_geocoded_cache_lookup(p_keys)",
      'function "x" does not exist',
      "schema cache reload",
    ]) {
      expect(missingRpcHint(m)).toContain("migration RPC T-format");
    }
  });

  it("chaîne vide pour une erreur sans rapport (pas de bruit dans les messages normaux)", () => {
    expect(missingRpcHint("TypeError: fetch failed")).toBe("");
    expect(missingRpcHint("permission denied for table")).toBe("");
  });
});

describe("retryTransient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retourne la valeur au 1ᵉʳ essai sans dormir si l'op réussit", async () => {
    const op = vi.fn(async () => "ok");
    await expect(retryTransient(op, "label")).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retry sur `fetch failed` transitoire puis réussit (l'incident G5 : le run NE meurt PAS)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return "recovered";
    });
    const result = await runWithFakeTimers(retryTransient(op, "cache read"));
    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("épuise maxRetries puis throw la DERNIÈRE erreur inchangée (fail-loud, message préservé)", async () => {
    vi.useFakeTimers();
    const boom = new TypeError("fetch failed");
    const op = vi.fn(async () => {
      throw boom;
    });
    await expect(runWithFakeTimers(retryTransient(op, "upsert", { maxRetries: 2 }))).rejects.toBe(
      boom,
    );
    // 1 essai initial + 2 retries = 3 appels
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("appelle `onRetry` une fois PAR retry absorbé (agrégation MEDIUM-6), 0 fois si succès direct", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const onRetry = vi.fn();
    const op = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return "ok";
    });
    await runWithFakeTimers(retryTransient(op, "label", { onRetry }));
    expect(onRetry).toHaveBeenCalledTimes(2); // 2 retries absorbés avant succès

    onRetry.mockClear();
    await retryTransient(async () => "direct", "label", { onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("ne retry JAMAIS une erreur non transitoire : throw immédiat, 1 seul appel", async () => {
    const logicErr = new Error("duplicate key value violates unique constraint");
    const op = vi.fn(async () => {
      throw logicErr;
    });
    await expect(retryTransient(op, "label")).rejects.toBe(logicErr);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("construit une op FRAÎCHE à chaque tentative (pas de réutilisation d'une promesse réglée)", async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    let n = 0;
    const op = vi.fn(async () => {
      const mine = ++n;
      seen.push(mine);
      if (mine < 2) throw new TypeError("fetch failed");
      return mine;
    });
    const r = await runWithFakeTimers(retryTransient(op, "label"));
    expect(r).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  // --- chemin `isRetryableResult` : op RÉSOUT `{error}` (PAS un throw) ---
  // C'est le mode de défaillance RÉEL de supabase-js prouvé en prod (G5) :
  // `.from().select()` sur `fetch failed` résout `{ data:null, error }`.

  it("retry quand op RÉSOUT un `{error}` transitoire puis réussit (incident G5 : le run NE meurt PAS)", async () => {
    vi.useFakeTimers();
    let n = 0;
    const op = vi.fn(async () => {
      n++;
      return n < 3
        ? { data: null, error: { message: "TypeError: fetch failed" } }
        : { data: ["ok"], error: null };
    });
    const isRetryableResult = (r: { error: unknown }) => isTransientSupabaseError(r.error);
    const res = await runWithFakeTimers(retryTransient(op, "cache read", { isRetryableResult }));
    expect(res).toEqual({ data: ["ok"], error: null });
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("NE retry PAS un `{error}` applicatif résolu → retourné tel quel (le `if(error)throw` caller tire fail-loud)", async () => {
    const op = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    const isRetryableResult = (r: { error: unknown }) => isTransientSupabaseError(r.error);
    const res = await retryTransient(op, "cache read", { isRetryableResult });
    expect(res).toEqual({ data: null, error: { message: "permission denied" } });
    expect(op).toHaveBeenCalledTimes(1); // jamais réessayé
  });

  it("épuisement sur `{error}` transitoire → RETOURNE la dernière valeur (PAS un throw : le caller garde son fail-loud, message préservé)", async () => {
    vi.useFakeTimers();
    const errVal = { data: null, error: { message: "fetch failed" } };
    const op = vi.fn(async () => errVal);
    const onRetry = vi.fn();
    const isRetryableResult = (r: { error: unknown }) => isTransientSupabaseError(r.error);
    const res = await runWithFakeTimers(
      retryTransient(op, "upsert", { maxRetries: 2, onRetry, isRetryableResult }),
    );
    expect(res).toBe(errVal); // valeur rendue telle quelle, PAS throw
    expect(op).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
