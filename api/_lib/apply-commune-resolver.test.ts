import { afterEach, describe, expect, it, vi } from "vitest";
import type { Commune } from "../../src/territoire/communes.js";
import { applyCommuneResolver } from "./apply-commune-resolver.js";
import * as resolveModule from "./resolve-commune.js";

function fakeCommune(code: string, nom: string, codeDepartement: string): Commune {
  return { code, nom, codesPostaux: [], codeDepartement };
}

afterEach(() => vi.restoreAllMocks());

describe("applyCommuneResolver", () => {
  it("nom_commune seul, résolu → { codeInsee }", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    const result = await applyCommuneResolver({
      nomCommune: "Lille",
      codeInsee: undefined,
      departement: undefined,
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({ codeInsee: "59350" });
  });

  it("nom_commune + departement → dept consommé comme hint, codeInsee retourné seul", async () => {
    const spy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("65392", "Saint-Martin", "65"),
    });
    const result = await applyCommuneResolver({
      nomCommune: "Saint-Martin",
      codeInsee: undefined,
      departement: "65",
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ nom: "Saint-Martin", departement: "65" }),
    );
    // CRITIQUE : dept N'EST PAS réinjecté dans le résultat
    expect(result).toEqual({ codeInsee: "65392" });
  });

  it("nom_commune ambigu → RangeError avec cause structurée ambiguous_commune", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValue({
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: { nom_commune: "Saint-Martin" },
        candidates: [
          { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
        ],
        total_matches: 5,
        truncated: false,
      },
    });
    await expect(
      applyCommuneResolver({
        nomCommune: "Saint-Martin",
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      }),
    ).rejects.toThrow(/ambiguë/i);

    try {
      await applyCommuneResolver({
        nomCommune: "Saint-Martin",
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).cause).toMatchObject({
        kind: "ambiguous_commune",
        total_matches: 5,
      });
    }
  });

  it("nom_commune + code_insee → RangeError redundant_commune_params sans appel resolveNomCommune", async () => {
    const spy = vi.spyOn(resolveModule, "resolveNomCommune");
    await expect(
      applyCommuneResolver({
        nomCommune: "Lille",
        codeInsee: "59350",
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      }),
    ).rejects.toThrow(/redondants/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("nom_commune + code_insee → cause.kind = redundant_commune_params", async () => {
    expect.assertions(2); // M1 fix : garantit que le catch est exécuté (sinon faux-vert)
    try {
      await applyCommuneResolver({
        nomCommune: "Lille",
        codeInsee: "59350",
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).cause).toMatchObject({
        kind: "redundant_commune_params",
        input: { nom_commune: "Lille", code_insee: "59350" },
      });
    }
  });

  it("code_insee + departement (acceptsDepartementAsScope:true) → RangeError redondant XOR", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: "59350",
        departement: "59",
        acceptsDepartementAsScope: true,
        requireScope: false,
      }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("code_insee seul → pass-through { codeInsee }", async () => {
    const result = await applyCommuneResolver({
      nomCommune: undefined,
      codeInsee: "59350",
      departement: undefined,
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({ codeInsee: "59350" });
  });

  it("departement seul + acceptsDepartementAsScope:true → pass-through { departement }", async () => {
    const result = await applyCommuneResolver({
      nomCommune: undefined,
      codeInsee: undefined,
      departement: "59",
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({ departement: "59" });
  });

  it("departement seul + acceptsDepartementAsScope:false → RangeError scope dept non supporté", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: undefined,
        departement: "59",
        acceptsDepartementAsScope: false,
        requireScope: true,
      }),
    ).rejects.toThrow(/département non supporté|calcul commune/i);
  });

  it("rien fourni + requireScope:true → RangeError scope requis", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: false,
        requireScope: true,
      }),
    ).rejects.toThrow(/scope requis|code_insee|nom_commune/i);
  });

  it("rien fourni + requireScope:false → {} (caller libre, FR entière OK)", async () => {
    const result = await applyCommuneResolver({
      nomCommune: undefined,
      codeInsee: undefined,
      departement: undefined,
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({});
  });

  it("commune_not_in_department → RangeError avec cause structurée + matches_in_other_dept", async () => {
    expect.assertions(3); // M1 fix
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: false,
      error: {
        kind: "commune_not_in_department",
        input: { nom_commune: "Lyon", departement: "13" },
        matches_in_other_dept: [
          { code: "69123", nom: "Lyon", codeDepartement: "69", population: 522969 },
        ],
      },
    });
    try {
      await applyCommuneResolver({
        nomCommune: "Lyon",
        codeInsee: undefined,
        departement: "13",
        acceptsDepartementAsScope: true,
        requireScope: false,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).message).toMatch(/introuvable dans le département/i);
      expect((err as RangeError).cause).toMatchObject({
        kind: "commune_not_in_department",
        matches_in_other_dept: [{ code: "69123", nom: "Lyon" }],
      });
    }
  });

  it("unknown_commune → RangeError + hint pédagogique dans le message", async () => {
    expect.assertions(2); // M1 fix
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: false,
      error: {
        kind: "unknown_commune",
        input: { nom_commune: "St-Martin" },
        hint: "Utiliser le nom officiel complet (ex. 'Saint-Martin').",
      },
    });
    try {
      await applyCommuneResolver({
        nomCommune: "St-Martin",
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      });
    } catch (err) {
      expect((err as RangeError).message).toMatch(/inconnue.*officiel/i);
      expect((err as RangeError).cause).toMatchObject({ kind: "unknown_commune" });
    }
  });

  it("M2 fix — code_insee + departement sur tool commune-only (acceptsDepartementAsScope:false) → erreur explicite, pas avalé silencieusement", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: "59350",
        departement: "59",
        acceptsDepartementAsScope: false,
        requireScope: true,
      }),
    ).rejects.toThrow(/incompatible.*code_insee|calcul commune/i);
  });

  it("M2 fix — wording explicite mentionne hint resolver pour le tool commune-only", async () => {
    expect.assertions(1);
    try {
      await applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: "59350",
        departement: "59",
        acceptsDepartementAsScope: false,
        requireScope: true,
      });
    } catch (err) {
      expect((err as RangeError).message).toMatch(/nom_commune.*désambiguïsation/i);
    }
  });

  it("M1 régression — ambiguous_commune cause préserve `truncated` flag", async () => {
    expect.assertions(2);
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: { nom_commune: "Sainte-Marie" },
        candidates: Array.from({ length: 10 }, (_, i) => ({
          code: `0${i}001`,
          nom: "Sainte-Marie",
          codeDepartement: String(i + 10),
          population: 1000 - i,
        })),
        total_matches: 15,
        truncated: true,
      },
    });
    try {
      await applyCommuneResolver({
        nomCommune: "Sainte-Marie",
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      });
    } catch (err) {
      expect((err as RangeError).cause).toMatchObject({ truncated: true });
      expect(((err as RangeError).cause as { candidates: unknown[] }).candidates).toHaveLength(10);
    }
  });
});
