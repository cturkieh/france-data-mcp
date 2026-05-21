import { describe, expect, it, vi } from "vitest";
import {
  CENTROIDE_COMMUNE_RESOLUTION_KM,
  ameliDeptMetadata,
  ameliRadiusMetadata,
  cdsRadiusMetadata,
  finessRadiusMetadata,
  refineAmeliGeoPrecisionLabel,
  refineRppsGeoPrecisionLabel,
  rppsRadiusMetadata,
} from "./query-metadata.js";

const hasSubCommuneNote = (notes: string[]): boolean =>
  notes.some((n) => n.includes("incompatible avec une précision au centroïde commune"));

const hasRppsMixteSubCommuneNote = (notes: string[]): boolean =>
  notes.some(
    (n) => n.includes("branche centroïde commune résiduelle") && n.includes("precise_only"),
  );

const hasAmeliMixteSubCommuneNote = (notes: string[]): boolean =>
  notes.some(
    (n) => n.includes("branche centroïde commune résiduelle") && n.includes("~23 % des PS Ameli"),
  );

describe("warning radius sub-commune (A2/A4)", () => {
  it("CDS centroïde pur : radius < 3 km → note GÉNÉRIQUE 'FAUX négatif' (TOUS PS d'une commune en bloc)", () => {
    // Chantier C 2026-05-21 : Ameli n'est plus dans ce bucket — l'étiquette
    // par défaut a basculé vers `centroide_commune_ameli_mixte` (~77 % adresse
    // précise) ; cf. test mixte Ameli ci-dessous. CDS reste 100 % centroïde
    // (CSV CNAM sans coords natives) — la note générique s'applique.
    const md = cdsRadiusMetadata(2);
    expect(hasSubCommuneNote(md.notes)).toBe(true);
    const note = md.notes.find((n) => n.includes("FAUX négatif"));
    expect(note).toBeDefined();
  });

  it("Ameli hybride Chantier C : radius < 3 km → note NUANCÉE (branche précise ~77 % fiable, pas la note générique)", () => {
    const md = ameliRadiusMetadata(2);
    // Pas la note générique CDS — la branche précise (`adresse`) reste
    // fiable même à <3km depuis le géocodage BAN.
    expect(hasSubCommuneNote(md.notes)).toBe(false);
    // Mais bien la note dédiée mixte Ameli.
    expect(hasAmeliMixteSubCommuneNote(md.notes)).toBe(true);
  });

  it("RPPS hybride V0.12.0 : radius < 3 km → note NUANCÉE (branche précise fiable, pas la note Ameli)", () => {
    const md = rppsRadiusMetadata(2);
    // Pas la note générique Ameli — la branche `precise` reste fiable même à <3km.
    expect(hasSubCommuneNote(md.notes)).toBe(false);
    // Mais bien la note dédiée mixte qui pointe `precise_only`.
    expect(hasRppsMixteSubCommuneNote(md.notes)).toBe(true);
  });

  it("radius >= 3 km → pas d'avertissement (Ameli ni RPPS)", () => {
    expect(hasAmeliMixteSubCommuneNote(ameliRadiusMetadata(5).notes)).toBe(false);
    expect(hasSubCommuneNote(rppsRadiusMetadata(10).notes)).toBe(false);
    expect(hasRppsMixteSubCommuneNote(rppsRadiusMetadata(10).notes)).toBe(false);
  });

  it("borne exacte : radius == 3 km → pas d'avertissement (seuil strict <)", () => {
    expect(
      hasAmeliMixteSubCommuneNote(ameliRadiusMetadata(CENTROIDE_COMMUNE_RESOLUTION_KM).notes),
    ).toBe(false);
    expect(
      hasRppsMixteSubCommuneNote(rppsRadiusMetadata(CENTROIDE_COMMUNE_RESOLUTION_KM).notes),
    ).toBe(false);
  });

  it("radius non fourni (undefined) → pas d'avertissement (rétrocompat)", () => {
    expect(hasAmeliMixteSubCommuneNote(ameliRadiusMetadata().notes)).toBe(false);
    expect(hasRppsMixteSubCommuneNote(rppsRadiusMetadata().notes)).toBe(false);
  });

  it("FINESS (coords Lambert93 natives, pas centroïde) jamais averti même radius minuscule", () => {
    // finessRadiusMetadata n'accepte pas radiusKm : la précision adresse ne
    // souffre pas du piège centroïde. Aucune note sous-commune possible.
    expect(hasSubCommuneNote(finessRadiusMetadata().notes)).toBe(false);
  });
});

