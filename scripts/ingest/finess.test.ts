/**
 * Unit tests for the FINESS CSV row parser. Locks down the v0.2.1 audit fixes:
 *
 *   B4.1 — `code_insee` must be the 5-char concatenation of dept + commune,
 *          NOT just the 3-char commune-in-dept code (Charleville-Mézières
 *          stored as "08105", not "105  ").
 *   B4.2 — `code_departement` must be a real, non-padded value the SQL filter
 *          can compare directly (no more `left(code_insee, 2)` workaround).
 *   B4.3 — `ville` must come from `ligneacheminement` (the real city name),
 *          NOT from `libdepartement` (the department label).
 *   B4.3 — `code_postal` must be parsed from `ligneacheminement` (was always
 *          NULL in v0.2.0).
 *   B4.3 — `voie` must concatenate `numvoie + typvoie + voie`, not just `voie`.
 */

import { describe, expect, it } from "vitest";
import { __TESTING__ } from "./finess.js";

const { parseFinessRecord, isValidDept, parseLambert93Coord } = __TESTING__;

const charlevilleEhpadRow: Record<string, string> = {
  nofinesset: "080000235",
  nofinessej: "080006083",
  rs: "EHPAD JEAN JAURES",
  rslongue: "EHPAD JEAN JAURES CHARLEVILLE",
  numvoie: "12",
  typvoie: "CRS",
  voie: "BRIAND",
  commune: "105",
  departement: "08",
  libdepartement: "ARDENNES",
  ligneacheminement: "08000 CHARLEVILLE MEZIERES",
  telephone: "0324337160",
  categetab: "500",
  libcategetab: "Etablissement d'hébergement pour personnes âgées dépendantes",
  coordxet: "823923.6",
  coordyet: "6964785.4",
};

