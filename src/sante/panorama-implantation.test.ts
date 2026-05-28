import { afterEach, describe, expect, it, vi } from "vitest";
import * as freshnessMod from "../storage/ingest-log.js";
import type { GeocodeResult } from "../territoire/geocode.js";
import * as geocodeMod from "../territoire/geocode.js";
import * as irisMod from "../territoire/iris-profil.js";
import * as ameliMod from "./ameli-db.js";
import * as cdsMod from "./cds-db.js";
import * as coverageMod from "./coverage.js";
import * as finessMod from "./finess-db.js";
import { panoramaImplantationComplet, runSection } from "./panorama-implantation.js";
import * as panoramaMod from "./panorama.js";
import * as rppsMod from "./rpps-db.js";

afterEach(() => vi.restoreAllMocks());

/** Mocke les 8 briques de section avec des retours minimaux valides. */
function mockAllSectionsOk(opts: { revenuPct?: number } = {}) {
  vi.spyOn(geocodeMod, "geocode").mockResolvedValue(geocodeOk());
  vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValue({
    codeInsee: "59350",
    niveau: "commune",
    niveauEtablissements: "departement",
    densitesProfessionnels: {} as never,
    etablissementsParFamille: [],
    demande: null,
    sources: {} as never,
  });
  vi.spyOn(irisMod, "getProfilIris").mockResolvedValue({
    found: true,
    lookupStatus: "found",
    mode: "bassin",
    rayon_km: 5,
    nb_iris_agreges: 27,
    population_bassin: 48230,
    age: {} as never,
    csp: {} as never,
    familles_avec_enfants: 6120,
    revenu_median_pondere: 24800,
    couverture: { revenu_pct_population: opts.revenuPct ?? 1, iris_revenu_manquants: 0 },
    source: "INSEE/FILOSOFI",
  } as never);
  vi.spyOn(finessMod, "getFinessInRadius").mockResolvedValue({
    count: 0,
    truncated: false,
    results: [],
  });
  vi.spyOn(rppsMod, "getRppsInRadius").mockResolvedValue({
    count: 0,
    truncated: false,
    results: [],
  });
  vi.spyOn(ameliMod, "getAmeliInRadius").mockResolvedValue({
    count: 0,
    truncated: false,
    results: [],
  });
  vi.spyOn(cdsMod, "getCdsInRadius").mockResolvedValue({ count: 0, truncated: false, results: [] });
  vi.spyOn(coverageMod, "getCoverageFinessVsSireneInRadius").mockResolvedValue({
    coverage_status: "computed",
    finess_only_count: 2,
    sirene_only_count: 5,
    finess_sites: 23,
    sirene_sirets: 21,
    coverage_ratio: 1.1,
  } as never);
  vi.spyOn(freshnessMod, "getDataFreshness").mockResolvedValue([
    {
      source: "finess",
      cadence_hint: "bimestrielle",
      last_success_at: "2026-05-01",
      staleness_days: 27,
    } as never,
  ]);
}

