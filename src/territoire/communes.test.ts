import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { communeContainingPoint, getCommuneByCode, searchCommunes } from "./communes.js";

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

  // Régression FRANCE-DATA-MCP-2 : avant V0.7.3 le throw était `Error` standard,
  // qui tombait en JSON-RPC -32603 internal_error + capture Sentry parasite.
  // RangeError → mapping -32602 bad_request via api/mcp.ts.
  it("throw RangeError (pas Error standard) quand aucun critère (FRANCE-DATA-MCP-2)", async () => {
    await expect(searchCommunes({})).rejects.toThrow(RangeError);
  });

  it("renvoie tableau vide si aucune commune trouvée", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const villes = await searchCommunes({ nom: "ZZZTOPONYMEINEXISTANT" });
    expect(villes).toEqual([]);
  });

  // V0.19 : filtre dept natif côté geo.api.gouv.fr (évite de filtrer côté boundary
  // et de risquer la perte de candidats au-delà de limit=30 sur une ville commune
  // type "Saint-Martin" dispersée nationalement).
  it("transmet codeDepartement à l'API quand fourni (V0.19)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { nom: "Mont-Saint-Martin", code: "08308", codeDepartement: "08", population: 88 },
      ]),
    );
    await searchCommunes({ nom: "Saint-Martin", codeDepartement: "08" });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("nom=Saint-Martin");
    expect(calledUrl).toContain("codeDepartement=08");
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

describe("communeContainingPoint (fallback frontières point→commune)", () => {
  it("résout la commune contenant le point (point-dans-polygone)", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ code: "50041", nom: "La Hague" }]));
    const result = await communeContainingPoint({ lat: 49.6546, lon: -1.8214 });
    expect(result).toEqual({ codeCommune: "50041", commune: "La Hague" });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/communes?");
    expect(calledUrl).toContain("lat=49.6546");
    expect(calledUrl).toContain("lon=-1.8214");
  });

  it("aucune commune aux frontières (point en mer) → null + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(jsonResponse([]));
    const result = await communeContainingPoint({ lat: 49.9, lon: -2.2 });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("aucune commune"));
    warnSpy.mockRestore();
  });

  it("FAIL-SAFE : erreur HTTP du service frontières → null (jamais de throw)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 404 = throw immédiat de fetchJson (4xx ≠ 429, pas de retry) → catch → null.
    fetchMock.mockResolvedValue(jsonResponse({ message: "not found" }, { status: 404 }));
    const result = await communeContainingPoint({ lat: 49.6546, lon: -1.8214 });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("indisponible"));
    warnSpy.mockRestore();
  });

  it("coords hors-bornes → API ignore le filtre et renvoie TOUTE la liste → null (anti faux positif)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Comportement réel prouvé en live : lat invalide → 200 + liste complète
    // (alphabétique, débute "01001"). length > 1 ⇒ on refuse (jamais data[0]).
    fetchMock.mockResolvedValue(
      jsonResponse([
        { code: "01001", nom: "L'Abergement-Clémenciat" },
        { code: "01002", nom: "L'Abergement-de-Varey" },
        { code: "01004", nom: "Ambérieu-en-Bugey" },
      ]),
    );
    const result = await communeContainingPoint({ lat: 200, lon: -2.2 });
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it("payload partiel (code sans nom) → null (pas de commune à moitié résolue)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(jsonResponse([{ code: "50041" }]));
    const result = await communeContainingPoint({ lat: 49.6546, lon: -1.8214 });
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });
});
