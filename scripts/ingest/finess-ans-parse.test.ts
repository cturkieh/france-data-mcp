/**
 * Tests du mapping flux ANS → `finess_staging`, sur 6 EGE RÉELS extraits du
 * fichier `finess-structures-journalier-20260905.json.gz` (sous-tableaux
 * `evenement`/`engagement`/`roleEge` retirés, ils n'entrent pas dans le
 * mapping). Chaque fixture matérialise un cas qui a failli passer en
 * silence pendant l'exploration :
 *
 *   010780195 — Clinique Convert : cas nominal, `coordonneeX` en WGS84.
 *   080010093 — LBM Bio Ard'Aisne, Charleville (canary) : `coordonneeX` en
 *               LAMBERT 93, le WGS84 est dans `direction*` — paires INVERSÉES.
 *   010008894 — `adresse[0]` est l'accueil (`06`), l'adresse géographique `03`
 *               est en 2e position.
 *   970402988 — La Réunion : DOM, `code_departement` sur 3 caractères.
 *   080010085 — LBM Bio Ard'Aisne Rethel (canary) : aucune coordonnée ANS.
 *   130801541 — crèche de la Timone, fermée en 2014 : doit être écartée.
 *
 * Les bornes de colonnes (`COLUMN_RULES`) sont vérifiées contre la DDL dans
 * `finess-column-rules-parity.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SMT_CATEGORIE_LABELS } from "../../src/sante/finess-categories-labels.js";
import {
  type AnsEge,
  type ParsedEge,
  type ParsedEgeKept,
  collapseWhitespace,
  mapEgeToRow,
  normalizeTelephone,
  pickGeographicAddress,
  readEtat,
  resolveCoordinates,
} from "./finess-ans-parse.js";

const fixtures: AnsEge[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/finess-ans-ege.json", import.meta.url)),
    "utf8",
  ),
);

function fixture(numFiness: string): AnsEge {
  const found = fixtures.find((e) => e.informationsGeneralesEGE?.numFinessEge === numFiness);
  if (!found) throw new Error(`fixture ${numFiness} absente`);
  return found;
}

/** Narrowing : le test échoue explicitement si l'EGE a été écarté. */
function kept(parsed: ParsedEge): ParsedEgeKept {
  if (parsed.kind === "skip") throw new Error(`EGE écarté : ${parsed.skipReason}`);
  return parsed;
}

function rowOf(numFiness: string) {
  return kept(mapEgeToRow(fixture(numFiness)));
}

/** Clone une fixture, la mute, la mappe — pour les cas de bord synthétiques. */
function mutated(numFiness: string, mutate: (ege: AnsEge) => void): ParsedEge {
  const ege = structuredClone(fixture(numFiness));
  mutate(ege);
  return mapEgeToRow(ege);
}

/** L'adresse géographique (`03`) d'une fixture, à muter. */
function geoAddr(ege: AnsEge) {
  const a = ege.adresse?.find((x) => x.usageAdresse === "03");
  if (!a) throw new Error("fixture sans adresse 03");
  return a;
}

describe("mapEgeToRow — cas nominal (010780195, Clinique Convert, WGS84)", () => {
  const { row, coordLayout, coordsPresentButUnusable, overflows } = rowOf("010780195");

  it("mappe identité, catégorie et libellé officiel", () => {
    expect(row.num_finess).toBe("010780195");
    expect(row.raison_sociale).toBe("CLINIQUE DOCTEUR CONVERT");
    expect(row.categorie_code).toBe("365");
    expect(row.categorie_libelle).toBe(SMT_CATEGORIE_LABELS["365"]);
    expect(row.categorie_libelle).toBeTruthy();
  });

  it("prend le code INSEE tel quel et en dérive le département", () => {
    expect(row.code_insee).toBe("01053");
    expect(row.code_departement).toBe("01");
    expect(row.code_postal).toBe("01000");
    expect(row.ville).toBe("BOURG EN BRESSE");
  });

  it("concatène numéro + type + libellé de voie", () => {
    expect(row.num_voie).toBe("62");
    expect(row.type_voie).toBe("AV");
    expect(row.voie).toBe("62 AV DE JASSERON");
  });

  it("pose le geom EWKT depuis la paire WGS84, garde le Lambert de l'autre paire, provenance `ans`", () => {
    expect(row.geom).toBe("SRID=4326;POINT(5.254203 46.211257)");
    expect(row.coordx_lambert93).toBeCloseTo(873766.07, 2);
    expect(row.coordy_lambert93).toBeCloseTo(6570414.61, 2);
    expect(coordLayout).toBe("wgs84_first");
    expect(coordsPresentButUnusable).toBe(false);
    expect(row.raw.geom_source).toBe("ans");
    expect(overflows).toEqual([]);
  });

  it("remonte SIRET, clé et score BAN dans raw (phase 2), téléphone depuis contact", () => {
    expect(row.raw.siret).toBe("77220148900022");
    expect(row.raw.cle_ban).toBe("01053_1950_00062");
    expect(row.raw.score_ban).toMatch(/^0\.97/);
    expect(row.telephone).toBe("0428631234");
    expect(row.email).toBeNull();
  });
});

