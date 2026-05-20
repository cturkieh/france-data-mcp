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

const hasRppsMixteSubCommuneNote = (notes: string[]): boolean =>
  notes.some(
    (n) => n.includes("branche centroïde commune résiduelle") && n.includes("precise_only"),
  );

describe("warning radius sub-commune (A2/A4)", () => {
  it("Ameli/CDS centroïde pur : radius < 3 km → note GÉNÉRIQUE 'FAUX négatif' (TOUS PS d'une commune en bloc)", () => {
    for (const md of [ameliRadiusMetadata(0.1), cdsRadiusMetadata(2)]) {
      expect(hasSubCommuneNote(md.notes)).toBe(true);
      const note = md.notes.find((n) => n.includes("FAUX négatif"));
      expect(note).toBeDefined();
    }
  });

  it("RPPS hybride V0.12.0 : radius < 3 km → note NUANCÉE (branche précise fiable, pas la note Ameli)", () => {
    const md = rppsRadiusMetadata(2);
    // Pas la note générique Ameli — la branche `precise` reste fiable même à <3km.
    expect(hasSubCommuneNote(md.notes)).toBe(false);
    // Mais bien la note dédiée mixte qui pointe `precise_only`.
    expect(hasRppsMixteSubCommuneNote(md.notes)).toBe(true);
  });

  it("radius >= 3 km → pas d'avertissement (Ameli ni RPPS)", () => {
    expect(hasSubCommuneNote(ameliRadiusMetadata(5).notes)).toBe(false);
    expect(hasSubCommuneNote(rppsRadiusMetadata(10).notes)).toBe(false);
    expect(hasRppsMixteSubCommuneNote(rppsRadiusMetadata(10).notes)).toBe(false);
  });

  it("borne exacte : radius == 3 km → pas d'avertissement (seuil strict <)", () => {
    expect(hasSubCommuneNote(ameliRadiusMetadata(CENTROIDE_COMMUNE_RESOLUTION_KM).notes)).toBe(
      false,
    );
    expect(
      hasRppsMixteSubCommuneNote(rppsRadiusMetadata(CENTROIDE_COMMUNE_RESOLUTION_KM).notes),
    ).toBe(false);
  });

  it("radius non fourni (undefined) → pas d'avertissement (rétrocompat)", () => {
    expect(hasSubCommuneNote(ameliRadiusMetadata().notes)).toBe(false);
    expect(hasRppsMixteSubCommuneNote(rppsRadiusMetadata().notes)).toBe(false);
  });

  it("FINESS (coords Lambert93 natives, pas centroïde) jamais averti même radius minuscule", () => {
    // finessRadiusMetadata n'accepte pas radiusKm : la précision adresse ne
    // souffre pas du piège centroïde. Aucune note sous-commune possible.
    expect(hasSubCommuneNote(finessRadiusMetadata().notes)).toBe(false);
  });
});
