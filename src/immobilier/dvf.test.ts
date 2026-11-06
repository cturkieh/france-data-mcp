import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();

vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import { dvfStatsInRadius } from "./dvf.js";

/** Forme PostgREST défavorable : tous les nombres en string. */
const ROW_STRINGS = {
  n_lignes: "1250",
  n_ventes: "1000",
  prix_m2_median: "4833.5",
  prix_m2_p25: "3500",
  prix_m2_p75: "6200.25",
  n_terrains: "42",
  prix_terrain_median: "150000",
  date_min: "2025-07-01",
  date_max: "2026-06-30",
};

const ROW_EMPTY = {
  n_lignes: 0,
  n_ventes: 0,
  prix_m2_median: null,
  prix_m2_p25: null,
  prix_m2_p75: null,
  n_terrains: 0,
  prix_terrain_median: null,
  date_min: null,
  date_max: null,
};

function rpcReturns(data: unknown): void {
  mockRpc.mockResolvedValueOnce({ data, error: null });
}

beforeEach(() => {
  mockRpc.mockReset();
});

describe("dvfStatsInRadius — appel", () => {
  it("appelle la RPC avec le rayon en mètres", async () => {
    rpcReturns([ROW_EMPTY]);
    await dvfStatsInRadius(48.84, 2.29, 2.5);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("dvf_stats_in_radius", {
      p_lat: 48.84,
      p_lon: 2.29,
      p_radius_meters: 2500,
    });
  });

  it.each([
    ["lat hors bornes", 91, 2.3, 1],
    ["lon hors bornes", 48.8, 181, 1],
    ["lat NaN", Number.NaN, 2.3, 1],
    ["rayon nul", 48.8, 2.3, 0],
    ["rayon au-delà du maximum", 48.8, 2.3, 51],
  ])("%s → RangeError sans appel RPC", async (_label, lat, lon, radius) => {
    await expect(dvfStatsInRadius(lat, lon, radius)).rejects.toBeInstanceOf(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("dvfStatsInRadius — coercition au boundary", () => {
  it("convertit les nombres sérialisés en string, et laisse les dates en chaînes ISO", async () => {
    rpcReturns([ROW_STRINGS]);
    await expect(dvfStatsInRadius(48.84, 2.29, 1)).resolves.toStrictEqual({
      n_lignes: 1250,
      n_ventes: 1000,
      prix_m2_median: 4833.5,
      prix_m2_p25: 3500,
      prix_m2_p75: 6200.25,
      n_terrains: 42,
      prix_terrain_median: 150000,
      date_min: "2025-07-01",
      date_max: "2026-06-30",
    });
  });

  it("garde les nombres JSON", async () => {
    rpcReturns([{ ...ROW_STRINGS, n_lignes: 3, n_ventes: 2, prix_m2_median: 4000.5 }]);
    const stats = await dvfStatsInRadius(48.84, 2.29, 1);
    expect(stats.n_lignes).toBe(3);
    expect(stats.n_ventes).toBe(2);
    expect(stats.prix_m2_median).toBe(4000.5);
  });

  it("zone sans vente : compteurs à 0, médianes et dates null (jamais 0)", async () => {
    rpcReturns([ROW_EMPTY]);
    await expect(dvfStatsInRadius(48.58, 7.75, 1)).resolves.toStrictEqual(ROW_EMPTY);
  });

  it.each([
    ["n_lignes", "N/A"],
    ["n_lignes", ""],
    ["n_lignes", null],
    ["n_ventes", "N/A"],
    ["n_ventes", 1.5],
    ["n_ventes", -1],
    ["n_terrains", undefined],
    ["n_terrains", false],
  ])("compteur illisible %s=%j → throw, jamais 0", async (field, value) => {
    rpcReturns([{ ...ROW_STRINGS, [field]: value }]);
    await expect(dvfStatsInRadius(48.84, 2.29, 1)).rejects.toThrow(
      new RegExp(`^\\[france-data-mcp\\] dvf_stats_in_radius.*${field} illisible`),
    );
  });

  it.each([
    ["prix_m2_median", "N/A"],
    ["prix_m2_median", ""],
    ["prix_m2_p25", "NaN"],
    ["prix_m2_p75", "Infinity"],
    ["prix_terrain_median", undefined],
  ])("prix illisible %s=%j → throw, jamais null ni 0", async (field, value) => {
    rpcReturns([{ ...ROW_STRINGS, [field]: value }]);
    await expect(dvfStatsInRadius(48.84, 2.29, 1)).rejects.toThrow(`${field} illisible`);
  });

  it.each([
    ["date_min", 2025],
    ["date_max", "hier"],
    ["date_max", undefined],
  ])("date illisible %s=%j → throw", async (field, value) => {
    rpcReturns([{ ...ROW_STRINGS, [field]: value }]);
    await expect(dvfStatsInRadius(48.84, 2.29, 1)).rejects.toThrow(`${field} illisible`);
  });
});

describe("dvfStatsInRadius — contrat et erreurs", () => {
  it.each([
    ["tableau vide", [], /0 lignes/],
    ["deux lignes", [ROW_EMPTY, ROW_EMPTY], /2 lignes/],
    ["objet nu", ROW_EMPTY, /object/],
    ["null sans erreur", null, /object/],
    ["ligne null", [null], /ligne illisible/],
    ["ligne scalaire", [42], /ligne illisible/],
  ])("%s → throw préfixé", async (_label, data, detail) => {
    rpcReturns(data);
    const promise = dvfStatsInRadius(48.84, 2.29, 1);
    await expect(promise).rejects.toThrow(/^\[france-data-mcp\] dvf_stats_in_radius/);
    await expect(promise).rejects.toThrow(detail);
  });

  it("erreur RPC → remonte le code et le message", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    await expect(dvfStatsInRadius(48.84, 2.29, 1)).rejects.toThrow(
      "[france-data-mcp] dvf_stats_in_radius (57014): canceling statement",
    );
  });

  it("RPC absente (PGRST202) → erreur, jamais « 0 vente »", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    await expect(dvfStatsInRadius(48.84, 2.29, 1)).rejects.toThrow("(PGRST202)");
  });
});
