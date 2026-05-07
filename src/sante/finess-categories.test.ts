import { describe, expect, it } from "vitest";
import { finessFamille } from "./finess-categories";

describe("finessFamille", () => {
  it("maps MCO codes to 'mco'", () => {
    expect(finessFamille("4101")).toBe("mco"); // Centre Hospitalier
    expect(finessFamille("4150")).toBe("mco"); // Hôpital local
  });

  it("maps EHPAD codes to 'ehpad'", () => {
    expect(finessFamille("500")).toBe("ehpad"); // EHPAD
    expect(finessFamille("502")).toBe("ehpad");
  });

  it("maps SSR codes to 'ssr'", () => {
    expect(finessFamille("4202")).toBe("ssr");
  });

  it("returns 'autre' for unknown / non-categorized codes", () => {
    expect(finessFamille("9999")).toBe("autre");
    expect(finessFamille(null)).toBe("autre");
    expect(finessFamille(undefined)).toBe("autre");
  });
});
