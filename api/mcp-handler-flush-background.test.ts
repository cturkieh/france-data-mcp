import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockVercelRes } from "./_lib/test-helpers.js";

/**
 * Garde-fou du fix "flush observabilité non-bloquant" (Lot A).
 *
 * Invariants prouvés :
 *  1. Le `finally` du handler programme le flush via `waitUntil` (chemin prod) —
 *     régression = retour au `await` bloquant (latence + timeouts qui jetaient
 *     des events).
 *  2. La réponse N'ATTEND PAS le flush : même si un puits ne se résout JAMAIS,
 *     `handler()` résout et `res.json` est appelé. Un re-`await` dans le
 *     `finally` ferait timeout ce test.
 *  3. Fail-soft : si `waitUntil` throw (hors runtime Vercel), `scheduleObserva-
 *     bilityFlush` ne crashe pas (fire-and-forget) et alerte UNE fois EN PROD
 *     (silencieux en dev/test où le throw est attendu — doctrine "zéro silence"
 *     sans bruit local).
 */
const mocks = vi.hoisted(() => ({
  waitUntil: vi.fn(),
  flushSentry: vi.fn(),
  captureMcpError: vi.fn(),
  captureMcpConfigWarning: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

// sentry.js mocké : `flushSentry` pilote le "pendant" (test non-blocage),
// `captureMcpConfigWarning` est l'alerte prod du fail-soft. observability reste
// RÉEL — `scheduleObservabilityFlush` (sous test) et `flushMcpEventsToAxiom`
// (no-op sans AXIOM_TOKEN) y vivent.
vi.mock("./_lib/sentry.js", () => ({
  captureMcpError: mocks.captureMcpError,
  captureMcpConfigWarning: mocks.captureMcpConfigWarning,
  flushSentry: mocks.flushSentry,
}));

import { __resetAxiomStateForTesting, scheduleObservabilityFlush } from "./_lib/observability.js";
import handler from "./mcp.js";

/** Requête `initialize` valide — chemin simple qui traverse le `finally`. */
function makeInitializeReq() {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  };
}

describe("flush observabilité déporté en arrière-plan (Lot A)", () => {
  beforeEach(() => {
    __resetAxiomStateForTesting();
    // flushMcpEventsToAxiom (réel, intra-module) doit rester no-op : pas de token
    // (stubEnv(undefined) retire la clé ; restauré par unstubAllEnvs en afterEach).
    vi.stubEnv("AXIOM_TOKEN", undefined);
    vi.stubEnv("AXIOM_DATASET", undefined);
    mocks.waitUntil.mockReset();
    mocks.flushSentry.mockReset().mockResolvedValue(undefined);
    mocks.captureMcpError.mockReset();
    mocks.captureMcpConfigWarning.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("handler — déporte le flush via waitUntil (chemin prod), réponse 200 envoyée", async () => {
    const req = makeInitializeReq();
    const { res, captured } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res);

    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({ jsonrpc: "2.0", id: 1 });
    // Le flush est programmé via waitUntil, exactement une fois, avec une Promise.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it("handler — NE BLOQUE PAS la réponse même si un puits ne se résout jamais", async () => {
    // flushSentry pend → le `Promise.allSettled` interne pend ; si le handler
    // l'attendait (re-`await` dans le finally), ce test timeout.
    mocks.flushSentry.mockImplementation(() => new Promise<void>(() => {}));
    const req = makeInitializeReq();
    const { res, captured } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res);

    expect(captured.status).toBe(200);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("scheduleObservabilityFlush — fail-soft EN PROD : waitUntil throw → alerte one-shot, pas de throw", () => {
    mocks.waitUntil.mockImplementation(() => {
      throw new Error("waitUntil called outside of a request context");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VERCEL_ENV", "production"); // l'alerte est gatée prod/preview

    // Buffer Axiom vide (reset en beforeEach) → flushMcpEventsToAxiom no-op,
    // pas de bruit axiomMissingWarner : on isole l'alerte waitUntil.
    expect(() => scheduleObservabilityFlush()).not.toThrow();

    // Doctrine "zéro silence" : le mode dégradé prod est signalé (console + Sentry),
    // avec la raison du throw dans le message (alerte actionnable).
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/flush observabilité dégradé.*request context/),
    );
    expect(mocks.captureMcpConfigWarning).toHaveBeenCalledWith(
      "observability_flush_degraded",
      expect.stringMatching(/flush observabilité dégradé/),
    );
  });

  it("scheduleObservabilityFlush — alerte ONE-SHOT : 2 échecs en prod/preview → 1 seule alerte", () => {
    mocks.waitUntil.mockImplementation(() => {
      throw new Error("waitUntil called outside of a request context");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VERCEL_ENV", "preview"); // couvre aussi la branche `preview` du gate

    scheduleObservabilityFlush();
    scheduleObservabilityFlush();

    // One-shot : la perte continue n'est signalée qu'une fois par instance lambda
    // (le signal sert au triage d'une régression binaire, pas à la mesure).
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(mocks.captureMcpConfigWarning).toHaveBeenCalledTimes(1);
  });

  it("scheduleObservabilityFlush — SILENCIEUX hors prod (throw attendu en dev/test)", () => {
    mocks.waitUntil.mockImplementation(() => {
      throw new Error("waitUntil called outside of a request context");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VERCEL_ENV", undefined); // retombe sur NODE_ENV="test" → ni prod ni preview

    expect(() => scheduleObservabilityFlush()).not.toThrow();
    // Pas de bruit : le throw hors Vercel est attendu, on ne pollue pas les logs locaux.
    expect(errSpy).not.toHaveBeenCalled();
    expect(mocks.captureMcpConfigWarning).not.toHaveBeenCalled();
  });
});
