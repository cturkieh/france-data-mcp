import { describe, expect, it } from "vitest";
import {
  CENTROIDE_COMMUNE_RESOLUTION_KM,
  ameliRadiusMetadata,
  cdsRadiusMetadata,
  finessRadiusMetadata,
  rppsRadiusMetadata,
} from "./query-metadata.js";

const hasSubCommuneNote = (notes: string[]): boolean =>
  notes.some((n) => n.includes("incompatible avec une précision au centroïde commune"));

describe("warning radius sub-commune (A2/A4)", () => {
  it("radius < 3 km sur source centroïde → note d'avertissement (Ameli/RPPS/CDS)", () => {
    for (const md of [ameliRadiusMetadata(0.1), rppsRadiusMetadata(2), cdsRadiusMetadata(2)]) {
      expect(hasSubCommuneNote(md.notes)).toBe(true);
      const note = md.notes.find((n) => n.includes("FAUX négatif"));
      expect(note).toBeDefined();
    }
  });

  it("radius >= 3 km → pas d'avertissement", () => {
    expect(hasSubCommuneNote(ameliRadiusMetadata(5).notes)).toBe(false);
    expect(hasSubCommuneNote(rppsRadiusMetadata(10).notes)).toBe(false);
  });

  it("borne exacte : radius == 3 km → pas d'avertissement (seuil strict <)", () => {
    expect(hasSubCommuneNote(ameliRadiusMetadata(CENTROIDE_COMMUNE_RESOLUTION_KM).notes)).toBe(
      false,
    );
  });

  it("radius non fourni (undefined) → pas d'avertissement (rétrocompat)", () => {
    expect(hasSubCommuneNote(ameliRadiusMetadata().notes)).toBe(false);
  });

  it("FINESS (coords Lambert93 natives, pas centroïde) jamais averti même radius minuscule", () => {
    // finessRadiusMetadata n'accepte pas radiusKm : la précision adresse ne
    // souffre pas du piège centroïde. Aucune note sous-commune possible.
    expect(hasSubCommuneNote(finessRadiusMetadata().notes)).toBe(false);
  });
});
