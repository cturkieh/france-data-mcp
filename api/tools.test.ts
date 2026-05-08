import { afterEach, describe, expect, it, vi } from "vitest";
import * as ameliDb from "../src/sante/ameli-db.js";
import * as finessDb from "../src/sante/finess-db.js";
import { deptFromCommune, findTool } from "./tools.js";

describe("deptFromCommune", () => {
  it("extrait le département pour la métropole standard", () => {
    expect(deptFromCommune("08105")).toBe("08");
    expect(deptFromCommune("75056")).toBe("75");
    expect(deptFromCommune("13055")).toBe("13");
  });

  it("préserve les codes Corse 2A et 2B", () => {
    expect(deptFromCommune("2A004")).toBe("2A");
    expect(deptFromCommune("2B033")).toBe("2B");
  });

  it("retourne 3 caractères pour les DOM (97x)", () => {
    expect(deptFromCommune("97411")).toBe("974");
    expect(deptFromCommune("97209")).toBe("972");
    expect(deptFromCommune("97120")).toBe("971");
    expect(deptFromCommune("97302")).toBe("973");
    expect(deptFromCommune("97601")).toBe("976");
  });

  it("retourne 3 caractères pour les TOM (98x)", () => {
    expect(deptFromCommune("98711")).toBe("987");
  });

  it("retourne undefined pour les entrées invalides", () => {
    expect(deptFromCommune(undefined)).toBeUndefined();
    expect(deptFromCommune("")).toBeUndefined();
    expect(deptFromCommune("0")).toBeUndefined();
  });

  it("retourne undefined si DOM mais codeCommune trop court", () => {
    expect(deptFromCommune("97")).toBeUndefined();
    expect(deptFromCommune("98")).toBeUndefined();
  });
});

describe("etablissements_finess_in_radius (MCP tool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré dans la liste des tools", () => {
    const tool = findTool("etablissements_finess_in_radius");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["lon", "lat"]);
  });

  it("rejette les appels sans lon/lat", async () => {
    const tool = findTool("etablissements_finess_in_radius");
    await expect(tool?.handler({})).rejects.toThrow(/lon et lat/);
    await expect(tool?.handler({ lon: 4.7 })).rejects.toThrow(/lon et lat/);
    await expect(tool?.handler({ lat: 49.7 })).rejects.toThrow(/lon et lat/);
  });

  it("rejette un radius_km hors bornes avec RangeError", async () => {
    const tool = findTool("etablissements_finess_in_radius");
    await expect(tool?.handler({ lon: 4.7, lat: 49.7, radius_km: 999 })).rejects.toThrow(
      RangeError,
    );
    await expect(tool?.handler({ lon: 4.7, lat: 49.7, radius_km: 0 })).rejects.toThrow(RangeError);
  });

  it("délègue à getFinessInRadius avec les bons arguments", async () => {
    const spy = vi
      .spyOn(finessDb, "getFinessInRadius")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("etablissements_finess_in_radius");
    await tool?.handler({
      lon: 4.7203,
      lat: 49.7724,
      radius_km: 5,
      familles: ["mco", "ehpad"],
      limit: 50,
    });
    expect(spy).toHaveBeenCalledWith({
      center: { lon: 4.7203, lat: 49.7724 },
      radiusKm: 5,
      familles: ["mco", "ehpad"],
      limit: 50,
    });
  });

  it("rejette une famille invalide", async () => {
    const tool = findTool("etablissements_finess_in_radius");
    await expect(
      tool?.handler({ lon: 4.7, lat: 49.7, familles: ["famille_inexistante"] }),
    ).rejects.toThrow();
  });

  it("accepte les nouvelles familles étendues (v0.2.1)", async () => {
    const spy = vi
      .spyOn(finessDb, "getFinessInRadius")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("etablissements_finess_in_radius");
    await tool?.handler({
      lon: 4.72,
      lat: 49.77,
      familles: ["pharmacie", "msp_cpts", "labo", "ssiad"],
    });
    expect(spy).toHaveBeenCalledWith({
      center: { lon: 4.72, lat: 49.77 },
      radiusKm: 5,
      familles: ["pharmacie", "msp_cpts", "labo", "ssiad"],
    });
  });
});

