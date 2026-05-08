import { describe, expect, it } from "vitest";
import { buildCommuneIndex } from "../../src/territoire/commune-index.js";
import type { Commune } from "../../src/territoire/communes.js";
import { parseAmeliRecord } from "./ameli.js";

const fixtures: Commune[] = [
  {
    code: "08105",
    nom: "Charleville-Mézières",
    codesPostaux: ["08000"],
    centre: { lon: 4.7203, lat: 49.7724 },
    codeDepartement: "08",
  },
  {
    code: "75056",
    nom: "Paris",
    codesPostaux: ["75001", "75008"],
    centre: { lon: 2.347, lat: 48.8589 },
    codeDepartement: "75",
  },
];
const idx = buildCommuneIndex(fixtures);

function row(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    ps_activite_nom: "MAYAUD",
    ps_activite_prenom: "NORBERT",
    ps_activite_civilite: "M",
    ps_activite_raison_sociale: "SELAS DE CARDIO",
    specialite_code: "03",
    specialite_libelle: "Cardiologue",
    type_ps_code: "1",
    type_ps_libelle: "Médecins généralistes et spécialistes",
    coordonnees_voie: "60 AVENUE DE JASSERON",
    coordonnees_complement: "",
    coordonnees_lieu_dit: "",
    coordonnees_code_postal: "08000",
    coordonnees_ville: "CHARLEVILLE MEZIERES",
    coordonnees_num_tel: "0474247675",
    secteur_conventionnel_code: "3",
    secteur_conventionnel_libelle: "Secteur 2",
    nature_exercice_code: "01",
    nature_exercice_libelle: "Libéral intégral",
    option_tarifaire_code: "3",
    option_tarifaire_libelle: "OPTAM",
    activite_particuliere_code: "",
    activite_particuliere_libelle: "",
    ...overrides,
  };
}

describe("parseAmeliRecord", () => {
  it("parses a complete row and produces an EWKT geom from the matched commune", () => {
    const result = parseAmeliRecord(row(), idx);
    expect(result.row).toBeDefined();
    expect(result.skipReason).toBeUndefined();
    if (!result.row) throw new Error("expected row");
    expect(result.row.nom).toBe("MAYAUD");
    expect(result.row.prenom).toBe("NORBERT");
    expect(result.row.specialite_code).toBe("03");
    expect(result.row.code_insee).toBe("08105");
    expect(result.row.code_departement).toBe("08");
    expect(result.row.code_postal).toBe("08000");
    expect(result.row.ville).toBe("CHARLEVILLE MEZIERES");
    expect(result.row.geom).toBe("SRID=4326;POINT(4.7203 49.7724)");
    expect(result.row.adresse).toBe("60 AVENUE DE JASSERON");
  });

  it("concatenates voie + complement + lieu_dit with comma separators", () => {
    const result = parseAmeliRecord(
      row({
        coordonnees_voie: "60 AV JEAN JAURES",
        coordonnees_complement: "BAT C",
        coordonnees_lieu_dit: "ZA LES PRES",
      }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.adresse).toBe("60 AV JEAN JAURES, BAT C, ZA LES PRES");
  });

  it("skips when both nom and prenom are empty", () => {
    expect(
      parseAmeliRecord(row({ ps_activite_nom: "", ps_activite_prenom: "" }), idx).skipReason,
    ).toBe("no_identity");
  });

  it("falls back to prenom when nom is missing (keeps NOT NULL constraint happy)", () => {
    const r = parseAmeliRecord(row({ ps_activite_nom: "" }), idx);
    if (!r.row) throw new Error("expected row");
    expect(r.row.nom).toBe("NORBERT");
    expect(r.row.prenom).toBe("NORBERT");
  });

  it("skips when both CP and ville are empty", () => {
    const r = parseAmeliRecord(row({ coordonnees_code_postal: "", coordonnees_ville: "" }), idx);
    expect(r.skipReason).toBe("no_locality");
  });

  it("skips with a sample key when commune cannot be matched", () => {
    const r = parseAmeliRecord(
      row({ coordonnees_code_postal: "99999", coordonnees_ville: "ZZ-INCONNU" }),
      idx,
    );
    expect(r.skipReason).toBe("unmatched_locality");
    if (r.skipReason === "unmatched_locality") {
      expect(r.sampleKey).toBe("99999|ZZ-INCONNU");
    }
  });

  it("strips CEDEX from CP for matching but stores 5-char canonical CP", () => {
    const r = parseAmeliRecord(
      row({ coordonnees_code_postal: "75008 CEDEX 8", coordonnees_ville: "PARIS" }),
      idx,
    );
    if (!r.row) throw new Error("expected row");
    expect(r.row.code_insee).toBe("75056");
    expect(r.row.code_postal).toBe("75008");
  });

  it("populates raw with non-empty original CSV columns only", () => {
    const r = parseAmeliRecord(row(), idx);
    if (!r.row) throw new Error("expected row");
    expect(r.row.raw.ps_activite_nom).toBe("MAYAUD");
    // empty columns are stripped
    expect(r.row.raw.coordonnees_complement).toBeUndefined();
    expect(r.row.raw.activite_particuliere_code).toBeUndefined();
  });

  it("returns null for optional fields when CSV column is empty", () => {
    const r = parseAmeliRecord(
      row({ coordonnees_num_tel: "", option_tarifaire_code: "", option_tarifaire_libelle: "" }),
      idx,
    );
    if (!r.row) throw new Error("expected row");
    expect(r.row.telephone).toBeNull();
    expect(r.row.option_tarifaire_code).toBeNull();
  });
});
