import { describe, expect, it } from "vitest";
import {
  CENTROIDE_COMMUNE_RESOLUTION_KM,
  ameliRadiusMetadata,
  cdsRadiusMetadata,
  finessRadiusMetadata,
  refineRppsGeoPrecisionLabel,
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

describe("refineRppsGeoPrecisionLabel — Fix #4 V0.13.0", () => {
  it("100% rows précis (adresse + etablissement_finess) → étiquette 'precis_uniquement'", () => {
    const meta = rppsRadiusMetadata(5);
    refineRppsGeoPrecisionLabel(
      [
        { geo_precision: "adresse" },
        { geo_precision: "etablissement_finess" },
        { geo_precision: "adresse" },
      ],
      meta,
    );
    expect(meta.geo_precision).toBe("centroide_commune_ans_precis_uniquement");
    expect(meta.notes[0]).toContain("TOUS les résultats");
    expect(meta.notes[0]).toContain("précision exacte");
  });

  it("100% rows centroïde → étiquette 'centroide_uniquement'", () => {
    const meta = rppsRadiusMetadata(5);
    refineRppsGeoPrecisionLabel(
      [{ geo_precision: "centroide_commune" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(meta.geo_precision).toBe("centroide_commune_ans_centroide_uniquement");
    expect(meta.notes[0]).toContain("centroïde commune");
    expect(meta.notes[0]).toContain("PAS discriminante");
  });

  it("mixte (précis + centroïde) → étiquette mixte préservée (comportement V0.12)", () => {
    const meta = rppsRadiusMetadata(5);
    const initialLabel = meta.geo_precision;
    refineRppsGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(meta.geo_precision).toBe(initialLabel);
  });

  it("rows vides → étiquette inchangée (pas de raffinage sur échantillon vide)", () => {
    const meta = rppsRadiusMetadata(5);
    const initialLabel = meta.geo_precision;
    refineRppsGeoPrecisionLabel([], meta);
    expect(meta.geo_precision).toBe(initialLabel);
  });

  it("row sans geo_precision typé → étiquette mixte préservée (garde-fou anti-régression RPC)", () => {
    // Si un row n'a pas de `geo_precision` (régression RPC, ancien dump, mock test),
    // on garde l'étiquette mixte par sécurité — affirmer "100% précis" sur un
    // échantillon partiellement typé serait trompeur.
    const meta = rppsRadiusMetadata(5);
    const initialLabel = meta.geo_precision;
    refineRppsGeoPrecisionLabel([{ geo_precision: "adresse" }, { geo_precision: undefined }], meta);
    expect(meta.geo_precision).toBe(initialLabel);
  });

  it("ne touche PAS une étiquette initiale non-mixte (helper RPPS-only)", () => {
    // Ameli/FINESS/CDS ont leurs propres étiquettes — pas raffinage croisé.
    const ameliMeta = ameliRadiusMetadata(5);
    refineRppsGeoPrecisionLabel([{ geo_precision: "adresse" }], ameliMeta);
    expect(ameliMeta.geo_precision).toBe("centroide_commune_ameli");
  });
});
