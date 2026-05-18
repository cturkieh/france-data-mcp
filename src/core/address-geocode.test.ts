import { describe, expect, it } from "vitest";
import { normalizeAddressKey, normalizeAddressKey3 } from "./address-geocode.js";

describe("normalizeAddressKey", () => {
  it("trim/upper/collapse + retire CEDEX", () => {
    expect(normalizeAddressKey("  12 Rue de la Pompe ", "75116 CEDEX", "75116")).toBe(
      "12 RUE DE LA POMPE|75116|75116",
    );
  });
  it("retire CEDEX avec numéro", () => {
    expect(normalizeAddressKey("Av X", "21078", "21231", "DIJON CEDEX 1")).toBe(
      "AV X|21078|21231|DIJON",
    );
  });
  it("clé déterministe (mêmes entrées → même clé)", () => {
    const a = normalizeAddressKey("1 RUE A", "75001", "75101");
    const b = normalizeAddressKey(" 1  rue a ", "75001", "75101");
    expect(a).toBe(b);
  });
});

describe("normalizeAddressKey3 (garde structurelle C1 / S-4-bis)", () => {
  // Le HARD GATE de parité SQL↔JS (`ban-geocode-parity.integration.test.ts`)
  // teste `normalizeAddressKey` (3-arg). `normalizeAddressKey3` est le point
  // d'appel cache prod : il DOIT être byte-identique à `normalizeAddressKey`
  // avec ville omise, sinon la couverture du HARD GATE ne s'étend pas au code
  // réellement exécuté. Cette équivalence relie les deux.
  const cases: Array<[string | null, string | null, string | null]> = [
    ["  12 Rue de la Pompe ", "75116 CEDEX", "75116"],
    ["60 AV DE JASSERON", "08000", "08105"],
    ["10 PLACE DE LA REPUBLIQUE", "75011", "75111"],
    [null, null, null],
    ["", "", ""],
    ["1 rue ß ŉ ǰ", "21078", "21231"],
    ["Av X CEDEX 1", "21078", "21231"],
  ];
  it("byte-identique à normalizeAddressKey(a,b,c) avec ville omise", () => {
    for (const [a, b, c] of cases) {
      expect(normalizeAddressKey3(a, b, c)).toBe(normalizeAddressKey(a, b, c));
    }
  });
  it("produit TOUJOURS exactement 3 segments (jamais 4 — ville structurellement impossible)", () => {
    for (const [a, b, c] of cases) {
      expect(normalizeAddressKey3(a, b, c).split("|")).toHaveLength(3);
    }
  });
});
