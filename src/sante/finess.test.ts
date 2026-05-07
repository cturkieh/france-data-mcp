import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type EtablissementFiness,
  haversineDistance,
  loadFiness,
  searchEtablissementsFiness,
} from "./finess.js";

describe("haversineDistance", () => {
  it("renvoie 0 pour deux points identiques", () => {
    const p = { lon: 4.7192, lat: 49.7672 };
    expect(haversineDistance(p, p)).toBe(0);
  });

  it("calcule une distance plausible Paris-Lyon (~390 km)", () => {
    const paris = { lon: 2.3522, lat: 48.8566 };
    const lyon = { lon: 4.8357, lat: 45.764 };
    const km = haversineDistance(paris, lyon) / 1000;
    expect(km).toBeGreaterThan(380);
    expect(km).toBeLessThan(400);
  });

  it("calcule une distance plausible sur courte distance (~100m)", () => {
    const a = { lon: 4.7192, lat: 49.7672 };
    const b = { lon: 4.7192, lat: 49.768 };
    const m = haversineDistance(a, b);
    expect(m).toBeGreaterThan(80);
    expect(m).toBeLessThan(120);
  });
});

describe("searchEtablissementsFiness", () => {
  const fixture: EtablissementFiness[] = [
    {
      finessEt: "080000111",
      raisonSociale: "EHPAD Charleville",
      categorieCode: "500",
      categorieLibelle: "EHPAD",
      codePostal: "08000",
      commune: "Charleville-Mézières",
      departement: "08",
      point: { lon: 4.72, lat: 49.77 },
    },
    {
      finessEt: "080000222",
      raisonSociale: "Centre Hospitalier de Charleville",
      categorieCode: "355",
      categorieLibelle: "Centre Hospitalier (CH)",
      codePostal: "08000",
      commune: "Charleville-Mézières",
      departement: "08",
      point: { lon: 4.715, lat: 49.768 },
    },
    {
      finessEt: "510000333",
      raisonSociale: "EHPAD Reims",
      categorieCode: "500",
      categorieLibelle: "EHPAD",
      codePostal: "51100",
      commune: "Reims",
      departement: "51",
      point: { lon: 4.034, lat: 49.258 },
    },
  ];

  it("filtre par catégorie", () => {
    const ehpad = searchEtablissementsFiness(fixture, { categories: ["500"] });
    expect(ehpad).toHaveLength(2);
    expect(ehpad.every((e) => e.categorieCode === "500")).toBe(true);
  });

  it("filtre par département", () => {
    const dep08 = searchEtablissementsFiness(fixture, { departement: "08" });
    expect(dep08).toHaveLength(2);
  });

  it("filtre par rayon géographique", () => {
    const proches = searchEtablissementsFiness(fixture, {
      center: { lon: 4.72, lat: 49.77 },
      radiusKm: 5,
    });
    expect(proches).toHaveLength(2);
    expect(proches.find((e) => e.commune === "Reims")).toBeUndefined();
  });

  it("combine catégorie + rayon", () => {
    const ehpadProches = searchEtablissementsFiness(fixture, {
      categories: ["500"],
      center: { lon: 4.72, lat: 49.77 },
      radiusKm: 5,
    });
    expect(ehpadProches).toHaveLength(1);
    expect(ehpadProches[0]?.commune).toBe("Charleville-Mézières");
  });

  it("respecte le limit", () => {
    const result = searchEtablissementsFiness(fixture, { limit: 1 });
    expect(result).toHaveLength(1);
  });

  it("rejette si center sans radiusKm", () => {
    expect(() =>
      searchEtablissementsFiness(fixture, { center: { lon: 4.72, lat: 49.77 } }),
    ).toThrow(/radiusKm/);
  });
});

describe("loadFiness", () => {
  it("parse un CSV FINESS minimal en objets EtablissementFiness", async () => {
    const csv = [
      "nofinesset;nofinessej;rs;categetab;cpostal;commune;codecommune;departement;coordxet;coordyet",
      "080000111;080111111;EHPAD Charleville;500;08000;Charleville-Mézières;08105;08;4.72;49.77",
      "080000222;080111111;CH Charleville;355;08000;Charleville-Mézières;08105;08;4.715;49.768",
    ].join("\n");

    const tmpFile = join(tmpdir(), `finess-test-${Date.now()}.csv`);
    await writeFile(tmpFile, csv, "utf-8");

    const index = await loadFiness({ csvPath: tmpFile });
    expect(index).toHaveLength(2);
    expect(index[0]?.raisonSociale).toBe("EHPAD Charleville");
    expect(index[0]?.categorieLibelle).toBe(
      "EHPAD (Établissement Hébergeant des Personnes Âgées Dépendantes)",
    );
    expect(index[0]?.point).toEqual({ lon: 4.72, lat: 49.77 });
  });
});
