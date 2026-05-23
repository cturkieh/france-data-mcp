/**
 * Tests boundary V0.20 — extension `densite_etablissements_sante` au niveau
 * commune (alignement avec densite_professionnels V0.9 + nom_commune V0.19).
 *
 * Pattern miroir api/tools-v019.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as densiteMod from "../src/sante/densite.js";
import * as hostedActivities from "../src/sante/hosted-activities.js";
import type { Commune } from "../src/territoire/communes.js";
import * as resolveModule from "./_lib/resolve-commune.js";
import { findTool } from "./tools.js";

function fakeCommune(code: string, nom: string, codeDepartement: string): Commune {
  return { code, nom, codesPostaux: [], codeDepartement };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("V0.20 — densite_etablissements_sante + niveau commune", () => {
  it("rétro-compat : code_dept seul fonctionne comme avant", async () => {
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteEtablissementsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>,
      );
    const tool = findTool("densite_etablissements_sante");
    await tool?.handler({ code_dept: "75", famille: "labo" });
    expect(densiteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ departement: "75", famille: "labo" }),
    );
    expect(densiteSpy.mock.calls[0]?.[0].codeInsee).toBeUndefined();
  });

  it("V0.20 — code_insee seul → passe codeInsee à la lib", async () => {
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteEtablissementsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>,
      );
    const tool = findTool("densite_etablissements_sante");
    await tool?.handler({ code_insee: "59350", famille: "labo" });
    expect(densiteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codeInsee: "59350", famille: "labo" }),
    );
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("V0.20 — nom_commune seul → résolu en codeInsee, passé à la lib", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteEtablissementsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>,
      );
    const tool = findTool("densite_etablissements_sante");
    await tool?.handler({ nom_commune: "Lille", famille: "labo" });
    expect(densiteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codeInsee: "59350", famille: "labo" }),
    );
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("V0.20 — nom_commune + code_dept (hint) → code_dept consommé, codeInsee retourné seul", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("65392", "Saint-Martin", "65"),
    });
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteEtablissementsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>,
      );
    const tool = findTool("densite_etablissements_sante");
    await tool?.handler({ nom_commune: "Saint-Martin", code_dept: "65", famille: "labo" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
    expect(densiteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codeInsee: "65392", famille: "labo" }),
    );
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("V0.20 — code_dept + code_insee → RangeError XOR (applyCommuneResolver branch 2)", async () => {
    const tool = findTool("densite_etablissements_sante");
    await expect(
      tool?.handler({ code_dept: "75", code_insee: "59350", famille: "labo" }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("V0.20 — nom_commune + code_insee → RangeError XOR redondant", async () => {
    const tool = findTool("densite_etablissements_sante");
    await expect(
      tool?.handler({ nom_commune: "Lille", code_insee: "59350", famille: "labo" }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("V0.20 — nom_commune ambigu → RangeError avec error.cause.kind=ambiguous_commune", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
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
    const tool = findTool("densite_etablissements_sante");
    try {
      await tool?.handler({ nom_commune: "Saint-Martin", famille: "labo" });
      throw new Error("expected RangeError");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).cause).toMatchObject({ kind: "ambiguous_commune" });
    }
  });

  it("V0.20 — rien fourni (sauf famille) → RangeError requireOneOf 3 alternatives", async () => {
    const tool = findTool("densite_etablissements_sante");
    await expect(tool?.handler({ famille: "labo" })).rejects.toThrow(
      /Attendu.*code_dept|code_insee|nom_commune/i,
    );
  });

  it("V0.20 — famille manquante → RangeError", async () => {
    const tool = findTool("densite_etablissements_sante");
    await expect(tool?.handler({ code_dept: "75" })).rejects.toThrow(/famille/i);
  });

  it("V0.20 — required du schema = ['famille'] uniquement (code_dept retiré)", () => {
    const tool = findTool("densite_etablissements_sante");
    expect(tool?.inputSchema.required).toEqual(["famille"]);
  });

  it("V0.20 — schema expose code_dept + code_insee + nom_commune", () => {
    const tool = findTool("densite_etablissements_sante");
    const props = tool?.inputSchema.properties as Record<string, unknown>;
    expect(props.code_dept).toBeDefined();
    expect(props.code_insee).toBeDefined();
    expect(props.nom_commune).toBeDefined();
  });

  it("C1 régression V0.20 — nom_commune → hosted activities appelées avec resolved.codeInsee (PAS undefined)", async () => {
    // Garde-fou silent-failure-hunter (V0.20 review Medium 1) — jumeau exact
    // du test V0.19 panorama. Sans ce test, une régression future qui
    // re-substituerait `codeInsee` brut à `resolved.codeInsee` dans le
    // handler densite_etablissements_sante ferait throw getHostedActivitiesInZone
    // (« departement OR codeInsee requis »), capturé silencieusement par
    // safeHostedFetch → champ activite_hebergee absent sans erreur visible.
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    vi.spyOn(densiteMod, "densiteEtablissementsSante").mockResolvedValueOnce({
      zone: {
        zone: "59350",
        niveau: "commune",
        countEtablissements: 1,
        population: 238246,
        populationAnnee: 2023,
        densitePour100k: 0.42,
      },
    } as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>);
    const hostedSpy = vi.spyOn(hostedActivities, "getHostedActivitiesInZone").mockResolvedValue({
      activite: "biologie_medicale",
      count: 13,
      zone: { codeInsee: "59350" },
    } as Awaited<ReturnType<typeof hostedActivities.getHostedActivitiesInZone>>);
    const tool = findTool("densite_etablissements_sante");
    await tool?.handler({ nom_commune: "Lille", famille: "labo" });
    expect(hostedSpy).toHaveBeenCalled();
    // Vérification load-bearing : codeInsee résolu transmis, JAMAIS undefined.
    const firstCall = hostedSpy.mock.calls[0]?.[0];
    expect(firstCall?.codeInsee).toBe("59350");
    expect(firstCall?.codeInsee).not.toBeUndefined();
    expect(firstCall?.departement).toBeUndefined();
  });

  it("V0.20 — XOR : nom_commune Paris + code_insee 75056 (PLM commune-mère) → redondant, PAS PLM-message", async () => {
    // Garde-fou silent-failure-hunter Medium 4 : l'ordre des asserts dans
    // le contrat resolver est load-bearing. Branch 1 (XOR redondant) DOIT
    // throw AVANT que assertNotPlmCommune ne soit considéré côté lib.
    const tool = findTool("densite_etablissements_sante");
    await expect(
      tool?.handler({ nom_commune: "Paris", code_insee: "75056", famille: "labo" }),
    ).rejects.toThrow(/redondants|SOIT/i);
    // Régression si throw "Paris/Lyon/Marseille" → ordre des asserts cassé
    await expect(
      tool?.handler({ nom_commune: "Paris", code_insee: "75056", famille: "labo" }),
    ).rejects.not.toThrow(/Paris\/Lyon\/Marseille/i);
  });

  it("V0.20 — niveau commune exposé côté tool MCP (garde-fou spread destructeur)", async () => {
    // Garde-fou silent-failure-hunter Low 2 : si un futur refactor pick/spread
    // perd silencieusement le champ `niveau`, le LLM caller ne distingue plus
    // dept vs commune → interprétation faussée des chiffres.
    vi.spyOn(densiteMod, "densiteEtablissementsSante").mockResolvedValueOnce({
      zone: {
        zone: "59350",
        niveau: "commune",
        countEtablissements: 4,
        population: 238246,
        populationAnnee: 2023,
        densitePour100k: 1.68,
      },
      parametres: { famille: "labo", methodologie: "test" },
      source: { etablissements: "FINESS DREES", population: "INSEE Melodi" },
    } as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>);
    const tool = findTool("densite_etablissements_sante");
    const result = (await tool?.handler({ code_insee: "59350", famille: "labo" })) as {
      zone: { niveau: string };
    };
    expect(result?.zone?.niveau).toBe("commune");
  });
});
