import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getAnonClient: () => ({ rpc: mockRpc }),
}));

import {
  getAmeliBySpecialiteDept,
  getAmeliInRadius,
  listAmeliSpecialites,
  listAmeliTypesPs,
} from "./ameli-db.js";

const sampleRow = {
  id: 1234,
  nom: "MAYAUD",
  prenom: "NORBERT",
  civilite: "M",
  raison_sociale: "SELAS DE CARDIO",
  specialite_code: "03",
  specialite_libelle: "Cardiologue",
  type_ps_code: "1",
  type_ps_libelle: "Médecins",
  adresse: "60 AVENUE DE JASSERON",
  code_postal: "08000",
  ville: "CHARLEVILLE MEZIERES",
  code_departement: "08 ", // CHAR(3) padded — must be trimmed by toAmeliResult
  code_insee: "08105",
  secteur_conventionnel_code: "3",
  secteur_conventionnel_libelle: "Secteur 2",
  nature_exercice_libelle: "Libéral intégral",
  telephone: "0474247675",
  geom: { type: "Point", coordinates: [4.7203, 49.7724] },
  distance_meters: 280.5,
};

beforeEach(() => {
  mockRpc.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAmeliInRadius", () => {
  it("calls ameli_in_radius RPC and maps each row", async () => {
    mockRpc.mockResolvedValue({ data: [sampleRow], error: null });
    const out = await getAmeliInRadius({
      center: { lat: 49.77, lon: 4.72 },
      radiusKm: 5,
      specialiteCodes: ["03"],
      typePsCodes: ["1"],
      limit: 50,
    });
    expect(mockRpc).toHaveBeenCalledWith("ameli_in_radius", {
      p_lat: 49.77,
      p_lon: 4.72,
      p_radius_meters: 5000,
      p_specialite_codes: ["03"],
      p_type_ps_codes: ["1"],
      p_limit: 51,
    });
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.results[0]?.identite.nom).toBe("MAYAUD");
    expect(out.results[0]?.adresse.code_departement).toBe("08"); // trimmed
    expect(out.results[0]?.coords).toEqual({ lat: 49.7724, lon: 4.7203 });
    expect(out.results[0]?.distance_km).toBe(0.28); // 280.5m → 0.28km
  });

  it("flags truncation when RPC returns limit+1 rows", async () => {
    const rows = Array.from({ length: 11 }, () => sampleRow);
    mockRpc.mockResolvedValue({ data: rows, error: null });
    const out = await getAmeliInRadius({
      center: { lat: 49.77, lon: 4.72 },
      radiusKm: 5,
      limit: 10,
    });
    expect(out.count).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it("rejects out-of-range coordinates with RangeError", async () => {
    await expect(getAmeliInRadius({ center: { lat: 91, lon: 4.72 }, radiusKm: 5 })).rejects.toThrow(
      /lat must be in/,
    );
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 200 }, radiusKm: 5 }),
    ).rejects.toThrow(/lon must be in/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects radius > 50 km or <= 0 with RangeError", async () => {
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 51 }),
    ).rejects.toThrow(/radiusKm must be in/);
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 0 }),
    ).rejects.toThrow(/radiusKm must be in/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejette un type_ps_code filtré à l'ingestion (3 = laboratoires) avec un message orientant vers FINESS", async () => {
    await expect(
      getAmeliInRadius({
        center: { lat: 49.77, lon: 4.72 },
        radiusKm: 5,
        typePsCodes: ["3"],
      }),
    ).rejects.toThrow(/n'est pas filtrable.*FINESS/s);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects limit out of [1, 500]", async () => {
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5, limit: 0 }),
    ).rejects.toThrow(/limit must be between/);
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5, limit: 501 }),
    ).rejects.toThrow(/limit must be between/);
  });

  it("formats RPC error with code, hint, and details", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column missing", hint: "rebuild RPC", details: "x" },
    });
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 }),
    ).rejects.toThrow(/ameli_in_radius \(42703\): column missing.*details: x.*hint: rebuild/);
  });

  it("defaults specialite_codes and type_ps_codes to empty arrays", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(mockRpc).toHaveBeenCalledWith(
      "ameli_in_radius",
      expect.objectContaining({ p_specialite_codes: [], p_type_ps_codes: [] }),
    );
  });
});