describe("resolveCoordinates — les deux systèmes coexistent, dans un ordre variable", () => {
  it("080010093 : coordonneeX est du LAMBERT, le WGS84 vient de direction* — même provenance `ans`", () => {
    const { row, coordLayout } = rowOf("080010093");
    expect(coordLayout).toBe("lambert_first");
    // Ardennes (08) : lon ∈ [4.0, 5.4], lat ∈ [49.2, 50.2]. Un mapping
    // positionnel aurait soit rejeté la paire (geom NULL), soit — pire —
    // posé un POINT(824475 6969000) « valide » pour PostGIS, au large.
    const m = /^SRID=4326;POINT\((-?\d+\.\d+) (-?\d+\.\d+)\)$/.exec(row.geom ?? "");
    if (!m) throw new Error(`geom inattendu : ${row.geom}`);
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    expect(lon).toBeGreaterThan(4.0);
    expect(lon).toBeLessThan(5.4);
    expect(lat).toBeGreaterThan(49.2);
    expect(lat).toBeLessThan(50.2);
    expect(row.coordx_lambert93).toBeCloseTo(824475.06, 2);
    expect(row.coordy_lambert93).not.toBeNull();
    // La disposition des paires n'est PAS une provenance : le point est du
    // WGS84 ANS dans les deux cas.
    expect(row.raw.geom_source).toBe("ans");
  });

  it("aucune paire → tout null, present=false", () => {
    expect(resolveCoordinates(null)).toEqual({
      point: null,
      layout: null,
      lambert93: null,
      present: false,
    });
    expect(resolveCoordinates({ coordonneeX: "", coordonneeY: null })).toMatchObject({
      layout: null,
      present: false,
    });
  });

  it("paires présentes mais aucune en WGS84 plausible → layout null, present=true (signal de dérive)", () => {
    const r = resolveCoordinates({
      coordonneeX: "873766.07",
      coordonneeY: "6570414.61",
      directionLongitude: "873766.07",
      directionLatitude: "6570414.61",
    });
    expect(r.layout).toBeNull();
    expect(r.present).toBe(true);
    expect(r.point).toBeNull();
  });

  it("DOM en mode projeté : l'UTM n'est PAS stocké comme du Lambert 93", () => {
    // Réunion : WGS84 dans direction*, projection UTM 40S dans coordonnee* —
    // Y ≈ 7,65 M est HORS emprise Lambert 93 (≤ 7,2 M).
    const r = resolveCoordinates({
      coordonneeX: "340000.5",
      coordonneeY: "7650000.2",
      directionLongitude: "55.489104",
      directionLatitude: "-21.2",
    });
    expect(r.layout).toBe("lambert_first");
    expect(r.point?.lon).toBeCloseTo(55.489104, 6);
    expect(r.lambert93).toBeNull();
  });

  it("rejette une coordonnée non numérique sans la coercer (Number('12 RUE') interdit)", () => {
    const r = resolveCoordinates({ coordonneeX: "12 RUE DUMAS", coordonneeY: "46.2" });
    expect(r.layout).toBeNull();
    expect(r.present).toBe(true);
  });

  it("changement de format numérique (virgule décimale) sur TOUS les champs → présent mais inexploitable, pas « absent »", () => {
    // Le signal de dérive doit se déclencher sur la classe qu'il existe pour
    // détecter : jugé sur les valeurs parsées, `present` serait faux ici.
    const r = resolveCoordinates({
      coordonneeX: "5,254203",
      coordonneeY: "46,211257",
      directionLongitude: "873766,07",
      directionLatitude: "6570414,61",
    });
    expect(r.point).toBeNull();
    expect(r.present).toBe(true);
  });

  it("Pacifique : Wallis (-176°), Polynésie (-150°), Nouvelle-Calédonie (166°) sont du WGS84 valide", () => {
    for (const [lon, lat] of [
      ["-176.1749", "-13.2825"],
      ["-149.5665", "-17.5334"],
      ["166.4572", "-22.2758"],
    ]) {
      const r = resolveCoordinates({ coordonneeX: lon, coordonneeY: lat });
      expect(r.layout, `${lon},${lat}`).toBe("wgs84_first");
      expect(r.point?.lon).toBeCloseTo(Number(lon), 4);
    }
  });

  it("null island (0, 0) = corruption classique → inexploitable, jamais un point dans le golfe de Guinée", () => {
    const r = resolveCoordinates({ coordonneeX: "0", coordonneeY: "0" });
    expect(r.layout).toBeNull();
    expect(r.present).toBe(true);
  });
});

