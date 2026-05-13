import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _clearPopulationCacheForTests,
  getPopulationByCommune,
  getPopulationByDept,
  getPopulationFrance,
} from "./insee-melodi.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  _clearPopulationCacheForTests();
  fetchSpy.mockReset();
});

afterEach(() => {
  fetchSpy.mockReset();
});

function mockMelodi(observations: Array<Record<string, unknown>>): void {
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({ observations, identifier: "DS_POPULATIONS_REFERENCE", paging: {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function obs(geo: string, year: string, measure: string, value: number): Record<string, unknown> {
  return {
    dimensions: { GEO: geo, FREQ: "A", TIME_PERIOD: year, POPREF_MEASURE: measure },
    measures: { OBS_VALUE_NIVEAU: { value } },
  };
}

describe("getPopulationByCommune", () => {
  it("parse les 3 mesures (PMUN/PCAP/PTOT) pour Paris 75056 en 2023", async () => {
    mockMelodi([
      obs("2025-COM-75056", "2023", "PMUN", 2103778),
      obs("2025-COM-75056", "2023", "PCAP", 15634),
      obs("2025-COM-75056", "2023", "PTOT", 2119412),
    ]);
    const result = await getPopulationByCommune("75056");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected found");
    expect(result.codeInsee).toBe("75056");
    expect(result.geoLevel).toBe("COM");
    expect(result.annee).toBe(2023);
    expect(result.populationMunicipale).toBe(2103778);
    expect(result.populationComptageApart).toBe(15634);
    expect(result.populationTotale).toBe(2119412);
    expect(result.millesimeGeographique).toBe("2025");
  });

  it("garde la TIME_PERIOD la plus récente quand plusieurs années sont retournées", async () => {
    mockMelodi([
      obs("2025-COM-75056", "2020", "PMUN", 2148000),
      obs("2025-COM-75056", "2023", "PMUN", 2103778),
      obs("2025-COM-75056", "2021", "PMUN", 2133000),
    ]);
    const result = await getPopulationByCommune("75056");
    if (!result.found) throw new Error("expected found");
    expect(result.annee).toBe(2023);
    expect(result.populationMunicipale).toBe(2103778);
  });

  it("accepte les codes Corse (2A004, 2B033)", async () => {
    mockMelodi([obs("2025-COM-2A004", "2023", "PMUN", 6800)]);
    const result = await getPopulationByCommune("2A004");
    expect(result.found).toBe(true);
  });

  it("rejette un code commune invalide (4 chiffres)", async () => {
    await expect(getPopulationByCommune("7505")).rejects.toThrow(RangeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejette un code commune non-string", async () => {
    await expect(getPopulationByCommune(75056 as unknown as string)).rejects.toThrow(RangeError);
  });

  it("retourne lookupNotFound quand observations vide (commune fusionnée)", async () => {
    mockMelodi([]);
    const result = await getPopulationByCommune("99999");
    expect(result.found).toBe(false);
    if (result.found) throw new Error("expected not found");
    expect(result.lookupStatus).toBe("not_found");
    expect(result.key).toBe("99999");
    expect(result.message).toContain("autocomplete_commune");
  });

  it("throw si PMUN absent du payload (régression upstream incomplète)", async () => {
    mockMelodi([
      obs("2025-COM-75056", "2023", "PCAP", 15634),
      obs("2025-COM-75056", "2023", "PTOT", 2119412),
    ]);
    await expect(getPopulationByCommune("75056")).rejects.toThrow(
      /PMUN absent du payload/u,
    );
  });

  it("throw si TIME_PERIOD non parsable (régression schéma SDMX)", async () => {
    // "Q1-2024" ne commence par aucun chiffre → parseInt retourne NaN.
    // Cas "2024-Q1" matche partiellement (parseInt → 2024) — pas un cas test
    // valable car parseInt extrait quand même l'année. Vrai cas pathologique :
    // string totalement non-numérique (régression schéma profond).
    mockMelodi([obs("2025-COM-75056", "Q1-2024", "PMUN", 2103778)]);
    await expect(getPopulationByCommune("75056")).rejects.toThrow(
      /aucune TIME_PERIOD parsable/u,
    );
  });

  it("mappe HTTP 400 INSEE en lookupNotFound (code rejeté par l'API)", async () => {
    fetchSpy.mockResolvedValue(
      new Response("Type de territoire non reconnu", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
    );
    const result = await getPopulationByCommune("12345");
    expect(result.found).toBe(false);
    if (result.found) throw new Error("expected not found");
    expect(result.message).toContain("rejeté");
  });

  it("hit le cache in-memory au 2ème appel pour le même code", async () => {
    mockMelodi([obs("2025-COM-75056", "2023", "PMUN", 2103778)]);
    await getPopulationByCommune("75056");
    await getPopulationByCommune("75056");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getPopulationByDept", () => {
  it("parse les 3 mesures pour le département 75", async () => {
    mockMelodi([
      obs("2025-DEP-75", "2023", "PMUN", 2103778),
      obs("2025-DEP-75", "2023", "PCAP", 15634),
      obs("2025-DEP-75", "2023", "PTOT", 2119412),
    ]);
    const result = await getPopulationByDept("75");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected found");
    expect(result.geoLevel).toBe("DEP");
    expect(result.populationMunicipale).toBe(2103778);
  });

  it("accepte les codes département Corse (2A, 2B) et DOM (971, 972...)", async () => {
    mockMelodi([obs("2025-DEP-2A", "2023", "PMUN", 158000)]);
    const a = await getPopulationByDept("2A");
    expect(a.found).toBe(true);

    fetchSpy.mockReset();
    mockMelodi([obs("2025-DEP-971", "2023", "PMUN", 384000)]);
    const guadeloupe = await getPopulationByDept("971");
    expect(guadeloupe.found).toBe(true);
  });

  it("rejette un code département invalide", async () => {
    await expect(getPopulationByDept("XX")).rejects.toThrow(RangeError);
    await expect(getPopulationByDept("9999")).rejects.toThrow(RangeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hit le cache in-memory séparément du cache commune", async () => {
    mockMelodi([obs("2025-COM-75056", "2023", "PMUN", 2103778)]);
    await getPopulationByCommune("75056");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    mockMelodi([obs("2025-DEP-75", "2023", "PMUN", 2103778)]);
    await getPopulationByDept("75");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("getPopulationFrance", () => {
  it("retourne la pop France entière (DOM inclus, FRANCE-F)", async () => {
    mockMelodi([
      obs("2025-FRANCE-F", "2023", "PMUN", 68094280),
      obs("2025-FRANCE-F", "2023", "PCAP", 1199825),
      obs("2025-FRANCE-F", "2023", "PTOT", 69294105),
    ]);
    const result = await getPopulationFrance();
    expect(result.codeInsee).toBe("FRANCE");
    expect(result.geoLevel).toBe("FRANCE");
    expect(result.annee).toBe(2023);
    expect(result.populationMunicipale).toBe(68094280);
    expect(result.populationTotale).toBe(69294105);
  });

  it("throw si Melodi renvoie 0 observations (incident upstream, pas un cas not_found légitime)", async () => {
    mockMelodi([]);
    await expect(getPopulationFrance()).rejects.toThrow(/0 observations.*FRANCE-F/u);
  });
});
