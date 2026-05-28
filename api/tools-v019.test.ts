/**
 * Tests boundary V0.19.0 : ajout `nom_commune` sur 3 tools + XOR strict
 * by_categorie + sémantique conditionnelle code_dept densite_professionnels.
 *
 * Source design : docs/plans/nom-commune-resolver-v019.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as densiteMod from "../src/sante/densite.js";
import * as finessDb from "../src/sante/finess-db.js";
import * as hostedActivities from "../src/sante/hosted-activities.js";
import * as panoramaMod from "../src/sante/panorama.js";
import type { Commune } from "../src/territoire/communes.js";
import * as resolveModule from "./_lib/resolve-commune.js";
import { findTool } from "./tools.js";

function fakeCommune(code: string, nom: string, codeDepartement: string): Commune {
  return { code, nom, codesPostaux: [], codeDepartement };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("V0.19.0 — etablissements_finess_by_categorie + nom_commune", () => {
  it("nom_commune seul → résolu en code_insee, passé à getFinessByCategorie", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    const dbSpy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof finessDb.getFinessByCategorie>>);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", nom_commune: "Lille" });
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ code_insee: "59350" }));
    expect(dbSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("nom_commune + departement (hint) → code_dept consommé comme hint, NON réinjecté en scope", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("65392", "Saint-Martin", "65"),
    });
    const dbSpy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof finessDb.getFinessByCategorie>>);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", nom_commune: "Saint-Martin", departement: "65" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ code_insee: "65392" }));
    expect(dbSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("XOR strict : departement + code_insee simultanés → RangeError redondants", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(
      tool?.handler({ categorie: "labo", departement: "59", code_insee: "59350" }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("XOR : nom_commune + code_insee simultanés → RangeError redondants", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(
      tool?.handler({ categorie: "labo", nom_commune: "Lille", code_insee: "59350" }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("nom_commune ambigu → RangeError avec error.cause.kind=ambiguous_commune", async () => {
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
    const tool = findTool("etablissements_finess_by_categorie");
    try {
      await tool?.handler({ categorie: "labo", nom_commune: "Saint-Martin" });
      throw new Error("expected RangeError");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).cause).toMatchObject({ kind: "ambiguous_commune" });
    }
  });

  it("rétro-compat : code_insee seul fonctionne comme avant", async () => {
    const dbSpy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof finessDb.getFinessByCategorie>>);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", code_insee: "59350" });
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ code_insee: "59350" }));
  });

  it("rétro-compat : departement seul fonctionne comme avant", async () => {
    const dbSpy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof finessDb.getFinessByCategorie>>);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", departement: "59" });
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "59" }));
  });

  it("rétro-compat : rien fourni (FR entière) fonctionne comme avant", async () => {
    const dbSpy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof finessDb.getFinessByCategorie>>);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo" });
    expect(dbSpy).toHaveBeenCalledWith({ famille: "labo" });
  });
});

describe("V0.19.0 — panorama_sante_territoire + nom_commune", () => {
  it("nom_commune seul → résolu, passé en codeInsee", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    const panoramaSpy = vi
      .spyOn(panoramaMod, "panoramaSanteTerritoire")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>);
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ nom_commune: "Lille" });
    expect(panoramaSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
  });

  it("departement seul → RangeError scope dept non supporté (panorama = commune)", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({ departement: "59" })).rejects.toThrow(
      /département non supporté|calcul commune/i,
    );
  });

  it("rien fourni → RangeError scope requis", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({})).rejects.toThrow(/scope requis|code_insee|nom_commune/i);
  });

  it("rétro-compat : code_insee seul fonctionne", async () => {
    const panoramaSpy = vi
      .spyOn(panoramaMod, "panoramaSanteTerritoire")
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>);
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ code_insee: "59350" });
    expect(panoramaSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
  });

  it("nom_commune + departement (hint) → résout dans le dept", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("65392", "Saint-Martin", "65"),
    });
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>,
    );
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ nom_commune: "Saint-Martin", departement: "65" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
  });

  it("XOR : nom_commune + code_insee → RangeError redondants", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({ nom_commune: "Lille", code_insee: "59350" })).rejects.toThrow(
      /redondants|SOIT/i,
    );
  });

  it("M2 fix — code_insee + departement → RangeError (panorama avale plus silencieusement le dept)", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({ code_insee: "59350", departement: "59" })).rejects.toThrow(
      /incompatible.*code_insee|calcul commune/i,
    );
  });

  it("C1 régression — nom_commune seul → hosted activities appelées avec resolved.codeInsee (PAS undefined)", async () => {
    // Garde-fou silent-failure-hunter C1 : avant le fix, panorama appelait
    // getHostedActivitiesInZone({codeInsee: undefined}) car il utilisait la
    // variable brute `codeInsee` (asString(args.code_insee)) au lieu de
    // `resolved.codeInsee`. La lib throw → safeHostedFetch catch silencieux →
    // activites_hebergees_par_famille absent du panorama avec faux warn.
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof panoramaMod.panoramaSanteTerritoire>>,
    );
    const hostedSpy = vi.spyOn(hostedActivities, "getHostedActivitiesInZone").mockResolvedValue({
      activite: "biologie_medicale",
      count: 13,
      zone: { codeInsee: "59350" },
    } as Awaited<ReturnType<typeof hostedActivities.getHostedActivitiesInZone>>);
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ nom_commune: "Lille", finess_familles: ["labo"] });
    expect(hostedSpy).toHaveBeenCalled();
    // Vérification load-bearing : codeInsee résolu transmis, JAMAIS undefined.
    const firstCall = hostedSpy.mock.calls[0]?.[0];
    expect(firstCall?.codeInsee).toBe("59350");
    expect(firstCall?.codeInsee).not.toBeUndefined();
  });
});

describe("V0.19.0 — densite_sante (professionnels) + nom_commune", () => {
  it("nom_commune seul → résolu, passé en codeInsee", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("59350", "Lille", "59"),
    });
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteProfessionnelsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteProfessionnelsSante>>,
      );
    const tool = findTool("densite_sante");
    await tool?.handler({ cible: "professionnels", nom_commune: "Lille" });
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("nom_commune + code_dept (hint) → code_dept consommé, codeInsee retourné, dept NON réinjecté", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: fakeCommune("65392", "Saint-Martin", "65"),
    });
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteProfessionnelsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteProfessionnelsSante>>,
      );
    const tool = findTool("densite_sante");
    await tool?.handler({ cible: "professionnels", nom_commune: "Saint-Martin", code_dept: "65" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "65392" }));
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("rétro-compat : code_dept seul = scope dept", async () => {
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteProfessionnelsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteProfessionnelsSante>>,
      );
    const tool = findTool("densite_sante");
    await tool?.handler({ cible: "professionnels", code_dept: "59" });
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "59" }));
    expect(densiteSpy.mock.calls[0]?.[0].codeInsee).toBeUndefined();
  });

  it("rétro-compat : code_insee seul = scope commune", async () => {
    const densiteSpy = vi
      .spyOn(densiteMod, "densiteProfessionnelsSante")
      .mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof densiteMod.densiteProfessionnelsSante>>,
      );
    const tool = findTool("densite_sante");
    await tool?.handler({ cible: "professionnels", code_insee: "59350" });
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
  });

  it("XOR : nom_commune + code_insee → RangeError redondant", async () => {
    const tool = findTool("densite_sante");
    await expect(
      tool?.handler({ cible: "professionnels", nom_commune: "Lille", code_insee: "59350" }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("rien fourni → RangeError requireOneOf (wording historique préservé)", async () => {
    const tool = findTool("densite_sante");
    await expect(tool?.handler({ cible: "professionnels" })).rejects.toThrow(
      /Attendu.*code_dept|nom_commune|code_insee/i,
    );
  });
});
