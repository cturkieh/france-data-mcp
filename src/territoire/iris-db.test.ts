import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import { assertIrisCode, fetchIrisProfilByCode, getPopulationByIris } from "./iris-db.js";

beforeEach(() => {
  mockRpc.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Ligne complète minimale renvoyée par la RPC iris_profil_by_code. */
function rpcRow(overrides: Record<string, unknown> = {}) {
  return {
    code_iris: "751103701",
    code_commune: "75110",
    libelle: "Saint-Vincent de Paul 1",
    type_iris: "H",
    pop_total: 2157,
    pop_65p: 282,
    revenu_median: 32510,
    ...overrides,
  };
}

describe("assertIrisCode", () => {
  it("accepte les codes 9 car. (métropole + Corse), rejette le reste", () => {
    expect(() => assertIrisCode("751103701")).not.toThrow();
    expect(() => assertIrisCode("2A0010000")).not.toThrow();
    expect(() => assertIrisCode("75110")).toThrow(RangeError); // commune, pas IRIS
    expect(() => assertIrisCode("7511037011")).toThrow(RangeError); // 10 car.
    expect(() => assertIrisCode("75A103701")).toThrow(RangeError);
  });
});

describe("getPopulationByIris", () => {
  it("retourne found + population pour un IRIS présent", async () => {
    mockRpc.mockResolvedValue({ data: [rpcRow()], error: null });
    const res = await getPopulationByIris("751103701");
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.population).toBe(2157);
      expect(res.codeCommune).toBe("75110");
      expect(res.libelle).toBe("Saint-Vincent de Paul 1");
      expect(res.typeIris).toBe("H");
      expect(res.annee).toBe(2022);
    }
    expect(mockRpc).toHaveBeenCalledWith("iris_profil_by_code", { p_code_iris: "751103701" });
  });

  it("coerce une population NUMERIC string et l'ARRONDIT (estimation décimale INSEE)", async () => {
    mockRpc.mockResolvedValue({ data: [rpcRow({ pop_total: "2157.34" })], error: null });
    const res = await getPopulationByIris("751103701");
    expect(res.found && res.population).toBe(2157); // arrondi, pas 2157.34
  });

  it("not_found MOTIVÉ si pop_total est non numérique (NaN) — jamais found NaN ni 0", async () => {
    mockRpc.mockResolvedValue({ data: [rpcRow({ pop_total: "N/A" })], error: null });
    const res = await getPopulationByIris("751103701");
    expect(res.found).toBe(false);
    if (!res.found) expect(res.message).toMatch(/illisible|corrompue/u);
  });

  it("not_found si la RPC ne renvoie aucune ligne (code absent du référentiel)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const res = await getPopulationByIris("759999999");
    expect(res.found).toBe(false);
    if (!res.found) {
      expect(res.lookupStatus).toBe("not_found");
      expect(res.key).toBe("759999999");
    }
  });

  it("not_found MOTIVÉ si l'IRIS existe mais pop_total est null (cas rare), jamais 0 silencieux", async () => {
    mockRpc.mockResolvedValue({ data: [rpcRow({ pop_total: null })], error: null });
    const res = await getPopulationByIris("751103701");
    expect(res.found).toBe(false);
    if (!res.found) expect(res.message).toMatch(/sans population/u);
  });

  it("throw RangeError sur format invalide (jamais un appel RPC)", async () => {
    await expect(getPopulationByIris("75110")).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("PROPAGE une panne RPC (ne masque pas en not_found)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getPopulationByIris("751103701")).rejects.toThrow(/iris_profil_by_code.*boom/u);
  });

  it("trim le code avant validation/lookup", async () => {
    mockRpc.mockResolvedValue({ data: [rpcRow()], error: null });
    await getPopulationByIris("  751103701  ");
    expect(mockRpc).toHaveBeenCalledWith("iris_profil_by_code", { p_code_iris: "751103701" });
  });
});

describe("fetchIrisProfilByCode", () => {
  it("retourne la ligne (réutilisable profil_iris) ou null si absente", async () => {
    mockRpc.mockResolvedValue({ data: [rpcRow()], error: null });
    expect((await fetchIrisProfilByCode("751103701"))?.code_iris).toBe("751103701");
    mockRpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchIrisProfilByCode("759999999")).toBeNull();
  });
});
