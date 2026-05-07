import { describe, expect, it } from "vitest";
import { deptFromCommune } from "./tools.js";

describe("deptFromCommune", () => {
  it("extrait le département pour la métropole standard", () => {
    expect(deptFromCommune("08105")).toBe("08");
    expect(deptFromCommune("75056")).toBe("75");
    expect(deptFromCommune("13055")).toBe("13");
  });

  it("préserve les codes Corse 2A et 2B", () => {
    expect(deptFromCommune("2A004")).toBe("2A");
    expect(deptFromCommune("2B033")).toBe("2B");
  });

  it("retourne 3 caractères pour les DOM (97x)", () => {
    // Saint-Denis (Réunion) : codeCommune 97411 → département 974
    expect(deptFromCommune("97411")).toBe("974");
    // Fort-de-France (Martinique) : 97209 → 972
    expect(deptFromCommune("97209")).toBe("972");
    // Pointe-à-Pitre (Guadeloupe) : 97120 → 971
    expect(deptFromCommune("97120")).toBe("971");
    // Cayenne (Guyane) : 97302 → 973
    expect(deptFromCommune("97302")).toBe("973");
    // Mayotte : 97601 → 976
    expect(deptFromCommune("97601")).toBe("976");
  });

  it("retourne 3 caractères pour les TOM (98x)", () => {
    // Polynésie française : 98711 → 987
    expect(deptFromCommune("98711")).toBe("987");
  });

  it("retourne undefined pour les entrées invalides", () => {
    expect(deptFromCommune(undefined)).toBeUndefined();
    expect(deptFromCommune("")).toBeUndefined();
    expect(deptFromCommune("0")).toBeUndefined();
  });

  it("retourne undefined si DOM mais codeCommune trop court", () => {
    // Cas dégénéré : codeCommune "97" sans le département complet → undefined
    expect(deptFromCommune("97")).toBeUndefined();
    expect(deptFromCommune("98")).toBeUndefined();
  });
});