describe("panorama_implantation_complet — sections (Promise.all + couverture)", () => {
  it("toutes sections OK → couverture tout 'ok' + meta peuplée", async () => {
    mockAllSectionsOk();
    const r = await panoramaImplantationComplet({ adresse: "Lille rue Nationale", rayonKm: 5 });
    expect(r.meta.code_insee).toBe("59350");
    expect(r.meta.point).toEqual({ lat: 50.633, lon: 3.057 });
    expect(r.meta.sources.length).toBeGreaterThan(0);
    for (const section of [
      "territoire",
      "demande",
      "concurrents",
      "pourvoyeurs",
      "prescripteurs",
      "cds",
      "referentiels",
    ]) {
      expect(r.couverture[section]).toBe("ok");
    }
    expect(r.referentiels).not.toBeNull();
  });

  it("FILOSOFI partiel → couverture.demande = 'partiel:revenu_pct_population=…' (spec §4.5)", async () => {
    mockAllSectionsOk({ revenuPct: 0.84 });
    const r = await panoramaImplantationComplet({ adresse: "Lille" });
    expect(r.couverture.demande).toBe("partiel:revenu_pct_population=0.84");
    expect(r.demande).not.toBeNull(); // la donnée reste servie
  });

  it("section 'demande' down → 'indisponible:…', les 6 autres restent 'ok'", async () => {
    mockAllSectionsOk();
    vi.spyOn(irisMod, "getProfilIris").mockRejectedValue(new Error("IRIS DB down"));
    const r = await panoramaImplantationComplet({ adresse: "Lille" });
    expect(r.couverture.demande).toMatch(/^indisponible:/);
    expect(r.demande).toBeNull();
    expect(r.couverture.territoire).toBe("ok");
    expect(r.couverture.concurrents).toBe("ok");
    expect(r.couverture.referentiels).toBe("ok");
  });

  it("Promise.all : les sections sont parallélisées (pas en série)", async () => {
    mockAllSectionsOk();
    const order: string[] = [];
    const slow =
      <T>(tag: string, val: T) =>
      async () => {
        order.push(`start-${tag}`);
        await new Promise((res) => setTimeout(res, 15));
        order.push(`end-${tag}`);
        return val;
      };
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockImplementation(
      slow("terr", {
        codeInsee: "59350",
        niveau: "commune",
        niveauEtablissements: "departement",
        densitesProfessionnels: {},
        etablissementsParFamille: [],
        demande: null,
        sources: {},
      }) as never,
    );
    vi.spyOn(finessMod, "getFinessInRadius").mockImplementation(
      slow("fin", { count: 0, truncated: false, results: [] }) as never,
    );
    vi.spyOn(cdsMod, "getCdsInRadius").mockImplementation(
      slow("cds", { count: 0, truncated: false, results: [] }) as never,
    );
    await panoramaImplantationComplet({ adresse: "Lille" });
    const firstEnd = order.findIndex((s) => s.startsWith("end-"));
    const lastStart = order
      .map((s, i) => (s.startsWith("start-") ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    expect(firstEnd).toBeGreaterThan(lastStart ?? -1); // tous les start AVANT le 1er end
  });
});

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

describe("panorama_implantation_complet — piège PLM (spec §4.5)", () => {
  it("arrondissement PLM (Paris 1er) → plm_mode=true + territoire 'indisponible' SANS appeler la brique commune-only", async () => {
    mockAllSectionsOk();
    vi.spyOn(geocodeMod, "geocode").mockResolvedValue(
      geocodeOk({ point: { lat: 48.86, lon: 2.34 }, codeCommune: "75101", commune: "Paris 1er" }),
    );
    // panorama_sante_territoire REJETTE les codes PLM (commune-only) → on ne
    // l'appelle PAS en PLM, on flague territoire indisponible (repli densite_sante dept).
    const terrSpy = vi.spyOn(panoramaMod, "panoramaSanteTerritoire");
    const r = await panoramaImplantationComplet({ adresse: "Paris 1er" });
    expect(r.meta.plm_mode).toBe(true);
    expect(terrSpy).not.toHaveBeenCalled();
    expect(r.couverture.territoire).toMatch(/^indisponible:/);
    expect(r.couverture.territoire).toContain("département");
    // Les sections radius/bassin restent servies (le point est valide).
    expect(r.couverture.concurrents).toBe("ok");
    expect(r.couverture.demande).toBe("ok");
  });

  it("commune non-PLM → plm_mode=false + territoire au code INSEE commune", async () => {
    mockAllSectionsOk();
    const terrSpy = vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValue({
      codeInsee: "59350",
      niveau: "commune",
      niveauEtablissements: "departement",
      densitesProfessionnels: {} as never,
      etablissementsParFamille: [],
      demande: null,
      sources: {} as never,
    });
    const r = await panoramaImplantationComplet({ adresse: "Lille" });
    expect(r.meta.plm_mode).toBe(false);
    expect(terrSpy).toHaveBeenCalledWith({ codeInsee: "59350" });
  });
});

describe("panorama_implantation_complet — garde-fous revue", () => {
  it("résultat radius tronqué (count cappé) → couverture 'partiel:tronqué' (count = plancher)", async () => {
    mockAllSectionsOk();
    // 50 labos rendus mais truncated:true → il y en a plus que la borne.
    vi.spyOn(finessMod, "getFinessInRadius").mockResolvedValue({
      count: 50,
      truncated: true,
      results: [],
    });
    const r = await panoramaImplantationComplet({ adresse: "Lyon Part-Dieu" });
    expect(r.couverture.concurrents).toMatch(/^partiel:tronqué/);
    expect(r.couverture.pourvoyeurs).toMatch(/^partiel:tronqué/);
  });

  it("géocode match_partial (IGN renvoie une autre adresse) → exposé dans meta.geocode (pas de rejet)", async () => {
    mockAllSectionsOk();
    vi.spyOn(geocodeMod, "geocode").mockResolvedValue(geocodeOk({ match_partial: true }));
    const r = await panoramaImplantationComplet({ adresse: "rue ambiguë" });
    expect(r.meta.geocode.match_partial).toBe(true);
    // Pas de rejet : l'étude est servie (signal conservateur, le LLM relativise).
    expect(r.couverture.concurrents).toBe("ok");
  });

  it("échec freshness → couverture.freshness flaggée (dégradation visible dans la sortie)", async () => {
    mockAllSectionsOk();
    vi.spyOn(freshnessMod, "getDataFreshness").mockRejectedValue(new Error("ingest-log down"));
    const r = await panoramaImplantationComplet({ adresse: "Lille" });
    expect(r.couverture.freshness).toMatch(/^indisponible:/);
    // Le panorama reste servi malgré freshness KO.
    expect(r.couverture.concurrents).toBe("ok");
  });
});