describe("parseFinessRecord (v0.2.1 audit fixes)", () => {
  it("reconstructs the full 5-char INSEE code from dept + commune", () => {
    const out = parseFinessRecord(charlevilleEhpadRow);
    expect(out.row?.code_insee).toBe("08105");
    expect(out.row?.code_departement).toBe("08");
  });

  it("zero-pads commune codes shorter than 3 chars", () => {
    const row = { ...charlevilleEhpadRow, commune: "5" };
    const out = parseFinessRecord(row);
    expect(out.row?.code_insee).toBe("08005");
  });

  it("trims whitespace padding on commune codes (CSV CHAR-padded fields)", () => {
    const row = { ...charlevilleEhpadRow, commune: "105  " };
    const out = parseFinessRecord(row);
    expect(out.row?.code_insee).toBe("08105");
  });

  it("extracts the real city name from ligneacheminement (NOT libdepartement)", () => {
    const out = parseFinessRecord(charlevilleEhpadRow);
    // Audit B4.3: v0.2.0 was returning ville="ARDENNES" (the dept label).
    expect(out.row?.ville).toBe("CHARLEVILLE MEZIERES");
    expect(out.row?.ville).not.toBe("ARDENNES");
  });

  it("extracts the postal code from ligneacheminement (was NULL in v0.2.0)", () => {
    const out = parseFinessRecord(charlevilleEhpadRow);
    expect(out.row?.code_postal).toBe("08000");
  });

  it("strips the CEDEX suffix from the city name but keeps the postal code", () => {
    const row = {
      ...charlevilleEhpadRow,
      ligneacheminement: "08011 CHARLEVILLE MEZIERES CEDEX",
    };
    const out = parseFinessRecord(row);
    expect(out.row?.code_postal).toBe("08011");
    expect(out.row?.ville).toBe("CHARLEVILLE MEZIERES");
  });

  it("strips the numbered CEDEX suffix (CEDEX 02, CEDEX 13...)", () => {
    const row = {
      ...charlevilleEhpadRow,
      ligneacheminement: "75001 PARIS CEDEX 01",
    };
    const out = parseFinessRecord(row);
    expect(out.row?.code_postal).toBe("75001");
    expect(out.row?.ville).toBe("PARIS");
  });

  it("concatenates numvoie + typvoie + voie into the full address", () => {
    const out = parseFinessRecord(charlevilleEhpadRow);
    // Audit B4.3: v0.2.0 was returning voie="BRIAND" (just the street name).
    expect(out.row?.voie).toBe("12 CRS BRIAND");
  });

  it("falls back to a partial address when only some street fields are present", () => {
    const row = { ...charlevilleEhpadRow, numvoie: "", typvoie: "" };
    const out = parseFinessRecord(row);
    expect(out.row?.voie).toBe("BRIAND");
  });

  it("returns voie=null when all three street fields are empty", () => {
    const row = { ...charlevilleEhpadRow, numvoie: "", typvoie: "", voie: "" };
    const out = parseFinessRecord(row);
    expect(out.row?.voie).toBeNull();
  });

  it("skips rows without a FINESS number", () => {
    const row = { ...charlevilleEhpadRow, nofinesset: "" };
    const out = parseFinessRecord(row);
    expect(out.skipReason).toBe("no_finess_id");
  });

  it("skips rows without a commune", () => {
    const row = { ...charlevilleEhpadRow, commune: "" };
    const out = parseFinessRecord(row);
    expect(out.skipReason).toBe("no_commune");
  });

  it("skips rows with malformed dept (likely CSV column shift)", () => {
    const row = { ...charlevilleEhpadRow, departement: "BERTRAND RUSSEL" };
    const out = parseFinessRecord(row);
    expect(out.skipReason).toBe("bad_dept");
  });

  it("skips DOM/COM rows with a dedicated 'dom_unsupported' reason (v0.2.1 SFH fix)", () => {
    const row = { ...charlevilleEhpadRow, departement: "974", commune: "411" };
    const out = parseFinessRecord(row);
    // SFH review caught that DOM rows being lumped under "no_commune" hid
    // them from the operator. They now have a dedicated skip reason so the
    // ingest log distinguishes a documented architectural limit from a
    // real CSV regression.
    expect(out.skipReason).toBe("dom_unsupported");
  });

  it("accepts Corse codes (2A, 2B)", () => {
    const row = { ...charlevilleEhpadRow, departement: "2A", commune: "004" };
    const out = parseFinessRecord(row);
    expect(out.row?.code_insee).toBe("2A004");
    expect(out.row?.code_departement).toBe("2A");
  });

  it("rejects '20' as a department (must use 2A or 2B for Corse)", () => {
    const row = { ...charlevilleEhpadRow, departement: "20" };
    const out = parseFinessRecord(row);
    expect(out.skipReason).toBe("bad_dept");
  });

  it("parses coordxet/coordyet into typed columns and empties raw (V0.4.2)", () => {
    const out = parseFinessRecord(charlevilleEhpadRow);
    if (!out.row) throw new Error("expected row");
    expect(out.row.coordx_lambert93).toBe(823923.6);
    expect(out.row.coordy_lambert93).toBe(6964785.4);
    expect(out.row.raw).toEqual({});
    expect(out.row.geom).toBeNull();
  });

  it("parses French decimal comma in coordxet/coordyet", () => {
    const row = { ...charlevilleEhpadRow, coordxet: "823923,6", coordyet: "6964785,4" };
    const out = parseFinessRecord(row);
    expect(out.row?.coordx_lambert93).toBe(823923.6);
    expect(out.row?.coordy_lambert93).toBe(6964785.4);
  });

  it("returns null coords when coordxet/coordyet are missing or non-numeric", () => {
    const empty = parseFinessRecord({ ...charlevilleEhpadRow, coordxet: "", coordyet: "" });
    expect(empty.row?.coordx_lambert93).toBeNull();
    expect(empty.row?.coordy_lambert93).toBeNull();

    const garbage = parseFinessRecord({
      ...charlevilleEhpadRow,
      coordxet: "GARBAGE",
      coordyet: "BLOB",
    });
    expect(garbage.row?.coordx_lambert93).toBeNull();
    expect(garbage.row?.coordy_lambert93).toBeNull();
  });

  it("flags ligneacheminement parse failures via the parser return", () => {
    const malformed = parseFinessRecord({ ...charlevilleEhpadRow, ligneacheminement: "GARBAGE" });
    expect(malformed.ligneAchPresentButUnparsed).toBe(true);
    expect(malformed.row?.code_postal).toBeNull();

    const ok = parseFinessRecord(charlevilleEhpadRow);
    expect(ok.ligneAchPresentButUnparsed).toBe(false);

    const empty = parseFinessRecord({ ...charlevilleEhpadRow, ligneacheminement: "" });
    expect(empty.ligneAchPresentButUnparsed).toBe(false);
  });
});

