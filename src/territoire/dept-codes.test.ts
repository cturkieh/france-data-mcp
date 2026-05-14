import { describe, expect, it } from "vitest";
import {
  assertValidCodeInsee,
  deptFromCodeInsee,
  deriveDeptFromCp,
  isValidCodeInsee,
  isValidDept,
} from "./dept-codes.js";

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

describe("deriveDeptFromCp", () => {
  it("returns 2-char prefix for métropole CP", () => {
    expect(deriveDeptFromCp("08000")).toBe("08");
    expect(deriveDeptFromCp("75001")).toBe("75");
    expect(deriveDeptFromCp("13008")).toBe("13");
    expect(deriveDeptFromCp("95800")).toBe("95");
  });

  it("returns 3-char prefix for DROM CP (97x)", () => {
    expect(deriveDeptFromCp("97400")).toBe("974"); // Réunion
    expect(deriveDeptFromCp("97120")).toBe("971"); // Guadeloupe
    expect(deriveDeptFromCp("97200")).toBe("972"); // Martinique
    expect(deriveDeptFromCp("97300")).toBe("973"); // Guyane
    expect(deriveDeptFromCp("97600")).toBe("976"); // Mayotte
  });

  it("returns 3-char prefix for COM CP (98x)", () => {
    expect(deriveDeptFromCp("98711")).toBe("987"); // Polynésie française
    expect(deriveDeptFromCp("98800")).toBe("988"); // Nouvelle-Calédonie
    expect(deriveDeptFromCp("98400")).toBe("984"); // TAAF
  });

  it("returns undefined for Corse CP (2A vs 2B ambigu sans commune)", () => {
    // 20100 est en Corse-du-Sud (2A) mais on ne peut pas le savoir sans
    // la commune — refuse plutôt que d'inventer.
    expect(deriveDeptFromCp("20000")).toBeUndefined();
    expect(deriveDeptFromCp("20100")).toBeUndefined();
    expect(deriveDeptFromCp("20200")).toBeUndefined();
    expect(deriveDeptFromCp("20300")).toBeUndefined();
  });

  it("trims surrounding whitespace and accepts CP+CEDEX suffix", () => {
    expect(deriveDeptFromCp("  08000 ")).toBe("08");
    expect(deriveDeptFromCp("75001 CEDEX 8")).toBe("75");
  });

  it("returns undefined for null/undefined/empty/short inputs", () => {
    expect(deriveDeptFromCp(null)).toBeUndefined();
    expect(deriveDeptFromCp(undefined)).toBeUndefined();
    expect(deriveDeptFromCp("")).toBeUndefined();
    expect(deriveDeptFromCp("   ")).toBeUndefined();
    expect(deriveDeptFromCp("0800")).toBeUndefined(); // 4 digits
    expect(deriveDeptFromCp("8")).toBeUndefined();
  });

  it("returns undefined for non-numeric or malformed CP", () => {
    expect(deriveDeptFromCp("ABCDE")).toBeUndefined();
    expect(deriveDeptFromCp("08-00")).toBeUndefined();
    expect(deriveDeptFromCp("AB000")).toBeUndefined();
  });

  it("returns undefined when prefix is not a valid French dept", () => {
    // 96xxx CP n'existe pas en France ; isValidDept('96') retourne true par
    // tolérance historique (regex \d{2}), mais on accepte cette limitation
    // — elle est plus loose que strict, à corriger en V0.5.x backlog si
    // besoin. Ici on documente le comportement actuel : pas de filtrage
    // exhaustif sur les codes inexistants.
    expect(deriveDeptFromCp("99000")).toBeUndefined(); // 99 invalide
    // Cas DROM hors range : "979xx" n'a pas de dept, isValidDept('979')=false.
    expect(deriveDeptFromCp("97900")).toBeUndefined();
    expect(deriveDeptFromCp("98300")).toBeUndefined(); // 983 hors range COM
  });
});

describe("isValidCodeInsee", () => {
  it("accepts métropole 5-digit codes", () => {
    expect(isValidCodeInsee("75056")).toBe(true); // Paris
    expect(isValidCodeInsee("75108")).toBe(true); // Paris 8e arrondissement
    expect(isValidCodeInsee("59009")).toBe(true); // Villeneuve-d'Ascq
    expect(isValidCodeInsee("13055")).toBe(true); // Marseille
    expect(isValidCodeInsee("69123")).toBe(true); // Lyon
    expect(isValidCodeInsee("01001")).toBe(true); // L'Abergement-Clémenciat
    expect(isValidCodeInsee("95040")).toBe(true); // Argenteuil
  });

  it("accepts Corse 2A/2B + 3 chiffres", () => {
    expect(isValidCodeInsee("2A004")).toBe(true); // Ajaccio
    expect(isValidCodeInsee("2B033")).toBe(true); // Bastia
  });

  it("accepts DOM 971xx-978xx", () => {
    expect(isValidCodeInsee("97120")).toBe(true); // Guadeloupe
    expect(isValidCodeInsee("97411")).toBe(true); // La Réunion
    expect(isValidCodeInsee("97608")).toBe(true); // Mayotte
  });

  it("accepts COM 984xx-988xx", () => {
    expect(isValidCodeInsee("98711")).toBe(true); // Polynésie
    expect(isValidCodeInsee("98800")).toBe(true); // Nouvelle-Calédonie
  });

  it("rejects codes with invalid territorial prefix", () => {
    expect(isValidCodeInsee("96000")).toBe(false); // 96xx n'existe pas
    expect(isValidCodeInsee("99999")).toBe(false); // 99xx n'existe pas
    expect(isValidCodeInsee("20001")).toBe(false); // 20xx → Corse 2A/2B requis
    expect(isValidCodeInsee("97900")).toBe(false); // 979 hors range DOM
    expect(isValidCodeInsee("98300")).toBe(false); // 983 hors range COM
  });

  it("rejects malformed inputs", () => {
    expect(isValidCodeInsee("")).toBe(false);
    expect(isValidCodeInsee("75")).toBe(false); // too short
    expect(isValidCodeInsee("750560")).toBe(false); // too long
    expect(isValidCodeInsee("75ABC")).toBe(false); // non-numeric tail
    expect(isValidCodeInsee("2C001")).toBe(false); // 2C non valide (Corse = 2A/2B)
    expect(isValidCodeInsee("00001")).toBe(false); // dept 00 inexistant
  });
});

describe("assertValidCodeInsee", () => {
  it("returns void on valid code", () => {
    expect(() => assertValidCodeInsee("75056")).not.toThrow();
  });

  it("throws RangeError on invalid code (for MCP -32602 mapping)", () => {
    expect(() => assertValidCodeInsee("99999")).toThrow(RangeError);
    expect(() => assertValidCodeInsee("invalid")).toThrow(/code_insee must be/);
  });
});