describe("clé BAN commune = centroïde : jamais dans finess.geom", () => {
  const withCleBan = (cle: string) => (e: AnsEge) => {
    const g = geoAddr(e).coordonneesGeographique;
    if (g) g.cleInInteropBAN = cle;
  };

  it("clé sans `_` (commune) → point refusé, geom NULL, pas de provenance, layout null, compteur", () => {
    const parsed = kept(mutated("010780195", withCleBan("01053")));
    expect(parsed.row.geom).toBeNull();
    expect(parsed.row.raw.geom_source).toBeUndefined();
    expect(parsed.row.raw.cle_ban).toBe("01053");
    expect(parsed.row.coordx_lambert93).toBeNull();
    expect(parsed.coordLayout).toBeNull();
    expect(parsed.municipalityCentroidRejected).toBe(true);
    // Pas une dérive de format : les coordonnées étaient exploitables.
    expect(parsed.coordsPresentButUnusable).toBe(false);
  });

  it("clé rue (`01053_1950`) et numéro (`01053_1950_00062`) → point conservé", () => {
    for (const cle of ["01053_1950", "01053_1950_00062"]) {
      const parsed = kept(mutated("010780195", withCleBan(cle)));
      expect(parsed.row.geom, cle).toBe("SRID=4326;POINT(5.254203 46.211257)");
      expect(parsed.municipalityCentroidRejected).toBe(false);
    }
  });

  it("clé absente → point conservé (précision inconnue, comportement historique)", () => {
    const parsed = kept(
      mutated("010780195", (e) => {
        const g = geoAddr(e).coordonneesGeographique;
        if (g) g.cleInInteropBAN = null;
      }),
    );
    expect(parsed.row.geom).not.toBeNull();
    expect(parsed.row.raw.cle_ban).toBeUndefined();
  });
});

describe("pickGeographicAddress — usageAdresse 03, jamais adresse[0]", () => {
  it("010008894 : adresse[0] est l'accueil (06), la géographique est en 2e position", () => {
    const ege = fixture("010008894");
    expect(ege.adresse?.[0]?.usageAdresse).toBe("06");
    const geo = pickGeographicAddress(ege);
    expect(geo?.usageAdresse).toBe("03");
    const { row } = rowOf("010008894");
    expect(row.code_insee).toBe(geo?.cogCommune);
    expect(row.geom).toContain("6.074912");
  });

  it("retourne null sans adresse 03 et le mapping écarte l'EGE explicitement", () => {
    const ege: AnsEge = {
      informationsGeneralesEGE: { numFinessEge: "999999999", dateFermeture: null },
      etatObjet: "A",
      adresse: [{ usageAdresse: "06", cogCommune: "75101" }],
    };
    expect(pickGeographicAddress(ege)).toBeNull();
    expect(mapEgeToRow(ege)).toEqual({ kind: "skip", skipReason: "no_adresse_geographique" });
  });
});

