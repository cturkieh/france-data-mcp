import { afterEach, describe, expect, it, vi } from "vitest";

import * as densiteMod from "../src/sante/densite.js";
import * as panoramaMod from "../src/sante/panorama.js";
import * as territoire from "../src/territoire/index.js";
import { findTool } from "./tools.js";

// Tests V0.9 : alias paramètres, code_insee dans densite_professionnels_sante,
// nouveau tool panorama_sante_territoire, messages d'erreur suggestifs.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UX V0.9 — alias paramètres autocomplete_commune", () => {
  it("accepte `q` (alias) → remappé en `nom`", async () => {
    const tool = findTool("autocomplete_commune");
    expect(tool).toBeDefined();
    const spy = vi.spyOn(territoire, "searchCommunes").mockResolvedValue([]);

    await tool?.handler({ q: "Lyon" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ nom: "Lyon" }));
  });

  it("accepte `query` et `search` comme alias de `nom`", async () => {
    const tool = findTool("autocomplete_commune");
    const spy = vi.spyOn(territoire, "searchCommunes").mockResolvedValue([]);

    await tool?.handler({ query: "Paris" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ nom: "Paris" }));

    await tool?.handler({ search: "Marseille" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ nom: "Marseille" }));
  });

  it("`code_insee` et `insee` aliasés vers `code`", async () => {
    const tool = findTool("autocomplete_commune");
    const spy = vi.spyOn(territoire, "searchCommunes").mockResolvedValue([]);

    await tool?.handler({ code_insee: "59009" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ code: "59009" }));

    await tool?.handler({ insee: "75056" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ code: "75056" }));
  });

  it("aucun argument → RangeError avec suggestion explicite", async () => {
    const tool = findTool("autocomplete_commune");
    vi.spyOn(territoire, "searchCommunes").mockResolvedValue([]);

    await expect(tool?.handler({})).rejects.toThrow(RangeError);
    await expect(tool?.handler({})).rejects.toThrow(/Attendu: "nom" ou "codePostal" ou "code"/);
  });

  it("nom canonique gagne si fourni avec un alias en conflit", async () => {
    const tool = findTool("autocomplete_commune");
    const spy = vi.spyOn(territoire, "searchCommunes").mockResolvedValue([]);

    await tool?.handler({ q: "ignored", nom: "Lyon" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ nom: "Lyon" }));
  });
});

describe("UX V0.9 — alias get_commune_by_code, population_par_*", () => {
  it("get_commune_by_code accepte code_insee → code", async () => {
    const tool = findTool("get_commune_by_code");
    const spy = vi.spyOn(territoire, "getCommuneByCode").mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: "X",
      message: "X",
    });

    await tool?.handler({ code_insee: "59009" });
    expect(spy).toHaveBeenCalledWith("59009");
  });

  it("population_par_commune accepte codeInsee/insee → code", async () => {
    const tool = findTool("population_par_commune");
    const spy = vi.spyOn(territoire, "getPopulationByCommune").mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: "X",
      message: "X",
    });

    await tool?.handler({ codeInsee: "59009" });
    expect(spy).toHaveBeenLastCalledWith("59009");
    await tool?.handler({ insee: "75056" });
    expect(spy).toHaveBeenLastCalledWith("75056");
  });

  it("population_par_departement accepte dept/departement/code_dept → code", async () => {
    const tool = findTool("population_par_departement");
    const spy = vi.spyOn(territoire, "getPopulationByDept").mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: "X",
      message: "X",
    });

    await tool?.handler({ dept: "59" });
    expect(spy).toHaveBeenLastCalledWith("59");
    await tool?.handler({ departement: "75" });
    expect(spy).toHaveBeenLastCalledWith("75");
    await tool?.handler({ code_dept: "13" });
    expect(spy).toHaveBeenLastCalledWith("13");
  });

  it("messages d'erreur explicites (Reçu vs Attendu vs Exemple)", async () => {
    const tool = findTool("population_par_commune");
    vi.spyOn(territoire, "getPopulationByCommune").mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: "X",
      message: "X",
    });

    await expect(tool?.handler({ foo: "bar" })).rejects.toThrow(/Attendu: "code"/);
    await expect(tool?.handler({ foo: "bar" })).rejects.toThrow(/Exemple: \{"code":/);
  });
});

