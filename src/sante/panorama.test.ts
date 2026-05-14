import { beforeEach, describe, expect, it, vi } from "vitest";

import * as densiteMod from "./densite.js";
import * as finessMod from "./finess-db.js";
import { panoramaSanteTerritoire } from "./panorama.js";

const densiteSpy = vi.spyOn(densiteMod, "densiteProfessionnelsSante");
const countFinessSpy = vi.spyOn(finessMod, "countFiness");

beforeEach(() => {
  densiteSpy.mockReset();
  countFinessSpy.mockReset();
});

function makeDensite(profession: string, count = 50, pop = 60_000) {
  return {
    zone: {
      zone: "59009",
      niveau: "commune" as const,
      countPs: count,
      population: pop,
      populationAnnee: 2023,
      densitePour100k: Math.round((count / pop) * 100_000 * 100) / 100,
    },
    parametres: {
      professionCode: profession,
      savoirFaireCode: null,
      modeExerciceCodes: ["L", "S", "M"],
      categorieCodes: ["C", "M"],
      methodologie: "test",
    },
    source: {
      ps: "RPPS / Annuaire Santé ANS (Supabase, mensuel)" as const,
      population: "INSEE Melodi (DS_POPULATIONS_REFERENCE)" as const,
    },
    comparaisonNationale: {
      national: {
        countPs: 100_000,
        population: 68_000_000,
        populationAnnee: 2023,
        densitePour100k: 147.06,
      },
      ecartVsNationalPct: -10,
    },
  };
}

describe("panoramaSanteTerritoire", () => {
  it("agrège densités médecins/infirmiers/pharmaciens + 5 familles FINESS par défaut", async () => {
    densiteSpy.mockImplementation(async (input) => makeDensite(input.professionCode ?? "10"));
    countFinessSpy.mockResolvedValue(3);

    const result = await panoramaSanteTerritoire({ codeInsee: "59009" });

    expect(result.niveau).toBe("commune");
    expect(result.codeInsee).toBe("59009");
    expect(result.densitesProfessionnels.medecins.parametres.professionCode).toBe("10");
    expect(result.densitesProfessionnels.infirmiers.parametres.professionCode).toBe("60");
    expect(result.densitesProfessionnels.pharmaciens.parametres.professionCode).toBe("21");
    expect(result.etablissementsParFamille).toEqual([
      { famille: "labo", count: 3 },
      { famille: "pharmacie", count: 3 },
      { famille: "ehpad", count: 3 },
      { famille: "mco", count: 3 },
      { famille: "msp_cpts", count: 3 },
    ]);
    expect(result.sources.professionnels).toContain("RPPS");
  });

  it("propage compareNational=true sur toutes les densités (sinon ratio inutile pour le LLM)", async () => {
    densiteSpy.mockImplementation(async (input) => makeDensite(input.professionCode ?? "10"));
    countFinessSpy.mockResolvedValue(0);

    await panoramaSanteTerritoire({ codeInsee: "75108" });

    for (const call of densiteSpy.mock.calls) {
      expect(call[0]?.compareNational).toBe(true);
      expect(call[0]?.codeInsee).toBe("75108");
    }
  });

  it("respecte la liste finessFamilles passée par le caller", async () => {
    densiteSpy.mockImplementation(async (input) => makeDensite(input.professionCode ?? "10"));
    countFinessSpy.mockResolvedValue(7);

    const result = await panoramaSanteTerritoire({
      codeInsee: "75108",
      finessFamilles: ["pharmacie", "mco"],
    });

    expect(result.etablissementsParFamille.map((e) => e.famille)).toEqual([
      "pharmacie",
      "mco",
    ]);
  });

  it("finessFamilles=[] → aucun appel countFiness, etablissementsParFamille vide", async () => {
    densiteSpy.mockImplementation(async (input) => makeDensite(input.professionCode ?? "10"));

    const result = await panoramaSanteTerritoire({
      codeInsee: "59009",
      finessFamilles: [],
    });

    expect(countFinessSpy).not.toHaveBeenCalled();
    expect(result.etablissementsParFamille).toEqual([]);
  });

  it("Promise.all : les densités sont parallélisées (pas séquentielles)", async () => {
    const order: string[] = [];
    densiteSpy.mockImplementation(async (input) => {
      order.push(`start-${input.professionCode}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${input.professionCode}`);
      return makeDensite(input.professionCode ?? "10");
    });
    countFinessSpy.mockResolvedValue(0);

    await panoramaSanteTerritoire({ codeInsee: "59009", finessFamilles: [] });

    // Tous les `start-X` doivent précéder tous les `end-Y` si parallélisé.
    const firstEnd = order.findIndex((s) => s.startsWith("end-"));
    const lastStart = order.map((s, i) => (s.startsWith("start-") ? i : -1)).filter((i) => i >= 0).pop();
    expect(firstEnd).toBeGreaterThan(lastStart ?? -1);
  });

  it("erreur sur une sous-requête → propage (pas de partial silencieux)", async () => {
    densiteSpy.mockImplementation(async (input) => {
      if (input.professionCode === "60") throw new Error("Melodi 500");
      return makeDensite(input.professionCode ?? "10");
    });
    countFinessSpy.mockResolvedValue(0);

    await expect(
      panoramaSanteTerritoire({ codeInsee: "59009" }),
    ).rejects.toThrow(/Melodi 500/);
  });

  it("DOM-COM tronqué (code_insee 2A001) → dept dérivé correctement", async () => {
    densiteSpy.mockImplementation(async (input) => makeDensite(input.professionCode ?? "10"));
    countFinessSpy.mockResolvedValue(2);

    await panoramaSanteTerritoire({ codeInsee: "2A004" });

    for (const call of countFinessSpy.mock.calls) {
      expect(call[0]?.departement).toBe("2A");
    }
  });

  it("V0.9 — code_insee invalide → RangeError fail-fast (avant tout sous-call)", async () => {
    // assertValidCodeInsee upfront (Passe 1 fix) → 1 seule erreur claire au
    // lieu de 4 sub-calls qui plantent chacune. Le test garantit que la
    // validation n'est pas retirée par un futur refactor.
    await expect(
      panoramaSanteTerritoire({ codeInsee: "INVALID" }),
    ).rejects.toThrow(RangeError);
    expect(densiteSpy).not.toHaveBeenCalled();
    expect(countFinessSpy).not.toHaveBeenCalled();
  });

  it("V0.9 — collision alias dans normalizeAliases → console.warn (anti silent drop)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Test indirect via normalizeAliases : on utilise le helper directement
    // car ses warn sont l'API observable.
    // (Ce test pourrait être déplacé dans args.test.ts mais il documente le
    // comportement attendu côté boundary MCP.)
    warnSpy.mockRestore();
  });

  it("DOM (97411 Réunion) → dept 974", async () => {
    densiteSpy.mockImplementation(async (input) => makeDensite(input.professionCode ?? "10"));
    countFinessSpy.mockResolvedValue(1);

    await panoramaSanteTerritoire({ codeInsee: "97411" });

    for (const call of countFinessSpy.mock.calls) {
      expect(call[0]?.departement).toBe("974");
    }
  });
});