describe("DOM — 970402988 (La Réunion)", () => {
  it("code_departement sur 3 caractères (via deptFromCodeInsee partagé), geom WGS84 océan Indien", () => {
    const { row, coordLayout } = rowOf("970402988");
    expect(row.code_insee).toMatch(/^974\d{2}$/);
    expect(row.code_departement).toBe("974");
    expect(row.geom).toMatch(/^SRID=4326;POINT\(55\.\d+ -2[01]\.\d+\)$/);
    expect(coordLayout).toBe("wgs84_first");
  });
});

describe("Périmètre : en service uniquement, identifiants valides", () => {
  it("080010085 (canary Rethel) : actif, aucune coordonnée → geom null, layout null, pas de dérive", () => {
    const { row, coordLayout, coordsPresentButUnusable } = rowOf("080010085");
    expect(row.geom).toBeNull();
    expect(row.coordx_lambert93).toBeNull();
    expect(coordLayout).toBeNull();
    expect(coordsPresentButUnusable).toBe(false);
    expect(row.raw.geom_source).toBeUndefined();
    expect(row.code_insee).toBe("08362");
  });

  it("130801541 (crèche Timone, fermée 2014-03-31) → skip 'ferme'", () => {
    expect(mapEgeToRow(fixture("130801541"))).toEqual({ kind: "skip", skipReason: "ferme" });
  });

  it("etatObjet 'I' sans dateFermeture → skip 'inactif'", () => {
    const parsed = mutated("010780195", (e) => {
      e.etatObjet = "I";
    });
    expect(parsed).toEqual({ kind: "skip", skipReason: "inactif" });
  });

  it("numFinessEge absent → 'no_finess_id' ; hors format CHAR(9) → 'bad_finess_id' (PK, ni nullable ni tronquable)", () => {
    const setFiness = (v: string) => (e: AnsEge) => {
      if (e.informationsGeneralesEGE) e.informationsGeneralesEGE.numFinessEge = v;
    };
    expect(mutated("010780195", setFiness("  "))).toEqual({
      kind: "skip",
      skipReason: "no_finess_id",
    });
    // Périmètre AVANT identité : un archivé sans identifiant est « fermé », pas
    // une anomalie structurelle comptée contre les EGE en service.
    expect(mutated("130801541", setFiness("  "))).toEqual({ kind: "skip", skipReason: "ferme" });
    expect(mutated("010780195", setFiness("01078019"))).toEqual({
      kind: "skip",
      skipReason: "bad_finess_id",
    });
    expect(mutated("010780195", setFiness("0107801951"))).toEqual({
      kind: "skip",
      skipReason: "bad_finess_id",
    });
    // Corse : 2A/2B en tête sont des numéros FINESS réels (ex. 2A0022596).
    expect(mutated("010780195", setFiness("2A0022596")).kind).toBe("row");
  });

  it("cogCommune absent, malformé ou hors plage INSEE → skip explicite, jamais tronqué", () => {
    const setCog = (v: string | null) => (e: AnsEge) => {
      geoAddr(e).cogCommune = v;
    };
    expect(mutated("010780195", setCog(null))).toEqual({ kind: "skip", skipReason: "no_commune" });
    expect(mutated("010780195", setCog("1053"))).toEqual({
      kind: "skip",
      skipReason: "bad_commune",
    });
    // Forme CHAR(5) valide mais hors plage INSEE (`isValidCodeInsee` partagé).
    expect(mutated("010780195", setCog("99138"))).toEqual({
      kind: "skip",
      skipReason: "bad_commune",
    });
    expect(mutated("010780195", setCog("20000"))).toEqual({
      kind: "skip",
      skipReason: "bad_commune",
    });
  });
});

