import { describe, expect, it } from "vitest";
import { buildCommuneIndex } from "../../src/territoire/commune-index.js";
import type { Commune } from "../../src/territoire/communes.js";
import { __TESTING__ } from "./rpps.js";

const { parseRppsRecord, COL } = __TESTING__;

const fixtures: Commune[] = [
  {
    code: "08105",
    nom: "Charleville-Mézières",
    codesPostaux: ["08000"],
    centre: { lon: 4.7203, lat: 49.7724 },
    codeDepartement: "08",
  },
  {
    code: "75108",
    nom: "Paris 8e Arrondissement",
    codesPostaux: ["75008"],
    centre: { lon: 2.3175, lat: 48.8722 },
    codeDepartement: "75",
  },
];
const idx = buildCommuneIndex(fixtures);

/**
 * Construit une ligne RPPS avec des valeurs par défaut plausibles. Les keys
 * matchent strictement les noms de colonnes ANS (`Identification nationale PP`,
 * etc.) que `parseRppsRecord` lit via les constantes `COL`.
 */
function row(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    [COL.RPPS_ID]: "810009647990",
    [COL.IDENTIFIANT_PP]: "10009647990",
    [COL.CIVILITE_LIBELLE]: "M.",
    [COL.NOM]: "DUPONT",
    [COL.PRENOM]: "JEAN",
    [COL.PROFESSION_CODE]: "10",
    [COL.PROFESSION_LIBELLE]: "Médecin",
    [COL.CATEGORIE_CODE]: "C",
    [COL.CATEGORIE_LIBELLE]: "Civil",
    [COL.SAVOIR_FAIRE_CODE]: "SM26",
    [COL.SAVOIR_FAIRE_LIBELLE]: "Cardiologie et maladies vasculaires",
    [COL.MODE_EXERCICE_CODE]: "S",
    [COL.MODE_EXERCICE_LIBELLE]: "Salarié",
    [COL.SIRET]: "78712043500012",
    [COL.SIREN]: "787120435",
    [COL.NUM_FINESS]: "080010234",
    [COL.NUM_FINESS_EJ]: "080000456",
    [COL.RAISON_SOCIALE]: "LBM BIO ARD'AISNE",
    [COL.ENSEIGNE]: "BIO ARD'AISNE",
    [COL.SECTEUR_LIBELLE]: "Privé",
    [COL.NUM_VOIE]: "60",
    [COL.TYPE_VOIE_LIBELLE]: "AV",
    [COL.VOIE]: "DE JASSERON",
    [COL.CODE_POSTAL]: "08000",
    [COL.CODE_COMMUNE]: "08105",
    [COL.LIBELLE_COMMUNE]: "CHARLEVILLE MEZIERES",
    [COL.TELEPHONE]: "0324567890",
    [COL.EMAIL]: "contact@example.com",
    ...overrides,
  };
}

