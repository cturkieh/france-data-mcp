import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../core/http.js";
import { getZonesAU } from "./apicarto-plu.js";

// ---------------------------------------------------------------------------
// Fetch mock (same pattern as src/core/http.test.ts)
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEATURE_AU: object = {
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: [] },
  properties: {
    typezone: "AU",
    libelle: "1AU",
    libelong: "Zone à urbaniser",
    libelle_commune: "Montpellier",
  },
};

const FEATURE_U: object = {
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: [] },
  properties: {
    typezone: "U",
    libelle: "UA",
    libelong: "Zone urbaine centrale",
    libelle_commune: "Montpellier",
  },
};

const FEATURE_N: object = {
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: [] },
  properties: {
    typezone: "N",
    libelle: "N",
    libelong: "Zone naturelle",
    libelle_commune: "Montpellier",
  },
};

const FEATURE_A: object = {
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: [] },
  properties: {
    typezone: "A",
    libelle: "A",
    libelong: "Zone agricole",
    libelle_commune: "Cherbourg-en-Cotentin",
  },
};

// Cas réel CNIG/GPU (Cherbourg) : « à urbaniser » = "AUc" (ouverte) / "AUs"
// (stricte), JAMAIS la chaîne nue "AU". Filtre strict === "AU" → comptait 0.
const FEATURE_AUC: object = {
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: [] },
  properties: {
    typezone: "AUc",
    libelle: "1AUc",
    libelong: "Zone à urbaniser ouverte",
    libelle_commune: "Cherbourg-en-Cotentin",
  },
};

const FEATURE_AUS: object = {
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: [] },
  properties: {
    typezone: "AUs",
    libelle: "2AUs",
    libelong: "Zone à urbaniser stricte",
    libelle_commune: "Cherbourg-en-Cotentin",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getZonesAU", () => {
  it("(a) features mixtes → AU + AUc + AUs retenues, U/A/N exclues, couverture:ok", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        type: "FeatureCollection",
        features: [FEATURE_U, FEATURE_AU, FEATURE_AUC, FEATURE_AUS, FEATURE_A, FEATURE_N],
      }),
    );

    const result = await getZonesAU(43.6, 3.87);

    expect(result.couverture).toBe("ok");
    // AU + AUc + AUs retenues ; U / A / N exclues
    expect(result.n_zones_au).toBe(3);
    // B1 : chaque entrée zones_au PORTE sa propre feature (source unique).
    // Le payload passe par JSON (fetch mock) → les features sont des copies deep-equal.
    expect(result.zones_au).toEqual([
      { typezone: "AU", libelle: "1AU", libelong: "Zone à urbaniser", feature: FEATURE_AU },
      {
        typezone: "AUc",
        libelle: "1AUc",
        libelong: "Zone à urbaniser ouverte",
        feature: FEATURE_AUC,
      },
      {
        typezone: "AUs",
        libelle: "2AUs",
        libelong: "Zone à urbaniser stricte",
        feature: FEATURE_AUS,
      },
    ]);
    // geojson ne contient que les features AU (préfixe AU, casse-insensible)
    expect(result.geojson.type).toBe("FeatureCollection");
    expect(result.geojson.features).toHaveLength(3);
    // B1 : geojson.features === zones_au.map(z=>z.feature) — alignement structurel garanti
    expect(result.geojson.features).toEqual(result.zones_au.map((z) => z.feature));
    const typezones = (result.geojson.features as { properties: { typezone: string } }[]).map(
      (f) => f.properties.typezone,
    );
    expect(typezones).toEqual(["AU", "AUc", "AUs"]);
  });

  it("(b) features[] vide → couverture:indisponible:no_plu, tout à zéro", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        type: "FeatureCollection",
        features: [],
      }),
    );

    const result = await getZonesAU(43.6, 3.87);

    expect(result.couverture).toBe("indisponible:no_plu");
    expect(result.n_zones_au).toBe(0);
    expect(result.zones_au).toEqual([]);
    expect(result.geojson.features).toEqual([]);
  });

  it("(c) features présentes mais aucune AU (U/A/N) → couverture:ok, n_zones_au:0", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        type: "FeatureCollection",
        features: [FEATURE_U, FEATURE_A, FEATURE_N],
      }),
    );

    const result = await getZonesAU(43.6, 3.87);

    expect(result.couverture).toBe("ok");
    expect(result.n_zones_au).toBe(0);
    expect(result.zones_au).toEqual([]);
    expect(result.geojson.features).toEqual([]);
  });

  it("(d) fetch rejette (erreur réseau) → getZonesAU rejette et émet console.warn", async () => {
    fetchMock.mockRejectedValue(new TypeError("network error"));

    await expect(getZonesAU(43.6, 3.87, { baseDelayMs: 1 })).rejects.toThrow("network error");
    expect(console.warn).toHaveBeenCalled();
  });

  it("(d-bis) HTTP error (ex: 500) → getZonesAU rejette", async () => {
    // fetchJson retry puis throw HttpError sur 500 après épuisement
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(getZonesAU(43.6, 3.87, { baseDelayMs: 1 })).rejects.toBeInstanceOf(HttpError);
  });

  it("URL construite avec lon EN PREMIER dans le GeoJSON Point (lon,lat)", async () => {
    fetchMock.mockResolvedValue(jsonOk({ type: "FeatureCollection", features: [] }));

    const lat = 43.6;
    const lon = 3.87;
    await getZonesAU(lat, lon);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    const geomParam = new URL(calledUrl).searchParams.get("geom");
    const point = JSON.parse(geomParam ?? "{}") as { type: string; coordinates: number[] };

    expect(point.type).toBe("Point");
    // coordinates[0]=lon, coordinates[1]=lat
    expect(point.coordinates[0]).toBe(lon);
    expect(point.coordinates[1]).toBe(lat);
  });

  it("radiusKm → geom est un Polygon bbox (pas un Point)", async () => {
    fetchMock.mockResolvedValue(jsonOk({ type: "FeatureCollection", features: [] }));

    await getZonesAU(43.6, 3.87, { radiusKm: 2 });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("Polygon");

    const geomParam = new URL(calledUrl).searchParams.get("geom");
    const geom = JSON.parse(geomParam ?? "{}") as { type: string };
    expect(geom.type).toBe("Polygon");
  });
});
