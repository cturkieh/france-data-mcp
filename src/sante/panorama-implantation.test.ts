import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeocodeResult } from "../territoire/geocode.js";
import * as geocodeMod from "../territoire/geocode.js";
import { panoramaImplantationComplet, runSection } from "./panorama-implantation.js";

afterEach(() => vi.restoreAllMocks());

describe("runSection — dégradation par section (spec §4.4)", () => {
  it("succès → { data, status: 'ok' }", async () => {
    const r = await runSection("concurrents", async () => ({ count: 3 }));
    expect(r).toEqual({ data: { count: 3 }, status: "ok" });
  });

  it("brique throw → { data: null, status: 'indisponible:…' } + warn, PAS de throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runSection("cds", async () => {
      throw new Error("CDS source 500");
    });
    expect(r.data).toBeNull();
    expect(r.status).toMatch(/^indisponible:/);
    expect(r.status).toContain("CDS source 500");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cds"));
  });
});

/** Géocode mock complet et fiable (Lille rue Nationale). */
function geocodeOk(overrides: Partial<GeocodeResult> = {}): GeocodeResult {
  return {
    point: { lat: 50.633, lon: 3.057 },
    label: "Rue Nationale 59000 Lille",
    score: 0.96,
    confidence_low: false,
    codeCommune: "59350",
    commune: "Lille",
    type: "housenumber",
    ...overrides,
  };
}

describe("panorama_implantation_complet — ancrage (rejet total)", () => {
  it("géocode sans résultat (null) → RangeError", async () => {
    vi.spyOn(geocodeMod, "geocode").mockResolvedValueOnce(null);
    await expect(panoramaImplantationComplet({ adresse: "zzz introuvable" })).rejects.toThrow(
      RangeError,
    );
  });

  it("confidence_low → RangeError (point non fiable)", async () => {
    vi.spyOn(geocodeMod, "geocode").mockResolvedValueOnce(
      geocodeOk({ score: 0.4, confidence_low: true }),
    );
    await expect(panoramaImplantationComplet({ adresse: "rue floue" })).rejects.toThrow(
      /confidence|fiable|ancrage/i,
    );
  });

  it("code_insee indérivable du géocode → RangeError", async () => {
    vi.spyOn(geocodeMod, "geocode").mockResolvedValueOnce(geocodeOk({ codeCommune: undefined }));
    await expect(panoramaImplantationComplet({ adresse: "sans insee" })).rejects.toThrow(
      /insee|ancrage/i,
    );
  });

  it("ni adresse ni (point+code_insee) → RangeError", async () => {
    await expect(panoramaImplantationComplet({})).rejects.toThrow(RangeError);
  });
});
