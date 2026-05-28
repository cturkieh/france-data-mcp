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

const { mapContourRecord, CODE_IRIS_RE } = __TESTING__;

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
