import { beforeEach, describe, expect, it, vi } from "vitest";

import * as melodi from "../territoire/insee-melodi.js";
import { densiteEtablissementsSante, densiteProfessionnelsSante } from "./densite.js";
import * as finessDb from "./finess-db.js";
import * as rppsDb from "./rpps-db.js";

const countRppsSpy = vi.spyOn(rppsDb, "countRpps");
const countFinessSpy = vi.spyOn(finessDb, "countFiness");
const popByDeptSpy = vi.spyOn(melodi, "getPopulationByDept");
const popFranceSpy = vi.spyOn(melodi, "getPopulationFrance");

beforeEach(() => {
  countRppsSpy.mockReset();
  countFinessSpy.mockReset();
  popByDeptSpy.mockReset();
  popFranceSpy.mockReset();
});

function popFound(value: number, annee = 2023, code = "75"): Awaited<
  ReturnType<typeof melodi.getPopulationByDept>
> {
  return {
    found: true,
    lookupStatus: "found",
    codeInsee: code,
    geoLevel: "DEP",
    annee,
    populationMunicipale: value,
    populationComptageApart: 0,
    populationTotale: value,
    millesimeGeographique: "2025",
    source: "INSEE Melodi (DS_POPULATIONS_REFERENCE)",
  };
}

function popFranceFound(value: number, annee = 2023): Awaited<
  ReturnType<typeof melodi.getPopulationFrance>
> {
  return {
    codeInsee: "FRANCE",
    geoLevel: "FRANCE",
    annee,
    populationMunicipale: value,
    populationComptageApart: 0,
    populationTotale: value,
    millesimeGeographique: "2025",
    source: "INSEE Melodi (DS_POPULATIONS_REFERENCE)",
  };
}

describe("densiteProfessionnelsSante", () => {
  it("calcule la densité médecins activité régulière par défaut (méthodo DREES)", async () => {
    countRppsSpy.mockResolvedValue(7900);
    popByDeptSpy.mockResolvedValue(popFound(2103778));

    const result = await densiteProfessionnelsSante({ departement: "75" });

    expect(countRppsSpy).toHaveBeenCalledWith({
      departement: "75",
      professionCode: "10",
      savoirFaireCode: null,
      modeExerciceCodes: ["L", "S", "M"],
      categorieCodes: [],
    });
    expect(result.zone.zone).toBe("75");
    expect(result.zone.countPs).toBe(7900);
    expect(result.zone.population).toBe(2103778);
    expect(result.zone.populationAnnee).toBe(2023);
    expect(result.zone.densitePour100k).toBe(round2((7900 / 2103778) * 100_000));
    expect(result.parametres.professionCode).toBe("10");
    expect(result.parametres.modeExerciceCodes).toEqual(["L", "S", "M"]);
    expect(result.parametres.methodologie).toContain("DREES");
    expect(result.comparaisonNationale).toBeUndefined();
  });

  it("permet de surcharger la profession (infirmiers) et la spécialité (cardiologues)", async () => {
    countRppsSpy.mockResolvedValue(450);
    popByDeptSpy.mockResolvedValue(popFound(2103778));

    await densiteProfessionnelsSante({
      departement: "75",
      professionCode: "60", // Infirmier
    });
    expect(countRppsSpy.mock.calls[0]?.[0]?.professionCode).toBe("60");

    countRppsSpy.mockResolvedValue(120);
    await densiteProfessionnelsSante({
      departement: "75",
      savoirFaireCode: "SM02",
    });
    expect(countRppsSpy.mock.calls[1]?.[0]?.savoirFaireCode).toBe("SM02");
  });

  it("modeExerciceCodes=null → désactive le filtre (tous statuts)", async () => {
    countRppsSpy.mockResolvedValue(15000);
    popByDeptSpy.mockResolvedValue(popFound(2103778));

    await densiteProfessionnelsSante({
      departement: "75",
      modeExerciceCodes: null,
    });
    expect(countRppsSpy.mock.calls[0]?.[0]?.modeExerciceCodes).toEqual([]);
  });

  it("compareNational=true → ajoute le calcul France entière + écart", async () => {
    // Dept 75 : 7900 médecins / 2,1M hab → ~376/100k
    countRppsSpy.mockResolvedValueOnce(7900);
    popByDeptSpy.mockResolvedValue(popFound(2103778));
    // National : 220k médecins / 68M hab → ~323/100k
    countRppsSpy.mockResolvedValueOnce(220000);
    popFranceSpy.mockResolvedValue(popFranceFound(68094280));

    const result = await densiteProfessionnelsSante({
      departement: "75",
      compareNational: true,
    });

    expect(result.comparaisonNationale).toBeDefined();
    expect(result.comparaisonNationale?.national.countPs).toBe(220000);
    expect(result.comparaisonNationale?.national.population).toBe(68094280);
    // 376 vs 323 → ~+16% sur-doté
    expect(result.comparaisonNationale?.ecartVsNationalPct).toBeGreaterThan(10);
    expect(result.comparaisonNationale?.ecartVsNationalPct).toBeLessThan(25);
  });

  it("compareNational : count_rpps national appelé sans filtre dept", async () => {
    countRppsSpy.mockResolvedValueOnce(7900);
    popByDeptSpy.mockResolvedValue(popFound(2103778));
    countRppsSpy.mockResolvedValueOnce(220000);
    popFranceSpy.mockResolvedValue(popFranceFound(68094280));

    await densiteProfessionnelsSante({ departement: "75", compareNational: true });

    const nationalCall = countRppsSpy.mock.calls[1]?.[0];
    expect(nationalCall?.departement).toBeUndefined();
    expect(nationalCall?.professionCode).toBe("10");
  });

  it("throw si la population du dept est introuvable côté Melodi", async () => {
    countRppsSpy.mockResolvedValue(7900);
    popByDeptSpy.mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: "99",
      message: "Département 99 introuvable",
    });
    await expect(densiteProfessionnelsSante({ departement: "99" })).rejects.toThrow(
      /Département 99 introuvable/u,
    );
  });

  it("population 0 → densité 0 (pas de division par 0)", async () => {
    countRppsSpy.mockResolvedValue(0);
    popByDeptSpy.mockResolvedValue(popFound(0));
    const result = await densiteProfessionnelsSante({ departement: "75" });
    expect(result.zone.densitePour100k).toBe(0);
  });

  it("écart national = 0 si densité nationale = 0 (pas de NaN)", async () => {
    countRppsSpy.mockResolvedValueOnce(100);
    popByDeptSpy.mockResolvedValue(popFound(1000));
    countRppsSpy.mockResolvedValueOnce(0);
    popFranceSpy.mockResolvedValue(popFranceFound(0));
    const result = await densiteProfessionnelsSante({
      departement: "75",
      compareNational: true,
    });
    expect(result.comparaisonNationale?.ecartVsNationalPct).toBe(0);
  });
});

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

