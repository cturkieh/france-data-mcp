import { describe, expect, it } from "vitest";
import {
  AMELI_SPECIALITES_FREQUENTES,
  AMELI_TYPE_PS_NOMENCLATURE,
  AMELI_TYPE_PS_QUERYABLE,
  clarifySecteurLibelle,
  clarifyTypePsLibelle,
} from "./ameli-nomenclature.js";

describe("AMELI_TYPE_PS_QUERYABLE", () => {
  it("contient uniquement les codes effectivement présents en base", () => {
    expect(AMELI_TYPE_PS_QUERYABLE).toEqual(expect.arrayContaining(["1", "2", "5"]));
    expect(AMELI_TYPE_PS_QUERYABLE).not.toContain("3"); // labos filtrés
    expect(AMELI_TYPE_PS_QUERYABLE).not.toContain("4"); // non-conventionnés filtrés
    expect(AMELI_TYPE_PS_QUERYABLE).toHaveLength(3);
  });
});

describe("clarifyTypePsLibelle", () => {
  it("clarifie le code 2 quand la source matche la référence Ameli", () => {
    const ref = AMELI_TYPE_PS_NOMENCLATURE["2"]?.libelleSource ?? "";
    expect(clarifyTypePsLibelle("2", ref)).toContain("Auxiliaires médicaux");
  });

  it("garde la source quand elle ne matche pas la référence (drift detection)", () => {
    expect(clarifyTypePsLibelle("2", "LIBELLE QUI A CHANGE")).toBe("LIBELLE QUI A CHANGE");
  });

  it("retourne le source pour les codes connus non-ambigus", () => {
    const ref1 = AMELI_TYPE_PS_NOMENCLATURE["1"]?.libelleSource ?? "";
    expect(clarifyTypePsLibelle("1", ref1)).toBe("Médecins généralistes et spécialistes");
  });

  it("retourne null/source quand le code est inconnu", () => {
    expect(clarifyTypePsLibelle("99", "Something")).toBe("Something");
    expect(clarifyTypePsLibelle("99", null)).toBeNull();
    expect(clarifyTypePsLibelle(null, "x")).toBe("x");
    expect(clarifyTypePsLibelle(null, null)).toBeNull();
  });
});

describe("clarifySecteurLibelle (A8)", () => {
  it("code 3 + libellé CNAM 'Secteur 2' → clarifié S2+DP (cas trompeur de l'audit)", () => {
    expect(clarifySecteurLibelle("3", "Secteur 2")).toBe(
      "Secteur 2 + droit permanent à dépassement (S2+DP)",
    );
  });

  it("codes 1 et 2 inchangés (déjà exacts côté CNAM)", () => {
    expect(clarifySecteurLibelle("1", "Secteur 1")).toBe("Secteur 1");
    expect(clarifySecteurLibelle("2", "Secteur 2")).toBe("Secteur 2");
  });

  it("drift CNAM (libellé source ≠ référence) → garde la source, n'invente pas", () => {
    expect(clarifySecteurLibelle("3", "Conventionné S2 DP")).toBe("Conventionné S2 DP");
  });

  it("code inconnu / null → source inchangée", () => {
    expect(clarifySecteurLibelle("9", "Non conventionné")).toBe("Non conventionné");
    expect(clarifySecteurLibelle(null, "x")).toBe("x");
    expect(clarifySecteurLibelle("3", null)).toBe(
      "Secteur 2 + droit permanent à dépassement (S2+DP)",
    );
    expect(clarifySecteurLibelle(null, null)).toBeNull();
  });
});

describe("AMELI_SPECIALITES_FREQUENTES", () => {
  it("référence des codes spécialité avec leur type_ps de rattachement", () => {
    const ide = AMELI_SPECIALITES_FREQUENTES.find((s) => s.code === "24");
    expect(ide?.libelle).toBe("Infirmier");
    expect(ide?.typePs).toBe("2");

    const dentiste = AMELI_SPECIALITES_FREQUENTES.find((s) => s.code === "19");
    expect(dentiste?.typePs).toBe("5");
  });

  it("tous les typePs référencés sont queryables (présents en base)", () => {
    for (const spec of AMELI_SPECIALITES_FREQUENTES) {
      expect(AMELI_TYPE_PS_QUERYABLE).toContain(spec.typePs);
    }
  });
});