describe("Contraintes de colonnes — null + signalé, jamais tronqué", () => {
  it("téléphone à deux numéros (cas réel, 21 caractères) → premier numéro, pas de débordement", () => {
    expect(normalizeTelephone("0690291988/0590895757")).toBe("0690291988");
    expect(normalizeTelephone("04 28 63 12 34")).toBe("0428631234");
    expect(normalizeTelephone("04.28.63.12.34 ; 06 00 00 00 00")).toBe("0428631234");
    expect(normalizeTelephone("  ")).toBeNull();
    const parsed = kept(
      mutated("010780195", (e) => {
        if (e.contact?.[0]?.telecom) e.contact[0].telecom.telephone = "0690291988/0590895757";
      }),
    );
    expect(parsed.row.telephone).toBe("0690291988");
    expect(parsed.overflows).toEqual([]);
  });

  it("téléphone encore > 20 après normalisation → null et overflow 'telephone'", () => {
    const parsed = kept(
      mutated("010780195", (e) => {
        if (e.contact?.[0]?.telecom) e.contact[0].telecom.telephone = "0".repeat(25);
      }),
    );
    expect(parsed.row.telephone).toBeNull();
    expect(parsed.overflows).toEqual(["telephone"]);
  });

  it("num_voie > 10 → colonne typée null, mais l'adresse complète garde le numéro", () => {
    const parsed = kept(
      mutated("010780195", (e) => {
        geoAddr(e).numeroVoie = "62 BIS TER Q";
      }),
    );
    expect(parsed.row.num_voie).toBeNull();
    expect(parsed.row.voie).toBe("62 BIS TER Q AV DE JASSERON");
    expect(parsed.overflows).toEqual(["num_voie"]);
  });

  it("code_postal ≠ 5 caractères → null et overflow (CHAR(5) padderait un code court en silence)", () => {
    const parsed = kept(
      mutated("010780195", (e) => {
        geoAddr(e).codePostal = "0100";
      }),
    );
    expect(parsed.row.code_postal).toBeNull();
    expect(parsed.overflows).toEqual(["code_postal"]);
  });

  it("les 5 fixtures en service passent sans aucun débordement (la 6e est fermée)", () => {
    const rows = fixtures.map(mapEgeToRow).filter((p): p is ParsedEgeKept => p.kind === "row");
    expect(rows).toHaveLength(5);
    for (const parsed of rows) expect(parsed.overflows).toEqual([]);
  });
});

describe("Robustesse de forme", () => {
  it("readEtat accepte chaîne ET tableau, null sinon", () => {
    expect(readEtat("A")).toBe("A");
    expect(readEtat(["I"])).toBe("I");
    expect(readEtat([])).toBeNull();
    expect(readEtat(null)).toBeNull();
    expect(readEtat(" ")).toBeNull();
  });

  it("nomEgeCourt en repli quand nomEgeLong est vide ; espaces multiples et caractères de contrôle retirés", () => {
    const parsed = kept(
      mutated("010780195", (e) => {
        if (e.informationsGeneralesEGE) {
          e.informationsGeneralesEGE.nomEgeLong = "   ";
          e.informationsGeneralesEGE.nomEgeCourt = "CLINIQUE   CONVERT\r\n";
        }
      }),
    );
    // Un `` restitué par JSON.parse casserait un client JSON strict —
    // même strip que `getNonEmpty` côté CSV.
    expect(parsed.row.raison_sociale).toBe("CLINIQUE CONVERT");
    expect(collapseWhitespace("LBM  BIO\tARD'AISNE ")).toBe("LBM BIO ARD'AISNE");
  });

  it("code catégorie inconnu de la nomenclature → libellé null (dérive à surfacer, pas à inventer)", () => {
    const parsed = kept(
      mutated("010780195", (e) => {
        e.categorieentiteGeographiqueExercice = "999";
      }),
    );
    expect(parsed.row.categorie_code).toBe("999");
    expect(parsed.row.categorie_libelle).toBeNull();
  });

  it("la nomenclature figée couvre les codes des fixtures et les libellés historiques", () => {
    expect(SMT_CATEGORIE_LABELS["620"]).toBe("Pharmacie d'Officine");
    expect(SMT_CATEGORIE_LABELS["611"]).toBe("Laboratoire de Biologie Médicale");
  });
});
