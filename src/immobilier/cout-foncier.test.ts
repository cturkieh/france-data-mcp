import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./dvf.js", () => ({
  dvfStatsInRadius: vi.fn(),
}));

import { coutFoncier } from "./cout-foncier.js";
import { type DvfStats, dvfStatsInRadius } from "./dvf.js";

const STATS: DvfStats = {
  n_lignes: 1250,
  n_ventes: 1000,
  prix_m2_median: 4833,
  prix_m2_p25: 3500,
  prix_m2_p75: 6200,
  n_terrains: 42,
  prix_terrain_median: 150000,
  date_min: "2025-07-01",
  date_max: "2026-06-30",
};

const INPUT = { lat: 48.84, lon: 2.29, rayon_km: 1 };

beforeEach(() => {
  vi.mocked(dvfStatsInRadius).mockReset();
});

describe("coutFoncier", () => {
  it("ventes présentes → couverture ok, chiffres de la base, n_ventes exact, période sur 2 années", async () => {
    vi.mocked(dvfStatsInRadius).mockResolvedValueOnce(STATS);

    await expect(coutFoncier(INPUT)).resolves.toStrictEqual({
      couverture: "ok",
      prix_m2_median: 4833,
      prix_m2_p25: 3500,
      prix_m2_p75: 6200,
      n_ventes: 1000,
      periode: "2025–2026",
      source: "DGFiP DVF",
    });
    expect(dvfStatsInRadius).toHaveBeenCalledWith(48.84, 2.29, 1);
  });

  it("période sur une seule année → année seule", async () => {
    vi.mocked(dvfStatsInRadius).mockResolvedValueOnce({
      ...STATS,
      date_min: "2026-01-02",
      date_max: "2026-06-30",
    });

    expect((await coutFoncier(INPUT)).periode).toBe("2026");
  });

  it("n_lignes = 0 → indisponible:no_data, valeurs null, n_ventes=0", async () => {
    vi.mocked(dvfStatsInRadius).mockResolvedValueOnce({
      n_lignes: 0,
      n_ventes: 0,
      prix_m2_median: null,
      prix_m2_p25: null,
      prix_m2_p75: null,
      n_terrains: 0,
      prix_terrain_median: null,
      date_min: null,
      date_max: null,
    });

    await expect(coutFoncier(INPUT)).resolves.toStrictEqual({
      couverture: "indisponible:no_data",
      prix_m2_median: null,
      prix_m2_p25: null,
      prix_m2_p75: null,
      n_ventes: 0,
      periode: null,
      source: "DGFiP DVF",
    });
  });

  it("des mutations mais aucune vente bâtie → ok, n_ventes=0, prix null, période servie", async () => {
    vi.mocked(dvfStatsInRadius).mockResolvedValueOnce({
      ...STATS,
      n_lignes: 3,
      n_ventes: 0,
      prix_m2_median: null,
      prix_m2_p25: null,
      prix_m2_p75: null,
    });

    const result = await coutFoncier(INPUT);
    expect(result.couverture).toBe("ok");
    expect(result.n_ventes).toBe(0);
    expect(result.prix_m2_median).toBeNull();
    expect(result.periode).toBe("2025–2026");
  });

  it("propage les erreurs de dvfStatsInRadius sans les avaler", async () => {
    vi.mocked(dvfStatsInRadius).mockRejectedValueOnce(
      new Error("[france-data-mcp] dvf_stats_in_radius (PGRST202): not found"),
    );

    await expect(coutFoncier(INPUT)).rejects.toThrow("PGRST202");
  });
});