describe("parseLambert93Coord (V0.4.2)", () => {
  it("parses a numeric string with a dot decimal", () => {
    expect(parseLambert93Coord("823923.6")).toBe(823923.6);
    expect(parseLambert93Coord("-1234.5")).toBe(-1234.5);
    expect(parseLambert93Coord("0")).toBe(0);
  });

  it("parses a numeric string with a French decimal comma", () => {
    expect(parseLambert93Coord("823923,6")).toBe(823923.6);
    expect(parseLambert93Coord("6964785,4")).toBe(6964785.4);
  });

  it("returns null for null, empty string, or non-numeric input", () => {
    expect(parseLambert93Coord(null)).toBeNull();
    expect(parseLambert93Coord("")).toBeNull();
    expect(parseLambert93Coord("ABC")).toBeNull();
    expect(parseLambert93Coord("NaN")).toBeNull();
  });

  it("rejects partial-parse inputs (defense against CSV column shifts)", () => {
    expect(parseLambert93Coord("12 RUE DUMAS")).toBeNull();
    expect(parseLambert93Coord("823923.6abc")).toBeNull();
    expect(parseLambert93Coord("12.3.4")).toBeNull();
    expect(parseLambert93Coord("1e6")).toBeNull(); // notation scientifique non standard CSV FR
  });

  it("rejects French thousand-separator commas (multi-comma input)", () => {
    // `replace(",", ".")` sans `g` flag ne remplace que la première virgule,
    // donc "1,234,5" devient "1.234,5" qui échoue la regex stricte → null.
    // Pas un partial-parse silencieux, mais le test ancre le contrat.
    expect(parseLambert93Coord("1,234,5")).toBeNull();
    expect(parseLambert93Coord("1.234,5")).toBeNull();
  });

  it("trims surrounding whitespace including \\r (Windows CSV) and tab", () => {
    expect(parseLambert93Coord("823923.6\r")).toBe(823923.6);
    expect(parseLambert93Coord("\t823923.6")).toBe(823923.6);
    expect(parseLambert93Coord("  823923.6  ")).toBe(823923.6);
  });
});

describe("isValidDept (v0.2.1)", () => {
  it("accepts valid metropole codes", () => {
    expect(isValidDept("01")).toBe(true);
    expect(isValidDept("08")).toBe(true);
    expect(isValidDept("75")).toBe(true);
    expect(isValidDept("95")).toBe(true);
  });

  it("accepts Corse 2A/2B but rejects '20'", () => {
    expect(isValidDept("2A")).toBe(true);
    expect(isValidDept("2B")).toBe(true);
    expect(isValidDept("20")).toBe(false);
  });

  it("accepts DOM/COM 3-char codes within the published INSEE ranges", () => {
    expect(isValidDept("971")).toBe(true); // Guadeloupe
    expect(isValidDept("974")).toBe(true); // La Réunion
    expect(isValidDept("978")).toBe(true); // Saint-Martin
    expect(isValidDept("984")).toBe(true); // TAAF
    expect(isValidDept("987")).toBe(true); // Polynésie
    expect(isValidDept("988")).toBe(true); // Nouvelle-Calédonie
  });

  it("rejects out-of-range 9XX codes (review-1 caught the original /^9[78]\\d$/ being too loose)", () => {
    expect(isValidDept("970")).toBe(false);
    expect(isValidDept("979")).toBe(false);
    expect(isValidDept("980")).toBe(false);
    expect(isValidDept("989")).toBe(false);
    expect(isValidDept("996")).toBe(false);
  });

  it("rejects malformed values (column shift, dirty data)", () => {
    expect(isValidDept("BERTRAND RUSSEL")).toBe(false);
    expect(isValidDept("AIN")).toBe(false);
    expect(isValidDept("8")).toBe(false); // single digit
    expect(isValidDept("")).toBe(false);
    expect(isValidDept("0123")).toBe(false); // 4 digits
  });
});