describe("densiteEtablissementsSante", () => {
  it("calcule la densité de labos (famille=labo) dans le dept 75", async () => {
    countFinessSpy.mockResolvedValue(180);
    popByDeptSpy.mockResolvedValue(popFound(2103778));

    const result = await densiteEtablissementsSante({ departement: "75", famille: "labo" });

    expect(countFinessSpy).toHaveBeenCalledWith({ departement: "75", famille: "labo" });
    expect(result.zone.zone).toBe("75");
    expect(result.zone.countEtablissements).toBe(180);
    expect(result.zone.population).toBe(2103778);
    expect(result.zone.densitePour100k).toBe(round2((180 / 2103778) * 100_000));
    expect(result.parametres.famille).toBe("labo");
    expect(result.parametres.methodologie).toContain("FINESS_FAMILY_CODES");
    expect(result.comparaisonNationale).toBeUndefined();
  });

  it("compareNational=true → ajoute calcul France entière + écart", async () => {
    countFinessSpy.mockResolvedValueOnce(180);
    popByDeptSpy.mockResolvedValue(popFound(2103778));
    countFinessSpy.mockResolvedValueOnce(4500);
    popFranceSpy.mockResolvedValue(popFranceFound(68094280));

    const result = await densiteEtablissementsSante({
      departement: "75",
      famille: "labo",
      compareNational: true,
    });

    expect(result.comparaisonNationale).toBeDefined();
    expect(result.comparaisonNationale?.national.countEtablissements).toBe(4500);
    expect(result.comparaisonNationale?.national.population).toBe(68094280);
    // Paris ~8,6/100k vs France ~6,6/100k → ~+30% sur-doté
    expect(result.comparaisonNationale?.ecartVsNationalPct).toBeGreaterThan(20);
  });

  it("compareNational : count_finess national appelé sans dept", async () => {
    countFinessSpy.mockResolvedValueOnce(180);
    popByDeptSpy.mockResolvedValue(popFound(2103778));
    countFinessSpy.mockResolvedValueOnce(4500);
    popFranceSpy.mockResolvedValue(popFranceFound(68094280));

    await densiteEtablissementsSante({
      departement: "75",
      famille: "labo",
      compareNational: true,
    });
    expect(countFinessSpy.mock.calls[1]?.[0]?.departement).toBeUndefined();
    expect(countFinessSpy.mock.calls[1]?.[0]?.famille).toBe("labo");
  });

  it("supporte d'autres familles (pharmacie, ehpad, mco)", async () => {
    countFinessSpy.mockResolvedValue(50);
    popByDeptSpy.mockResolvedValue(popFound(1_000_000));
    for (const famille of ["pharmacie", "ehpad", "mco"] as const) {
      await densiteEtablissementsSante({ departement: "13", famille });
    }
    expect(countFinessSpy.mock.calls.map((c) => c[0]?.famille)).toEqual([
      "pharmacie",
      "ehpad",
      "mco",
    ]);
  });

  it("throw si la population du dept est introuvable", async () => {
    countFinessSpy.mockResolvedValue(50);
    popByDeptSpy.mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: "99",
      message: "Département 99 introuvable",
    });
    await expect(
      densiteEtablissementsSante({ departement: "99", famille: "labo" }),
    ).rejects.toThrow(/Département 99 introuvable/u);
  });

  it("population 0 → densité 0 (pas de division par 0)", async () => {
    countFinessSpy.mockResolvedValue(0);
    popByDeptSpy.mockResolvedValue(popFound(0));
    const result = await densiteEtablissementsSante({ departement: "75", famille: "labo" });
    expect(result.zone.densitePour100k).toBe(0);
  });
});
