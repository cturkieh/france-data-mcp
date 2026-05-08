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
    expect(finessFamille("292")).toBe("psychiatrie"); // CHS lutte maladies mentales
    expect(finessFamille("156")).toBe("psychiatrie"); // CMP
    expect(finessFamille("161")).toBe("psychiatrie"); // Maison Santé Maladies Mentales
    expect(finessFamille("425")).toBe("psychiatrie"); // CATTP
    expect(finessFamille("430")).toBe("psychiatrie"); // Postcure malades mentaux
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

  it("maps ambulatoire / dialyse / pluri-pro codes correctly", () => {
    expect(finessFamille("124")).toBe("ambulatoire"); // Centre de Santé
    expect(finessFamille("141")).toBe("dialyse"); // own family in v0.3.x — Centre de dialyse
    expect(finessFamille("146")).toBe("dialyse"); // alternative à la dialyse
    expect(finessFamille("603")).toBe("msp_cpts"); // MSP
    expect(finessFamille("604")).toBe("msp_cpts"); // CPTS
  });

  it("maps SLD / HAD to dedicated families", () => {
    expect(finessFamille("362")).toBe("sld"); // USLD — corrected (was wrongly "psychiatrie" in old v0.2.1)
    expect(finessFamille("127")).toBe("had");
  });

  it("maps handicap_adultes (MAS, FAM, ESAT, SAVS, SAMSAH…)", () => {
    expect(finessFamille("255")).toBe("handicap_adultes"); // MAS
    expect(finessFamille("437")).toBe("handicap_adultes"); // FAM
    expect(finessFamille("246")).toBe("handicap_adultes"); // ESAT
    expect(finessFamille("445")).toBe("handicap_adultes"); // SAMSAH
    expect(finessFamille("446")).toBe("handicap_adultes"); // SAVS
    expect(finessFamille("382")).toBe("handicap_adultes"); // Foyer de vie
    expect(finessFamille("600")).toBe("handicap_adultes"); // Foyer hébergement
  });

  it("maps aide_domicile (SAAD, SPASAD, oxygène)", () => {
    expect(finessFamille("460")).toBe("aide_domicile"); // SAAD
    expect(finessFamille("209")).toBe("aide_domicile"); // SPASAD
    expect(finessFamille("632")).toBe("aide_domicile"); // O2 à domicile
  });

  it("maps PMI / petite enfance", () => {
    expect(finessFamille("223")).toBe("pmi");
    expect(finessFamille("228")).toBe("pmi");
    expect(finessFamille("230")).toBe("pmi");
    expect(finessFamille("268")).toBe("pmi"); // CMS médico-scolaire
  });

  it("maps enfance_protection (MECS, AEMO/AED, foyer enfance…)", () => {
    expect(finessFamille("177")).toBe("enfance_protection"); // MECS
    expect(finessFamille("175")).toBe("enfance_protection"); // Foyer de l'enfance
    expect(finessFamille("295")).toBe("enfance_protection"); // AEMO/AED — moved out of `autre` in v0.3.x
    expect(finessFamille("441")).toBe("enfance_protection"); // CAE
  });

  it("maps hebergement_social (CHRS, FJT, maisons relais, CADA)", () => {
    expect(finessFamille("214")).toBe("hebergement_social"); // CHRS
    expect(finessFamille("257")).toBe("hebergement_social"); // FJT
    expect(finessFamille("258")).toBe("hebergement_social"); // Maisons relais
    expect(finessFamille("443")).toBe("hebergement_social"); // CADA
  });

  it("maps prevention_sante (transfusion, dispensaires, CES)", () => {
    expect(finessFamille("132")).toBe("prevention_sante"); // Transfusion sanguine
    expect(finessFamille("142")).toBe("prevention_sante"); // Dispensaire AT
    expect(finessFamille("347")).toBe("prevention_sante"); // CES
  });

  it("maps groupements (GCS, GCSMS)", () => {
    expect(finessFamille("696")).toBe("groupement");
    expect(finessFamille("697")).toBe("groupement");
    expect(finessFamille("698")).toBe("groupement");
  });

  it("maps senior_accompagnement / residence_autonomie", () => {
    expect(finessFamille("202")).toBe("residence_autonomie");
    expect(finessFamille("207")).toBe("senior_accompagnement"); // Centre jour PA
    expect(finessFamille("463")).toBe("senior_accompagnement"); // CLIC
  });

  it("maps pharmacie famille incl. propharmacies", () => {
    expect(finessFamille("620")).toBe("pharmacie"); // Officine
    expect(finessFamille("627")).toBe("pharmacie"); // Propharmacie
  });

  it("maps labo / pharmacie / imagerie to dedicated families", () => {
    expect(finessFamille("611")).toBe("labo");
    expect(finessFamille("619")).toBe("imagerie");
    expect(finessFamille("620")).toBe("pharmacie");
  });

  it("maps AEMO/AED (295) to enfance_protection — NOT 'mco' (audit fix)", () => {
    // Audit B2 bis: code 295 is "Services AEMO et AED" (child protection),
    // not "Établissement Public de Santé" as v0.2.0 claimed. v0.3.x moved
    // it from `autre` (intermediate fix) to its rightful family.
    expect(finessFamille("295")).toBe("enfance_protection");
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