describe("getAmeliBySpecialiteDept", () => {
  it("calls ameli_by_specialite_dept with explicit nulls for omitted filters", async () => {
    // The dept RPC returns NULL::DOUBLE PRECISION for distance_meters,
    // mirror that in the mock so distance_km comes back null.
    mockRpc.mockResolvedValue({ data: [{ ...sampleRow, distance_meters: null }], error: null });
    const out = await getAmeliBySpecialiteDept({ departement: "08", specialiteCode: "03" });
    expect(mockRpc).toHaveBeenCalledWith("ameli_by_specialite_dept", {
      p_departement: "08",
      p_specialite_code: "03",
      p_type_ps_code: null,
      p_limit: 101,
      p_offset: 0,
    });
    expect(out.count).toBe(1);
    expect(out.results[0]?.distance_km).toBeNull();
  });

  it("accepts Corse 2A/2B and DOM 974", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliBySpecialiteDept({ departement: "2A" });
    await getAmeliBySpecialiteDept({ departement: "974" });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid department codes", async () => {
    await expect(getAmeliBySpecialiteDept({ departement: "20" })).rejects.toThrow(
      /must be a valid INSEE code/,
    );
    await expect(getAmeliBySpecialiteDept({ departement: "999" })).rejects.toThrow(
      /must be a valid INSEE code/,
    );
    await expect(getAmeliBySpecialiteDept({ departement: "" })).rejects.toThrow(
      /must be a valid INSEE code/,
    );
  });

  it("forwarde offset au RPC pour énumérer un département à fort effectif", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliBySpecialiteDept({ departement: "75", limit: 100, offset: 200 });
    // Strict matcher : un refactor qui transposerait p_specialite_code et
    // p_type_ps_code dans le code-path offset doit être détecté.
    expect(mockRpc).toHaveBeenCalledWith("ameli_by_specialite_dept", {
      p_departement: "75",
      p_specialite_code: null,
      p_type_ps_code: null,
      p_limit: 101,
      p_offset: 200,
    });
  });

  it("rejette un offset négatif ou hors borne avec RangeError", async () => {
    await expect(getAmeliBySpecialiteDept({ departement: "75", offset: -1 })).rejects.toThrow(
      /offset must be between/,
    );
    await expect(getAmeliBySpecialiteDept({ departement: "75", offset: 200_000 })).rejects.toThrow(
      /offset must be between/,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("listAmeliSpecialites", () => {
  it("call le RPC et map les rows en AmeliSpecialiteEntry triés par count", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "24",
          libelle: "Infirmier",
          type_ps_code: "2",
          type_ps_libelle: "Autres PS (...)",
          count: "104041",
        },
        {
          code: "01",
          libelle: "Médecin généraliste",
          type_ps_code: "1",
          type_ps_libelle: "Médecins généralistes et spécialistes",
          count: 55381,
        },
      ],
      error: null,
    });
    const out = await listAmeliSpecialites();
    expect(mockRpc).toHaveBeenCalledWith("ameli_lister_specialites");
    expect(out).toHaveLength(2);
    expect(out[0]?.code).toBe("24");
    expect(out[0]?.count).toBe(104041); // string BIGINT coerced to number
    expect(out[1]?.count).toBe(55381); // number passes through
  });

  it("filtre les rows sans code (defensive)", async () => {
    mockRpc.mockResolvedValue({
      data: [
        { code: null, libelle: "x", type_ps_code: "1", type_ps_libelle: "y", count: 1 },
        {
          code: "01",
          libelle: "MG",
          type_ps_code: "1",
          type_ps_libelle: "Médecins",
          count: 100,
        },
      ],
      error: null,
    });
    const out = await listAmeliSpecialites();
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe("01");
  });

  it("retourne un array vide quand le RPC renvoie un array vide (catalogue absent)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    expect(await listAmeliSpecialites()).toEqual([]);
  });

  it("throw quand le RPC viole son contrat (data null sans error — V0.4.3 expectRpcRows)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(listAmeliSpecialites()).rejects.toThrow(/RPC contract violation/);
  });

  it("propage l'erreur RPC en exception", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listAmeliSpecialites()).rejects.toThrow(/ameli_lister_specialites.*boom/);
  });
});

describe("listAmeliTypesPs", () => {
  it("clarifie le libellé du code 2 quand la source matche la référence", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "2",
          libelle_source: "Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…)",
          count: "245990",
          specialites_presentes: [
            { code: "24", libelle: "Infirmier", count: 104041 },
            { code: "26", libelle: "Masseur-kinésithérapeute", count: 86588 },
          ],
        },
      ],
      error: null,
    });
    const out = await listAmeliTypesPs();
    expect(out[0]?.code).toBe("2");
    expect(out[0]?.libelle_source).toContain("Autres PS");
    expect(out[0]?.libelle_clarifie).toContain("Auxiliaires médicaux");
    expect(out[0]?.specialites_presentes).toHaveLength(2);
    expect(out[0]?.specialites_presentes[0]?.code).toBe("24");
  });

  it("garde la source quand elle ne matche pas la référence (drift detection)", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "2",
          libelle_source: "LIBELLE AMELI MODIFIE EN UPSTREAM",
          count: 245990,
          specialites_presentes: [],
        },
      ],
      error: null,
    });
    const out = await listAmeliTypesPs();
    expect(out[0]?.libelle_clarifie).toBe("LIBELLE AMELI MODIFIE EN UPSTREAM");
  });

  it("gère specialites_presentes null/undefined", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "1",
          libelle_source: "Médecins généralistes et spécialistes",
          count: 172150,
          specialites_presentes: null,
        },
      ],
      error: null,
    });
    const out = await listAmeliTypesPs();
    expect(out[0]?.specialites_presentes).toEqual([]);
  });
});
