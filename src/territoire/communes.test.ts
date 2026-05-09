import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCommuneByCode, searchCommunes } from "./communes.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("searchCommunes", () => {
  it("trouve Charleville-Mézières par nom avec boost population", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          nom: "Charleville-Mézières",
          code: "08105",
          codesPostaux: ["08000"],
          centre: { type: "Point", coordinates: [4.7203, 49.7724] },
          population: 45560,
          codeDepartement: "08",
          codeRegion: "44",
        },
      ]),
    );

    const villes = await searchCommunes({ nom: "Charleville", boostPopulation: true });

    expect(villes).toHaveLength(1);
    expect(villes[0]).toMatchObject({
      code: "08105",
      nom: "Charleville-Mézières",
      population: 45560,
      codeDepartement: "08",
    });
    expect(villes[0]?.centre).toEqual({ lon: 4.7203, lat: 49.7724 });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("nom=Charleville");
    expect(calledUrl).toContain("boost=population");
  });

  it("recherche par code postal", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await searchCommunes({ codePostal: "08000" });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("codePostal=08000");
  });

  it("clamp limit entre 1 et 30", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await searchCommunes({ nom: "Paris", limit: 999 });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("limit=30");
  });

  it("rejette si aucun critère fourni", async () => {
    await expect(searchCommunes({})).rejects.toThrow(/au moins un critère/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renvoie tableau vide si aucune commune trouvée", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const villes = await searchCommunes({ nom: "ZZZTOPONYMEINEXISTANT" });
    expect(villes).toEqual([]);
  });
});

describe("getCommuneByCode", () => {
  it("renvoie un LookupNotFound typé si code introuvable", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const commune = await getCommuneByCode("99999");
    expect(commune.found).toBe(false);
    if (!commune.found) {
      expect(commune.key).toBe("99999");
      expect(commune.lookupStatus).toBe("not_found");
      expect(commune.message).toMatch(/introuvable|fusionnée|mal formé/i);
    }
  });

  it("renvoie la commune wrappée found:true si trouvée", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          nom: "Reims",
          code: "51454",
          codesPostaux: ["51100"],
          population: 180000,
        },
      ]),
    );
    const commune = await getCommuneByCode("51454");
    expect(commune.found).toBe(true);
    if (commune.found) {
      expect(commune.nom).toBe("Reims");
    }
  });
});

describe("fetchAllCommunes", () => {
  it("appelle /communes sans paramètre de recherche, avec geometry=centre", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          nom: "Charleville-Mézières",
          code: "08105",
          codesPostaux: ["08000"],
          centre: { type: "Point", coordinates: [4.7203, 49.7724] },
          codeDepartement: "08",
        },
      ]),
    );
    const { fetchAllCommunes } = await import("./communes.js");
    const all = await fetchAllCommunes();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ code: "08105", codeDepartement: "08" });
    expect(all[0]?.centre).toEqual({ lon: 4.7203, lat: 49.7724 });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/communes?");
    expect(calledUrl).toContain("geometry=centre");
    expect(calledUrl).not.toContain("nom=");
    expect(calledUrl).not.toContain("codePostal=");
  });
});
