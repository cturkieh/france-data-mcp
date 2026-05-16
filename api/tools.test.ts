import { afterEach, describe, expect, it, vi } from "vitest";
import * as ameliDb from "../src/sante/ameli-db.js";
import * as crossSource from "../src/sante/cross-source.js";
import * as finessDb from "../src/sante/finess-db.js";
import * as dinum from "../src/sante/index.js";
import * as inseeSirene from "../src/sante/insee-sirene.js";
import * as rppsDb from "../src/sante/rpps-db.js";
import * as ingestLog from "../src/storage/ingest-log.js";
import * as geocode from "../src/territoire/geocode.js";
import { TOOLS, categorieCodesFromArgs, deptFromCommune, findTool } from "./tools.js";

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

  it("forwarde offset au wrapper DB pour pagination", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliBySpecialiteDept")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_par_specialite_dept");
    await tool?.handler({ departement: "75", limit: 100, offset: 200 });
    expect(spy).toHaveBeenCalledWith({
      departement: "75",
      limit: 100,
      offset: 200,
    });
  });

  it("inclut périmètre Ameli libéraux conventionnés dans la description", () => {
    const tool = findTool("professionnels_par_specialite_dept");
    expect(tool?.description).toContain("libéraux conventionnés");
    expect(tool?.description).toContain("HORS PÉRIMÈTRE");
  });
});

describe("documentation tools Ameli — type_ps codes", () => {
  it("la description type_ps_codes est cohérente avec la nomenclature live (1, 2, 5)", () => {
    const tool = findTool("professionnels_in_radius");
    const arr = (tool?.inputSchema.properties as Record<string, { description: string }>)
      .type_ps_codes;
    expect(arr.description).toContain("'1'");
    expect(arr.description).toContain("'2'");
    expect(arr.description).toContain("'5'");
    expect(arr.description).toContain("auxiliaires médicaux");
    // Garde-fou anti-régression : les anciens codes faux ne doivent plus apparaître
    // dans la doc (cf. audit Charleville 2026-05-09 : '3 sage-femme', '4 chir-dentiste',
    // '8 kiné' n'existent pas dans la nomenclature Ameli).
    expect(arr.description).not.toMatch(/'3'\s*sage-femme/i);
    expect(arr.description).not.toMatch(/'4'\s*chir-dentiste/i);
    expect(arr.description).not.toMatch(/'8'\s*kiné/i);
  });

  it("la description du tool oriente vers specialite_codes pour ciblage précis", () => {
    const tool = findTool("professionnels_in_radius");
    expect(tool?.description).toMatch(/cibler une profession précise/i);
    expect(tool?.description).toContain("lister_specialites_ameli");
  });

  it("la description annonce explicitement le calcul haversine", () => {
    const tool = findTool("professionnels_in_radius");
    expect(tool?.description).toContain("haversine");
  });
});

describe("lister_specialites_ameli (MCP tool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré dans la liste des tools", () => {
    const tool = findTool("lister_specialites_ameli");
    expect(tool).toBeDefined();
    // Aucun paramètre requis : le tool retourne toute la nomenclature.
    expect(tool?.inputSchema.required).toBeUndefined();
  });

  it("délègue à listAmeliSpecialites et expose un count", async () => {
    const spy = vi.spyOn(ameliDb, "listAmeliSpecialites").mockResolvedValueOnce([
      {
        code: "24",
        libelle: "Infirmier",
        libelle_clarifie: "Infirmier",
        type_ps_code: "2",
        type_ps_libelle: "Autres PS (...)",
        count: 104041,
        is_libelle_partage: false,
      },
    ]);
    const tool = findTool("lister_specialites_ameli");
    const result = (await tool?.handler({})) as { count: number; results: unknown[] };
    expect(spy).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it("limit défaut tronque + expose total/truncated (B2)", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      code: String(i),
      libelle: `S${i}`,
      libelle_clarifie: `S${i}`,
      type_ps_code: "1",
      type_ps_libelle: "Médecins",
      count: 1000 - i,
      is_libelle_partage: false,
    }));
    vi.spyOn(ameliDb, "listAmeliSpecialites").mockResolvedValue(many);
    const tool = findTool("lister_specialites_ameli");
    const def = (await tool?.handler({})) as {
      count: number;
      total: number;
      truncated: boolean;
      results: unknown[];
    };
    expect(def.count).toBe(50);
    expect(def.total).toBe(60);
    expect(def.truncated).toBe(true);
    expect(def.results).toHaveLength(50);

    const all = (await tool?.handler({ limit: 1000 })) as { count: number; truncated: boolean };
    expect(all.count).toBe(60);
    expect(all.truncated).toBe(false);
  });
});

