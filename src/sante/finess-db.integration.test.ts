import { beforeAll, describe, expect, it } from "vitest";
import { __resetClientsForTesting } from "../storage/supabase.js";
import { getFinessByCategorie, getFinessInRadius } from "./finess-db.js";

const CHARLEVILLE = { lat: 49.7724, lon: 4.7203 };

beforeAll(() => {
  // Tests run against Supabase Local (started by `pnpm db:start`).
  process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.SUPABASE_ANON_KEY ??= process.env.SUPABASE_LOCAL_ANON_KEY ?? ""; // overridden in CI
  __resetClientsForTesting();
});

describe("getFinessInRadius", () => {
  it("returns establishments within 5km of Charleville, sorted by distance", async () => {
    const result = await getFinessInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      limit: 100,
    });

    // Seed has 14 rows in <5km (excluding NULL-geom row 080000202 + the 4
    // intentionally-out-of-range rows 080000101..104). Breakdown:
    //   2 MCO (017, 025) + 6 EHPAD-family (051..056) + 3 SSR (071..073) +
    //   2 "autre" inside radius (091 labo, 092 MSP) + 1 unknown 9999 (201) = 14.
    expect(result.results.length).toBe(14);
    expect(result.results[0]?.distance_km).toBeLessThanOrEqual(
      result.results[1]?.distance_km ?? Number.POSITIVE_INFINITY,
    );

    // Locks the C2 contract: PostGIS geom must come back as parseable
    // GeoJSON, not raw EWKB hex. Regression here would mean the RPC stopped
    // casting via ST_AsGeoJSON and the wrapper silently emits coords: null.
    const first = result.results[0];
    expect(first?.coords).toBeDefined();
    expect(typeof first?.coords?.lat).toBe("number");
    expect(typeof first?.coords?.lon).toBe("number");
    // Charleville sits around (49.77, 4.72) — sanity-bound the parsed values.
    expect(first?.coords?.lat).toBeGreaterThan(49);
    expect(first?.coords?.lat).toBeLessThan(50);
    expect(first?.coords?.lon).toBeGreaterThan(4);
    expect(first?.coords?.lon).toBeLessThan(5);
  });

  it("filters by family (mco)", async () => {
    const result = await getFinessInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      familles: ["mco"],
    });
    expect(result.results.every((r) => r.categorie.famille === "mco")).toBe(true);
    expect(result.results.length).toBe(2); // CH + Polyclinique
  });

  it("filters by family (ehpad)", async () => {
    const result = await getFinessInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      familles: ["ehpad"],
    });
    expect(result.results.every((r) => r.categorie.famille === "ehpad")).toBe(true);
    expect(result.results.length).toBe(6);
  });

  it("returns empty results when nothing is in range", async () => {
    const result = await getFinessInRadius({
      center: { lat: 0, lon: 0 }, // middle of the ocean
      radiusKm: 5,
    });
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("respects the limit parameter and reports truncation", async () => {
    const result = await getFinessInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      limit: 3,
    });
    expect(result.results).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("excludes rows with NULL geom from spatial queries", async () => {
    const result = await getFinessInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
    });
    expect(result.results.find((r) => r.num_finess === "080000202")).toBeUndefined();
  });
});

describe("getFinessByCategorie", () => {
  it("returns all EHPAD in dept 08", async () => {
    const result = await getFinessByCategorie({
      famille: "ehpad",
      departement: "08",
    });
    // Seed contains 9 rows whose code_insee starts with "08" AND categorie_code
    // in {500, 501, 502}:
    //   080000051..080000056 (6 in Charleville-Mézières / 08105)
    //   080000101            (1 in Sedan / 08409)
    //   080000104            (1 in Mézières-sur-Issoire / 08400)
    //   080000202            (1 with NULL geom — code_insee 08105, code 500)
    // The by_categorie RPC has no geom filter, so 080000202 IS included here.
    expect(result.results.length).toBe(9);
    expect(result.results.every((r) => r.adresse.code_insee.startsWith("08"))).toBe(true);
  });

  it("filters by code_insee when provided", async () => {
    const result = await getFinessByCategorie({
      famille: "ehpad",
      code_insee: "08105",
    });
    // 6 rows in Charleville-Mézières (4× code 500 + 1× 501 + 1× 502) + the
    // NULL-geom row 080000202 (also code 500, code_insee 08105) = 7
    expect(result.results.length).toBe(7);
    expect(result.results.every((r) => r.adresse.code_insee === "08105")).toBe(true);
  });

  it("returns empty results for an empty department", async () => {
    const result = await getFinessByCategorie({
      famille: "ehpad",
      departement: "99",
    });
    expect(result.results).toEqual([]);
  });
});
