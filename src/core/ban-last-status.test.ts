import { describe, expect, it } from "vitest";
import { banLastStatus } from "./ban-last-status.js";

// Référence : la valeur EXACTE produite par les deux ternaires inline
// d'origine (scripts/ingest/rpps.ts runBanGeocodeStep + scripts/ban-backfill.mjs,
// byte-identiques). Toute divergence ici = régression silencieuse du cache.
function inlineTernary(accepted: boolean, isUnresolved: boolean): string {
  return accepted ? "accepted" : isUnresolved ? "unresolved" : "rejected_low_score";
}

describe("banLastStatus — table de vérité complète", () => {
  const cases: Array<{ accepted: boolean; isUnresolved: boolean; expected: string }> = [
    // accepted gagne toujours, quel que soit isUnresolved
    { accepted: true, isUnresolved: false, expected: "accepted" },
    { accepted: true, isUnresolved: true, expected: "accepted" },
    // non accepté + non résolu → unresolved
    { accepted: false, isUnresolved: true, expected: "unresolved" },
    // non accepté + résolu (score < seuil OU rupture de contrat downgradée :
    // accepted=false, isUnresolved=false car resultScore non-null) →
    // rejected_low_score (S-3 mappe ici, identique aux deux sites)
    { accepted: false, isUnresolved: false, expected: "rejected_low_score" },
  ];

  for (const { accepted, isUnresolved, expected } of cases) {
    it(`accepted=${accepted}, isUnresolved=${isUnresolved} → "${expected}"`, () => {
      expect(banLastStatus(accepted, isUnresolved)).toBe(expected);
      // Parité octet-à-octet avec le ternaire inline d'origine
      expect(banLastStatus(accepted, isUnresolved)).toBe(inlineTernary(accepted, isUnresolved));
    });
  }

  it("couvre les 4 combinaisons booléennes exhaustivement", () => {
    for (const accepted of [true, false]) {
      for (const isUnresolved of [true, false]) {
        expect(banLastStatus(accepted, isUnresolved)).toBe(inlineTernary(accepted, isUnresolved));
      }
    }
  });

  it("le cas rupture de contrat R4/S-3 (accepted downgradé→false, resultScore non-null ⇒ isUnresolved=false) mappe sur rejected_low_score", () => {
    expect(banLastStatus(false, false)).toBe("rejected_low_score");
  });
});