describe("lister_types_ps_ameli (MCP tool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré dans la liste des tools", () => {
    const tool = findTool("lister_types_ps_ameli");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toBeUndefined();
  });

  it("délègue à listAmeliTypesPs et expose specialites_presentes au caller", async () => {
    const spy = vi.spyOn(ameliDb, "listAmeliTypesPs").mockResolvedValueOnce([
      {
        code: "2",
        libelle_source: "Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…)",
        libelle_clarifie: "Auxiliaires médicaux (...)",
        count: 245990,
        specialites_presentes: [{ code: "24", libelle: "Infirmier", count: 104041 }],
      },
    ]);
    const tool = findTool("lister_types_ps_ameli");
    const result = (await tool?.handler({})) as {
      count: number;
      results: Array<{ specialites_presentes: unknown[] }>;
    };
    expect(spy).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
    expect(result.results[0]?.specialites_presentes).toHaveLength(1);
  });

  it("include_specialites=false remplace le sous-tableau par nb_specialites (B2)", async () => {
    vi.spyOn(ameliDb, "listAmeliTypesPs").mockResolvedValueOnce([
      {
        code: "2",
        libelle_source: "Autres PS",
        libelle_clarifie: "Auxiliaires médicaux",
        count: 245990,
        specialites_presentes: [
          { code: "24", libelle: "Infirmier", count: 104041 },
          { code: "26", libelle: "Kiné", count: 80000 },
        ],
      },
    ]);
    const tool = findTool("lister_types_ps_ameli");
    const result = (await tool?.handler({ include_specialites: false })) as {
      results: Array<{ specialites_presentes?: unknown[]; nb_specialites?: number }>;
    };
    expect(result.results[0]?.specialites_presentes).toBeUndefined();
    expect(result.results[0]?.nb_specialites).toBe(2);
  });
});

describe("coercition tolérante des nombres (asNumber)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepte les coordonnées passées en string par certains clients MCP", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliInRadius")
      .mockResolvedValueOnce({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_in_radius");
    // Cf. audit empirique 2026-05-08 : le client Claude Code transmet les
    // nombres comme strings via son transport JSON-RPC. La régression observée
    // ("lon et lat (number) requis") doit rester corrigée.
    await tool?.handler({ lon: "4.7203", lat: "49.7724", radius_km: "5" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        center: { lon: 4.7203, lat: 49.7724 },
        radiusKm: 5,
      }),
    );
  });

  it("rejette toujours les valeurs vraiment non-numériques", async () => {
    const tool = findTool("professionnels_in_radius");
    // Message actionnable précis (avec le nom du paramètre + valeur reçue) au
    // lieu du `/lon et lat/` générique : permet au caller MCP de diagnostiquer
    // la saisie fautive plutôt que deviner laquelle des 2 coords est en cause.
    await expect(tool?.handler({ lon: "abc", lat: "49.7" })).rejects.toThrow(/lon doit être/);
    await expect(tool?.handler({ lon: true, lat: 49.7 })).rejects.toThrow(/lon doit être/);
    await expect(tool?.handler({ lon: {}, lat: 49.7 })).rejects.toThrow(/lon doit être/);
  });
});

