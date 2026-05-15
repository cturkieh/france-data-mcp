import { describe, expect, it } from "vitest";
import { buildCommuneIndex } from "../../src/territoire/commune-index.js";
import type { Commune } from "../../src/territoire/communes.js";
import { __TESTING__ } from "./cds.js";

const { parseCdsRecord, parseStrictBoolean } = __TESTING__;

const fixtures: Commune[] = [
  {
    code: "75108",
    nom: "Paris 8e Arrondissement",
    codesPostaux: ["75008"],
    centre: { lon: 2.317, lat: 48.872 },
    codeDepartement: "75",
  },
  {
    code: "13201",
    nom: "Marseille 1er Arrondissement",
    codesPostaux: ["13001"],
    centre: { lon: 5.379, lat: 43.297 },
    codeDepartement: "13",
  },
];
const idx = buildCommuneIndex(fixtures);

function row(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    etab_finess: "750000123",
    etab_raison_sociale: "CDS MUNICIPAL TEST",
    etab_carte_vitale: "true",
    etab_apcv: "false",
    specialite_code: "01",
    specialite_libelle: "Médecine générale",
    type_etab_code: "124",
    type_etab_libelle: "Centre de santé",
    coordonnees_voie: "10 RUE DE LA PAIX",
    coordonnees_complement: "",
    coordonnees_lieu_dit: "",
    coordonnees_code_postal: "75008",
    coordonnees_ville: "PARIS",
    coordonnees_num_tel: "0123456789",
    ...overrides,
  };
}

describe("parseCdsRecord", () => {
  it("parses une ligne complète et produit un EWKT geom depuis la commune matchée", () => {
    const result = parseCdsRecord(row(), idx);
    expect(result.acc).toBeDefined();
    expect(result.skipReason).toBeUndefined();
    if (!result.acc) throw new Error("expected acc");
    expect(result.acc.etab_finess).toBe("750000123");
    expect(result.acc.etab_raison_sociale).toBe("CDS MUNICIPAL TEST");
    expect(result.acc.accepte_carte_vitale).toBe(true);
    expect(result.acc.accepte_apcv).toBe(false);
    expect(result.acc.code_insee).toBe("75108");
    expect(result.acc.code_departement).toBe("75");
    expect(result.acc.code_postal).toBe("75008");
    expect(result.acc.ville).toBe("PARIS");
    expect(result.acc.geom).toBe("SRID=4326;POINT(2.317 48.872)");
    expect(result.acc.specialites.size).toBe(1);
    expect(result.acc.specialites.get("01")).toBe("Médecine générale");
    expect(result.acc.type_etab_code).toBe("124");
    // Les 2 booléens sont "true"/"false" valides → aucun fallback.
    expect(result.booleanFallbacks).toBe(0);
  });

  it("compte les booleanFallbacks quand carte_vitale/apcv ne sont ni true ni false", () => {
    const result = parseCdsRecord(row({ etab_carte_vitale: "1", etab_apcv: "" }), idx);
    if (!result.acc) throw new Error("expected acc");
    // "1" et "" → 2 fallbacks (alimente le seuil anti-drift CNAM avant swap).
    expect(result.booleanFallbacks).toBe(2);
    expect(result.acc.accepte_carte_vitale).toBe(false);
    expect(result.acc.accepte_apcv).toBe(false);
  });

  it("préserve les leading zeros sur etab_finess (csv-parse ne doit pas convertir en number)", () => {
    const result = parseCdsRecord(row({ etab_finess: "010000456" }), idx);
    if (!result.acc) throw new Error("expected acc");
    expect(result.acc.etab_finess).toBe("010000456");
    expect(result.acc.etab_finess.length).toBe(9);
  });

  it("trim le whitespace sur etab_finess (defense-in-depth contre CSV sale)", () => {
    const result = parseCdsRecord(row({ etab_finess: "  750000123  " }), idx);
    if (!result.acc) throw new Error("expected acc");
    expect(result.acc.etab_finess).toBe("750000123");
  });

  it("skip no_finess quand etab_finess vide", () => {
    expect(parseCdsRecord(row({ etab_finess: "" }), idx)).toEqual({ skipReason: "no_finess" });
  });

  it("skip no_finess quand etab_finess invalide (pas 9 chiffres)", () => {
    expect(parseCdsRecord(row({ etab_finess: "12345" }), idx)).toEqual({ skipReason: "no_finess" });
    expect(parseCdsRecord(row({ etab_finess: "1234567890" }), idx)).toEqual({
      skipReason: "no_finess",
    });
    expect(parseCdsRecord(row({ etab_finess: "abc456789" }), idx)).toEqual({
      skipReason: "no_finess",
    });
  });

  it("skip no_locality quand CP ou ville absent", () => {
    expect(parseCdsRecord(row({ coordonnees_code_postal: "" }), idx)).toEqual({
      skipReason: "no_locality",
    });
    expect(parseCdsRecord(row({ coordonnees_ville: "" }), idx)).toEqual({
      skipReason: "no_locality",
    });
  });

  it("skip unmatched_locality avec sampleKey quand CP+ville inconnus de geo.api", () => {
    const result = parseCdsRecord(
      row({ coordonnees_code_postal: "99999", coordonnees_ville: "INCONNUE" }),
      idx,
    );
    expect(result.skipReason).toBe("unmatched_locality");
    if (result.skipReason !== "unmatched_locality") throw new Error("expected unmatched");
    expect(result.sampleKey).toBe("99999|INCONNUE");
  });

  it("CHAR(5) safe : trim + slice du code postal sale (' 75008 CEDEX' → '75008')", () => {
    const result = parseCdsRecord(row({ coordonnees_code_postal: " 75008 CEDEX" }), idx);
    if (!result.acc) throw new Error("expected acc");
    // Note : ce test vérifie le slicing quand un match commune réussit malgré
    // le contenu sale ; en pratique geo.api ne match pas " 75008 CEDEX". On
    // simule via un CP propre dans les fixtures, donc ce test exerce surtout
    // la garde defense-in-depth. Si match échoue, skipReason s'applique.
    if (result.acc.code_postal.length > 5) {
      throw new Error(`code_postal devrait faire ≤ 5 chars, reçu: "${result.acc.code_postal}"`);
    }
  });

  it("type_etab_code 125 (CDS dentaire) stocké tel quel sans normalisation 124", () => {
    const result = parseCdsRecord(
      row({ type_etab_code: "125", type_etab_libelle: "Centre de santé dentaire" }),
      idx,
    );
    if (!result.acc) throw new Error("expected acc");
    expect(result.acc.type_etab_code).toBe("125");
    expect(result.acc.type_etab_libelle).toBe("Centre de santé dentaire");
  });

  it("default type_etab_code à 124 quand absent du CSV (defense-in-depth)", () => {
    const result = parseCdsRecord(row({ type_etab_code: "", type_etab_libelle: "" }), idx);
    if (!result.acc) throw new Error("expected acc");
    expect(result.acc.type_etab_code).toBe("124");
    expect(result.acc.type_etab_libelle).toBe("Centre de santé");
  });

  it("default specialite_code à _unknown_ quand absent (anti-perte de ligne)", () => {
    const result = parseCdsRecord(row({ specialite_code: "", specialite_libelle: "" }), idx);
    if (!result.acc) throw new Error("expected acc");
    expect(result.acc.specialites.has("_unknown_")).toBe(true);
  });
});

