import { describe, expect, it } from "vitest";
import {
  buildCommuneIndex,
  matchCommune,
  normalizeCityName,
  normalizeCp,
} from "./commune-index.js";
import type { Commune } from "./communes.js";

const fixtures: Commune[] = [
  {
    code: "08105",
    nom: "Charleville-Mézières",
    codesPostaux: ["08000"],
    centre: { lon: 4.7203, lat: 49.7724 },
    codeDepartement: "08",
  },
  {
    code: "75056",
    nom: "Paris",
    codesPostaux: ["75001", "75002", "75008", "75116"],
    centre: { lon: 2.347, lat: 48.8589 },
    codeDepartement: "75",
  },
  // Two communes share the same CP — fallback must NOT pick one.
  {
    code: "01001",
    nom: "L'Abergement-Clémenciat",
    codesPostaux: ["01400"],
    centre: { lon: 4.93, lat: 46.15 },
    codeDepartement: "01",
  },
  {
    code: "01100",
    nom: "Châtillon-sur-Chalaronne",
    codesPostaux: ["01400"],
    centre: { lon: 4.95, lat: 46.12 },
    codeDepartement: "01",
  },
  // DOM
  {
    code: "97411",
    nom: "Saint-Denis",
    codesPostaux: ["97400"],
    centre: { lon: 55.45, lat: -20.88 },
    codeDepartement: "974",
  },
  // Corse
  {
    code: "2A004",
    nom: "Ajaccio",
    codesPostaux: ["20000", "20090"],
    centre: { lon: 8.738, lat: 41.927 },
    codeDepartement: "2A",
  },
];

describe("normalizeCityName", () => {
  it("uppercases, strips accents, normalizes saint abbreviations", () => {
    expect(normalizeCityName("Charleville-Mézières")).toBe("CHARLEVILLE MEZIERES");
    expect(normalizeCityName("St Denis")).toBe("SAINT DENIS");
    expect(normalizeCityName("Ste Foy")).toBe("SAINTE FOY");
    expect(normalizeCityName("L'Abergement-Clémenciat")).toBe("L ABERGEMENT CLEMENCIAT");
  });

  it("collapses multiple spaces and trims", () => {
    expect(normalizeCityName("  PARIS  ")).toBe("PARIS");
    expect(normalizeCityName("ST   DENIS")).toBe("SAINT DENIS");
  });
});

describe("normalizeCp", () => {
  it("returns first 5 digits of a CEDEX-suffixed CP", () => {
    expect(normalizeCp("75008 CEDEX 8")).toBe("75008");
    expect(normalizeCp("08000")).toBe("08000");
  });

  it("returns null for invalid CPs", () => {
    expect(normalizeCp("ABC")).toBeNull();
    expect(normalizeCp("123")).toBeNull();
    expect(normalizeCp("")).toBeNull();
  });
});

// `deptFromCodeInsee` covered in `dept-codes.test.ts` (V0.4 consolidation).

describe("buildCommuneIndex", () => {
  it("indexes communes by (cp, normalized name)", () => {
    const idx = buildCommuneIndex(fixtures);
    const m = idx.byCpAndName.get("08000|CHARLEVILLE MEZIERES");
    expect(m?.codeInsee).toBe("08105");
    expect(m?.codeDepartement).toBe("08");
    expect(m?.lon).toBe(4.7203);
  });

  it("indexes a multi-CP commune under each of its CPs", () => {
    const idx = buildCommuneIndex(fixtures);
    expect(idx.byCpAndName.get("75001|PARIS")?.codeInsee).toBe("75056");
    expect(idx.byCpAndName.get("75116|PARIS")?.codeInsee).toBe("75056");
    expect(idx.byCpAndName.get("75008|PARIS")?.codeInsee).toBe("75056");
  });

  it("groups multiple communes sharing a CP for fallback resolution", () => {
    const idx = buildCommuneIndex(fixtures);
    expect(idx.byCp.get("01400")?.length).toBe(2);
    expect(idx.byCp.get("08000")?.length).toBe(1);
  });

  it("derives codeDepartement from codeInsee when missing in payload", () => {
    const c: Commune = {
      code: "97411",
      nom: "Saint-Denis-de-la-Reunion",
      codesPostaux: ["97400"],
      centre: { lon: 55.45, lat: -20.88 },
      // codeDepartement omitted on purpose
    };
    const idx = buildCommuneIndex([c]);
    expect(idx.byCpAndName.get("97400|SAINT DENIS DE LA REUNION")?.codeDepartement).toBe("974");
  });

  it("skips communes without centre", () => {
    const c: Commune = {
      code: "99999",
      nom: "Ghost",
      codesPostaux: ["99999"],
    };
    const idx = buildCommuneIndex([c]);
    expect(idx.byCpAndName.size).toBe(0);
    expect(idx.byCp.size).toBe(0);
  });

  it("skips communes without codesPostaux", () => {
    const c: Commune = {
      code: "99999",
      nom: "Ghost",
      codesPostaux: [],
      centre: { lon: 0, lat: 0 },
    };
    const idx = buildCommuneIndex([c]);
    expect(idx.byCpAndName.size).toBe(0);
  });
});

describe("matchCommune", () => {
  const idx = buildCommuneIndex(fixtures);

  it("returns the exact match when CP+ville agree", () => {
    expect(matchCommune(idx, "08000", "CHARLEVILLE MEZIERES")?.codeInsee).toBe("08105");
    expect(matchCommune(idx, "08000", "Charleville-Mézières")?.codeInsee).toBe("08105");
  });

  it("strips CEDEX from CP before matching", () => {
    expect(matchCommune(idx, "75008 CEDEX 8", "PARIS")?.codeInsee).toBe("75056");
  });

  it("matches St-prefix abbreviation", () => {
    expect(matchCommune(idx, "97400", "ST DENIS")?.codeInsee).toBe("97411");
  });

  it("falls back to CP when only one commune is served by the CP", () => {
    // Ville inconnue mais CP 08000 ne dessert que Charleville
    expect(matchCommune(idx, "08000", "ville-bidon-typo")?.codeInsee).toBe("08105");
  });

  it("refuses to fallback when multiple communes share the CP", () => {
    expect(matchCommune(idx, "01400", "LIEU INCONNU")).toBeNull();
  });

  it("returns null when CP itself is unknown", () => {
    expect(matchCommune(idx, "00000", "Charleville-Mézières")).toBeNull();
  });

  it("returns null when CP is absent or invalid", () => {
    expect(matchCommune(idx, null, "Paris")).toBeNull();
    expect(matchCommune(idx, undefined, "Paris")).toBeNull();
    expect(matchCommune(idx, "ABC", "Paris")).toBeNull();
  });

  it("matches Corse via the standard normalization (Ajaccio CP 20090)", () => {
    expect(matchCommune(idx, "20090", "AJACCIO")?.codeDepartement).toBe("2A");
  });
});