describe("refineRppsGeoPrecisionLabel — Fix #4 V0.13.0 (factory pure)", () => {
  it("100% rows précis (adresse + etablissement_finess) → étiquette 'precis_uniquement'", () => {
    const meta = rppsRadiusMetadata(5);
    const refined = refineRppsGeoPrecisionLabel(
      [
        { geo_precision: "adresse" },
        { geo_precision: "etablissement_finess" },
        { geo_precision: "adresse" },
      ],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ans_precis_uniquement");
    expect(refined.notes[0]).toContain("TOUS les résultats");
    expect(refined.notes[0]).toContain("précision exacte");
    // Factory pure : l'input n'est PAS muté.
    expect(meta.geo_precision).toBe("centroide_commune_ans_mixte");
  });

  it("100% rows centroïde → étiquette 'centroide_uniquement'", () => {
    const meta = rppsRadiusMetadata(5);
    const refined = refineRppsGeoPrecisionLabel(
      [{ geo_precision: "centroide_commune" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ans_centroide_uniquement");
    expect(refined.notes[0]).toContain("centroïde commune");
    expect(refined.notes[0]).toContain("PAS discriminante");
  });

  it("mixte (précis + centroïde) → retourne baseMeta inchangé (même référence)", () => {
    const meta = rppsRadiusMetadata(5);
    const refined = refineRppsGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(refined).toBe(meta); // factory pure : pas de raffinage = même ref
    expect(refined.geo_precision).toBe("centroide_commune_ans_mixte");
  });

  it("rows vides → retourne baseMeta inchangé (pas de raffinage sur échantillon vide)", () => {
    const meta = rppsRadiusMetadata(5);
    const refined = refineRppsGeoPrecisionLabel([], meta);
    expect(refined).toBe(meta);
  });

  it("row sans geo_precision typé → retourne baseMeta inchangé (garde-fou anti-régression RPC)", () => {
    // Si un row n'a pas de `geo_precision` (régression RPC, ancien dump, mock test),
    // on garde l'étiquette mixte par sécurité — affirmer "100% précis" sur un
    // échantillon partiellement typé serait trompeur.
    const meta = rppsRadiusMetadata(5);
    const refined = refineRppsGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: undefined }],
      meta,
    );
    expect(refined).toBe(meta);
    expect(refined.geo_precision).toBe("centroide_commune_ans_mixte");
  });

  it("row sans geo_precision → console.warn LOUD émis (Fix P1 silent-failure-hunter)", () => {
    // Garde-fou /review Passe 2 silent-failure-hunter : sans ce test, un dev
    // qui retire le `console.warn` (perçu comme bruit) reste vert et le signal
    // d'audit prod (drift RPC suspectée) disparaît silencieusement.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const meta = rppsRadiusMetadata(5);
    refineRppsGeoPrecisionLabel([{ geo_precision: "adresse" }, { geo_precision: undefined }], meta);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("drift RPC suspectée"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    warnSpy.mockRestore();
  });

  it("radius<3 + 100% rows centroïde → note 'La branche précise' filtrée (Fix P1 anti-mensonge)", () => {
    // Garde-fou /review Passe 2 silent-failure-hunter : la note shortRadiusMixed
    // injectée par `rppsRadiusMetadata` quand radius<3 dit "la branche précise
    // (~68,5 %) reste fiable, passer precise_only: true". Après refine vers
    // `_centroide_uniquement`, cette note est MENSONGÈRE (0 % précis). Le fix
    // la filtre via la signature `"La branche précise"`. Ce test verrouille
    // l'invariant bidirectionnel :
    //   1. La note shortRadiusMixed CONTIENT bien "La branche précise" côté
    //      `rppsRadiusMetadata` (sinon le filtre est no-op silent).
    //   2. Le filtre la RETIRE bien après refine vers `_centroide_uniquement`.
    // Si quelqu'un reformule la note dans `rppsRadiusMetadata` sans mettre à
    // jour le filtre, ce test pète.
    const meta = rppsRadiusMetadata(2); // short-radius → note shortRadiusMixed injectée
    expect(meta.notes.some((n) => n.includes("La branche précise"))).toBe(true);
    const refined = refineRppsGeoPrecisionLabel(
      [{ geo_precision: "centroide_commune" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ans_centroide_uniquement");
    // La note mensongère DOIT être filtrée.
    expect(refined.notes.some((n) => n.includes("La branche précise"))).toBe(false);
    // Mais l'input n'est pas muté (factory pure).
    expect(meta.notes.some((n) => n.includes("La branche précise"))).toBe(true);
  });

  it("radius<3 + 100% rows précis → note 'La branche précise' PRÉSERVÉE (le précis-only ne ment pas)", () => {
    // Symétrique au test précédent : quand on refine vers `_precis_uniquement`,
    // la note shortRadiusMixed n'est PAS mensongère (elle parle de la branche
    // précise qui est précisément celle qui a tout fourni). Doit être préservée.
    const meta = rppsRadiusMetadata(2);
    const refined = refineRppsGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: "etablissement_finess" }],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ans_precis_uniquement");
    expect(refined.notes.some((n) => n.includes("La branche précise"))).toBe(true);
  });

  it("ne touche PAS une étiquette initiale non-mixte-RPPS (helper RPPS-only)", () => {
    // Ameli/FINESS/CDS ont leurs propres étiquettes — pas de raffinage croisé.
    // L'étiquette Ameli a sa propre mixte (`centroide_commune_ameli_mixte`
    // depuis Chantier C 2026-05-21), gardée par `refineAmeliGeoPrecisionLabel`
    // (jumeau dédié) ; `refineRppsGeoPrecisionLabel` ne doit JAMAIS la toucher.
    const ameliMeta = ameliRadiusMetadata(5);
    const refined = refineRppsGeoPrecisionLabel([{ geo_precision: "adresse" }], ameliMeta);
    expect(refined).toBe(ameliMeta);
    expect(refined.geo_precision).toBe("centroide_commune_ameli_mixte");
  });

  it("préserve les notes additionnelles (Haversine, short-radius) au-delà de notes[0]", () => {
    // Garde-fou /simplify quality P2 : le contrat invariant est `notes[0] = SOURCE_NOTE[X]`,
    // les notes additionnelles (haversine, short-radius warning) en queue
    // doivent être préservées par le raffinage. Sans `notes.slice(1)`, on
    // perdrait les notes append par `buildMetadata` / `rppsRadiusMetadata`.
    const meta = rppsRadiusMetadata(2); // short-radius → 2 notes (source + nuancée)
    expect(meta.notes.length).toBeGreaterThanOrEqual(2);
    const initialTrailingNote = meta.notes[1];
    const refined = refineRppsGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: "adresse" }],
      meta,
    );
    expect(refined.notes.length).toBe(meta.notes.length);
    expect(refined.notes[0]).not.toBe(meta.notes[0]); // SOURCE_NOTE remplacée
    expect(refined.notes[1]).toBe(initialTrailingNote); // queue préservée
  });

  it("invariant `notes[0]` du contrat avec buildMetadata (SOURCE_NOTE en tête)", () => {
    // Garde-fou /simplify quality P2 : `refineRppsGeoPrecisionLabel` repose sur
    // `notes[0] === SOURCE_NOTE[geo_precision_initial]`. Ce test verrouille
    // l'invariant pour que toute évolution de `buildMetadata` qui insérerait
    // une autre note prioritaire en tête CASSE explicitement plutôt que de
    // pourrir silencieusement le raffinage.
    const meta = rppsRadiusMetadata(5);
    // L'étiquette initiale est "centroide_commune_ans_mixte" ; sa SOURCE_NOTE
    // doit être en notes[0]. Vérifié indirectement par le contenu attendu.
    expect(meta.notes[0]).toContain("HYBRIDES");
    expect(meta.notes[0]).toContain("MIXTE par résultat");
  });
});