describe("dedupe_by_ps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePs(
    overrides: Partial<{
      id: number;
      nom: string;
      prenom: string;
      civilite: string;
      specCode: string;
      voie: string;
      raisonSociale: string | null;
    }>,
  ) {
    const o = {
      id: overrides.id ?? 1,
      nom: overrides.nom ?? "DUPONT",
      prenom: overrides.prenom ?? "JEAN",
      civilite: overrides.civilite ?? "M",
      specCode: overrides.specCode ?? "01",
      voie: overrides.voie ?? "RUE 1",
      raisonSociale: "raisonSociale" in overrides ? (overrides.raisonSociale ?? null) : null,
    };
    return {
      id: o.id,
      identite: { nom: o.nom, prenom: o.prenom, civilite: o.civilite },
      specialite: { code: o.specCode, libelle: "Médecin généraliste" },
      type_ps: { code: "1", libelle: "Médecin" },
      adresse: {
        voie: o.voie,
        code_postal: "08000",
        ville: "CHARLEVILLE",
        code_departement: "08",
        code_insee: "08105",
        raison_sociale: o.raisonSociale,
      },
      coords: { lat: 49.77, lon: 4.72 },
      distance_km: null,
      telephone: null,
      conventions: {
        secteur_code: "1",
        secteur_libelle: "Secteur 1",
        nature_exercice_code: null,
        nature_exercice_libelle: null,
        option_tarifaire_code: null,
        option_tarifaire_libelle: null,
      },
    };
  }

  it("regroupe les sites multiples d'un même praticien (rayon)", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValueOnce({
      count: 3,
      truncated: false,
      results: [
        makePs({ id: 1, voie: "RUE 1" }),
        makePs({ id: 2, voie: "RUE 2" }),
        makePs({ id: 3, nom: "MARTIN", prenom: "PAUL", voie: "RUE 3" }),
      ],
    });
    const tool = findTool("professionnels_in_radius");
    const result = (await tool?.handler({
      lon: 4.72,
      lat: 49.77,
      dedupe_by_ps: true,
    })) as { count: number; results: { sites: unknown[] }[] };
    expect(result.count).toBe(2); // DUPONT JEAN + MARTIN PAUL
    expect(result.results[0]?.sites).toHaveLength(2); // 2 adresses pour DUPONT
    expect(result.results[1]?.sites).toHaveLength(1); // 1 adresse pour MARTIN
  });

  it("regroupe un même PS exerçant sous deux raisons sociales distinctes (régression post-V0.10.6)", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValueOnce({
      count: 2,
      truncated: false,
      results: [
        makePs({ id: 1, voie: "RUE 1", raisonSociale: "SELARL CABINET A" }),
        makePs({ id: 2, voie: "RUE 2", raisonSociale: "SCM CENTRE B" }),
      ],
    });
    const tool = findTool("professionnels_in_radius");
    const result = (await tool?.handler({
      lon: 4.72,
      lat: 49.77,
      dedupe_by_ps: true,
    })) as {
      count: number;
      results: { sites: { adresse: { raison_sociale: string | null } }[] }[];
    };
    // Une SEULE personne (raison sociale exclue de la clé d'identité)…
    expect(result.count).toBe(1);
    expect(result.results[0]?.sites).toHaveLength(2);
    // …mais chaque site conserve sa propre raison sociale (pas de perte).
    const raisons = result.results[0]?.sites.map((s) => s.adresse.raison_sociale).sort();
    expect(raisons).toEqual(["SCM CENTRE B", "SELARL CABINET A"]);
  });

  it("différencie deux PS à même nom/prenom mais civilités distinctes", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValueOnce({
      count: 2,
      truncated: false,
      results: [makePs({ id: 1, civilite: "M" }), makePs({ id: 2, civilite: "Mme" })],
    });
    const tool = findTool("professionnels_in_radius");
    const result = (await tool?.handler({
      lon: 4.72,
      lat: 49.77,
      dedupe_by_ps: true,
    })) as { count: number };
    expect(result.count).toBe(2);
  });

  it("ne dédoublonne pas quand dedupe_by_ps est false ou omis", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValue({
      count: 2,
      truncated: false,
      results: [makePs({ id: 1 }), makePs({ id: 2 })],
    });
    const tool = findTool("professionnels_in_radius");
    const without = (await tool?.handler({ lon: 4.72, lat: 49.77 })) as { count: number };
    const explicit = (await tool?.handler({
      lon: 4.72,
      lat: 49.77,
      dedupe_by_ps: false,
    })) as { count: number };
    expect(without.count).toBe(2);
    expect(explicit.count).toBe(2);
  });

  it("propage truncated, expose rawCount, et ajoute un warning quand tronqué", async () => {
    // Cas réel : la dédup tourne sur un résultat tronqué amont. Le même PS
    // peut être à cheval sur 2 pages → faux positif côté unicité. Le warning
    // doit être surfacé pour que le caller paginate avant de cumuler.
    vi.spyOn(ameliDb, "getAmeliBySpecialiteDept").mockResolvedValueOnce({
      count: 100,
      truncated: true,
      results: [makePs({ id: 1 }), makePs({ id: 2 })],
    });
    const tool = findTool("professionnels_par_specialite_dept");
    const result = (await tool?.handler({ departement: "75", dedupe_by_ps: true })) as {
      count: number;
      rawCount: number;
      truncated: boolean;
      warning?: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(1); // 2 entrées, même PS dédupliqué
    expect(result.rawCount).toBe(100); // décompte amont préservé pour offset + rawCount
    expect(result.warning).toMatch(/Dédup partielle/);
  });

  it("n'ajoute pas de warning quand le résultat amont n'est pas tronqué", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValueOnce({
      count: 1,
      truncated: false,
      results: [makePs({ id: 1 })],
    });
    const tool = findTool("professionnels_in_radius");
    const result = (await tool?.handler({ lon: 4.72, lat: 49.77, dedupe_by_ps: true })) as {
      warning?: string;
    };
    expect(result.warning).toBeUndefined();
  });

  it("active la dédup avec une string 'true' (transport MCP qui stringifie les booleans)", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValueOnce({
      count: 2,
      truncated: false,
      results: [makePs({ id: 1, voie: "RUE 1" }), makePs({ id: 2, voie: "RUE 2" })],
    });
    const tool = findTool("professionnels_in_radius");
    const result = (await tool?.handler({
      lon: 4.72,
      lat: 49.77,
      dedupe_by_ps: "true",
    })) as { count: number };
    expect(result.count).toBe(1); // dédup activé via "true" string
  });

  it("rejette une valeur dedupe_by_ps non-coercible", async () => {
    const tool = findTool("professionnels_in_radius");
    await expect(tool?.handler({ lon: 4.72, lat: 49.77, dedupe_by_ps: "yes" })).rejects.toThrow(
      /dedupe_by_ps/,
    );
  });
});

