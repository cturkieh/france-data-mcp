import { afterEach, describe, expect, it, vi } from "vitest";
import { createWarnOnce } from "./warn-once.js";

describe("createWarnOnce", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("émet le premier message, tait les suivants, réarme au reset", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = createWarnOnce();
    expect(w.hasWarned()).toBe(false);
    expect(w.warn("un")).toBe(true);
    expect(w.warn("deux")).toBe(false);
    expect(w.hasWarned()).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("un");
    w.reset();
    expect(w.hasWarned()).toBe(false);
    expect(w.warn("trois")).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("deux fabriques sont indépendantes (pas de registre partagé, pas de collision)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = createWarnOnce();
    const b = createWarnOnce();
    expect(a.warn("a")).toBe(true);
    expect(b.warn("b")).toBe(true);
    a.reset();
    expect(b.hasWarned()).toBe(true);
    expect(a.hasWarned()).toBe(false);
  });
});
