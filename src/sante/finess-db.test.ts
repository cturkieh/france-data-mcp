import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase à l'import : permet aux tests `getFinessByNumFiness`
// d'invoquer le wrapper sans accès DB. Les tests de validation d'input
// throw AVANT le RPC, donc ils ne touchent pas le mock — compat.
const mockRpc = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getAnonClient: () => ({ rpc: mockRpc }),
}));

import { getFinessByCategorie, getFinessByNumFiness, getFinessInRadius } from "./finess-db.js";

// Pure unit tests for the input-validation guards. No DB / Supabase Local
// needed — the RangeError throws before any RPC call. Locks the SFH-7
// (lat/lon WGS84 bounds) and limit-bound contracts against silent regressions.

describe("getFinessInRadius input validation", () => {
  it("rejects latitude outside [-90, 90]", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: 91, lon: 0 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
    await expect(
      getFinessInRadius({
        center: { lat: -91, lon: 0 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
  });

  it("rejects longitude outside [-180, 180]", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: 49.7724, lon: 200 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lon must be in/);
    await expect(
      getFinessInRadius({
        center: { lat: 49.7724, lon: -200 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lon must be in/);
  });

  it("rejects NaN lat or lon", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: Number.NaN, lon: 4.7 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
    await expect(
      getFinessInRadius({
        center: { lat: 49.7, lon: Number.NaN },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lon must be in/);
  });

  it("rejects Infinity lat or lon", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: Number.POSITIVE_INFINITY, lon: 4.7 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
  });

  it("rejects limit out of [1, 500]", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: 49.7, lon: 4.7 },
        radiusKm: 5,
        limit: 0,
      }),
    ).rejects.toThrow(/limit must be between/);
    await expect(
      getFinessInRadius({
        center: { lat: 49.7, lon: 4.7 },
        radiusKm: 5,
        limit: 1000,
      }),
    ).rejects.toThrow(/limit must be between/);
  });

  it("rejects radiusKm out of [0.1, 50] (V0.4.1 — DB layer alignment with Ameli)", async () => {
    // Avant V0.4.1, le DB layer FINESS n'avait aucune validation et acceptait
    // radiusKm: 1000 → ST_DWithin sur 95K rows pour rien. Cas régressif à
    // verrouiller : tout caller direct (lib npm) doit voir RangeError.
    await expect(
      getFinessInRadius({ center: { lat: 49.7, lon: 4.7 }, radiusKm: 51 }),
    ).rejects.toThrow(RangeError);
    await expect(
      getFinessInRadius({ center: { lat: 49.7, lon: 4.7 }, radiusKm: 0.05 }),
    ).rejects.toThrow(/radiusKm must be in/);
    await expect(
      getFinessInRadius({ center: { lat: 49.7, lon: 4.7 }, radiusKm: -1 }),
    ).rejects.toThrow(/radiusKm must be in/);
  });
});

describe("getFinessByCategorie input validation", () => {
  it("rejects limit out of [1, 500]", async () => {
    await expect(getFinessByCategorie({ famille: "ehpad", limit: 0 })).rejects.toThrow(
      /limit must be between/,
    );
    await expect(getFinessByCategorie({ famille: "ehpad", limit: 1000 })).rejects.toThrow(
      /limit must be between/,
    );
  });
});

describe("getFinessByNumFiness LookupResult (V0.4.3 migration)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retourne un LookupNotFound typé quand le RPC ne renvoie rien", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const out = await getFinessByNumFiness("999999999");
    expect(out.found).toBe(false);
    if (!out.found) {
      expect(out.key).toBe("999999999");
      expect(out.lookupStatus).toBe("not_found");
      expect(out.message).toMatch(/introuvable|DREES|émergente/i);
    }
  });

  it("wrap le résultat en found:true quand le RPC retourne un row", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          num_finess: "080010101",
          raison_sociale: "LBM BIO ARD'AISNE",
          categorie_code: "611",
          categorie_libelle: "Laboratoire de Biologie Médicale",
          voie: "7 R DUBOIS CRANCE",
          code_postal: "08000",
          ville: "CHARLEVILLE MEZIERES",
          code_departement: "08",
          code_insee: "08105",
          telephone: "0324564266",
          email: null,
          geom: { type: "Point", coordinates: [4.715688833, 49.77217843] },
        },
      ],
      error: null,
    });
    const out = await getFinessByNumFiness("080010101");
    expect(out.found).toBe(true);
    if (out.found) {
      expect(out.num_finess).toBe("080010101");
      expect(out.raison_sociale).toBe("LBM BIO ARD'AISNE");
    }
  });

  it("warn et garde le premier row quand le RPC remonte plusieurs lignes (PK normalement unique)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = {
      num_finess: "080010101",
      raison_sociale: "DUPLICATE A",
      categorie_code: "611",
      categorie_libelle: "Laboratoire de Biologie Médicale",
      voie: "7 R DUBOIS CRANCE",
      code_postal: "08000",
      ville: "CHARLEVILLE MEZIERES",
      code_departement: "08",
      code_insee: "08105",
      telephone: null,
      email: null,
      geom: null,
    };
    mockRpc.mockResolvedValue({
      data: [row, { ...row, raison_sociale: "DUPLICATE B" }],
      error: null,
    });
    const out = await getFinessByNumFiness("080010101");
    expect(out.found).toBe(true);
    if (out.found) {
      expect(out.raison_sociale).toBe("DUPLICATE A");
    }
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("expected ≤ 1");
    warnSpy.mockRestore();
  });

  it("rejette un num_finess mal formé sans appeler le RPC", async () => {
    // V0.7.3 : utilise `assertValidNumFiness` shared helper, message "invalide ... attendu 9 chiffres".
    await expect(getFinessByNumFiness("123")).rejects.toThrow(/num_finess invalide/);
    await expect(getFinessByNumFiness("123")).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
