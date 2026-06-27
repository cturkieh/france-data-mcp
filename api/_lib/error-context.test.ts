import { describe, expect, it } from "vitest";
import { attachErrorContext, extractErrorContext } from "./error-context.js";

describe("attachErrorContext / extractErrorContext", () => {
  it("attach + extract round-trip on Error instance", () => {
    const err = new Error("statement timeout");
    attachErrorContext(err, { departement: "75", offset: 0 });
    expect(extractErrorContext(err)).toEqual({ departement: "75", offset: 0 });
  });

  it("works on plain object errors (non-Error throws)", () => {
    const err = { code: "57014", message: "timeout" };
    attachErrorContext(err, { tool: "x" });
    expect(extractErrorContext(err)).toEqual({ tool: "x" });
  });

  it("returns undefined for unsupported error shapes", () => {
    expect(extractErrorContext("string error")).toBeUndefined();
    expect(extractErrorContext(42)).toBeUndefined();
    expect(extractErrorContext(null)).toBeUndefined();
    expect(extractErrorContext(undefined)).toBeUndefined();
  });

  it("returns undefined when no context was attached", () => {
    const err = new Error("boom");
    expect(extractErrorContext(err)).toBeUndefined();
  });

  it("attach is no-op on null / undefined / primitive (does not throw)", () => {
    expect(() => attachErrorContext(null, { x: 1 })).not.toThrow();
    expect(() => attachErrorContext(undefined, { x: 1 })).not.toThrow();
    expect(() => attachErrorContext("s", { x: 1 })).not.toThrow();
    expect(() => attachErrorContext(42, { x: 1 })).not.toThrow();
  });

  it("context is not enumerable — JSON.stringify(err) does not leak it", () => {
    const err = new Error("boom");
    attachErrorContext(err, { departement: "75", secret: "should_not_leak" });
    const serialized = JSON.stringify({ ...err, message: err.message });
    expect(serialized).not.toContain("departement");
    expect(serialized).not.toContain("should_not_leak");
  });

  it("second attach replaces the first (no merge — JSDoc contract)", () => {
    const err = new Error("boom");
    attachErrorContext(err, { stage: "init" });
    attachErrorContext(err, { stage: "fallback", retry: 2 });
    expect(extractErrorContext(err)).toEqual({ stage: "fallback", retry: 2 });
  });

  it("ignores attached values that are not objects (defense-in-depth)", () => {
    const err = new Error("boom");
    // Force a bad value via the same symbol used internally.
    const SYM = Symbol.for("mcp.query_context");
    Object.defineProperty(err, SYM, { value: "not an object", enumerable: false });
    expect(extractErrorContext(err)).toBeUndefined();
  });

  it("rejects array values (Sentry setContext attend un object plain)", () => {
    const err = new Error("boom");
    // Cast intentionnel : un dev qui ferait `attachErrorContext(err, [...] as any)`
    // doit voir un undefined retourné côté lecture, pas un array corrompu.
    attachErrorContext(err, [{ x: 1 }] as unknown as Readonly<Record<string, unknown>>);
    expect(extractErrorContext(err)).toBeUndefined();
  });

  it("Object.getOwnPropertyNames ne révèle pas le context (defense-in-depth Sentry)", () => {
    const err = new Error("boom");
    attachErrorContext(err, { secret: "leak" });
    expect(Object.getOwnPropertyNames(err)).not.toContain("secret");
    // Symbol-keyed prop ne sort QUE via getOwnPropertySymbols, jamais
    // via getOwnPropertyNames ni JSON.stringify ni Object.keys.
    expect(Object.keys(err)).not.toContain("secret");
  });
});
