import { describe, expect, it } from "vitest";
import { parseRpcCount } from "./parse-rpc-count.js";

describe("parseRpcCount — garde unique des compteurs RPC (entier ≥ 0, number OU string)", () => {
  it("accepte number et string décimale (BIGINT PostgREST), rend un number", () => {
    expect(parseRpcCount(0, "x")).toBe(0);
    expect(parseRpcCount(2720, "x")).toBe(2720);
    expect(parseRpcCount("339000", "x")).toBe(339_000);
    expect(parseRpcCount(" 12 ", "x")).toBe(12);
  });

  it("refuse null, vide, objet, non-décimal, non-fini, négatif et non-entier — même invariant sur les deux branches", () => {
    for (const bad of [
      null,
      "",
      {},
      "1e5",
      "N/A",
      "12.7",
      -3,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => parseRpcCount(bad, "rpc_x"), JSON.stringify(bad)).toThrow(
        /rpc_x returned .* RPC contract regression/,
      );
    }
  });
});