describe("parseStrictBoolean", () => {
  it("accepte 'true' / 'false' case-insensitive sans fallback", () => {
    expect(parseStrictBoolean({ k: "true" }, "k")).toEqual({ value: true, isFallback: false });
    expect(parseStrictBoolean({ k: "TRUE" }, "k")).toEqual({ value: true, isFallback: false });
    expect(parseStrictBoolean({ k: "True" }, "k")).toEqual({ value: true, isFallback: false });
    expect(parseStrictBoolean({ k: "false" }, "k")).toEqual({ value: false, isFallback: false });
    expect(parseStrictBoolean({ k: "FALSE" }, "k")).toEqual({ value: false, isFallback: false });
  });

  it("trim whitespace avant comparaison", () => {
    expect(parseStrictBoolean({ k: "  true  " }, "k")).toEqual({ value: true, isFallback: false });
    expect(parseStrictBoolean({ k: "\tfalse\n" }, "k")).toEqual({
      value: false,
      isFallback: false,
    });
  });

  it("value=false + isFallback=true sur valeur absente / vide / inconnue", () => {
    // isFallback=true alimente le compteur thresholdé avant swap (anti-drift CNAM).
    expect(parseStrictBoolean({}, "k")).toEqual({ value: false, isFallback: true });
    expect(parseStrictBoolean({ k: "" }, "k")).toEqual({ value: false, isFallback: true });
    expect(parseStrictBoolean({ k: "1" }, "k")).toEqual({ value: false, isFallback: true });
    expect(parseStrictBoolean({ k: "yes" }, "k")).toEqual({ value: false, isFallback: true });
    expect(parseStrictBoolean({ k: "oui" }, "k")).toEqual({ value: false, isFallback: true });
  });
});
