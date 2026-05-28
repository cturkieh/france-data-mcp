/**
 * Tests unitaires du parseur de contours IRIS (Phase B étape 1). Verrouille le
 * mapping CSV ogr2ogr → row staging, sur des lignes à la VRAIE forme de la
 * source (header vérifié `ogrinfo`/CSV 2026-05-28 :
 * geometrie,cleabs,code_insee,nom_commune,iris,code_iris,nom_iris,type_iris).
 *
 * Invariants protégés :
 *  - EWKT : géométrie préfixée `SRID=4326;` (le WKT nu d'ogr2ogr est SRID 0 →
 *    rejeté par le cast vers geometry(MultiPolygon, 4326) sans ce préfixe).
 *  - code_iris : CHAR(9), Corse `2A/2B` acceptée, tout autre format = skip compté.
 *  - géométrie vide = skip compté (jamais une row geom NULL → la colonne est NOT NULL).
 */

import { describe, expect, it } from "vitest";
import { __TESTING__ } from "./iris.js";

const {
  mapContourRecord,
  mapPopRecord,
  mapFamillesRecord,
  parseNum,
  CODE_IRIS_RE,
  POP_COLUMNS,
  FAMILLES_COLUMNS,
  POP_EXPECTED_HEADERS,
  FAMILLES_EXPECTED_HEADERS,
} = __TESTING__;

/** Ligne réelle Paris 10e (IRIS urbain TYP_IRIS H). */
const parisH: Record<string, string> = {
  geometrie: "MULTIPOLYGON (((2.3660 48.8827,2.3670 48.8830,2.3665 48.8820,2.3660 48.8827)))",
  cleabs: "CONTOURS-IRIS0000000000000001",
  code_insee: "75110",
  nom_commune: "Paris 10e Arrondissement",
  iris: "3701",
  code_iris: "751103701",
  nom_iris: "Saint-Vincent de Paul 1",
  type_iris: "H",
};

describe("mapContourRecord", () => {
  it("mappe une ligne valide et préfixe la géométrie en EWKT SRID=4326", () => {
    const out = mapContourRecord(parisH);
    expect(out.skip).toBeUndefined();
    expect(out.row).toEqual({
      code_iris: "751103701",
      code_commune: "75110",
      libelle: "Saint-Vincent de Paul 1",
      type_iris: "H",
      geom: `SRID=4326;${parisH.geometrie}`,
    });
  });

  it("accepte un code_iris corse (2A/2B) et en dérive code_commune", () => {
    const out = mapContourRecord({ ...parisH, code_iris: "2A0010000", code_insee: "2A001" });
    expect(out.row?.code_iris).toBe("2A0010000");
    expect(out.row?.code_commune).toBe("2A001");
  });

  it("trim le code_iris CHAR-paddé avant validation", () => {
    const out = mapContourRecord({ ...parisH, code_iris: " 751103701 " });
    expect(out.row?.code_iris).toBe("751103701");
  });

  it("skippe (bad_code) un code_iris de longueur ≠ 9", () => {
    expect(mapContourRecord({ ...parisH, code_iris: "75110370" }).skip).toBe("bad_code");
    expect(mapContourRecord({ ...parisH, code_iris: "7511037010" }).skip).toBe("bad_code");
  });

  it("skippe (bad_code) un code_iris non conforme (lettre hors 2A/2B)", () => {
    expect(mapContourRecord({ ...parisH, code_iris: "7A1103701" }).skip).toBe("bad_code");
    expect(mapContourRecord({ ...parisH, code_iris: "2C0010000" }).skip).toBe("bad_code");
    expect(mapContourRecord({ ...parisH, code_iris: "" }).skip).toBe("bad_code");
  });

  it("skippe (empty_geom) une géométrie vide — jamais de row geom NULL (colonne NOT NULL)", () => {
    expect(mapContourRecord({ ...parisH, geometrie: "" }).skip).toBe("empty_geom");
    expect(mapContourRecord({ ...parisH, geometrie: "   " }).skip).toBe("empty_geom");
  });

  it("normalise libelle/type_iris absents en null (pas de chaîne vide)", () => {
    const out = mapContourRecord({ ...parisH, nom_iris: "", type_iris: "  " });
    expect(out.row?.libelle).toBeNull();
    expect(out.row?.type_iris).toBeNull();
  });

  it("dérive code_commune de code_iris, JAMAIS de la colonne code_insee (garde anti-clé-vide)", () => {
    // P2 (silent-failure-hunter) : si on faisait confiance à `code_insee`, une
    // colonne absente/décalée produirait une clé de raccord vide ingérée en
    // silence (CHAR(5) NOT NULL accepte `'     '`). La dérivation l'interdit :
    // même avec code_insee absent OU contradictoire, code_commune = les 5
    // premiers car. de code_iris (déjà validé).
    const { code_insee, ...sansInsee } = parisH;
    void code_insee;
    expect(mapContourRecord(sansInsee).row?.code_commune).toBe("75110");
    expect(mapContourRecord({ ...parisH, code_insee: "99999" }).row?.code_commune).toBe("75110");
  });
});

