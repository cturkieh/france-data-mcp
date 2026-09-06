import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase à l'import : permet aux tests `getFinessByNumFiness`
// d'invoquer le wrapper sans accès DB. Les tests de validation d'input
// throw AVANT le RPC, donc ils ne touchent pas le mock — compat.
const mockRpc = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getAnonClient: () => ({ rpc: mockRpc }),
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import {
  _resetFinessGeoPrecisionMissingWarning,
  getFinessByCategorie,
  getFinessByNumFiness,
  getFinessInRadius,
} from "./finess-db.js";

// Pure unit tests for the input-validation guards. No DB / Supabase Local
// needed — the RangeError throws before any RPC call. Locks the SFH-7
// (lat/lon WGS84 bounds) and limit-bound contracts against silent regressions.

describe("getFinessInRadius input validation", () => {
  it("rejects latitude outside [-90, 90]", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: 91, lon: 0 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
    await expect(
      getFinessInRadius({
        center: { lat: -91, lon: 0 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
  });

  it("rejects longitude outside [-180, 180]", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: 49.7724, lon: 200 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lon must be in/);
    await expect(
      getFinessInRadius({
        center: { lat: 49.7724, lon: -200 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lon must be in/);
  });

  it("rejects NaN lat or lon", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: Number.NaN, lon: 4.7 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
    await expect(
      getFinessInRadius({
        center: { lat: 49.7, lon: Number.NaN },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lon must be in/);
  });

  it("rejects Infinity lat or lon", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: Number.POSITIVE_INFINITY, lon: 4.7 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/lat must be in/);
  });

  it("rejects limit out of [1, 500]", async () => {
    await expect(
      getFinessInRadius({
        center: { lat: 49.7, lon: 4.7 },
        radiusKm: 5,
        limit: 0,
      }),
    ).rejects.toThrow(/limit must be between/);
    await expect(
      getFinessInRadius({
        center: { lat: 49.7, lon: 4.7 },
        radiusKm: 5,
        limit: 1000,
      }),
    ).rejects.toThrow(/limit must be between/);
  });

  it("rejects radiusKm out of [0.1, 50] (V0.4.1 — DB layer alignment with Ameli)", async () => {
    // Avant V0.4.1, le DB layer FINESS n'avait aucune validation et acceptait
    // radiusKm: 1000 → ST_DWithin sur 95K rows pour rien. Cas régressif à
    // verrouiller : tout caller direct (lib npm) doit voir RangeError.
    await expect(
      getFinessInRadius({ center: { lat: 49.7, lon: 4.7 }, radiusKm: 51 }),
    ).rejects.toThrow(RangeError);
    await expect(
      getFinessInRadius({ center: { lat: 49.7, lon: 4.7 }, radiusKm: 0.05 }),
    ).rejects.toThrow(/radiusKm must be in/);
    await expect(
      getFinessInRadius({ center: { lat: 49.7, lon: 4.7 }, radiusKm: -1 }),
    ).rejects.toThrow(/radiusKm must be in/);
  });
});

describe("getFinessByCategorie input validation", () => {
  it("rejette un code_insee ou un département hors format AVANT la RPC (le cast CHAR(n) tronquerait en silence)", async () => {
    mockRpc.mockReset();
    await expect(getFinessByCategorie({ famille: "labo", code_insee: "751011" })).rejects.toThrow(
      RangeError,
    );
    await expect(getFinessByCategorie({ famille: "labo", departement: "7500" })).rejects.toThrow(
      RangeError,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects limit out of [1, 500]", async () => {
    await expect(getFinessByCategorie({ famille: "ehpad", limit: 0 })).rejects.toThrow(
      /limit must be between/,
    );
    await expect(getFinessByCategorie({ famille: "ehpad", limit: 1000 })).rejects.toThrow(
      /limit must be between/,
    );
  });
});

/** Ligne RPC de référence (LBM Bio Ard'Aisne, canary) — surcharger par spread. */
const RPC_ROW = {
  num_finess: "080010101",
  raison_sociale: "LBM BIO ARD'AISNE",
  categorie_code: "611",
  categorie_libelle: "Laboratoire de Biologie Médicale",
  voie: "7 R DUBOIS CRANCE",
  code_postal: "08000",
  ville: "CHARLEVILLE MEZIERES",
  code_departement: "08",
  code_insee: "08105",
  telephone: "0324564266",
  email: null,
  geom: { type: "Point", coordinates: [4.715688833, 49.77217843] },
  siret: "12345678900012",
  geom_source: "ans",
};

describe("getFinessByNumFiness LookupResult (V0.4.3 migration)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retourne un LookupNotFound typé quand le RPC ne renvoie rien", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const out = await getFinessByNumFiness("999999999");
    expect(out.found).toBe(false);
    if (!out.found) {
      expect(out.key).toBe("999999999");
      expect(out.lookupStatus).toBe("not_found");
      expect(out.message).toMatch(/introuvable|EN SERVICE|ANS/);
    }
  });

  it("wrap le résultat en found:true quand le RPC retourne un row", async () => {
    mockRpc.mockResolvedValue({ data: [RPC_ROW], error: null });
    const out = await getFinessByNumFiness("080010101");
    expect(out.found).toBe(true);
    if (out.found) {
      expect(out.num_finess).toBe("080010101");
      expect(out.raison_sociale).toBe("LBM BIO ARD'AISNE");
      expect(out.geo_precision).toBe("adresse");
      expect(out.siret_ans).toBe("12345678900012");
    }
  });

  it("warn et garde le premier row quand le RPC remonte plusieurs lignes (PK normalement unique)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = { ...RPC_ROW, raison_sociale: "DUPLICATE A", geom: null, geom_source: null };
    mockRpc.mockResolvedValue({
      data: [row, { ...row, raison_sociale: "DUPLICATE B" }],
      error: null,
    });
    const out = await getFinessByNumFiness("080010101");
    expect(out.found).toBe(true);
    if (out.found) {
      expect(out.raison_sociale).toBe("DUPLICATE A");
    }
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("expected ≤ 1");
    warnSpy.mockRestore();
  });

  it("rejette un num_finess mal formé sans appeler le RPC", async () => {
    // V0.7.3 : utilise `assertValidNumFiness` shared helper, message "invalide ... attendu 9 chiffres".
    await expect(getFinessByNumFiness("123")).rejects.toThrow(/num_finess invalide/);
    await expect(getFinessByNumFiness("123")).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("geo_precision par résultat + siret_ans (V0.30.0, colonne finess.geom_source)", () => {
  const base = { ...RPC_ROW, code_departement: "08 ", distance_meters: 280.5 };
  const point = RPC_ROW.geom;
  const radius = () => getFinessInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });

  beforeEach(() => {
    mockRpc.mockReset();
    _resetFinessGeoPrecisionMissingWarning();
  });

  it("les trois provenances du vocabulaire → geo_precision='adresse' (jamais de centroïde en base), sans warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: ["ans", "ban_address", "previous_ingest"].map((geom_source, i) => ({
        ...base,
        num_finess: `08001010${i}`,
        geom: point,
        siret: null,
        geom_source,
      })),
      error: null,
    });
    const out = await radius();
    expect(out.results.map((r) => r.geo_precision)).toEqual(["adresse", "adresse", "adresse"]);
    expect(out.results[0]?.siret_ans).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("valeur hors vocabulaire (ex. centroïde passé par une migration sans la lib) → throw, jamais traduite en 'adresse'", async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...base, geom: point, siret: null, geom_source: "commune_centroid" }],
      error: null,
    });
    await expect(radius()).rejects.toThrow(/contract violation.*commune_centroid/);
  });

  it("sans coords : geo_precision ABSENT (pas null), siret_ans conservé", async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...base, geom: null, siret: "12345678900012", geom_source: null }],
      error: null,
    });
    const out = await getFinessByCategorie({ famille: "labo" });
    const r = out.results[0];
    expect(r?.coords).toBeNull();
    expect(r && "geo_precision" in r).toBe(false);
    expect(r?.siret_ans).toBe("12345678900012");
  });

  it("siret CHAR(14) paddé/vide → trim ou null", async () => {
    mockRpc.mockResolvedValue({
      data: [
        { ...base, geom: null, siret: "12345678900012  ", geom_source: null },
        { ...base, num_finess: "080010102", geom: null, siret: "   ", geom_source: null },
      ],
      error: null,
    });
    const out = await getFinessByCategorie({ famille: "labo" });
    expect(out.results[0]?.siret_ans).toBe("12345678900012");
    expect(out.results[1]?.siret_ans).toBeNull();
  });

  it("colonne geom_source ABSENTE (RPC antérieure) : warn 1-shot, geo_precision='adresse' quand même, et note dans query_metadata", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: [
        { ...base, geom: point, geom_source: undefined },
        { ...base, num_finess: "080010102", geom: point, geom_source: undefined },
        { ...base, num_finess: "080010103", geom: null, geom_source: undefined },
      ],
      error: null,
    });
    const out = await radius();
    expect(out.results.map((r) => r.geo_precision)).toEqual(["adresse", "adresse", undefined]);
    const drift = warnSpy.mock.calls.filter((c) => String(c[0]).includes("geom_source"));
    expect(drift).toHaveLength(1);
    expect(String(drift[0]?.[0])).toContain("[finess-db]");
    expect(out.query_metadata?.notes.at(-1)).toMatch(
      /^2 établissement\(s\) servi\(s\) sans colonne de provenance/,
    );
    warnSpy.mockRestore();
  });

  it("geom_source null AVEC un point : état impossible (contrainte geom ⇔ geom_source) → throw", async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...base, geom: point, geom_source: null }],
      error: null,
    });
    await expect(radius()).rejects.toThrow(/contract violation.*null/);
  });

  it("query_metadata porte l'étiquette point_etablissement_finess (plus lambert93_natif_finess)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const out = await radius();
    expect(out.query_metadata?.geo_precision).toBe("point_etablissement_finess");
    expect(out.query_metadata?.notes.join(" ")).toMatch(/ANS/);
    expect(out.query_metadata?.notes.join(" ")).not.toMatch(/DREES/);
  });
});
