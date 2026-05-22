import { describe, expect, it } from "vitest";
import { AMELI_PERIMETRE, RPPS_PERIMETRE, finessFamillePerimetre } from "./perimetre";

describe("finessFamillePerimetre", () => {
  it("sans famille → lentille catégorie dominante, périmètre 'tous'", () => {
    const p = finessFamillePerimetre(undefined);
    expect(p.source).toMatch(/FINESS/);
    expect(p.lens).toBe("categorie_dominante");
    expect(p.compte).toMatch(/tous/i);
    expect(p.completeness_note.length).toBeGreaterThan(0);
  });

  it("famille labo → rider sur les plateaux hospitaliers", () => {
    const p = finessFamillePerimetre(["labo"]);
    expect(p.compte).toContain("labo");
    expect(p.completeness_note).toMatch(/hospitali/i);
  });

  it("famille imagerie → rider sur l'absence de cabinets en FINESS", () => {
    const p = finessFamillePerimetre(["imagerie"]);
    expect(p.completeness_note).toMatch(/imagerie/i);
  });

  it("plusieurs familles → riders cumulés", () => {
    const p = finessFamillePerimetre(["labo", "pharmacie"]);
    expect(p.completeness_note).toMatch(/hospitali/i);
    expect(p.completeness_note).toMatch(/PUI|usage intérieur/i);
  });

  it("famille sans rider (ex. ehpad) → note de base seule, pas de crash", () => {
    const p = finessFamillePerimetre(["ehpad"]);
    expect(p.completeness_note.length).toBeGreaterThan(0);
  });
});

describe("descripteurs statiques", () => {
  it("AMELI_PERIMETRE déclare l'exclusion des salariés", () => {
    expect(AMELI_PERIMETRE.lens).toBe("liberal_conventionne");
    expect(AMELI_PERIMETRE.exclut).toMatch(/salari/i);
    expect(AMELI_PERIMETRE.completeness_note).toMatch(/RPPS/);
  });

  it("RPPS_PERIMETRE se déclare comme registre complet", () => {
    expect(RPPS_PERIMETRE.lens).toBe("registre_complet");
  });
});
