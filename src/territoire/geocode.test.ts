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

  it("hors couverture IGN (0 feature, ex. NYC) → null + warn observabilité (A10)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(geocodeResponse([]));
    const result = await reverseGeocode({ lon: -74.006, lat: 40.7128 });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("hors couverture"));
    warnSpy.mockRestore();
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

describe("confidence_low seuil par type + match_partial (P2)", () => {
  function feature(score: number, type: string, label: string) {
    return geocodeResponse([
      { geometry: { type: "Point", coordinates: [4.7, 49.7] }, properties: { label, score, type } },
    ]);
  }

  it("housenumber score 0.58 → confidence_low=true (symptôme P2 : faux housenumber)", async () => {
    fetchMock.mockResolvedValue(feature(0.58, "housenumber", "8 Pave Bleu 21000 Dijon"));
    const result = await geocode("8 rue du Pré aux Bœufs 21000 Dijon");
    // Ancien seuil global 0.5 → 0.58 passait en confidence_low=false (bug).
    expect(result?.confidence_low).toBe(true);
  });

  it("municipality score 0.55 → confidence_low=false (fallback commune acceptable)", async () => {
    fetchMock.mockResolvedValue(feature(0.55, "municipality", "Dijon 21000"));
    const result = await geocode("Dijon");
    expect(result?.confidence_low).toBe(false);
  });

  it("type IGN inconnu → seuil défaut prudent 0.5", async () => {
    fetchMock.mockResolvedValue(feature(0.45, "poi", "Quelque chose"));
    const result = await geocode("X");
    expect(result?.confidence_low).toBe(true);
  });

  it("match_partial=true quand le label IGN diverge fortement de l'adresse demandée", async () => {
    fetchMock.mockResolvedValue(feature(0.72, "housenumber", "8 Pave Bleu 21000 Dijon"));
    const result = await geocode("8 rue du Pré aux Bœufs 21000 Dijon");
    expect(result?.match_partial).toBe(true);
  });

  it("match_partial=false quand le label IGN correspond à l'adresse demandée", async () => {
    const label = "64 Cours Aristide Briand 08000 Charleville-Mézières";
    fetchMock.mockResolvedValue(feature(0.97, "housenumber", label));
    const result = await geocode(label);
    expect(result?.match_partial).toBe(false);
  });

  it("match_partial absent en géocodage inverse (pas d'adresse demandée)", async () => {
    fetchMock.mockResolvedValue(feature(0.9, "housenumber", "1 Rue Test 75001 Paris"));
    const result = await reverseGeocode({ lon: 2.35, lat: 48.85 });
    expect(result).not.toBeNull();
    expect(result && "match_partial" in result).toBe(false);
  });
});

describe("coordonnées invalides (symétrie B1 — payload IGN dégradé)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const valid = {
    geometry: { type: "Point", coordinates: [2.35, 48.85] },
    properties: { label: "Valide 75001 Paris", score: 0.9, type: "street" },
  };

  it("geocodeMany ignore une feature sans geometry et garde les valides", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        { properties: { label: "Sans geometry", score: 0.9, type: "street" } },
        valid,
      ]),
    );
    const results = await geocodeMany("x");
    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe("Valide 75001 Paris");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp] geocode: feature sans coordonnées exploitables"),
    );
  });

  it("geocodeMany ignore coordinates non-array / longueur invalide", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        { geometry: { type: "Point", coordinates: "2.35,48.85" }, properties: { label: "A" } },
        { geometry: { type: "Point", coordinates: [] }, properties: { label: "B" } },
        valid,
      ]),
    );
    const results = await geocodeMany("x");
    expect(results.map((r) => r.label)).toEqual(["Valide 75001 Paris"]);
  });

  it("geocodeMany ignore lon/lat non finis (null, NaN)", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        { geometry: { type: "Point", coordinates: [null, 48.85] }, properties: { label: "A" } },
        {
          geometry: { type: "Point", coordinates: [2.35, Number.NaN] },
          properties: { label: "B" },
        },
        valid,
      ]),
    );
    const results = await geocodeMany("x");
    expect(results.map((r) => r.label)).toEqual(["Valide 75001 Paris"]);
  });

  it("geocode renvoie null si la seule feature a des coords inexploitables", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        { geometry: { type: "Point", coordinates: [undefined, undefined] }, properties: {} },
      ]),
    );
    const result = await geocode("adresse coords cassées");
    expect(result).toBeNull();
  });

  it("reverseGeocode saute une 1re feature inexploitable et retourne la suivante valide", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([
        { geometry: { coordinates: [999] }, properties: { label: "Cassée" } },
        valid,
      ]),
    );
    const result = await reverseGeocode({ lon: 2.35, lat: 48.85 });
    expect(result?.label).toBe("Valide 75001 Paris");
  });

  it("reverseGeocode renvoie null si toutes les features sont inexploitables", async () => {
    fetchMock.mockResolvedValue(
      geocodeResponse([{ geometry: {}, properties: { label: "Cassée" } }]),
    );
    const result = await reverseGeocode({ lon: 2.35, lat: 48.85 });
    expect(result).toBeNull();
  });
});
