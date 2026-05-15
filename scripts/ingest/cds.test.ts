import { describe, expect, it } from "vitest";
import { buildCommuneIndex } from "../../src/territoire/commune-index.js";
import type { Commune } from "../../src/territoire/communes.js";
import { __TESTING__ } from "./cds.js";

const { parseCdsRecord, parseStrictBoolean } = __TESTING__;

// Fixtures = codes INSEE RÉELS (Paris 75056, Marseille 13055), tels que
// geo.api.gouv `/communes` les expose — surtout PAS des codes arrondissement
// fabriqués (75108…), qui masquaient le bug de pivot FINESS prod 2026-05-15.
const fixtures: Commune[] = [
  {
    code: "75056",
    nom: "Paris",
    codesPostaux: ["75001", "75008", "75116"],
    centre: { lon: 2.3522, lat: 48.8566 },
    codeDepartement: "75",
  },
  {
    code: "13055",
    nom: "Marseille",
    codesPostaux: ["13001"],
    centre: { lon: 5.3698, lat: 43.2965 },
    codeDepartement: "13",
  },
];
const idx = buildCommuneIndex(fixtures);

// num_finess → code_insee. Porte un code ARRONDISSEMENT (75112, Paris 12e)
// exprès : valide le fold arrondissement → commune (75056) du pivot, le bug
// exact que les anciennes fixtures masquaient. `parseCdsRecord` défaute à une
// Map vide (chemin fallback `(cp, ville)`) — la prod passe toujours l'index
// explicite via `streamCsvAndInsert`.
const finessMap = new Map<string, string>([["750000123", "75112"]]);

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
    expect(result.acc.code_insee).toBe("75056");
    expect(result.acc.code_departement).toBe("75");
    expect(result.acc.code_postal).toBe("75008");
    expect(result.acc.ville).toBe("PARIS");
    expect(result.acc.geom).toBe("SRID=4326;POINT(2.3522 48.8566)");
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
    expect(parseCdsRecord(row({ etab_finess: "" }), idx)).toEqual({
      skipReason: "no_finess",
    });
  });

  it("skip no_finess quand etab_finess invalide (pas 9 chiffres)", () => {
    expect(parseCdsRecord(row({ etab_finess: "12345" }), idx)).toEqual({
      skipReason: "no_finess",
    });
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

  it("pivot FINESS + fold arrondissement résout malgré une adresse CEDEX (échec prod 2026-05-15)", () => {
    // finessMap porte 75112 (Paris 12e). Le CSV a une adresse CEDEX que
    // geo.api ne matche pas → sans pivot, skip. Le pivot fold 75112 → 75056
    // (commune Paris réelle, présente dans byInsee) et résout.
    const result = parseCdsRecord(
      row({ coordonnees_code_postal: "75112", coordonnees_ville: "PARIS CEDEX 12" }),
      idx,
      finessMap,
    );
    if (!result.acc) throw new Error("expected acc résolu via FINESS");
    expect(result.resolvedVia).toBe("finess");
    expect(result.acc.code_insee).toBe("75056");
    expect(result.acc.code_departement).toBe("75");
    expect(result.acc.geom).toBe("SRID=4326;POINT(2.3522 48.8566)");
    // L'adresse brute CSV est conservée (affichage), seul le géocodage pivote.
    expect(result.acc.ville).toBe("PARIS CEDEX 12");
  });

  it("fallback_drees_lag quand le FINESS est absent de la table (latence DREES, bénin)", () => {
    const result = parseCdsRecord(row(), idx);
    if (!result.acc) throw new Error("expected acc");
    expect(result.resolvedVia).toBe("fallback_drees_lag");
    expect(result.acc.code_insee).toBe("75056");
  });

  it("fallback_orphan_insee quand le code_insee FINESS est inconnu de byInsee (anomalie)", () => {
    // FINESS présent mais code_insee absent de l'index commune (fusion,
    // geo.api drift) → fallback (cp, ville) MAIS discriminé orphan, car il
    // peut mal géocoder une CEDEX → thresholdé avant swap dans main().
    const orphan = new Map<string, string>([["750000123", "99999"]]);
    const result = parseCdsRecord(row(), idx, orphan);
    if (!result.acc) throw new Error("expected acc via fallback");
    expect(result.resolvedVia).toBe("fallback_orphan_insee");
    expect(result.acc.code_insee).toBe("75056");
  });

  it("skip unmatched_locality quand NI le pivot FINESS NI le fallback ne résolvent", () => {
    const result = parseCdsRecord(
      row({ coordonnees_code_postal: "99999", coordonnees_ville: "INCONNUE" }),
      idx,
      new Map<string, string>([["750000123", "88888"]]),
    );
    expect(result.skipReason).toBe("unmatched_locality");
    if (result.skipReason !== "unmatched_locality") throw new Error("expected unmatched");
    expect(result.sampleKey).toBe("99999|INCONNUE");
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
