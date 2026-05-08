import { describe, expect, it } from "vitest";
import {
  DELIBERATELY_AUTRE,
  FINESS_CATEGORIES,
  FINESS_FAMILY_CODES,
  finessFamille,
} from "./finess-categories";

describe("finessFamille", () => {
  it("maps acute-care MCO codes to 'mco'", () => {
    expect(finessFamille("101")).toBe("mco"); // CHR
    expect(finessFamille("106")).toBe("mco"); // CH
    expect(finessFamille("108")).toBe("mco"); // CHU
    expect(finessFamille("131")).toBe("mco"); // CLCC (real code, was 365 in v0.2.0 mistake)
    expect(finessFamille("355")).toBe("mco"); // CH
    expect(finessFamille("365")).toBe("mco"); // Etab Soins Pluridisciplinaire
  });

  it("maps SSR codes to 'ssr'", () => {
    expect(finessFamille("109")).toBe("ssr");
  });

  it("maps EHPAD codes to 'ehpad'", () => {
    expect(finessFamille("500")).toBe("ehpad");
    expect(finessFamille("501")).toBe("ehpad");
    expect(finessFamille("502")).toBe("ehpad");
  });

  it("maps psychiatry codes to 'psychiatrie' (split out of mco in v0.2.1)", () => {
    expect(finessFamille("292")).toBe("psychiatrie"); // CHS
    expect(finessFamille("362")).toBe("psychiatrie"); // CH spé psychiatrie
    expect(finessFamille("156")).toBe("psychiatrie"); // CMP
  });

  it("maps SSIAD (354) to 'ssiad' — NOT 'mco'", () => {
    // Audit B2 bis caught this: code 354 is "Service de Soins Infirmiers à
    // Domicile", not "Hôpital privé" as the v0.2.0 nomenclature claimed.
    expect(finessFamille("354")).toBe("ssiad");
  });

  it("maps HAD (127) to its own family", () => {
    expect(finessFamille("127")).toBe("had");
  });

  it("maps handicap_enfants codes correctly", () => {
    expect(finessFamille("182")).toBe("handicap_enfants"); // SESSAD
    expect(finessFamille("183")).toBe("handicap_enfants"); // IME
    expect(finessFamille("186")).toBe("handicap_enfants"); // ITEP
    expect(finessFamille("190")).toBe("handicap_enfants"); // CAMSP
  });

  it("maps addictologie codes correctly", () => {
    expect(finessFamille("197")).toBe("addictologie"); // CSAPA
    expect(finessFamille("178")).toBe("addictologie"); // CAARUD
    expect(finessFamille("180")).toBe("addictologie"); // LHSS
  });

  it("maps ambulatoire/coordination codes correctly", () => {
    expect(finessFamille("124")).toBe("ambulatoire"); // Centre de Santé
    expect(finessFamille("141")).toBe("ambulatoire"); // dialyse
    expect(finessFamille("603")).toBe("msp_cpts"); // MSP
    expect(finessFamille("604")).toBe("msp_cpts"); // CPTS
  });

  it("maps labo / pharmacie / imagerie to dedicated families", () => {
    expect(finessFamille("611")).toBe("labo");
    expect(finessFamille("619")).toBe("imagerie");
    expect(finessFamille("620")).toBe("pharmacie");
  });

  it("maps AEMO/AED (295) to 'autre' — NOT 'mco'", () => {
    // Audit B2 bis: code 295 is "Services AEMO et AED" (child protection),
    // not "Établissement Public de Santé" as v0.2.0 claimed.
    expect(finessFamille("295")).toBe("autre");
  });

  it("returns 'autre' for unknown / non-categorized codes", () => {
    expect(finessFamille("9999")).toBe("autre");
    expect(finessFamille(null)).toBe("autre");
    expect(finessFamille(undefined)).toBe("autre");
  });

  it("returns 'autre' for empty string and pure-whitespace inputs", () => {
    expect(finessFamille("")).toBe("autre");
    expect(finessFamille("   ")).toBe("autre");
    expect(finessFamille("\t")).toBe("autre");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(finessFamille(" 108 ")).toBe("mco");
    expect(finessFamille("\t500\n")).toBe("ehpad");
    expect(finessFamille("109 ")).toBe("ssr");
  });

  it("invariant: every FINESS_CATEGORIES code has an explicit family decision", () => {
    // Adding a code to FINESS_CATEGORIES without classifying it (either via
    // a family Set or via DELIBERATELY_AUTRE) is a silent-failure trap. This
    // test forces the decision to be explicit at code-review time.
    for (const code of Object.keys(FINESS_CATEGORIES)) {
      const fam = finessFamille(code);
      if (fam === "autre") {
        expect(
          DELIBERATELY_AUTRE.has(code),
          `Code "${code}" (${(FINESS_CATEGORIES as Record<string, string>)[code]}) is in FINESS_CATEGORIES but maps to "autre" without being declared in DELIBERATELY_AUTRE. Add it to a family Set or to DELIBERATELY_AUTRE with a comment.`,
        ).toBe(true);
      }
    }
  });

  it("invariant: DELIBERATELY_AUTRE is disjoint from every family Set", () => {
    for (const code of DELIBERATELY_AUTRE) {
      expect(
        finessFamille(code),
        `Code "${code}" is in DELIBERATELY_AUTRE but classifies as a family — remove it from one of the two declarations.`,
      ).toBe("autre");
    }
  });

  it("invariant: SSIAD (354) and AEMO/AED (295) are NOT in mco", () => {
    // Regression guard for audit B2 bis. The v0.2.0 nomenclature placed
    // these social/medico-social codes under mco because the libellés were
    // copy-pasted from a stale source. Re-introducing them silently here
    // would re-break the family classifier.
    expect(FINESS_FAMILY_CODES.mco).not.toContain("354");
    expect(FINESS_FAMILY_CODES.mco).not.toContain("295");
  });
});