describe("entreprises_in_radius — délégation proximité native (P3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const emptyResult = { total: 0, page: 1, perPage: 10, totalPages: 0, entreprises: [] };

  it("naf + lon/lat/radiusKm → délègue à searchEntreprises avec center (pas de reverseGeocode/Haversine)", async () => {
    const spy = vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(emptyResult);
    const reverseSpy = vi.spyOn(geocode, "reverseGeocode");
    const tool = findTool("entreprises_in_radius");
    await tool?.handler({ naf: "8690B", lon: 4.7192, lat: 49.7672, radiusKm: 5, perPage: 3 });

    expect(reverseSpy).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        naf: "8690B",
        center: { lon: 4.7192, lat: 49.7672 },
        radiusKm: 5,
        perPage: 3,
      }),
    );
  });

  it("q + lon/lat/radiusKm → propage la RangeError de searchEntreprises (proximité ≠ q)", async () => {
    vi.spyOn(dinum, "searchEntreprises").mockRejectedValue(
      new RangeError("/near_point ne supporte pas `q`"),
    );
    const tool = findTool("entreprises_in_radius");
    await expect(
      tool?.handler({ q: "biogroup", lon: 4.7192, lat: 49.7672, radiusKm: 5 }),
    ).rejects.toThrow(RangeError);
  });

  it("recherche administrative (naf + departement) inchangée", async () => {
    const spy = vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(emptyResult);
    const tool = findTool("entreprises_in_radius");
    await tool?.handler({ naf: "8690B", departement: "08" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ naf: "8690B", departement: "08" }));
  });
});

describe("coerceNumber loud-failure (silent default guard)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejette explicitement un radius_km non-coercible plutôt que tomber sur le default", async () => {
    // Audit silent-failure-hunter : `asNumber("50 km") ?? 5` substituait
    // silencieusement 5 km, masquant la saisie invalide. coerceNumber doit
    // throw, pas fallback.
    const tool = findTool("professionnels_in_radius");
    await expect(tool?.handler({ lon: 4.7, lat: 49.7, radius_km: "50 km" })).rejects.toThrow(
      /radius_km/,
    );
    await expect(tool?.handler({ lon: 4.7, lat: 49.7, radius_km: "abc" })).rejects.toThrow(
      /radius_km/,
    );
  });

  it("rejette un limit non-coercible plutôt que silencieusement défaut 100", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(tool?.handler({ categorie: "ehpad", limit: "abc" })).rejects.toThrow(/limit/);
  });

  it("garde le default quand le paramètre est absent (undefined/null)", async () => {
    const spy = vi
      .spyOn(ameliDb, "getAmeliInRadius")
      .mockResolvedValue({ count: 0, truncated: false, results: [] });
    const tool = findTool("professionnels_in_radius");
    await tool?.handler({ lon: 4.72, lat: 49.77 });
    await tool?.handler({ lon: 4.72, lat: 49.77, radius_km: null });
    expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ radiusKm: 5 }));
    expect(spy).toHaveBeenNthCalledWith(2, expect.objectContaining({ radiusKm: 5 }));
  });
});

// Boundary MCP→TS du filtre catégorie professionnelle RPPS. `buildCategorieCodes`
// est testé côté lib (`rpps-db.test.ts`) ; ici on verrouille la traduction
// flags MCP → array et le rejet du legacy `include_inactifs` (silent failure
// dual : un caller V0.5.4 cache hit recevait sinon `[C]` au lieu de `[C,M]`).