describe("etablissements_finess_by_categorie (MCP tool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré dans la liste des tools", () => {
    const tool = findTool("etablissements_finess_by_categorie");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["categorie"]);
  });

  it("rejette les appels sans categorie", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(tool?.handler({})).rejects.toThrow(/categorie/);
  });

  it("rejette une categorie inconnue", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(tool?.handler({ categorie: "famille_inexistante" })).rejects.toThrow(/categorie/);
  });

  it("accepte les nouvelles familles étendues (v0.2.1)", async () => {
    const spy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "pharmacie", departement: "08" });
    expect(spy).toHaveBeenCalledWith({ famille: "pharmacie", departement: "08" });
  });

  it("délègue à getFinessByCategorie avec departement + limit", async () => {
    const spy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({
      categorie: "ehpad",
      departement: "08",
      limit: 200,
    });
    expect(spy).toHaveBeenCalledWith({
      famille: "ehpad",
      departement: "08",
      limit: 200,
    });
  });

  it("délègue avec code_insee et sans departement", async () => {
    const spy = vi
      .spyOn(finessDb, "getFinessByCategorie")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "mco", code_insee: "08105" });
    expect(spy).toHaveBeenCalledWith({
      famille: "mco",
      code_insee: "08105",
    });
  });
});

describe("professionnels_in_radius (MCP tool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré et expose lon/lat comme requis", () => {
    const tool = findTool("professionnels_in_radius");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["lon", "lat"]);
    expect(tool?.description).toContain("L.1461-2"); // mention CGU obligatoire
  });

  it("rejette les appels sans lon/lat", async () => {
    const tool = findTool("professionnels_in_radius");
    await expect(tool?.handler({})).rejects.toThrow(/lon et lat/);
    await expect(tool?.handler({ lon: 4.7 })).rejects.toThrow(/lon et lat/);
  });

  it("délègue à getAmeliInRadius avec radius default 5km et tableaux mappés", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliInRadius")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_in_radius");
    await tool?.handler({
      lon: 4.7203,
      lat: 49.7724,
      radius_km: 10,
      specialite_codes: ["01", "03"],
      type_ps_codes: ["1"],
      limit: 50,
    });
    expect(spy).toHaveBeenCalledWith({
      center: { lon: 4.7203, lat: 49.7724 },
      radiusKm: 10,
      specialiteCodes: ["01", "03"],
      typePsCodes: ["1"],
      limit: 50,
    });
  });

  it("applique radius_km par défaut à 5 quand omis", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliInRadius")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_in_radius");
    await tool?.handler({ lon: 4.72, lat: 49.77 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ radiusKm: 5 }));
  });

  it("rejette specialite_codes non-tableau ou avec élément non-string", async () => {
    const tool = findTool("professionnels_in_radius");
    await expect(tool?.handler({ lon: 4.7, lat: 49.7, specialite_codes: "01" })).rejects.toThrow(
      /specialite_codes/,
    );
    await expect(tool?.handler({ lon: 4.7, lat: 49.7, specialite_codes: [1, 2] })).rejects.toThrow(
      /string/,
    );
  });

  it("rejette une chaîne vide dans specialite_codes (silent-failure guard)", async () => {
    const tool = findTool("professionnels_in_radius");
    await expect(
      tool?.handler({ lon: 4.7, lat: 49.7, specialite_codes: ["", "01"] }),
    ).rejects.toThrow(/chaîne vide/);
  });

  it("normalise un tableau vide à 'no filter' au lieu de 'filter-out-everything'", async () => {
    // Lock the V0.4 contract: `[]` → forwarded as undefined → wrapper falls
    // back to []. Net SQL behavior: no filter (cardinality=0 branch). A
    // future regression that forwards [] literally would silently match
    // nothing instead of everything.
    const spy = vi
      .spyOn(ameliDb, "getAmeliInRadius")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_in_radius");
    await tool?.handler({ lon: 4.7, lat: 49.7, specialite_codes: [], type_ps_codes: [] });
    const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArgs?.specialiteCodes).toBeUndefined();
    expect(callArgs?.typePsCodes).toBeUndefined();
  });
});

describe("professionnels_par_specialite_dept (MCP tool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré et expose departement comme requis", () => {
    const tool = findTool("professionnels_par_specialite_dept");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["departement"]);
    expect(tool?.description).toContain("L.1461-2");
  });

  it("rejette les appels sans departement", async () => {
    const tool = findTool("professionnels_par_specialite_dept");
    await expect(tool?.handler({})).rejects.toThrow(/departement/);
  });

  it("délègue à getAmeliBySpecialiteDept avec filtres optionnels", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliBySpecialiteDept")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_par_specialite_dept");
    await tool?.handler({ departement: "08", specialite_code: "03", limit: 200 });
    expect(spy).toHaveBeenCalledWith({
      departement: "08",
      specialiteCode: "03",
      limit: 200,
    });
  });

  it("délègue avec type_ps_code seul", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliBySpecialiteDept")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_par_specialite_dept");
    await tool?.handler({ departement: "75", type_ps_code: "2" });
    expect(spy).toHaveBeenCalledWith({
      departement: "75",
      typePsCode: "2",
    });
  });
});
