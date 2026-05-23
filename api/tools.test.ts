import { afterEach, describe, expect, it, vi } from "vitest";
import * as ameliDb from "../src/sante/ameli-db.js";
import * as coverage from "../src/sante/coverage.js";
import * as crossSource from "../src/sante/cross-source.js";
import * as densite from "../src/sante/densite.js";
import * as finessDb from "../src/sante/finess-db.js";
import * as hostedActivities from "../src/sante/hosted-activities.js";
import * as dinum from "../src/sante/index.js";
import * as inseeSirene from "../src/sante/insee-sirene.js";
import * as panorama from "../src/sante/panorama.js";
import { finessFamillePerimetre } from "../src/sante/perimetre.js";
import * as rppsDb from "../src/sante/rpps-db.js";
import * as ingestLog from "../src/storage/ingest-log.js";
import * as geocode from "../src/territoire/geocode.js";
import {
  TOOLS,
  categorieCodesFromArgs,
  deptFromCommune,
  findTool,
  withPerimetre,
} from "./tools.js";

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
    // Phase 2 : pharmacie + dept = scope ZONE valide → le handler appelle
    // getHostedActivitiesInZone (pharmacie mappable). Mock pour éviter le
    // réseau (SUPABASE_URL missing en test unit).
    vi.spyOn(hostedActivities, "getHostedActivitiesInZone").mockResolvedValueOnce({
      activite: "pharmacie à usage intérieur",
      count: 0,
      note: "test-note",
      sites_apercu: [],
      truncated: false,
    });
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

  // === V0.13.0 Fix #5 — toggle includeDirigeants =============================

  const resultWithDirigeants = {
    total: 1,
    page: 1,
    perPage: 10,
    totalPages: 1,
    entreprises: [
      {
        siren: "507815942",
        nomComplet: "BIOGROUP NORD",
        naf: "8690B",
        finances: [],
        dirigeants: [
          { nom: "DURAND", prenoms: "JEAN", fonction: "PRESIDENT" },
          { nom: "MARTIN", prenoms: "ANNE", fonction: "DIRIGEANT" },
        ],
        actif: true,
        etablissements: [],
      },
    ],
  };

  it("Fix #5 — includeDirigeants=false strip la liste dirigeants côté handler", async () => {
    vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(resultWithDirigeants);
    const tool = findTool("entreprises_in_radius");
    const result = (await tool?.handler({
      naf: "8690B",
      lon: 4.72,
      lat: 49.77,
      radiusKm: 5,
      includeDirigeants: false,
    })) as typeof resultWithDirigeants;
    expect(result.entreprises[0]?.dirigeants).toEqual([]);
    // Reste du shape inchangé.
    expect(result.entreprises[0]?.siren).toBe("507815942");
    expect(result.entreprises[0]?.naf).toBe("8690B");
    expect(result.total).toBe(1);
  });

  it("Fix #5 — includeDirigeants par défaut true (backward-compat V0.12)", async () => {
    vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(resultWithDirigeants);
    const tool = findTool("entreprises_in_radius");
    // Param omis → dirigeants exposés (comportement V0.12 préservé).
    const result = (await tool?.handler({
      naf: "8690B",
      lon: 4.72,
      lat: 49.77,
      radiusKm: 5,
    })) as typeof resultWithDirigeants;
    expect(result.entreprises[0]?.dirigeants).toHaveLength(2);
  });

  it("Fix #5 — includeDirigeants=true explicite préserve la liste", async () => {
    vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(resultWithDirigeants);
    const tool = findTool("entreprises_in_radius");
    const result = (await tool?.handler({
      naf: "8690B",
      lon: 4.72,
      lat: 49.77,
      radiusKm: 5,
      includeDirigeants: true,
    })) as typeof resultWithDirigeants;
    expect(result.entreprises[0]?.dirigeants).toHaveLength(2);
  });

  it("Fix #5 — string 'false' strip dirigeants (intention respectée via coerceBoolean)", async () => {
    // V0.13.1 — uniformité avec les autres params booléens (precise_only,
    // dedupe_by_ps, etc.) qui passent par `coerceBoolean`. Un caller LLM qui
    // stringifie `"false"` (très fréquent en JSON tool-call) doit voir son
    // intention respectée — pas silencieusement ignorée.
    vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(resultWithDirigeants);
    const tool = findTool("entreprises_in_radius");
    const result = (await tool?.handler({
      naf: "8690B",
      lon: 4.72,
      lat: 49.77,
      radiusKm: 5,
      includeDirigeants: "false",
    })) as typeof resultWithDirigeants;
    expect(result.entreprises[0]?.dirigeants).toEqual([]);
  });

  it("Fix #5 — string 'true' / 0 / 1 reconnus (uniforme avec coerceBoolean)", async () => {
    vi.spyOn(dinum, "searchEntreprises").mockResolvedValue(resultWithDirigeants);
    const tool = findTool("entreprises_in_radius");
    // string "true" → boolean true → preserve dirigeants
    const r1 = (await tool?.handler({
      naf: "8690B",
      lon: 4.72,
      lat: 49.77,
      radiusKm: 5,
      includeDirigeants: "true",
    })) as typeof resultWithDirigeants;
    expect(r1.entreprises[0]?.dirigeants).toHaveLength(2);
    // 0 → boolean false → strip
    const r2 = (await tool?.handler({
      naf: "8690B",
      lon: 4.72,
      lat: 49.77,
      radiusKm: 5,
      includeDirigeants: 0,
    })) as typeof resultWithDirigeants;
    expect(r2.entreprises[0]?.dirigeants).toEqual([]);
  });

  it("Fix #5 — input booléen mal typé throw RangeError (anti-silent-failure)", async () => {
    // Garbage (objet, string non-coerciable) DOIT throw RangeError → mappé
    // JSON-RPC `-32602 invalid_params` côté boundary MCP. Le caller reçoit un
    // retour explicite plutôt qu'un comportement silencieusement par défaut.
    // Cohérent avec `coerceNumber` (test `coerceNumber loud-failure`).
    const tool = findTool("entreprises_in_radius");
    await expect(
      tool?.handler({
        naf: "8690B",
        lon: 4.72,
        lat: 49.77,
        radiusKm: 5,
        includeDirigeants: "maybe",
      }),
    ).rejects.toThrow(/includeDirigeants/);
    await expect(
      tool?.handler({
        naf: "8690B",
        lon: 4.72,
        lat: 49.77,
        radiusKm: 5,
        includeDirigeants: { foo: 1 },
      }),
    ).rejects.toThrow(/includeDirigeants/);
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

describe("radius PS — geo_precision documenté (régression B5 V0.12.0)", () => {
  it("professionnels_in_radius (Ameli) : description documente la précision géo HYBRIDE (2 valeurs geo_precision + split ~77/~23 post-Chantier C)", () => {
    const tool = findTool("professionnels_in_radius");
    expect(tool?.description).toMatch(/geo_precision/);
    // Chantier C V0.14.0 — Ameli n'est plus 100 % centroïde commune : ~77 %
    // des PS sont géocodés à l'adresse BAN. La description DOIT exposer les 2
    // valeurs canoniques, sinon un LLM lisant la description au tool-discovery
    // croit les coords Ameli inexploitables et sous-utilise la donnée précise.
    expect(tool?.description).toContain("adresse");
    expect(tool?.description).toContain("centroide_commune");
    // Ameli n'a PAS de FINESS join (≠ RPPS) — la 3e valeur geo_precision RPPS
    // ne doit jamais être copiée ici (faux contrat de précision au site FINESS).
    expect(tool?.description).not.toContain("etablissement_finess");
    // Le split doit rester chiffré (~77 % adresse précise / ~23 % centroïde
    // résiduel) : un LLM doit savoir que la majorité des coords sont exactes.
    expect(tool?.description).toMatch(/77\s*%/);
    expect(tool?.description).toMatch(/23\s*%/);
    // L'avertissement intra-commune reste pertinent UNIQUEMENT pour la branche
    // centroïde résiduelle (distance_km non discriminante pour les PS d'une
    // même commune) — pas pour la branche `adresse` précise.
    expect(tool?.description).toMatch(/m[êe]me commune|intra-commune/i);
    // Le param `precise_only` doit être NARRÉ (pas juste nommé) : un LLM doit
    // savoir QUAND l'activer (à true → exclut le centroïde, rayons courts).
    expect(tool?.description).toMatch(/precise_only/);
    expect(tool?.description).toMatch(/precise_only.*(true|exclut|recommand)/i);
  });

  it("professionnels_in_radius : inputSchema expose precise_only:boolean (default false)", () => {
    const tool = findTool("professionnels_in_radius");
    const props = tool?.inputSchema.properties as
      | Record<string, { type: string; description: string; default?: boolean }>
      | undefined;
    expect(props?.precise_only?.type).toBe("boolean");
    expect(props?.precise_only?.default).toBe(false);
    // La description du param décrit l'EFFET sans re-documenter tout le tool
    // (anti-drift inter-edits — jumeau du garde-fou RPPS precise_only).
    const desc = props?.precise_only?.description ?? "";
    expect(desc, "doit nommer l'action d'exclusion").toMatch(/exclut|exclu/i);
    expect(desc, "doit nommer ce qui est exclu (centroïde commune, ï accentué OK)").toMatch(
      /centro[iï]de\s+commune/i,
    );
    expect(desc, "doit nommer le gain (distance_km exacte)").toMatch(/distance_km/);
    expect(desc, "doit expliciter le défaut false").toMatch(/d[ée]faut\s+false/i);
    expect(desc.length, "anti-rebond drift : param ne doit pas re-documenter le tool").toBeLessThan(
      300,
    );
  });

  it("professionnels_rpps_in_radius (V0.12.0) : description documente les 3 valeurs geo_precision + narration precise_only", () => {
    const tool = findTool("professionnels_rpps_in_radius");
    expect(tool?.description).toMatch(/geo_precision/);
    // Les 3 valeurs publiques doivent apparaître pour éclairer le LLM caller.
    expect(tool?.description).toContain("adresse");
    expect(tool?.description).toContain("etablissement_finess");
    expect(tool?.description).toContain("centroide_commune");
    // Narration utile de `precise_only` (pas juste le mot) : un dev qui retire
    // l'explication mais garde le nom de param ferait silencieusement perdre
    // au LLM la connaissance du quand-l'activer (M2 silent-failure-hunter).
    expect(tool?.description).toMatch(/precise_only.*(true|exclut|forcer|100\s*%)/i);
    expect(tool?.description).toMatch(/31[,.]5\s*%/); // taux de centroïde résiduel
    // L'avertissement intra-commune reste pertinent UNIQUEMENT pour la branche
    // centroïde résiduelle (mode hybride). Une régression qui retire la
    // narration "même commune" ferait perdre cette nuance au caller.
    expect(tool?.description).toMatch(/m[êe]me commune|intra-commune/i);
  });

  it("professionnels_rpps_in_radius : inputSchema expose precise_only:boolean (default false)", () => {
    const tool = findTool("professionnels_rpps_in_radius");
    const props = tool?.inputSchema.properties as
      | Record<string, { type: string; description: string; default?: boolean }>
      | undefined;
    expect(props?.precise_only?.type).toBe("boolean");
    expect(props?.precise_only?.default).toBe(false);
    // V0.12.1 — la description du param décrit l'EFFET du switch sans
    // re-documenter la sémantique complète du tool (anti-drift inter-edits).
    // Le regex précédent `/centroide commune|distance_km/i` était tautologique :
    // (1) `centroide` sans accent ne matche pas `centroïde` (ï) de la description ;
    // (2) `distance_km` apparaît partout côté tools.ts. → 4 assertions
    // structurelles d'intention + borne anti-rebond drift.
    const desc = props?.precise_only?.description ?? "";
    expect(desc, "doit nommer l'action d'exclusion").toMatch(/exclut|exclu/i);
    expect(desc, "doit nommer ce qui est exclu (centroïde commune, ï accentué OK)").toMatch(
      /centro[iï]de\s+commune/i,
    );
    expect(desc, "doit nommer le gain (distance_km exacte)").toMatch(/distance_km/);
    expect(desc, "doit expliciter le défaut false").toMatch(/d[ée]faut\s+false/i);
    expect(desc.length, "anti-rebond drift : param ne doit pas re-documenter le tool").toBeLessThan(
      300,
    );
  });

  // M3 silent-failure-hunter : asymétrie corrigée — les 4 tools RPPS de
  // listing/lookup vérifient TOUS la présence des 3 valeurs canoniques
  // (pas juste le mot `geo_precision` qui laissait passer une description
  // appauvrie à `"NB: champ geo_precision présent."`).
  //
  // V0.12.1 : les 3 tools listés consomment désormais TOUS le constant
  // `RPPS_GEO_PRECISION_HINT` (DRY). Une régression sur la constante
  // propagerait silencieusement sur les 3 sites — cette boucle est le
  // garde-fou central, complété par un test direct sur la constante (cf.
  // « RPPS_GEO_PRECISION_HINT constant »).
  const TOOLS_VERIFYING_3_VALUES = [
    "professionnels_rpps_par_dept",
    "rpps_search_by_name",
    "professionnel_by_rpps",
  ] as const;

  for (const name of TOOLS_VERIFYING_3_VALUES) {
    it(`${name} : description mentionne les 3 valeurs canoniques geo_precision`, () => {
      const tool = findTool(name);
      expect(tool?.description).toMatch(/geo_precision/);
      expect(tool?.description).toContain("adresse");
      expect(tool?.description).toContain("etablissement_finess");
      expect(tool?.description).toContain("centroide_commune");
    });
  }

  // V0.12.1 silent-failure-hunter I2 — garde explicite sur la constante
  // partagée par les 3 tools. Sans ce test, un dev qui modifie la constante
  // pour retirer/renommer UNE valeur propagerait silencieusement aux 3
  // consommateurs simultanément (impossible à distinguer d'un edit volontaire).
  it("RPPS_GEO_PRECISION_HINT : les 3 valeurs canoniques + nuance ~3 km centroïde présentes dans les 3 callsites", () => {
    const hintConsumers = [
      "professionnels_rpps_par_dept",
      "rpps_search_by_name",
      "professionnel_by_rpps",
    ];
    for (const name of hintConsumers) {
      const desc = findTool(name)?.description ?? "";
      // Les 3 valeurs canoniques arrivent par le hint partagé.
      expect(desc, `${name} doit contenir adresse`).toContain("adresse");
      expect(desc, `${name} doit contenir etablissement_finess`).toContain("etablissement_finess");
      expect(desc, `${name} doit contenir centroide_commune`).toContain("centroide_commune");
      // Garde le ~3 km (chiffre stable du contrat — un changement = update
      // délibéré, jamais un drift inter-edits).
      expect(desc, `${name} doit garder la nuance ~3 km centroïde`).toMatch(
        /centro[iï]de\s+commune.*~?\s*3\s*km/i,
      );
    }
  });

  it("professionnel_by_rpps : description précise la sémantique par-site (PS multi-sites)", () => {
    const tool = findTool("professionnel_by_rpps");
    expect(tool?.description).toMatch(/site/);
  });

  // V0.12.1 silent-failure-hunter S3 — verrouille l'invariant « rpps_dans_etablissement
  // documente coords:null + pointe le pivot géoloc ». Un dev qui simplifie la
  // description en futur edit pourrait retirer cette ligne sans rien casser
  // (asymétrie LLM des 5 tools RPPS = par_dept/search_by_name/by_rpps/in_radius
  // exposent geo_precision, dans_etablissement non — il DOIT documenter pourquoi).
  it("rpps_dans_etablissement : description annonce coords/distance_km = null + pointe etablissement_by_finess", () => {
    const desc = findTool("rpps_dans_etablissement")?.description ?? "";
    expect(desc, "doit annoncer null sur coords/distance_km").toMatch(
      /(coords|distance_km).*null|null.*(coords|distance_km)/i,
    );
    expect(desc, "doit pointer le pivot géoloc").toContain("etablissement_by_finess");
  });

  // /review P2 S2 silent-failure-hunter — test bout-en-bout boundary MCP :
  // un caller JSON-RPC envoyant `precise_only: "yes"` (non reconnu par
  // `coerceBoolean`) doit recevoir une RangeError actionnable au lieu de
  // retomber silencieusement en mode hybride. Couvre la classe que
  // `coerceBoolean(args.precise_only, ...)` ferme par construction.
  it("professionnels_rpps_in_radius : precise_only non reconnu → RangeError au boundary handler (silent failure fermé)", async () => {
    const tool = findTool("professionnels_rpps_in_radius");
    await expect(
      tool?.handler({
        center: { lat: 48.85, lon: 2.35 },
        radius_km: 5,
        precise_only: "yes",
      }),
    ).rejects.toThrow(RangeError);
  });

  it("professionnels_rpps_in_radius : precise_only stringifié reconnu (`'true'`/`'1'`) → accepté (compat JSON-RPC)", async () => {
    // Cohérent avec coerceBoolean : "true"/"1" sont des inputs JSON-RPC
    // stringifiés courants. Throw une RangeError ici régresserait un usage
    // légitime. On vérifie juste que le handler n'avale pas — passer un
    // mock supabase coûteux serait excessif (la lib est testée séparément
    // dans rpps-db.test.ts). On accepte un échec downstream (env DB absent)
    // qui prouve que le boundary a passé sans throw RangeError.
    const tool = findTool("professionnels_rpps_in_radius");
    let caughtError: unknown;
    try {
      await tool?.handler({
        center: { lat: 48.85, lon: 2.35 },
        radius_km: 5,
        precise_only: "true",
      });
    } catch (e) {
      caughtError = e;
    }
    // Si erreur, ce n'est PAS une RangeError sur precise_only.
    if (caughtError instanceof RangeError) {
      expect(caughtError.message).not.toMatch(/precise_only/);
    }
  });

  // Jumeau Ameli des 2 tests boundary RPPS ci-dessus — `professionnels_in_radius`
  // (Ameli) prend `lon`/`lat` à plat (≠ `center` imbriqué côté RPPS).
  it("professionnels_in_radius : precise_only non reconnu → RangeError au boundary handler (silent failure fermé)", async () => {
    const tool = findTool("professionnels_in_radius");
    await expect(
      tool?.handler({
        lon: 2.35,
        lat: 48.85,
        radius_km: 5,
        precise_only: "yes",
      }),
    ).rejects.toThrow(RangeError);
  });

  it("professionnels_in_radius : precise_only stringifié reconnu (`'true'`/`'1'`) → accepté (compat JSON-RPC)", async () => {
    // Cohérent avec coerceBoolean : "true"/"1" sont des inputs JSON-RPC
    // stringifiés courants. On vérifie juste que le boundary handler n'avale
    // pas — un échec downstream (env DB absent) est acceptable et prouve que
    // le boundary a passé sans throw RangeError sur precise_only.
    const tool = findTool("professionnels_in_radius");
    let caughtError: unknown;
    try {
      await tool?.handler({ lon: 2.35, lat: 48.85, radius_km: 5, precise_only: "true" });
    } catch (e) {
      caughtError = e;
    }
    if (caughtError instanceof RangeError) {
      expect(caughtError.message).not.toMatch(/precise_only/);
    }
  });
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

describe("perimetre wiring professionnels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("professionnels_in_radius expose perimetre.lens === 'liberal_conventionne' (AMELI_PERIMETRE)", async () => {
    vi.spyOn(ameliDb, "getAmeliInRadius").mockResolvedValueOnce({
      count: 0,
      truncated: false,
      results: [],
    });
    const tool = findTool("professionnels_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ lon: 2.35, lat: 48.85 })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("liberal_conventionne");
  });

  it("professionnels_par_specialite_dept expose perimetre.lens === 'liberal_conventionne' (AMELI_PERIMETRE)", async () => {
    vi.spyOn(ameliDb, "getAmeliBySpecialiteDept").mockResolvedValueOnce({
      count: 3,
      truncated: false,
      results: [],
    });
    const tool = findTool("professionnels_par_specialite_dept");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ departement: "59" })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("liberal_conventionne");
    expect(out?.count).toBe(3);
  });

  it("professionnels_rpps_in_radius expose perimetre.lens === 'registre_complet' (RPPS_PERIMETRE)", async () => {
    vi.spyOn(rppsDb, "getRppsInRadius").mockResolvedValueOnce({
      count: 0,
      truncated: false,
      results: [],
    });
    const tool = findTool("professionnels_rpps_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({
      center: { lat: 48.85, lon: 2.35 },
      radius_km: 5,
    })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("registre_complet");
  });

  it("professionnels_rpps_par_dept expose perimetre.lens === 'registre_complet' (RPPS_PERIMETRE)", async () => {
    vi.spyOn(rppsDb, "getRppsParSpecialiteDept").mockResolvedValueOnce({
      count: 5,
      truncated: false,
      results: [],
    });
    const tool = findTool("professionnels_rpps_par_dept");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ departement: "59" })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("registre_complet");
    expect(out?.count).toBe(5);
  });
});