describe("categorieCodesFromArgs", () => {
  it("retourne Civils seuls quand aucun flag n'est passé", () => {
    expect(categorieCodesFromArgs({})).toEqual(["C"]);
  });

  it("ajoute Agents publics (M) quand include_agents_publics=true", () => {
    expect(categorieCodesFromArgs({ include_agents_publics: true })).toEqual(["C", "M"]);
  });

  it("ajoute Étudiants (E) quand include_etudiants=true", () => {
    expect(categorieCodesFromArgs({ include_etudiants: true })).toEqual(["C", "E"]);
  });

  it("inclut les 3 codes quand les 2 flags sont true", () => {
    expect(
      categorieCodesFromArgs({ include_etudiants: true, include_agents_publics: true }),
    ).toEqual(["C", "M", "E"]);
  });

  it('accepte la coercition string `"true"` / `"1"` (transports MCP qui stringifient)', () => {
    expect(categorieCodesFromArgs({ include_agents_publics: "true" })).toEqual(["C", "M"]);
    expect(categorieCodesFromArgs({ include_etudiants: "1" })).toEqual(["C", "E"]);
  });

  it("propage en RangeError une valeur ambiguë (mappé -32602 par api/mcp.ts)", () => {
    expect(() => categorieCodesFromArgs({ include_agents_publics: "yes" })).toThrow(RangeError);
    expect(() => categorieCodesFromArgs({ include_etudiants: 2 })).toThrow(RangeError);
  });

  it("rejette explicitement le legacy include_inactifs (V0.5.4 → V0.5.5 breaking)", () => {
    expect(() => categorieCodesFromArgs({ include_inactifs: true })).toThrow(/V0\.5\.5/);
    // Même `false` est rejeté : le caller doit migrer vers les nouveaux flags
    // pour ne pas continuer à propager une intention périmée.
    expect(() => categorieCodesFromArgs({ include_inactifs: false })).toThrow(/V0\.5\.5/);
  });
});

describe("etablissement_by_siret (MCP tool — V0.6.0)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré dans la liste des tools", () => {
    const tool = findTool("etablissement_by_siret");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["siret"]);
  });

  it("rejette un SIRET non 14 chiffres avec RangeError (loud failure)", async () => {
    const tool = findTool("etablissement_by_siret");
    await expect(tool?.handler({ siret: "12345" })).rejects.toThrow(RangeError);
    await expect(tool?.handler({ siret: "abcdefghijklmn" })).rejects.toThrow(RangeError);
    await expect(tool?.handler({ siret: "123456789012345" })).rejects.toThrow(RangeError); // 15 chars
  });

  it("rejette siret absent avec RangeError (cohérent convention -32602)", async () => {
    const tool = findTool("etablissement_by_siret");
    await expect(tool?.handler({})).rejects.toThrow(/siret/);
  });

  it("trim les whitespaces avant validation", async () => {
    const siret = "78712043500015";
    const spy = vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue({
      found: false,
      lookupStatus: "not_found",
      key: siret,
      message: "noop",
    });
    const tool = findTool("etablissement_by_siret");
    await tool?.handler({ siret: `  ${siret}  ` });
    expect(spy).toHaveBeenCalledWith(siret);
  });

  it("forward le SIRET validé à lookupSiretViaInsee + retourne le LookupResult tel quel", async () => {
    const siret = "78712043500015";
    const fakeFound = {
      found: true as const,
      lookupStatus: "found" as const,
      siret,
      siren: "787120435",
      raisonSocialeUniteLegale: "LABO ACME",
      enseigne: null,
      denominationUsuelle: null,
      naf: "86.90B",
      actif: true,
      dateCreation: "2020-01-01",
      dateFermeture: null,
      estSiege: true,
      trancheEffectif: "11",
      adresse: {
        libelle: "1 RUE TEST 75001 PARIS",
        numeroVoie: "1",
        typeVoie: "RUE",
        libelleVoie: "TEST",
        codePostal: "75001",
        libelleCommune: "PARIS",
        codeCommune: "75101",
      },
    };
    vi.spyOn(inseeSirene, "lookupSiretViaInsee").mockResolvedValue(fakeFound);
    const tool = findTool("etablissement_by_siret");
    await expect(tool?.handler({ siret })).resolves.toEqual(fakeFound);
  });
});

describe("rpps_search_by_name (MCP tool — V0.6.0)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré + nom requis", () => {
    const tool = findTool("rpps_search_by_name");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["nom"]);
  });

  it("rejette nom absent avec RangeError (loud failure)", async () => {
    const tool = findTool("rpps_search_by_name");
    await expect(tool?.handler({})).rejects.toThrow(RangeError);
    await expect(tool?.handler({ nom: "" })).rejects.toThrow(RangeError);
    await expect(tool?.handler({ nom: "   " })).rejects.toThrow(RangeError);
  });

  it("forward nom + prenom + dept + limit + categorieCodes default au wrapper TS", async () => {
    const spy = vi
      .spyOn(rppsDb, "getRppsByName")
      .mockResolvedValue({ count: 0, truncated: false, results: [] });
    const tool = findTool("rpps_search_by_name");
    await tool?.handler({ nom: "Martin", prenom: "Jean", departement: "75", limit: 10 });
    expect(spy).toHaveBeenCalledWith({
      nom: "Martin",
      prenom: "Jean",
      departement: "75",
      categorieCodes: ["C"],
      limit: 10,
    });
  });

  it("omet prenom/dept/limit quand absents mais inclut toujours categorieCodes default", async () => {
    const spy = vi
      .spyOn(rppsDb, "getRppsByName")
      .mockResolvedValue({ count: 0, truncated: false, results: [] });
    const tool = findTool("rpps_search_by_name");
    await tool?.handler({ nom: "Martin" });
    expect(spy).toHaveBeenCalledWith({ nom: "Martin", categorieCodes: ["C"] });
  });

  it("propage include_etudiants / include_agents_publics au wrapper TS", async () => {
    const spy = vi
      .spyOn(rppsDb, "getRppsByName")
      .mockResolvedValue({ count: 0, truncated: false, results: [] });
    const tool = findTool("rpps_search_by_name");
    await tool?.handler({ nom: "Martin", include_etudiants: true, include_agents_publics: true });
    expect(spy).toHaveBeenCalledWith({
      nom: "Martin",
      categorieCodes: ["C", "M", "E"],
    });
  });

  it("rejette limit non-coercible (silent default guard, cohérent autres tools)", async () => {
    const tool = findTool("rpps_search_by_name");
    await expect(tool?.handler({ nom: "Martin", limit: "abc" })).rejects.toThrow(/limit/);
  });
});