describe("parseRppsRecord", () => {
  it("parses une ligne complète et produit un EWKT geom au centroïde commune", () => {
    const result = parseRppsRecord(row(), idx);
    expect(result.row).toBeDefined();
    if (!result.row) throw new Error("expected row");
    expect(result.row.rpps_id).toBe("810009647990");
    expect(result.row.nom).toBe("DUPONT");
    expect(result.row.prenom).toBe("JEAN");
    expect(result.row.profession_code).toBe("10");
    expect(result.row.savoir_faire_code).toBe("SM26");
    expect(result.row.mode_exercice_code).toBe("S");
    expect(result.row.num_finess).toBe("080010234");
    expect(result.row.code_insee).toBe("08105");
    expect(result.row.code_departement).toBe("08");
    expect(result.row.code_postal).toBe("08000");
    expect(result.row.geom).toBe("SRID=4326;POINT(4.7203 49.7724)");
    expect(result.row.geom_source).toBe("commune_centroid");
    expect(result.row.adresse).toBe("60 AV DE JASSERON");
  });

  it("concatène num_voie + type_voie + libelle_voie séparés par espace", () => {
    const result = parseRppsRecord(
      row({ [COL.NUM_VOIE]: "12", [COL.TYPE_VOIE_LIBELLE]: "PLACE", [COL.VOIE]: "DE LA PAIX" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.adresse).toBe("12 PLACE DE LA PAIX");
  });

  it("retourne adresse=null quand voie + type + numéro tous vides", () => {
    const result = parseRppsRecord(
      row({ [COL.NUM_VOIE]: "", [COL.TYPE_VOIE_LIBELLE]: "", [COL.VOIE]: "" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.adresse).toBeNull();
  });

  it("skip no_identity quand rpps_id est vide (row absent)", () => {
    const result = parseRppsRecord(row({ [COL.RPPS_ID]: "" }), idx);
    expect(result.row).toBeUndefined();
  });

  it("skip no_identity quand nom OU prénom vide", () => {
    expect(parseRppsRecord(row({ [COL.NOM]: "", [COL.PRENOM]: "" }), idx).row).toBeUndefined();
    expect(parseRppsRecord(row({ [COL.NOM]: "" }), idx).row).toBeUndefined();
    expect(parseRppsRecord(row({ [COL.PRENOM]: "" }), idx).row).toBeUndefined();
  });

  it("conserve nom et prénom tels quels (pas de duplication silencieuse)", () => {
    const r = parseRppsRecord(row({ [COL.NOM]: "MARTIN", [COL.PRENOM]: "Sophie" }), idx);
    if (!r.row) throw new Error("expected row");
    expect(r.row.nom).toBe("MARTIN");
    expect(r.row.prenom).toBe("Sophie");
  });

  // --- Pas de skip no_locality : geom NULL fallback + enrichissement FINESS ---

  it("produit row geom NULL quand CP ET ville absents (étudiant/retraité)", () => {
    const result = parseRppsRecord(row({ [COL.CODE_POSTAL]: "", [COL.LIBELLE_COMMUNE]: "" }), idx);
    if (!result.row) throw new Error("expected row (CP+ville absents)");
    expect(result.row.geom).toBeNull();
    expect(result.row.geom_source).toBeNull();
    expect(result.row.code_departement).toBeNull();
    expect(result.row.code_insee).toBeNull();
    // Identité préservée pour permettre lookup par rpps_id
    expect(result.row.rpps_id).toBe("810009647990");
    expect(result.row.num_finess).toBe("080010234");
  });

  it("produit row geom NULL avec dept dérivé du CP quand CP+ville unmatched (métropole)", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "08999", [COL.LIBELLE_COMMUNE]: "VILLE INCONNUE" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.geom).toBeNull();
    expect(result.row.geom_source).toBeNull();
    expect(result.row.code_departement).toBe("08");
    expect(result.row.code_insee).toBeNull();
  });

  it("dérive dept DOM 3-chars depuis CP unmatched", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "97400", [COL.LIBELLE_COMMUNE]: "SAINT-DENIS-LA-REUNION" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.geom).toBeNull();
    expect(result.row.code_departement).toBe("974");
  });

  it("retourne dept NULL pour CP Corse 20xxx (ambigu 2A/2B sans commune)", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "20100", [COL.LIBELLE_COMMUNE]: "VILLE INCONNUE" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.code_departement).toBeNull();
  });

  it("retourne dept NULL pour CP malformé sans match commune", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "ABC", [COL.LIBELLE_COMMUNE]: "" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.code_departement).toBeNull();
  });

  it("préserve num_finess sur PS sans adresse — clé du post-enrichissement", () => {
    const result = parseRppsRecord(
      row({
        [COL.CODE_POSTAL]: "",
        [COL.LIBELLE_COMMUNE]: "",
        [COL.NUM_FINESS]: "750100166",
      }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.num_finess).toBe("750100166");
    expect(result.row.geom).toBeNull();
    // Le post-INSERT `ingest_apply_rpps_finess_enrichment_batch` joindra
    // sur ce num_finess pour combler geom + dept + insee depuis FINESS.
  });

  // --- Pas de match commune mais infos préservées ---------------------------------------------------

  it("trim+slice le code_postal à 5 chars (CHAR(5) safety)", () => {
    const result = parseRppsRecord(row({ [COL.CODE_POSTAL]: "  08000 CEDEX " }), idx);
    if (!result.row) throw new Error("expected row");
    // Le matchCommune travaille sur le CP brut ; le slice ne s'applique
    // qu'au stockage final.
    expect(result.row.code_postal).toBe("08000");
  });

  it("expose num_finess et num_finess_ej pour le pivot RPPS↔FINESS", () => {
    const result = parseRppsRecord(row(), idx);
    if (!result.row) throw new Error("expected row");
    expect(result.row.num_finess).toBe("080010234");
    expect(result.row.num_finess_ej).toBe("080000456");
    expect(result.row.siret).toBe("78712043500012");
    expect(result.row.siren).toBe("787120435");
  });

  it("propage les modes d'exercice (libéral L, salarié S, mixte M)", () => {
    const lib = parseRppsRecord(row({ [COL.MODE_EXERCICE_CODE]: "L" }), idx);
    expect(lib.row?.mode_exercice_code).toBe("L");
    const sal = parseRppsRecord(row({ [COL.MODE_EXERCICE_CODE]: "S" }), idx);
    expect(sal.row?.mode_exercice_code).toBe("S");
    const mix = parseRppsRecord(row({ [COL.MODE_EXERCICE_CODE]: "M" }), idx);
    expect(mix.row?.mode_exercice_code).toBe("M");
  });

  it("conserve raw vide pour économiser le stockage Supabase", () => {
    const result = parseRppsRecord(row(), idx);
    if (!result.row) throw new Error("expected row");
    expect(result.row.raw).toEqual({});
  });
});