describe("perimetre wiring FINESS / densité / panorama / coverage", () => {
  // Couverture handler-level des tools câblés en Task 3. Verrouille que
  // `perimetre` survit jusqu'à la sortie du handler — un `await` manquant
  // avant `withFreshness` spreadait une Promise et jetait `perimetre`
  // silencieusement (bug latent des 2 tools FINESS). Chaque test asserte
  // AUSSI une clé de données pour catcher l'inverse (perte du payload).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("etablissements_finess_in_radius expose perimetre + préserve count", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 7,
      truncated: false,
      results: [],
    });
    const tool = findTool("etablissements_finess_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ lon: 2.35, lat: 48.85 })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("categorie_dominante");
    expect(out?.count).toBe(7);
  });

  it("etablissements_finess_by_categorie expose perimetre + préserve count", async () => {
    vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({
      count: 4,
      truncated: false,
      results: [],
    });
    const tool = findTool("etablissements_finess_by_categorie");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ categorie: "labo" })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("categorie_dominante");
    expect(out?.count).toBe(4);
  });

  it("densite_etablissements_sante expose perimetre + préserve le payload", async () => {
    const mocked = { zone: { densite: 12.3 } } as Awaited<
      ReturnType<typeof densite.densiteEtablissementsSante>
    >;
    vi.spyOn(densite, "densiteEtablissementsSante").mockResolvedValueOnce(mocked);
    // Phase 2 : labo + dept déclenche désormais getHostedActivitiesInZone
    // (labo mappable + scope ZONE). Mock pour éviter le réseau.
    vi.spyOn(hostedActivities, "getHostedActivitiesInZone").mockResolvedValueOnce({
      activite: "biologie médicale",
      count: 0,
      note: "test-note",
      sites_apercu: [],
      truncated: false,
    });
    const tool = findTool("densite_etablissements_sante");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ code_dept: "59", famille: "labo" })) as Record<
      string,
      unknown
    >;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("categorie_dominante");
    expect(out?.zone).toEqual({ densite: 12.3 });
  });

  it("densite_professionnels_sante expose perimetre + préserve le payload", async () => {
    const mocked = { zone: { densite: 45.6 } } as Awaited<
      ReturnType<typeof densite.densiteProfessionnelsSante>
    >;
    vi.spyOn(densite, "densiteProfessionnelsSante").mockResolvedValueOnce(mocked);
    const tool = findTool("densite_professionnels_sante");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ code_dept: "59" })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("registre_complet");
    expect(out?.zone).toEqual({ densite: 45.6 });
  });

  it("panorama_sante_territoire expose perimetre + préserve le payload", async () => {
    const mocked = { codeInsee: "59009" } as Awaited<
      ReturnType<typeof panorama.panoramaSanteTerritoire>
    >;
    vi.spyOn(panorama, "panoramaSanteTerritoire").mockResolvedValueOnce(mocked);
    // Phase 2 : DEFAULT_FAMILLES contient labo + pharmacie (mappables) →
    // 2 appels parallèles à getHostedActivitiesInZone. mockResolvedValue
    // (sans Once) couvre les 2 appels.
    vi.spyOn(hostedActivities, "getHostedActivitiesInZone").mockResolvedValue({
      activite: "test",
      count: 0,
      note: "test-note",
      sites_apercu: [],
      truncated: false,
    });
    const tool = findTool("panorama_sante_territoire");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ code_insee: "59009" })) as Record<string, unknown>;
    // Panorama reçoit `finessFamillePerimetre` (volet établissements) → lentille
    // catégorie, PAS registre_complet.
    const perimetre = out?.perimetre as Record<string, unknown>;
    expect(perimetre?.lens).toBe("categorie_dominante");
    expect(out?.codeInsee).toBe("59009");
    // Fix A : sur le chemin par défaut (finess_familles omis), la lib compte
    // DEFAULT_FAMILLES — le `compte` doit refléter ces familles précises, pas
    // annoncer « tous les établissements FINESS » (sur-comptage silencieux).
    expect(perimetre?.compte).not.toMatch(/tous/i);
  });

  it("finess_sirene_coverage_in_radius expose perimetre + préserve le payload", async () => {
    const mocked = { coverage_ratio: 0.5 } as Awaited<
      ReturnType<typeof coverage.getCoverageFinessVsSireneInRadius>
    >;
    vi.spyOn(coverage, "getCoverageFinessVsSireneInRadius").mockResolvedValueOnce(mocked);
    const tool = findTool("finess_sirene_coverage_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ lon: 2.35, lat: 48.85, naf: "8690B" })) as Record<
      string,
      unknown
    >;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("categorie_dominante");
    expect(out?.coverage_ratio).toBe(0.5);
  });

  it("finess_sirene_coverage_in_radius — perimetre reflète l'auto-derive NAF→familles (pas 'tous')", async () => {
    // Cas nominal : caller omet `familles`, la lib auto-dérive depuis le NAF
    // (ex. 8690B → ['labo']) et l'expose dans `familles_auto_derivees`. Le
    // handler DOIT consommer ce champ pour que `perimetre.compte` reflète
    // le scope réellement compté — sinon surdéclaration silencieuse (même
    // bug que panorama V0.17, commit e306104).
    const mocked = {
      finess_sites: 7,
      sirene_sirets: 9,
      matched_count: 6,
      coverage_ratio: 0.86,
      matched_samples: [],
      finess_only_samples: [],
      sirene_only_samples: [],
      methodology: "...",
      caveats: [],
      coverage_status: "ok",
      familles_auto_derivees: ["labo"],
    } as unknown as Awaited<ReturnType<typeof coverage.getCoverageFinessVsSireneInRadius>>;
    vi.spyOn(coverage, "getCoverageFinessVsSireneInRadius").mockResolvedValueOnce(mocked);
    // Phase 2 : auto-derive ['labo'] (single mappable) déclenche désormais
    // getHostedActivitiesInRadius (biologie). Mock pour éviter le réseau.
    vi.spyOn(hostedActivities, "getHostedActivitiesInRadius").mockResolvedValueOnce({
      activite: "biologie médicale",
      count: 0,
      note: "test-note",
      sites_apercu: [],
      truncated: false,
    });
    const tool = findTool("finess_sirene_coverage_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ lon: 2.35, lat: 48.85, naf: "8690B" })) as Record<
      string,
      unknown
    >;
    const perimetre = out?.perimetre as Record<string, unknown>;
    expect(perimetre?.compte).toContain("labo");
    expect(perimetre?.compte).not.toMatch(/tous/i);
  });

  it("panorama_sante_territoire avec finess_familles=[] expose perimetre.lens === 'registre_complet'", async () => {
    // Special-case : `finess_familles: []` désactive le volet FINESS (la lib
    // retourne `etablissementsParFamille: []`) → le panorama ne décrit plus
    // que population + densités RPPS, donc `perimetre` doit basculer sur
    // RPPS_PERIMETRE (pas annoncer une lentille FINESS vide).
    const mocked = {
      codeInsee: "59350",
      niveau: "commune",
      niveauEtablissements: "indisponible",
      densitesProfessionnels: { medecins: null, infirmiers: null, pharmaciens: null },
      etablissementsParFamille: [],
      sources: [],
    } as unknown as Awaited<ReturnType<typeof panorama.panoramaSanteTerritoire>>;
    vi.spyOn(panorama, "panoramaSanteTerritoire").mockResolvedValueOnce(mocked);
    const tool = findTool("panorama_sante_territoire");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({
      code_insee: "59350",
      finess_familles: [],
    })) as Record<string, unknown>;
    expect((out?.perimetre as Record<string, unknown>)?.lens).toBe("registre_complet");
  });
});