describe("data_freshness (MCP tool — V0.6.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré sans paramètre requis", () => {
    const tool = findTool("data_freshness");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toBeUndefined();
  });

  it("retourne un objet `{ sources: [...] }` listant les 3 sources DB-backed", async () => {
    vi.spyOn(ingestLog, "getDataFreshness").mockResolvedValue([
      {
        source: "finess",
        last_success_at: "2026-04-30T00:00:00Z",
        last_success_row_count: 90000,
        last_attempt_at: "2026-04-30T00:00:00Z",
        last_attempt_status: "success",
        staleness_days: 11,
        cadence_hint: "bimestrielle (~tous les 2 mois côté DREES)",
      },
      {
        source: "ameli_ps",
        last_success_at: "2026-05-10T00:00:00Z",
        last_success_row_count: 130000,
        last_attempt_at: "2026-05-10T00:00:00Z",
        last_attempt_status: "success",
        staleness_days: 1,
        cadence_hint: "hebdomadaire (côté Annuaire Santé Ameli)",
      },
      {
        source: "rpps",
        last_success_at: null,
        last_success_row_count: null,
        last_attempt_at: null,
        last_attempt_status: null,
        staleness_days: null,
        cadence_hint: "mensuelle (côté Annuaire Santé ANS)",
      },
    ]);

    const tool = findTool("data_freshness");
    const result = (await tool?.handler({})) as { sources: Array<{ source: string }> };
    expect(result.sources).toHaveLength(3);
    expect(result.sources.map((s) => s.source)).toEqual(["finess", "ameli_ps", "rpps"]);
  });

  it("propage les erreurs DB (pas de silent fallback)", async () => {
    vi.spyOn(ingestLog, "getDataFreshness").mockRejectedValue(new Error("DB down"));
    const tool = findTool("data_freshness");
    await expect(tool?.handler({})).rejects.toThrow(/DB down/);
  });
});

describe("verifier_site_actif (MCP tool — V0.6.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré avec num_finess requis", () => {
    const tool = findTool("verifier_site_actif");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["num_finess"]);
  });

  it("rejette num_finess absent avec RangeError", async () => {
    const tool = findTool("verifier_site_actif");
    await expect(tool?.handler({})).rejects.toThrow(/num_finess/);
  });

  it("forward num_finess à verifierSiteActif", async () => {
    const spy = vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue({
      found: false,
      key: "590048997",
      lookupStatus: "not_found",
      message: "introuvable",
    });
    const tool = findTool("verifier_site_actif");
    await tool?.handler({ num_finess: "590048997" });
    expect(spy).toHaveBeenCalledWith("590048997");
  });
});

describe("compare_raison_sociale_finess_vs_rpps (MCP tool — V0.6.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré avec num_finess requis", () => {
    const tool = findTool("compare_raison_sociale_finess_vs_rpps");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["num_finess"]);
  });

  it("rejette num_finess absent", async () => {
    const tool = findTool("compare_raison_sociale_finess_vs_rpps");
    await expect(tool?.handler({})).rejects.toThrow(/num_finess/);
  });

  it("forward au wrapper TS", async () => {
    const spy = vi.spyOn(crossSource, "compareRaisonSocialeFinessVsRpps").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      num_finess: "590048997",
      finess_raison_sociale: "DIAGNOVIE",
      rpps_raisons_sociales: ["BIOGROUP NORD"],
      statut: "divergent_after_normalization",
    });
    const tool = findTool("compare_raison_sociale_finess_vs_rpps");
    await tool?.handler({ num_finess: "590048997" });
    expect(spy).toHaveBeenCalledWith("590048997");
  });
});

