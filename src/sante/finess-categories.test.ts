import { describe, expect, it } from "vitest";
import { DELIBERATELY_AUTRE, FINESS_CATEGORIES, finessFamille } from "./finess-categories";

describe("finessFamille", () => {
  it("maps MCO codes to 'mco'", () => {
    expect(finessFamille("108")).toBe("mco"); // CHU
    expect(finessFamille("355")).toBe("mco"); // CH
    expect(finessFamille("354")).toBe("mco"); // Hôpital privé
    expect(finessFamille("106")).toBe("mco"); // Hôpital local
  });

  it("maps SSR codes to 'ssr'", () => {
    expect(finessFamille("109")).toBe("ssr"); // SSR
  });

  it("maps EHPAD codes to 'ehpad'", () => {
    expect(finessFamille("500")).toBe("ehpad"); // EHPAD
    expect(finessFamille("501")).toBe("ehpad"); // Maison de retraite
    expect(finessFamille("502")).toBe("ehpad"); // Logement-foyer
  });

  it("maps psychiatry codes to 'autre' (V0.2 scope only covers MCO/SSR/EHPAD)", () => {
    expect(finessFamille("292")).toBe("autre"); // CHS
    expect(finessFamille("362")).toBe("autre"); // CH spé psychiatrie
  });

  it("returns 'autre' for unknown / non-categorized codes", () => {
    expect(finessFamille("9999")).toBe("autre");
    expect(finessFamille("611")).toBe("autre"); // Laboratoire
    expect(finessFamille("620")).toBe("autre"); // Pharmacie
    expect(finessFamille(null)).toBe("autre");
    expect(finessFamille(undefined)).toBe("autre");
  });

  it("returns 'autre' for empty string and pure-whitespace inputs", () => {
    // Empty / whitespace-only inputs are upstream-parsing-bug suspects but
    // this classifier silently maps them to "autre" — surfacing them is the
    // ingest layer's job (will land with scripts/ingest/finess.ts).
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
    // A code cannot simultaneously be classified into a family AND declared
    // as deliberately unclassified. Catches accidental double-listing.
    for (const code of DELIBERATELY_AUTRE) {
      expect(
        finessFamille(code),
        `Code "${code}" is in DELIBERATELY_AUTRE but classifies as a family — remove it from one of the two declarations.`,
      ).toBe("autre");
    }
  });
});