describe("UX V0.9 — densite_professionnels_sante XOR code_dept/code_insee", () => {
  it("alias dept/departement → code_dept", async () => {
    const tool = findTool("densite_professionnels_sante");
    const spy = vi.spyOn(densiteMod, "densiteProfessionnelsSante").mockResolvedValue({
      // structure minimale, on ne vérifie que l'appel
    } as unknown as Awaited<ReturnType<typeof densiteMod.densiteProfessionnelsSante>>);

    await tool?.handler({ dept: "59" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ departement: "59" }));

    await tool?.handler({ departement: "75" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ departement: "75" }));
  });

  it("V0.9 — code_insee fourni → densité au niveau commune", async () => {
    const tool = findTool("densite_professionnels_sante");
    const spy = vi
      .spyOn(densiteMod, "densiteProfessionnelsSante")
      .mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof densiteMod.densiteProfessionnelsSante>>,
      );

    await tool?.handler({ code_insee: "59009" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59009" }));
    const call = spy.mock.calls[0]?.[0];
    expect(call?.departement).toBeUndefined();
  });

  it("XOR violation : code_dept + code_insee → RangeError explicite (via resolveZone lib)", async () => {
    const tool = findTool("densite_professionnels_sante");
    // Pas de mock densiteProfessionnelsSante : on veut que la lib réelle
    // exécute resolveZone et throw avant tout RPC. Wording lib utilise les
    // noms TS ("departement"/"codeInsee") plutôt que les noms MCP.
    await expect(tool?.handler({ code_dept: "59", code_insee: "59009" })).rejects.toThrow(
      /SOIT departement.*SOIT codeInsee/,
    );
  });

  it("aucun des deux → suggestion explicite", async () => {
    const tool = findTool("densite_professionnels_sante");
    await expect(tool?.handler({})).rejects.toThrow(/Attendu: "code_dept" ou "code_insee"/);
  });
});

describe("UX V0.9 — densite_etablissements_sante alias", () => {
  it("alias dept → code_dept", async () => {
    const tool = findTool("densite_etablissements_sante");
    const spy = vi
      .spyOn(densiteMod, "densiteEtablissementsSante")
      .mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof densiteMod.densiteEtablissementsSante>>,
      );

    await tool?.handler({ dept: "59", famille: "labo" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ departement: "59" }));
  });
});

describe("V0.9 — panorama_sante_territoire (nouveau tool)", () => {
  it("est exposé dans le registry MCP", () => {
    const tool = findTool("panorama_sante_territoire");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["code_insee"]);
  });

  it("appelle panoramaSanteTerritoire avec codeInsee", async () => {
    const tool = findTool("panorama_sante_territoire");
    const spy = vi
      .spyOn(panoramaMod, "panoramaSanteTerritoire")
      .mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>,
      );

    await tool?.handler({ code_insee: "59009" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59009" }));
  });

  it("alias codeInsee/insee/code → code_insee", async () => {
    const tool = findTool("panorama_sante_territoire");
    const spy = vi
      .spyOn(panoramaMod, "panoramaSanteTerritoire")
      .mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>,
      );

    await tool?.handler({ codeInsee: "75108" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ codeInsee: "75108" }));
    await tool?.handler({ insee: "2A004" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ codeInsee: "2A004" }));
    await tool?.handler({ code: "13055" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ codeInsee: "13055" }));
  });

  it("propage finess_familles → finessFamilles (familles valides)", async () => {
    const tool = findTool("panorama_sante_territoire");
    const spy = vi
      .spyOn(panoramaMod, "panoramaSanteTerritoire")
      .mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>,
      );

    await tool?.handler({ code_insee: "59009", finess_familles: ["pharmacie", "mco"] });
    const call = spy.mock.calls[0]?.[0];
    expect(call?.finessFamilles).toEqual(["pharmacie", "mco"]);
  });

  it("V0.9 fix — famille invalide → RangeError (anti-silent-failure)", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(
      tool?.handler({
        code_insee: "59009",
        finess_familles: ["pharmacie", "famille_invalide_qui_existe_pas"],
      }),
    ).rejects.toThrow(/famille FINESS invalide/);
  });

  it("code_insee manquant → message d'erreur explicite avec exemple", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({})).rejects.toThrow(/Attendu: "code_insee"/);
    await expect(tool?.handler({})).rejects.toThrow(/Exemple: \{"code_insee":"59009"\}/);
  });
});
