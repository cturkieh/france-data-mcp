import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceWarner, prodOnlyConfigWarner } from "./once-warner.js";

describe("onceWarner", () => {
  it("exécute l'action au premier warn()", () => {
    const action = vi.fn();
    const w = onceWarner();
    w.warn(action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("ne ré-exécute pas l'action sur warn() subséquents (idempotence)", () => {
    const action = vi.fn();
    const w = onceWarner();
    w.warn(action);
    w.warn(action);
    w.warn(action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("hasWarned reflète l'état flag", () => {
    const w = onceWarner();
    expect(w.hasWarned()).toBe(false);
    w.warn(() => {});
    expect(w.hasWarned()).toBe(true);
  });

  it("reset() permet de re-déclencher l'action", () => {
    const action = vi.fn();
    const w = onceWarner();
    w.warn(action);
    w.reset();
    expect(w.hasWarned()).toBe(false);
    w.warn(action);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("warn() avec différentes actions — seul le premier passe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const w = onceWarner();
    w.warn(first);
    w.warn(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("warn() après reset accepte une nouvelle action", () => {
    const first = vi.fn();
    const second = vi.fn();
    const w = onceWarner();
    w.warn(first);
    w.reset();
    w.warn(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("exception dans action n'est pas catchée (fail-fast par design)", () => {
    const w = onceWarner();
    expect(() =>
      w.warn(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // Le flag est set AVANT l'action (sinon une exception ferait re-trigger
    // au prochain appel, ce qui inonderait le log). Conventional defensive.
    expect(w.hasWarned()).toBe(true);
  });

  it("plusieurs warners sont indépendants (pas d'état partagé)", () => {
    const a = onceWarner();
    const b = onceWarner();
    a.warn(() => {});
    expect(a.hasWarned()).toBe(true);
    expect(b.hasWarned()).toBe(false);
  });
});

describe("prodOnlyConfigWarner", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // vi.stubEnv auto-restore via afterEach unstubAllEnvs.
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("émet console.error + captureFn quand VERCEL_ENV=production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("x manquant"));
    expect(capture).toHaveBeenCalledWith("missing_x", "x manquant");
  });

  it("émet aussi quand VERCEL_ENV=preview (smoke tests pré-prod)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("no-op en development", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(w.hasWarned()).toBe(false);
  });

  it("no-op si VERCEL_ENV vide ET NODE_ENV=test (CI sans Vercel)", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    expect(capture).not.toHaveBeenCalled();
  });

  it("idempotence : 2e warn() consécutif n'appelle captureFn qu'une fois", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    w.warn();
    w.warn();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("reset() permet de re-déclencher captureFn", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    w.reset();
    expect(w.hasWarned()).toBe(false);
    w.warn();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("code et message passés inchangés à captureFn (fingerprint Sentry stable)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("custom_code", "custom message verbatim", capture);
    w.warn();
    expect(capture).toHaveBeenCalledWith("custom_code", "custom message verbatim");
  });

  it("message préfixé [france-data-mcp] dans console.error", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const capture = vi.fn();
    const w = prodOnlyConfigWarner("missing_x", "x manquant", capture);
    w.warn();
    expect(errorSpy).toHaveBeenCalledWith("[france-data-mcp] x manquant");
  });
});
