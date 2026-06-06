import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock dvfInRadius + aggregatePrix via spyOn — imported after the mocks below
// ---------------------------------------------------------------------------

// We need to mock the storage module so dvf.ts can be imported without a real DB
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({
    from: vi.fn(),
    rpc: vi.fn(),
  }),
}));

import { coutFoncier } from "./cout-foncier.js";
import * as dvfModule from "./dvf.js";
import type { DvfMutation } from "./dvf.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMutation(overrides: Partial<DvfMutation>): DvfMutation {
  return {
    id_mutation: "M001",
    date_mutation: "2024-01-01",
    nature_mutation: "Vente",
    valeur_fonciere: null,
    code_commune: "75056",
    type_local: "Appartement",
    surface_reelle_bati: 50,
    surface_terrain: null,
    prix_m2: 4000,
    longitude: 2.3,
    latitude: 48.8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coutFoncier", () => {
  it("(a) rows présentes → couverture ok, agrégats passés via aggregatePrix, période correcte", async () => {
    const rows: DvfMutation[] = [
      makeMutation({ date_mutation: "2023-03-15", prix_m2: 3000 }),
      makeMutation({ id_mutation: "M002", date_mutation: "2024-07-01", prix_m2: 5000 }),
    ];

    vi.spyOn(dvfModule, "dvfInRadius").mockResolvedValueOnce(rows);

    const result = await coutFoncier({ lat: 48.8, lon: 2.3, rayon_km: 1 });

    expect(result.couverture).toBe("ok");
    expect(result.source).toBe("DGFiP DVF");

    // aggregatePrix sur ces 2 rows : prix_m2s triés = [3000, 5000]
    // médiane pair = (3000 + 5000) / 2 = 4000
    expect(result.prix_m2_median).toBeCloseTo(4000, 0);
    // p25 index = 0.25 * 1 = 0.25 → 3000 + 0.25*(5000-3000) = 3500
    expect(result.prix_m2_p25).toBeCloseTo(3500, 0);
    // p75 index = 0.75 * 1 = 0.75 → 3000 + 0.75*(5000-3000) = 4500
    expect(result.prix_m2_p75).toBeCloseTo(4500, 0);
    expect(result.n_ventes).toBe(2);

    // période = min/max year des date_mutation
    expect(result.periode).toBe("2023–2024");
  });

  it("(a bis) période sur une seule année → format sans tiret", async () => {
    const rows: DvfMutation[] = [
      makeMutation({ date_mutation: "2024-01-01", prix_m2: 3000 }),
      makeMutation({ id_mutation: "M002", date_mutation: "2024-11-15", prix_m2: 4000 }),
    ];

    vi.spyOn(dvfModule, "dvfInRadius").mockResolvedValueOnce(rows);

    const result = await coutFoncier({ lat: 48.8, lon: 2.3, rayon_km: 1 });

    expect(result.couverture).toBe("ok");
    expect(result.periode).toBe("2024");
  });

  it("(b) rows vides → couverture indisponible:no_data, nulls, n_ventes=0, periode=null", async () => {
    vi.spyOn(dvfModule, "dvfInRadius").mockResolvedValueOnce([]);

    const result = await coutFoncier({ lat: 48.8, lon: 2.3, rayon_km: 1 });

    expect(result.couverture).toBe("indisponible:no_data");
    expect(result.prix_m2_median).toBeNull();
    expect(result.prix_m2_p25).toBeNull();
    expect(result.prix_m2_p75).toBeNull();
    expect(result.n_ventes).toBe(0);
    expect(result.periode).toBeNull();
    expect(result.source).toBe("DGFiP DVF");
  });

  it("propage les erreurs de dvfInRadius sans les avaler", async () => {
    vi.spyOn(dvfModule, "dvfInRadius").mockRejectedValueOnce(
      new Error("RPC dvf_in_radius: network failure"),
    );

    await expect(coutFoncier({ lat: 48.8, lon: 2.3, rayon_km: 1 })).rejects.toThrow(
      "dvf_in_radius",
    );
  });
});