describe("compare_adresse_cnam_vs_finess (MCP tool — P4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré avec num_finess requis", () => {
    const tool = findTool("compare_adresse_cnam_vs_finess");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["num_finess"]);
  });

  it("rejette num_finess absent", async () => {
    const tool = findTool("compare_adresse_cnam_vs_finess");
    await expect(tool?.handler({})).rejects.toThrow(/num_finess/);
  });

  it("forward au wrapper TS", async () => {
    const spy = vi.spyOn(crossSource, "compareAdresseCnamVsFiness").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      num_finess: "710015710",
      cnam_adresse: "5 RUE DE L'ARQUEBUSE 71400 AUTUN",
      finess_adresse: "15 BD BERNARD GIBERSTEIN 71400 AUTUN",
      score_dice: 0.42,
      statut: "divergent_after_normalization",
    });
    const tool = findTool("compare_adresse_cnam_vs_finess");
    await tool?.handler({ num_finess: "710015710" });
    expect(spy).toHaveBeenCalledWith("710015710");
  });
});

describe("historique_etablissement (MCP tool — V0.6.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré avec num_finess requis", () => {
    const tool = findTool("historique_etablissement");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["num_finess"]);
  });

  it("forward au wrapper TS", async () => {
    const spy = vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue({
      found: false,
      key: "590048997",
      lookupStatus: "not_found",
      message: "noop",
    });
    const tool = findTool("historique_etablissement");
    await tool?.handler({ num_finess: "590048997" });
    expect(spy).toHaveBeenCalledWith("590048997");
  });
});

describe("reconcilier_finess_sirene (MCP tool — V0.6.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("est enregistré avec num_finess requis", () => {
    const tool = findTool("reconcilier_finess_sirene");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["num_finess"]);
  });

  it("forward au wrapper TS", async () => {
    const spy = vi.spyOn(crossSource, "reconcilierFinessSirene").mockResolvedValue({
      found: true,
      lookupStatus: "found",
      num_finess: "590048997",
      candidates: [],
      skipped: [],
    });
    const tool = findTool("reconcilier_finess_sirene");
    await tool?.handler({ num_finess: "590048997" });
    expect(spy).toHaveBeenCalledWith("590048997");
  });
});

describe("outputSchema declarations (V0.7.5 MCP spec 2025-06-18 §6.3)", () => {
  it("expose un outputSchema sur les tools object-root (28 tools attendus)", () => {
    const withOutput = TOOLS.filter((t) => t.outputSchema !== undefined);
    // 34 tools après V0.10.4 (+ compare_adresse_cnam_vs_finess, audit P4)
    // - 3 spec-violating (autocomplete_commune array-root, geocode_adresse / reverse_geocode nullable)
    // - 3 V0.8 sans outputSchema (densite_professionnels_sante, densite_etablissements_sante,
    //   lister_specialites_medicales — objets riches imbriqués, schema détaillé reporté en V0.8.1)
    // = 28.
    expect(withOutput).toHaveLength(28);
  });

  it("omet volontairement l'outputSchema pour les tools array-root ou nullable", () => {
    // Spec MCP exige `type: "object"` littéral au root → ces 3 tools ne peuvent
    // pas déclarer un schema conforme et restent sans outputSchema (préférable
    // à un schema invalide qui ferait planter les clients stricts).
    for (const name of ["autocomplete_commune", "geocode_adresse", "reverse_geocode"]) {
      const tool = findTool(name);
      expect(tool?.outputSchema).toBeUndefined();
    }
  });

  it("chaque outputSchema déclaré a `type: object` (spec MCP 2025-06-18 §6.3)", () => {
    for (const tool of TOOLS) {
      if (tool.outputSchema === undefined) continue;
      expect(tool.outputSchema.type).toBe("object");
    }
  });
});

describe("densite_professionnels_sante — exemples savoir_faire_code (régression B4)", () => {
  const savoirFaireDesc = () => {
    const tool = findTool("densite_professionnels_sante");
    const props = tool?.inputSchema.properties as
      | Record<string, { description: string }>
      | undefined;
    return props?.savoir_faire_code?.description ?? "";
  };

  it("n'associe JAMAIS SM26 à la dermatologie (SM26 = médecine générale)", () => {
    expect(savoirFaireDesc()).not.toMatch(/SM26[^.]*[Dd]ermato/);
  });

  it("documente SM15 comme code dermato-vénéréologie", () => {
    expect(savoirFaireDesc()).toMatch(/SM15[^.]*[Dd]ermato/);
  });
});