describe("CODE_IRIS_RE", () => {
  it("matche les codes métropole et corses, rejette le reste", () => {
    expect(CODE_IRIS_RE.test("010010000")).toBe(true); // commune rurale Z
    expect(CODE_IRIS_RE.test("751103701")).toBe(true); // IRIS urbain
    expect(CODE_IRIS_RE.test("2A0010000")).toBe(true); // Corse 2A
    expect(CODE_IRIS_RE.test("2B0330000")).toBe(true); // Corse 2B
    expect(CODE_IRIS_RE.test("75110370")).toBe(false); // 8 car.
    expect(CODE_IRIS_RE.test("2C0010000")).toBe(false); // lettre invalide
    expect(CODE_IRIS_RE.test("75A103701")).toBe(false); // lettre hors position 2
  });
});

describe("parseNum", () => {
  it("parse les comptes INSEE, null pour vide/non-numérique", () => {
    expect(parseNum("859")).toBe(859);
    expect(parseNum("692.108")).toBeCloseTo(692.108);
    expect(parseNum("  42 ")).toBe(42);
    expect(parseNum("")).toBeNull();
    expect(parseNum("   ")).toBeNull();
    expect(parseNum(undefined)).toBeNull();
    expect(parseNum("N/A")).toBeNull();
  });
});

describe("mapPopRecord (RP population — âge + CSP)", () => {
  // Forme réelle (clé `IRIS`, colonnes P22_*/C22_*) vérifiée sur la base INSEE.
  const popRow: Record<string, string> = {
    IRIS: "751103701",
    COM: "75110",
    P22_POP: "1850",
    P22_POP0014: "300",
    P22_POP1529: "400",
    P22_POP3044: "450",
    P22_POP4559: "350",
    P22_POP6074: "250",
    P22_POP75P: "100",
    P22_POP65P: "260",
    C22_POP15P: "1550",
    C22_POP15P_STAT_GSEC11_21: "5",
    C22_POP15P_STAT_GSEC12_22: "45",
    C22_POP15P_STAT_GSEC13_23: "520",
    C22_POP15P_STAT_GSEC14_24: "310",
    C22_POP15P_STAT_GSEC15_25: "240",
    C22_POP15P_STAT_GSEC16_26: "90",
    C22_POP15P_STAT_GSEC32: "300",
    C22_POP15P_STAT_GSEC40: "40",
  };

  it("mappe toutes les colonnes âge + les 8 CSP sur les bons champs", () => {
    const r = mapPopRecord(popRow);
    expect(r.row).toEqual({
      code_iris: "751103701",
      pop_total: 1850,
      pop_0_14: 300,
      pop_15_29: 400,
      pop_30_44: 450,
      pop_45_59: 350,
      pop_60_74: 250,
      pop_75p: 100,
      pop_65p: 260,
      pop_15p: 1550,
      csp_agriculteurs: 5,
      csp_artisans_comm: 45,
      csp_cadres: 520,
      csp_prof_interm: 310,
      csp_employes: 240,
      csp_ouvriers: 90,
      csp_retraites: 300,
      csp_autres: 40,
    });
  });

  it("skippe (bad_code, COMPTÉ) si la colonne IRIS est non conforme", () => {
    expect(mapPopRecord({ ...popRow, IRIS: "75110370" }).skip).toBe("bad_code");
    expect(mapPopRecord({ ...popRow, IRIS: "" }).skip).toBe("bad_code");
  });

  it("passe les cellules vides à null (secret statistique), pas à 0", () => {
    const r = mapPopRecord({ ...popRow, P22_POP75P: "", C22_POP15P_STAT_GSEC11_21: "" });
    expect(r.row?.pop_75p).toBeNull();
    expect(r.row?.csp_agriculteurs).toBeNull();
  });

  it("expectedHeaders couvre IRIS + TOUTES les colonnes lues (garde anti-NULL-silencieux)", () => {
    // Garantie structurelle du fix HIGL revue : toute colonne du COLUMN_MAP est
    // dans expectedHeaders → un renommage INSEE échoue en preValidateFile (LOUD)
    // au lieu de produire parseNum(undefined)=null en masse.
    expect(POP_EXPECTED_HEADERS).toContain("IRIS");
    for (const col of Object.values(POP_COLUMNS)) {
      expect(POP_EXPECTED_HEADERS).toContain(col);
    }
    expect(POP_EXPECTED_HEADERS.length).toBe(Object.keys(POP_COLUMNS).length + 1);
  });
});

describe("mapFamillesRecord (RP couples-familles-ménages)", () => {
  const famRow: Record<string, string> = {
    IRIS: "751103701",
    C22_MEN: "1100",
    C22_MENCOUPAENF: "240",
    C22_MENCOUPSENF: "300",
    C22_MENFAMMONO: "90",
  };

  it("mappe ménages + structures familiales", () => {
    expect(mapFamillesRecord(famRow).row).toEqual({
      code_iris: "751103701",
      menages_total: 1100,
      couples_avec_enfants: 240,
      couples_sans_enfants: 300,
      familles_monoparentales: 90,
    });
  });

  it("skippe (bad_code) si code_iris non conforme", () => {
    expect(mapFamillesRecord({ ...famRow, IRIS: "xxx" }).skip).toBe("bad_code");
  });

  it("expectedHeaders couvre IRIS + toutes les colonnes familles lues", () => {
    expect(FAMILLES_EXPECTED_HEADERS).toContain("IRIS");
    for (const col of Object.values(FAMILLES_COLUMNS)) {
      expect(FAMILLES_EXPECTED_HEADERS).toContain(col);
    }
    expect(FAMILLES_EXPECTED_HEADERS.length).toBe(Object.keys(FAMILLES_COLUMNS).length + 1);
  });
});
