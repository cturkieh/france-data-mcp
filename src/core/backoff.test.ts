import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, jitter, sleep } from "./backoff.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sleep", () => {
  it("resolves after ~ms (fake timers)", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = sleep(1000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("jitter", () => {
  it("stays in [0, 250) and is an integer", () => {
    for (let i = 0; i < 200; i++) {
      const j = jitter();
      expect(Number.isInteger(j)).toBe(true);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(250);
    }
  });

  it("returns 0 when Math.random() is 0 and 249 when it approaches 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(jitter()).toBe(0);
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(jitter()).toBe(249);
  });
});

describe("backoffDelayMs", () => {
  it("grows as base * 2^attempt + jitter() with jitter stubbed to 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffDelayMs(0, 500)).toBe(500);
    expect(backoffDelayMs(1, 500)).toBe(1000);
    expect(backoffDelayMs(2, 500)).toBe(2000);
    expect(backoffDelayMs(3, 500)).toBe(4000);
    expect(backoffDelayMs(0, 250)).toBe(250);
  });

  it("adds the jitter term (formula identical to the ex-inline copies)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter() === 125
    expect(backoffDelayMs(0, 500)).toBe(500 + 125);
    expect(backoffDelayMs(2, 500)).toBe(500 * 2 ** 2 + 125);
  });

  it("stays within [base*2^attempt, base*2^attempt + 250) for random jitter", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      for (const base of [250, 500]) {
        const lower = base * 2 ** attempt;
        const d = backoffDelayMs(attempt, base);
        expect(d).toBeGreaterThanOrEqual(lower);
        expect(d).toBeLessThan(lower + 250);
      }
    }
  });
});
