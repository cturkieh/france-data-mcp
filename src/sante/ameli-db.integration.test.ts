import { beforeAll, describe, expect, it } from "vitest";
import { __resetClientsForTesting } from "../storage/supabase.js";
import { getAmeliBySpecialiteDept, getAmeliInRadius } from "./ameli-db.js";

const CHARLEVILLE = { lat: 49.7724, lon: 4.7203 };

beforeAll(() => {
  // Tests run against Supabase Local (started by `pnpm db:start`).
  // Skip with `pnpm test:unit` if the local stack isn't running.
  process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.SUPABASE_ANON_KEY ??= process.env.SUPABASE_LOCAL_ANON_KEY ?? "";
  __resetClientsForTesting();
});

describe("getAmeliInRadius", () => {
  it("returns PS within 5km of Charleville, sorted by distance", async () => {
    const result = await getAmeliInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      limit: 100,
    });
    // Seed has 9 PS in Charleville (5 MG + 1 cardio + 3 IDE) inside 5km.
    // The cardio at Sedan, the MG at Reims, and the NULL-geom row are
    // excluded by the radius / NULL filter.
    expect(result.results.length).toBe(9);
    expect(result.results[0]?.distance_km).toBeLessThanOrEqual(
      result.results[1]?.distance_km ?? Number.POSITIVE_INFINITY,
    );

    // Same PostgREST geom contract as FINESS — JSONB GeoJSON, never raw EWKB.
    const first = result.results[0];
    expect(first?.coords).toBeDefined();
    expect(typeof first?.coords?.lat).toBe("number");
    expect(typeof first?.coords?.lon).toBe("number");
    expect(first?.coords?.lat).toBeGreaterThan(49);
    expect(first?.coords?.lat).toBeLessThan(50);
    expect(first?.coords?.lon).toBeGreaterThan(4);
    expect(first?.coords?.lon).toBeLessThan(5);
  });

  it("filters by specialite_codes (cardio only)", async () => {
    const result = await getAmeliInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      specialiteCodes: ["03"],
    });
    expect(result.results.every((r) => r.specialite.code === "03")).toBe(true);
    expect(result.results.length).toBe(1); // Only the SEED_MAYAUD cardio at Charleville
  });

  it("filters by type_ps_codes (IDE only)", async () => {
    const result = await getAmeliInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      typePsCodes: ["2"],
    });
    expect(result.results.every((r) => r.type_ps.code === "2")).toBe(true);
    expect(result.results.length).toBe(3); // Three seeded IDE in Charleville
  });

  it("returns empty results when nothing in range", async () => {
    const result = await getAmeliInRadius({
      center: { lat: 0, lon: 0 }, // ocean
      radiusKm: 5,
    });
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("respects limit and reports truncation", async () => {
    const result = await getAmeliInRadius({
      center: CHARLEVILLE,
      radiusKm: 5,
      limit: 3,
    });
    expect(result.results).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });
});

describe("getAmeliBySpecialiteDept", () => {
  it("lists every PS in dept 08 (Ardennes)", async () => {
    const result = await getAmeliBySpecialiteDept({ departement: "08" });
    // 9 in Charleville + 1 cardio Sedan + 1 NULL-geom = 11.
    // The dept RPC doesn't filter on geog NULL, so the SEED_NULLGEOM row
    // shows up here even though it's invisible to the radius RPC.
    expect(result.results.length).toBe(11);
    expect(result.results.every((r) => r.adresse.code_departement === "08")).toBe(true);
  });

  it("filters by specialite (MG only) in dept 08", async () => {
    const result = await getAmeliBySpecialiteDept({
      departement: "08",
      specialiteCode: "01",
    });
    // 5 MG Charleville + 1 NULL-geom (also MG) = 6 in dept 08.
    expect(result.results.length).toBe(6);
    expect(result.results.every((r) => r.specialite.code === "01")).toBe(true);
  });

  it("filters by type_ps (IDE) in dept 08", async () => {
    const result = await getAmeliBySpecialiteDept({
      departement: "08",
      typePsCode: "2",
    });
    expect(result.results.length).toBe(3);
    expect(result.results.every((r) => r.type_ps.code === "2")).toBe(true);
  });

  it("returns nothing for a dept without seeded PS", async () => {
    const result = await getAmeliBySpecialiteDept({ departement: "75" });
    expect(result.results).toEqual([]);
  });
});