describe("refineAmeliGeoPrecisionLabel — Chantier C 2026-05-21 (factory pure, jumeau RPPS)", () => {
  it("100% rows adresse → étiquette 'centroide_commune_ameli_precis_uniquement'", () => {
    const meta = ameliRadiusMetadata(5);
    const refined = refineAmeliGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: "adresse" }, { geo_precision: "adresse" }],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ameli_precis_uniquement");
    expect(refined.notes[0]).toContain("ban_address");
  });

  it("100% rows centroide_commune → étiquette 'centroide_commune_ameli_centroide_uniquement'", () => {
    const meta = ameliRadiusMetadata(5);
    const refined = refineAmeliGeoPrecisionLabel(
      [{ geo_precision: "centroide_commune" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ameli_centroide_uniquement");
  });

  it("distribution mixte → étiquette mixte initiale conservée", () => {
    const meta = ameliRadiusMetadata(5);
    const refined = refineAmeliGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(refined).toBe(meta);
    expect(refined.geo_precision).toBe("centroide_commune_ameli_mixte");
  });

  it("0 rows → étiquette mixte initiale conservée (rétrocompat)", () => {
    const meta = ameliRadiusMetadata(5);
    const refined = refineAmeliGeoPrecisionLabel([], meta);
    expect(refined).toBe(meta);
  });

  it("row sans geo_precision typé → warn + étiquette mixte préservée (drift RPC suspectée)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const meta = ameliRadiusMetadata(5);
    const refined = refineAmeliGeoPrecisionLabel(
      [{ geo_precision: "adresse" }, { geo_precision: undefined }],
      meta,
    );
    expect(refined).toBe(meta);
    const matching = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("refineAmeliGeoPrecisionLabel"),
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it("radius<3 + 100% centroïde → note 'branche précise' filtrée (parité fix RPPS sfh)", () => {
    const meta = ameliRadiusMetadata(2); // short-radius → note nuancée Ameli injectée
    expect(meta.notes.some((n) => n.includes("La branche précise"))).toBe(true);
    const refined = refineAmeliGeoPrecisionLabel(
      [{ geo_precision: "centroide_commune" }, { geo_precision: "centroide_commune" }],
      meta,
    );
    expect(refined.geo_precision).toBe("centroide_commune_ameli_centroide_uniquement");
    // La note mensongère DOIT être filtrée.
    expect(refined.notes.some((n) => n.includes("La branche précise"))).toBe(false);
    // Mais l'input n'est pas muté (factory pure).
    expect(meta.notes.some((n) => n.includes("La branche précise"))).toBe(true);
  });

  it("ne touche PAS une étiquette initiale non-mixte-Ameli (helper Ameli-only)", () => {
    // Si le caller passe une étiquette RPPS mixte, le helper Ameli return tel
    // quel (jumeau symétrique de refineRppsGeoPrecisionLabel).
    const rppsMeta = rppsRadiusMetadata(5);
    const refined = refineAmeliGeoPrecisionLabel([{ geo_precision: "adresse" }], rppsMeta);
    expect(refined).toBe(rppsMeta);
    expect(refined.geo_precision).toBe("centroide_commune_ans_mixte");
  });

  it("ameliDeptMetadata = étiquette mixte initiale (raffinage post-RPC dans ameli-db.ts)", () => {
    const md = ameliDeptMetadata();
    expect(md.geo_precision).toBe("centroide_commune_ameli_mixte");
  });
});