describe("radius PS — distance non discriminante intra-commune (régression B5)", () => {
  for (const name of ["professionnels_in_radius", "professionnels_rpps_in_radius"]) {
    it(`${name} : la description explique geo_precision + distance identique par commune`, () => {
      const tool = findTool(name);
      expect(tool?.description).toMatch(/geo_precision/);
      expect(tool?.description).toMatch(/m[êe]me .*commune|ne (pas|discrimine)/i);
    });
  }
});

describe("collision nomenclatures Ameli/ANS (régression B3)", () => {
  for (const name of [
    "densite_professionnels_sante",
    "professionnels_rpps_par_dept",
    "professionnels_rpps_in_radius",
  ]) {
    it(`${name} avertit que les codes Ameli ≠ codes ANS`, () => {
      const tool = findTool(name);
      expect(tool?.description).toMatch(/Ameli/);
      expect(tool?.description).toMatch(/nomenclature|ANS/);
      expect(tool?.description).toMatch(/distincte|différent|ne (jamais|pas) (passer|confondre)/i);
    });
  }
});

describe("lister_specialites_medicales — limit + profession_code (B2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applique limit défaut, expose total/truncated et conserve profession_code", async () => {
    const many = Array.from({ length: 95 }, (_, i) => ({
      code: `SM${i}`,
      libelle: `Spé ${i}`,
      count_ps: 1000 - i,
    }));
    vi.spyOn(rppsDb, "listSavoirFaireRpps").mockResolvedValue(many);
    const tool = findTool("lister_specialites_medicales");
    const result = (await tool?.handler({})) as {
      count: number;
      total: number;
      truncated: boolean;
      profession_code: string | null;
      results: unknown[];
    };
    expect(result.count).toBe(50);
    expect(result.total).toBe(95);
    expect(result.truncated).toBe(true);
    expect(result.profession_code).toBe("10");
  });
});

describe("FINESS — note troncature raison_sociale (régression B6)", () => {
  for (const name of [
    "etablissement_by_finess",
    "etablissements_finess_in_radius",
    "etablissements_finess_by_categorie",
  ]) {
    it(`${name} signale que raison_sociale est abrégée en amont DREES`, () => {
      const tool = findTool(name);
      expect(tool?.description).toMatch(/raison.?social/i);
      expect(tool?.description).toMatch(/abrég|tronqu|38/i);
    });
  }
});

describe("rpps_search_by_name — désambiguïsation homonymes (régression B8)", () => {
  it("ne conseille pas de trier par match_score et oriente vers departement", () => {
    const tool = findTool("rpps_search_by_name");
    expect(tool?.description).not.toMatch(/match_score.{0,20}pour (trier|affiner)/i);
    expect(tool?.description).toMatch(/homonym/i);
    expect(tool?.description).toMatch(/departement|prénom/i);
    expect(tool?.description).toMatch(/truncated/);
  });
});

describe("data_freshness — schema paramètres explicite (régression B10)", () => {
  it("déclare additionalProperties:false (pas de schema vide ambigu)", () => {
    const tool = findTool("data_freshness");
    expect(tool?.inputSchema.additionalProperties).toBe(false);
  });
});

describe("geocode_adresse — interprétation du score (régression B1)", () => {
  it("la description explique le score et confidence_low", () => {
    const tool = findTool("geocode_adresse");
    expect(tool?.description).toMatch(/confidence_low/);
    expect(tool?.description).toMatch(/0\.5|douteux|incertain/i);
  });
});

describe("exemples code_insee PLM corrigés (régression P2)", () => {
  function descAndParam(name: string): string {
    const tool = findTool(name);
    const props = tool?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    return `${tool?.description ?? ""} ${props?.code_insee?.description ?? ""} ${props?.code?.description ?? ""}`;
  }

  for (const name of [
    "densite_professionnels_sante",
    "panorama_sante_territoire",
    "population_par_commune",
  ]) {
    it(`${name} : aucun code arrondissement PLM présenté comme exemple positif`, () => {
      const txt = descAndParam(name);
      // Un code arrondissement entre guillemets accolé à un nom de ville =
      // exemple d'usage trompeur (ex: "75108" Paris 8e). Les mentions de
      // plages dans un avertissement ("75101-75120") restent autorisées.
      expect(txt).not.toMatch(/"751(0[1-9]|1[0-9]|20)"/);
      expect(txt).not.toMatch(/"132(0[1-9]|1[0-6])"/);
      expect(txt).not.toMatch(/"693(8[1-9])"/);
    });
  }

  for (const name of ["densite_professionnels_sante", "panorama_sante_territoire"]) {
    it(`${name} : signale PLM non supporté + oriente code_dept`, () => {
      const d = findTool(name)?.description ?? "";
      expect(d).toMatch(/Paris|Lyon|Marseille/);
      expect(d).toMatch(/code_dept|département/i);
      expect(d).toMatch(/indisponible|non supporté|RangeError/i);
    });
  }
});
