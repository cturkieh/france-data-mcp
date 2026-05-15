import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();

vi.mock("../storage/supabase.js", () => ({
  getAnonClient: () => ({ rpc: mockRpc }),
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import { getCdsByFiness, getCdsInRadius } from "./cds-db.js";

const VALID_FINESS = "750000123";

function fakeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    etab_finess: VALID_FINESS,
    etab_raison_sociale: "CDS MUNICIPAL TEST",
    accepte_carte_vitale: true,
    accepte_apcv: false,
    specialites_codes: ["01", "22"],
    specialites_libelles: ["Médecine générale", "Médecine générale (autre code)"],
    type_etab_code: "124",
    type_etab_libelle: "Centre de santé",
    telephone: "0123456789",
    voie: "10 RUE DE LA PAIX",
    complement_voie: null,
    lieu_dit: null,
    code_postal: "75008",
    ville: "PARIS",
    code_departement: "75",
    code_insee: "75108",
    geom: { type: "Point", coordinates: [2.317, 48.872] },
    distance_meters: 1234,
    ...overrides,
  };
}

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCdsByFiness", () => {
  it("throw RangeError sur num_finess mal formé (avant tout I/O)", async () => {
    await expect(getCdsByFiness("123")).rejects.toThrow(RangeError);
    await expect(getCdsByFiness("abcdefghi")).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("retourne lookupNotFound quand RPC retourne array vide", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const result = await getCdsByFiness(VALID_FINESS);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toContain("introuvable dans la base CDS");
      expect(result.message).toContain("Annuaire santé Ameli");
    }
  });

  it("retourne lookupFound avec shape mappé quand RPC retourne 1 row", async () => {
    mockRpc.mockResolvedValue({ data: [fakeRow()], error: null });
    const result = await getCdsByFiness(VALID_FINESS);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.etab_finess).toBe(VALID_FINESS);
    expect(result.raison_sociale).toBe("CDS MUNICIPAL TEST");
    expect(result.accepte_carte_vitale).toBe(true);
    expect(result.specialites.codes).toEqual(["01", "22"]);
    expect(result.specialites.libelles).toEqual([
      "Médecine générale",
      "Médecine générale (autre code)",
    ]);
    expect(result.type_etab.code).toBe("124");
    expect(result.coords).toEqual({ lat: 48.872, lon: 2.317 });
    expect(result.adresse.code_postal).toBe("75008");
    expect(result.adresse.code_insee).toBe("75108");
  });

  it("warn et picke first quand RPC retourne >1 row (defense-in-depth PK)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: [fakeRow(), fakeRow()], error: null });
    const result = await getCdsByFiness(VALID_FINESS);
    expect(result.found).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("returned 2 rows"));
  });

  it("propage l'erreur RPC formatée", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "permission denied", code: "42501" },
    });
    await expect(getCdsByFiness(VALID_FINESS)).rejects.toThrow("centres_sante_by_finess");
  });

  it("coords null quand geom malformé (pas de Golfe-de-Guinée silencieux)", async () => {
    mockRpc.mockResolvedValue({
      data: [fakeRow({ geom: { type: "Point", coordinates: [undefined, undefined] } })],
      error: null,
    });
    const result = await getCdsByFiness(VALID_FINESS);
    if (!result.found) throw new Error("unreachable");
    expect(result.coords).toBeNull();
  });
});

describe("getCdsInRadius", () => {
  it("throw RangeError sur coords invalides (avant tout I/O)", async () => {
    await expect(getCdsInRadius({ center: { lat: 999, lon: 0 }, radiusKm: 5 })).rejects.toThrow(
      RangeError,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("throw RangeError sur radius hors bornes", async () => {
    await expect(getCdsInRadius({ center: { lat: 48.8, lon: 2.3 }, radiusKm: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      getCdsInRadius({ center: { lat: 48.8, lon: 2.3 }, radiusKm: 100 }),
    ).rejects.toThrow(RangeError);
  });

  it("appelle le RPC avec les params attendus + arrays vides par défaut", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getCdsInRadius({ center: { lat: 48.872, lon: 2.317 }, radiusKm: 5 });
    expect(mockRpc).toHaveBeenCalledWith("centres_sante_in_radius", {
      p_lat: 48.872,
      p_lon: 2.317,
      p_radius_meters: 5000,
      p_specialite_codes: [],
      p_accepte_carte_vitale: null,
      p_type_etab_codes: [],
      p_limit: 101, // default limit 100 + 1
    });
  });

  it("forward specialiteCodes + accepteCarteVitale + typeEtabCodes au RPC", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getCdsInRadius({
      center: { lat: 48.872, lon: 2.317 },
      radiusKm: 10,
      specialiteCodes: ["01", "22"],
      accepteCarteVitale: true,
      typeEtabCodes: ["124"],
      limit: 50,
    });
    expect(mockRpc).toHaveBeenCalledWith("centres_sante_in_radius", {
      p_lat: 48.872,
      p_lon: 2.317,
      p_radius_meters: 10000,
      p_specialite_codes: ["01", "22"],
      p_accepte_carte_vitale: true,
      p_type_etab_codes: ["124"],
      p_limit: 51,
    });
  });

  it("retourne count + truncated + results mappés + query_metadata", async () => {
    // Simule limit=2 : RPC ramène 3 rows (limit+1) → truncated true, count=2
    mockRpc.mockResolvedValue({
      data: [
        fakeRow(),
        fakeRow({ etab_finess: "750000124" }),
        fakeRow({ etab_finess: "750000125" }),
      ],
      error: null,
    });
    const result = await getCdsInRadius({
      center: { lat: 48.872, lon: 2.317 },
      radiusKm: 5,
      limit: 2,
    });
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.etab_finess).toBe(VALID_FINESS);
    expect(result.query_metadata?.geo_precision).toBe("centroide_commune_cds");
    expect(result.query_metadata?.distance_type).toBe("haversine_postgis");
  });

  it("specialites codes/libelles fallback à [] si RPC remonte null (defense)", async () => {
    mockRpc.mockResolvedValue({
      data: [fakeRow({ specialites_codes: null, specialites_libelles: null })],
      error: null,
    });
    const result = await getCdsInRadius({
      center: { lat: 48.872, lon: 2.317 },
      radiusKm: 5,
    });
    expect(result.results[0]?.specialites.codes).toEqual([]);
    expect(result.results[0]?.specialites.libelles).toEqual([]);
  });
});
