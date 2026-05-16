import { describe, expect, it } from "vitest";
import { diceCoefficient, normalizeForCompare } from "./text-match.js";

describe("normalizeForCompare", () => {
  it("supprime les diacritiques et abaisse la casse", () => {
    expect(normalizeForCompare("CRÊPERIE Évêché")).toBe("creperie eveche");
  });

  it("normalise apostrophes typographiques, tirets et ponctuation en espace unique", () => {
    expect(normalizeForCompare("L'Haÿ-les-Roses, 94")).toBe("l hay les roses 94");
  });

  it("collapse les espaces multiples et trim", () => {
    expect(normalizeForCompare("  A   B  ")).toBe("a b");
  });
});

describe("diceCoefficient", () => {
  it("renvoie 1 pour des chaînes identiques", () => {
    expect(diceCoefficient("rue du pre aux boeufs", "rue du pre aux boeufs")).toBe(1);
  });

  it("renvoie 0 pour des libellés sans bigramme commun", () => {
    expect(diceCoefficient("pre aux boeufs", "pave bleu")).toBeLessThan(0.5);
  });

  it("reste robuste à l'ordre des mots / typos (score élevé)", () => {
    expect(diceCoefficient("8 rue du pre aux boeufs", "rue du pre aux boeuf 8")).toBeGreaterThan(
      0.7,
    );
  });

  it("égalité stricte sous 2 caractères (évite le 0 du Dice classique)", () => {
    expect(diceCoefficient("a", "a")).toBe(1);
    expect(diceCoefficient("a", "b")).toBe(0);
  });
});
