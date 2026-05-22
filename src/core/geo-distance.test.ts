import { describe, expect, it } from "vitest";
import { haversineMeters } from "./geo-distance.js";

describe("haversineMeters", () => {
  it("retourne 0 pour deux points identiques", () => {
    expect(haversineMeters({ lat: 48.85, lon: 2.35 }, { lat: 48.85, lon: 2.35 })).toBe(0);
  });

  it("mesure une distance intra-bâtiment < 5 m (cas prod Neuilly Sablons : FINESS vs SIRET repreneur)", () => {
    const finess = { lat: 48.885770555, lon: 2.260478349 };
    const repreneur = { lat: 48.8857650614302, lon: 2.26046260829636 };
    const d = haversineMeters(finess, repreneur);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(5);
  });

  it("mesure un voisin de rue ~110 m (cas prod ALLALI 48 vs FINESS 85 av Ch. de Gaulle)", () => {
    const finess = { lat: 48.880400623, lon: 2.273110328 };
    const voisin = { lat: 48.880616394, lon: 2.2745813376 };
    const d = haversineMeters(finess, voisin);
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(140);
  });

  it("est symétrique : d(a,b) === d(b,a)", () => {
    const a = { lat: 48.8, lon: 2.3 };
    const b = { lat: 48.9, lon: 2.4 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
  });

  it("Paris ↔ Lyon ≈ 392 km (ordre de grandeur connu, vol d'oiseau)", () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const lyon = { lat: 45.764, lon: 4.8357 };
    const d = haversineMeters(paris, lyon);
    expect(d).toBeGreaterThan(390_000);
    expect(d).toBeLessThan(396_000);
  });
});
