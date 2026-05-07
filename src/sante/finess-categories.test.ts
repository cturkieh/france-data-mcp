import { describe, expect, it } from "vitest";
import { finessFamille } from "./finess-categories";

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
    expect(finessFamille("")).toBe("autre");
  });
});
