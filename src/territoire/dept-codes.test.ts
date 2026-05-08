import { describe, expect, it } from "vitest";
import { deptFromCodeInsee, isValidDept } from "./dept-codes.js";

describe("deptFromCodeInsee", () => {
  it("returns 2-char prefix for métropole", () => {
    expect(deptFromCodeInsee("08105")).toBe("08");
    expect(deptFromCodeInsee("75056")).toBe("75");
    expect(deptFromCodeInsee("13055")).toBe("13");
  });

  it("preserves 2A/2B for Corse", () => {
    expect(deptFromCodeInsee("2A004")).toBe("2A");
    expect(deptFromCodeInsee("2B033")).toBe("2B");
  });

  it("returns 3-char prefix for DOM/COM", () => {
    expect(deptFromCodeInsee("97411")).toBe("974");
    expect(deptFromCodeInsee("97120")).toBe("971");
    expect(deptFromCodeInsee("98711")).toBe("987");
  });

  it("returns undefined for too-short codes", () => {
    expect(deptFromCodeInsee("0")).toBeUndefined();
    expect(deptFromCodeInsee("")).toBeUndefined();
    expect(deptFromCodeInsee(null)).toBeUndefined();
    expect(deptFromCodeInsee(undefined)).toBeUndefined();
  });

  it("returns undefined for DOM prefix but too-short", () => {
    expect(deptFromCodeInsee("97")).toBeUndefined();
    expect(deptFromCodeInsee("98")).toBeUndefined();
  });
});

describe("isValidDept", () => {
  it("accepts 2-char métropole", () => {
    expect(isValidDept("01")).toBe(true);
    expect(isValidDept("75")).toBe(true);
    expect(isValidDept("95")).toBe(true);
  });

  it("rejects '20' (must use Corse 2A/2B)", () => {
    expect(isValidDept("20")).toBe(false);
  });

  it("accepts Corse 2A and 2B", () => {
    expect(isValidDept("2A")).toBe(true);
    expect(isValidDept("2B")).toBe(true);
  });

  it("accepts DROM 971-978", () => {
    expect(isValidDept("971")).toBe(true);
    expect(isValidDept("974")).toBe(true);
    expect(isValidDept("978")).toBe(true);
  });

  it("accepts COM 984-988", () => {
    expect(isValidDept("984")).toBe(true);
    expect(isValidDept("987")).toBe(true);
  });

  it("rejects invalid dept codes", () => {
    expect(isValidDept("")).toBe(false);
    expect(isValidDept("AB")).toBe(false);
    expect(isValidDept("999")).toBe(false);
    expect(isValidDept("970")).toBe(false); // not in DROM range
    expect(isValidDept("979")).toBe(false);
    expect(isValidDept("989")).toBe(false);
    expect(isValidDept("2C")).toBe(false);
    expect(isValidDept("123")).toBe(false);
  });
});
