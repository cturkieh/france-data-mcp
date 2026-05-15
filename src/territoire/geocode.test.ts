import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode, geocodeMany, reverseGeocode } from "./geocode.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function geocodeResponse(features: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("geocode", () => {
  it("géocode une adresse Charleville et retourne coords + score", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        {
          geometry: { type: "Point", coordinates: [4.719239, 49.767192] },
          properties: {
            label: "64 Cours Aristide Briand 08000 Charleville-Mézières",
            score: 0.9731,
            type: "housenumber",
            postcode: "08000",
            citycode: "08105",
            city: "Charleville-Mézières",
          },
        },
      ]),
    );

    const result = await geocode("64 Cours Aristide Briand 08000 Charleville-Mézières");

    expect(result).not.toBeNull();
    expect(result?.point).toEqual({ lon: 4.719239, lat: 49.767192 });
    expect(result?.score).toBeGreaterThan(0.9);
    expect(result?.type).toBe("housenumber");
    expect(result?.commune).toBe("Charleville-Mézières");
  });

  it("renvoie null si aucune adresse trouvée", async () => {
    fetchMock.mockResolvedValue(geocodeResponse([]));
    const result = await geocode("XXX adresse inexistante XXX");
    expect(result).toBeNull();
  });

  it("transmet le filtre codePostal", async () => {
    fetchMock.mockResolvedValue(geocodeResponse([]));
    await geocode("Cours Briand", { codePostal: "08000" });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("postcode=08000");
  });
});

describe("geocodeMany", () => {
  it("renvoie plusieurs candidats", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        {
          geometry: { type: "Point", coordinates: [2.35, 48.85] },
          properties: { label: "A", score: 0.9, type: "street" },
        },
        {
          geometry: { type: "Point", coordinates: [2.36, 48.86] },
          properties: { label: "B", score: 0.8, type: "street" },
        },
      ]),
    );
    const results = await geocodeMany("rue de Rivoli", { limit: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]?.label).toBe("A");
  });
});

describe("reverseGeocode", () => {
  it("transforme coords en adresse", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        {
          geometry: { type: "Point", coordinates: [4.719, 49.767] },
          properties: {
            label: "Cours Aristide Briand 08000 Charleville-Mézières",
            score: 0.95,
            type: "street",
          },
        },
      ]),
    );
    const result = await reverseGeocode({ lon: 4.719, lat: 49.767 });
    expect(result?.label).toContain("Charleville");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/reverse/");
  });
});

describe("confidence_low (B1)", () => {
  function singleFeature(score: number) {
    return geocodeResponse([
      {
        geometry: { type: "Point", coordinates: [4.7, 49.7] },
        properties: { label: "Rue X 08000 Y", score, type: "street" },
      },
    ]);
  }

  it("confidence_low=false quand score >= seuil", async () => {
    fetchMock.mockResolvedValue(singleFeature(0.82));
    const result = await geocode("62 Boulevard de la Liberté Lille");
    expect(result?.confidence_low).toBe(false);
  });

  it("confidence_low=true quand score < seuil (match douteux)", async () => {
    fetchMock.mockResolvedValue(singleFeature(0.33));
    const result = await geocode("62 Boulevard de la Liberté Lille");
    expect(result?.confidence_low).toBe(true);
  });

  it("propage confidence_low via reverseGeocode", async () => {
    fetchMock.mockResolvedValue(singleFeature(0.4));
    const result = await reverseGeocode({ lon: 4.7, lat: 49.7 });
    expect(result?.confidence_low).toBe(true);
  });

  it("score absent du payload IGN → confidence_low=true (prudence, pas faux négatif)", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        {
          geometry: { type: "Point", coordinates: [4.7, 49.7] },
          properties: { label: "Rue X 08000 Y", type: "street" },
        },
      ]),
    );
    const result = await geocode("adresse au score manquant");
    expect(result?.confidence_low).toBe(true);
  });

  it("score NaN → confidence_low=true (pas false silencieux)", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        {
          geometry: { type: "Point", coordinates: [4.7, 49.7] },
          properties: { label: "Rue X 08000 Y", score: Number.NaN, type: "street" },
        },
      ]),
    );
    const result = await geocode("adresse au score NaN");
    expect(result?.confidence_low).toBe(true);
  });
});