describe("withPerimetre (helper de câblage)", () => {
  it("ajoute le champ perimetre sans muter les autres clés du résultat", () => {
    const result = { count: 3, results: [] };
    const perimetre = finessFamillePerimetre(["labo"]);
    const out = withPerimetre(result, perimetre);
    expect(out).toEqual({ count: 3, results: [], perimetre });
    expect(out.count).toBe(3);
    expect(out.perimetre).toBe(perimetre);
  });

  it("ne mute pas l'objet d'entrée (retourne une copie)", () => {
    const result = { count: 1, results: [{ id: 1 }] };
    const out = withPerimetre(result, finessFamillePerimetre(undefined));
    expect(out).not.toBe(result);
    expect(result).not.toHaveProperty("perimetre");
  });

  it("propage le descripteur famille-aware tel quel (note + lens)", () => {
    const perimetre = finessFamillePerimetre(["labo"]);
    const out = withPerimetre({ count: 0, results: [] }, perimetre);
    expect(out.perimetre.lens).toBe("categorie_dominante");
    expect(out.perimetre.completeness_note).toMatch(/hospitali/i);
  });
});

// Phase 2 — câblage du champ `activite_hebergee` sur les tools `etablissements_finess_*`.
// 4 cas couverts : 1 famille mappable (chemin nominal), multi-familles (omis),
// famille non-mappable (omis), by_categorie sans scope zone (omis).
describe("activite_hebergee wiring — etablissements_finess_*", () => {
  afterEach(() => vi.restoreAllMocks());

  it("etablissements_finess_in_radius famille=labo expose activite_hebergee biologie (chemin nominal)", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 12,
      truncated: false,
      results: [],
    } as unknown as Awaited<ReturnType<typeof finessDb.getFinessInRadius>>);
    vi.spyOn(hostedActivities, "getHostedActivitiesInRadius").mockResolvedValueOnce({
      activite: "biologie médicale",
      count: 5,
      note: "Plateaux techniques de biologie hébergés — Ne pas additionner les deux comptes sans préciser leur nature.",
      sites_apercu: [],
      truncated: false,
    });
    const tool = findTool("etablissements_finess_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({
      lat: 50.63,
      lon: 3.06,
      familles: ["labo"],
      radius_km: 5,
    })) as Record<string, unknown>;
    expect(out.count).toBe(12);
    const hosted = out.activite_hebergee as { activite: string; count: number; note: string };
    expect(hosted.count).toBe(5);
    expect(hosted.activite).toBe("biologie médicale");
    expect(hosted.note).toMatch(/[Nn]e pas additionner/);
  });

  it("multi-familles → activite_hebergee absent (sémantique ambiguë)", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 0,
      truncated: false,
      results: [],
    } as unknown as Awaited<ReturnType<typeof finessDb.getFinessInRadius>>);
    // PAS de spy sur getHostedActivitiesInRadius : si appelé, ça throw réseau.
    const tool = findTool("etablissements_finess_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({
      lat: 50.63,
      lon: 3.06,
      familles: ["labo", "pharmacie"],
      radius_km: 5,
    })) as Record<string, unknown>;
    expect(out.activite_hebergee).toBeUndefined();
  });

  it("famille sans hosted (ex. ehpad) → activite_hebergee absent", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 0,
      truncated: false,
      results: [],
    } as unknown as Awaited<ReturnType<typeof finessDb.getFinessInRadius>>);
    const tool = findTool("etablissements_finess_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({
      lat: 50.63,
      lon: 3.06,
      familles: ["ehpad"],
      radius_km: 5,
    })) as Record<string, unknown>;
    expect(out.activite_hebergee).toBeUndefined();
  });

  it("etablissements_finess_by_categorie sans dept ni commune → activite_hebergee absent (pas de scope zone)", async () => {
    vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({
      count: 4112,
      truncated: false,
      results: [],
    } as unknown as Awaited<ReturnType<typeof finessDb.getFinessByCategorie>>);
    const tool = findTool("etablissements_finess_by_categorie");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ categorie: "labo" })) as Record<string, unknown>;
    expect(out.count).toBe(4112);
    expect(out.activite_hebergee).toBeUndefined();
  });

  it("panorama_sante_territoire expose activites_hebergees_par_famille pour les familles mappables uniquement", async () => {
    vi.spyOn(panorama, "panoramaSanteTerritoire").mockResolvedValueOnce({
      codeInsee: "59009",
    } as Awaited<ReturnType<typeof panorama.panoramaSanteTerritoire>>);
    // DEFAULT_FAMILLES = [labo, pharmacie, ehpad, mco, msp_cpts] →
    // mappables : labo (biologie), pharmacie (PUI). Non mappables : ehpad,
    // mco, msp_cpts. Donc 2 appels parallèles à getHostedActivitiesInZone.
    vi.spyOn(hostedActivities, "getHostedActivitiesInZone")
      .mockResolvedValueOnce({
        activite: "biologie médicale",
        count: 5,
        note: "Plateaux ... Ne pas additionner les deux comptes sans préciser leur nature.",
        sites_apercu: [],
        truncated: false,
      })
      .mockResolvedValueOnce({
        activite: "pharmacie à usage intérieur",
        count: 3,
        note: "PUI ... Ne pas additionner les deux comptes sans préciser leur nature.",
        sites_apercu: [],
        truncated: false,
      });
    const tool = findTool("panorama_sante_territoire");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ code_insee: "59009" })) as Record<string, unknown>;
    const dict = out.activites_hebergees_par_famille as Record<
      string,
      { activite: string; count: number }
    >;
    expect(dict).toBeDefined();
    expect(Object.keys(dict).sort()).toEqual(["labo", "pharmacie"]);
    expect(dict.labo?.count).toBe(5);
    expect(dict.pharmacie?.count).toBe(3);
    // ehpad/mco/msp_cpts (non mappables) absents
    expect(dict.ehpad).toBeUndefined();
    expect(dict.mco).toBeUndefined();
    expect(dict.msp_cpts).toBeUndefined();
  });

  it("panorama_sante_territoire finess_familles=[] → activites_hebergees_par_famille absent (volet désactivé)", async () => {
    vi.spyOn(panorama, "panoramaSanteTerritoire").mockResolvedValueOnce({
      codeInsee: "59009",
    } as Awaited<ReturnType<typeof panorama.panoramaSanteTerritoire>>);
    const tool = findTool("panorama_sante_territoire");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ code_insee: "59009", finess_familles: [] })) as Record<
      string,
      unknown
    >;
    expect(out.activites_hebergees_par_famille).toBeUndefined();
  });

  it("finess_sirene_coverage_in_radius famille=labo expose activite_hebergee biologie", async () => {
    vi.spyOn(coverage, "getCoverageFinessVsSireneInRadius").mockResolvedValueOnce({
      finess_sites: 12,
      sirene_sirets: 14,
      matched_count: 11,
      coverage_ratio: 0.92,
      matched_samples: [],
      finess_only_samples: [],
      sirene_only_samples: [],
      methodology: "...",
      caveats: [],
      coverage_status: "ok",
      familles_auto_derivees: ["labo"],
    } as unknown as Awaited<ReturnType<typeof coverage.getCoverageFinessVsSireneInRadius>>);
    vi.spyOn(hostedActivities, "getHostedActivitiesInRadius").mockResolvedValueOnce({
      activite: "biologie médicale",
      count: 4,
      note: "Plateaux ... Ne pas additionner les deux comptes sans préciser leur nature.",
      sites_apercu: [],
      truncated: false,
    });
    const tool = findTool("finess_sirene_coverage_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ lon: 2.35, lat: 48.85, naf: "8690B" })) as Record<
      string,
      unknown
    >;
    expect(out.coverage_ratio).toBe(0.92);
    const hosted = out.activite_hebergee as { activite: string; count: number; note: string };
    expect(hosted.count).toBe(4);
    expect(hosted.activite).toBe("biologie médicale");
    expect(hosted.note).toMatch(/[Nn]e pas additionner/);
  });

  it("densite_etablissements_sante famille=labo expose activite_hebergee biologie + densite_pour_100k_hab", async () => {
    vi.spyOn(densite, "densiteEtablissementsSante").mockResolvedValueOnce({
      zone: {
        zone: "59",
        countEtablissements: 95,
        population: 2_600_000,
        populationAnnee: 2023,
        densitePour100k: 3.65,
      },
      parametres: { famille: "labo" },
      source: { etablissements: "FINESS / DREES", population: "INSEE Melodi" },
    } as unknown as Awaited<ReturnType<typeof densite.densiteEtablissementsSante>>);
    vi.spyOn(hostedActivities, "getHostedActivitiesInZone").mockResolvedValueOnce({
      activite: "biologie médicale",
      count: 52, // densité hostée attendue = 52 / 2_600_000 * 100_000 = 2.0
      note: "Plateaux ... Ne pas additionner les deux comptes sans préciser leur nature.",
      sites_apercu: [],
      truncated: false,
    });
    const tool = findTool("densite_etablissements_sante");
    expect(tool).toBeDefined();
    const out = (await tool?.handler({ code_dept: "59", famille: "labo" })) as Record<
      string,
      unknown
    >;
    const hosted = out.activite_hebergee as {
      activite: string;
      count: number;
      densite_pour_100k_hab: number;
    };
    expect(hosted.count).toBe(52);
    expect(hosted.activite).toBe("biologie médicale");
    expect(hosted.densite_pour_100k_hab).toBe(2); // (52 / 2_600_000) * 100_000 = 2.0
  });
});
