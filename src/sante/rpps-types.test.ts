import { describe, expect, it } from "vitest";

import { RPPS_SAVOIR_FAIRE } from "./rpps-types.js";

/**
 * Garde-fou anti-drift sur les codes savoir_faire ANS canoniques.
 *
 * Mapping vérifié sur le dump prod le 2026-05-15 via le tool MCP
 * `lister_specialites_medicales` (profession_code='10') :
 *   - SM02 = "Anesthesie-réanimation"            (23 586 PS)
 *   - SM04 = "Cardiologie et maladies vasculaires" (18 002 PS)
 *   - SM15 = "Dermatologie et vénéréologie"        (7 594 PS)
 *   - SM26 = "Qualifié en Médecine Générale"      (61 273 PS) — PAS la dermato
 *
 * Bug historique B4 : SM26 était libellé "Dermato-vénéréologie" → un caller
 * demandant la densité de dermatologues récupérait l'effectif médecine
 * générale (8x trop), silencieusement.
 */
describe("RPPS_SAVOIR_FAIRE — codes ANS vérifiés sur dump prod", () => {
  it("SM02 = Anesthésie-réanimation", () => {
    expect(RPPS_SAVOIR_FAIRE.ANESTHESIE_REANIMATION).toBe("SM02");
  });

  it("SM04 = Cardiologie", () => {
    expect(RPPS_SAVOIR_FAIRE.CARDIOLOGIE).toBe("SM04");
  });

  it("SM15 = Dermatologie et vénéréologie (PAS SM26)", () => {
    expect(RPPS_SAVOIR_FAIRE.DERMATO_VENEREOLOGIE).toBe("SM15");
  });

  it("SM26 = Médecine générale", () => {
    expect(RPPS_SAVOIR_FAIRE.MEDECINE_GENERALE).toBe("SM26");
  });
});
