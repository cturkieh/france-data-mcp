import { describe, expect, it } from "vitest";
import { getFinessByCategorie, getFinessInRadius } from "./finess-db.js";

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
