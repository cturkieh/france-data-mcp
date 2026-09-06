/**
 * Tests de la politique de validation FINESS, sur les chiffres RÉELLEMENT
 * mesurés le 2026-09-05 (`docs/plans/finess-migration-ans.md` § 6) : le run
 * réel doit passer, chaque garde-fou doit se déclencher sur une dérive
 * plausible, et une base vide (première ingestion) ne doit pas bloquer.
 */

import { describe, expect, it } from "vitest";
import { FINESS_CATEGORIE_LABELS_REFRESHED_AT } from "../../src/sante/finess-categories-labels.js";
import {
  COORDS_UNUSABLE_FAIL_RATE,
  type IngestStreamStats,
  LOST_GEOM_MAX_RATE,
  MIN_GEOM_COVERAGE,
  MIN_ROWS,
  MOVED_MAX_RATE,
  NOMENCLATURE_MAX_AGE_DAYS,
  REMOVED_MAX_RATE,
  type StagingDiff,
  assessParsedRows,
  assessStagingDiff,
  nomenclatureAgeDays,
} from "./finess-validate.js";

/** Run réel du 2026-09-05 21:24 UTC (dry-run n°3 identique). */
function realStats(overrides: Partial<IngestStreamStats> = {}): IngestStreamStats {
  return {
    inserted: 104_734,
    pmej: 98_208,
    skipped: {
      no_finess_id: 0,
      bad_finess_id: 0,
      ferme: 69_799,
      inactif: 148,
      no_adresse_geographique: 0,
      no_commune: 0,
      bad_commune: 0,
    },
    geomByLayout: { wgs84_first: 57_930, lambert_first: 20_497 },
    coordsUnusable: 0,
    // 32 lignes sans categorie_code en prod le 2026-09-05 (0,03 %) — repéré
    // par la revue, aucun compteur ne les signalait.
    nullCategorieCode: 32,
    emptyRaisonSociale: 0,
    municipalityRejected: 186,
    unknownCategorieCounts: new Map([
      ["698", 1178],
      ["632", 919],
      ["640", 784],
    ]),
    missingLabelCounts: new Map(),
    overflowCounts: new Map(),
    ...overrides,
  };
}

function realDiff(overrides: Partial<StagingDiff> = {}): StagingDiff {
  return {
    staging_rows: 104_734,
    prod_rows: 93_403,
    prod_with_geom: 93_401,
    added: 17_450,
    removed: 6_119,
    lost_geom: 0,
    moved_gt_500m: 5_395,
    staging_geom_null: 5_271,
    staging_no_voie: 647,
    staging_geom_source: { ans: 78_427, previous_ingest: 21_036, none: 5_271 },
    ...overrides,
  };
}

describe("assessParsedRows — chiffres réels", () => {
  it("le run réel passe sans fatal ; fermés/inactifs ne sont pas des anomalies ; les 32 sans catégorie sont SIGNALÉS", () => {
    const a = assessParsedRows(realStats());
    expect(a.fatal).toEqual([]);
    expect(a.warnings).toEqual([
      "[finess] content anomalies (0.03% of inserted): 32 without categorie_code, 0 with empty raison_sociale",
    ]);
    expect(
      a.info.some((l) =>
        l.includes(
          "wgs84_first=57930 lambert_first=20497 none=26307 (dont centroïdes commune BAN refusés : 186)",
        ),
      ),
    ).toBe(true);
    expect(a.info.some((l) => l.includes('codes catégorie en famille "autre"'))).toBe(true);
  });

  it("volume hors bornes → fatal immédiat, sans évaluer le reste (taux sans objet)", () => {
    const low = assessParsedRows(realStats({ inserted: MIN_ROWS - 1 }));
    expect(low.fatal).toHaveLength(1);
    expect(low.fatal[0]).toMatch(/below minimum/);
    expect(low.info).toEqual([]);
    const high = assessParsedRows(realStats({ inserted: 250_000 }));
    expect(high.fatal[0]).toMatch(/above maximum/);
  });

  it("anomalies structurelles : warn sous 1 % du total lu, fatal au-dessus", () => {
    const skipped = realStats().skipped;
    const warnOnly = assessParsedRows(realStats({ skipped: { ...skipped, bad_commune: 500 } }));
    expect(warnOnly.fatal).toEqual([]);
    expect(warnOnly.warnings[0]).toMatch(/500 malformed cogCommune/);
    // 1 100 / (104 734 + 1 100) = 1,04 % > 1 %.
    const fatal = assessParsedRows(realStats({ skipped: { ...skipped, bad_finess_id: 1_100 } }));
    expect(fatal.fatal[0]).toMatch(/Structural parsing anomaly rate 1\.04%/);
  });

  it("catégorie nulle en masse (l'ANS encapsule le code dans un tableau) → fatal, plus de swap en `success` muet", () => {
    const a = assessParsedRows(realStats({ nullCategorieCode: 104_734 }));
    expect(a.fatal[0]).toMatch(/Content anomaly rate 100\.00%/);
    const few = assessParsedRows(realStats({ nullCategorieCode: 1_000, emptyRaisonSociale: 40 }));
    expect(few.fatal).toEqual([]);
    expect(few.warnings[0]).toMatch(/1000 without categorie_code, 40 with empty raison_sociale/);
    const overByName = assessParsedRows(
      realStats({ nullCategorieCode: 0, emptyRaisonSociale: 1_100 }),
    );
    expect(overByName.fatal[0]).toMatch(/Content anomaly rate 1\.05%/);
  });

  it("coordonnées inexploitables : silence ≤ 2 %, warn entre 2 et 5 %, fatal > 5 %", () => {
    const unusable = (l: string) => /aucune paire WGS84 plausible/.test(l);
    expect(assessParsedRows(realStats({ coordsUnusable: 2_000 })).warnings.some(unusable)).toBe(
      false,
    );
    const warn = assessParsedRows(realStats({ coordsUnusable: 3_000 }));
    expect(warn.fatal).toEqual([]);
    expect(warn.warnings.find(unusable)).toMatch(/: 3000 rows \(2\.86%\)/);
    const fatal = assessParsedRows(
      realStats({ coordsUnusable: Math.ceil(104_734 * COORDS_UNUSABLE_FAIL_RATE) + 1 }),
    );
    expect(fatal.fatal[0]).toMatch(/Unusable-coordinates rate/);
  });

  it("débordement de colonne : 1 téléphone (cas réel) = warn ; > 1 % sur un champ = fatal", () => {
    const one = assessParsedRows(realStats({ overflowCounts: new Map([["telephone", 1]]) }));
    expect(one.fatal).toEqual([]);
    expect(one.warnings.some((l) => /au-delà de leur colonne : telephone=1$/.test(l))).toBe(true);
    const many = assessParsedRows(realStats({ overflowCounts: new Map([["num_voie", 1_100]]) }));
    expect(many.fatal[0]).toMatch(/Column overflow on num_voie: 1100 rows/);
  });

  it("nomenclature : « autre » > 15 % = warn ; > 50 % = fatal ; libellés manquants > 1 % = fatal", () => {
    const drift = assessParsedRows(
      realStats({
        unknownCategorieCounts: new Map([["999", 17_000]]),
        missingLabelCounts: new Map([["999", 500]]),
      }),
    );
    expect(drift.fatal).toEqual([]);
    expect(drift.warnings.some((l) => l.includes('"autre" rate 16.23%'))).toBe(true);
    expect(drift.warnings.some((l) => l.includes("SANS libellé"))).toBe(true);
    // Catalogue TS désynchronisé de la nomenclature : plus un simple drift.
    const broken = assessParsedRows(
      realStats({ unknownCategorieCounts: new Map([["999", 60_000]]) }),
    );
    expect(broken.fatal[0]).toMatch(/"autre" rate 57\.29% above 50\.00%/);
    // finess-categories-labels.ts tronqué : des milliers de libellés NULL.
    const emptied = assessParsedRows(realStats({ missingLabelCounts: new Map([["620", 19_921]]) }));
    expect(emptied.fatal[0]).toMatch(/19921 rows \(19\.02%\) without categorie_libelle/);
  });
});

describe("assessStagingDiff — chiffres réels et dérives", () => {
  it("le run réel passe : couverture 94,97 % ≥ 0,93, retirés 6,55 % ≤ 10 %, lost_geom 0", () => {
    const a = assessStagingDiff(realStats(), realDiff());
    expect(a.fatal).toEqual([]);
    expect(a.info[0]).toBe("[finess] couverture géo : 99463/104734 (94.97%)");
  });

  it("la baseline mesurée reste au-dessus du seuil avec 2 points de marge, pas moins", () => {
    // 99 463 / 104 734 = 0,9497 ; le seuil 0,93 est la baseline − 2 points.
    expect(MIN_GEOM_COVERAGE).toBeLessThan(0.9497);
    expect(MIN_GEOM_COVERAGE).toBeGreaterThan(0.92);
    // 6,18 % de déplacés le jour de migration, 0 ensuite : 20 % tolère une
    // vague de re-géocodage BAN, pas une inversion (→ ~100 %).
    expect(MOVED_MAX_RATE).toBeGreaterThan(0.0618);
  });

  it("staging_rows ≠ inserted (staging polluée / inserts perdus) → fatal avant tout ratio", () => {
    const a = assessStagingDiff(realStats(), realDiff({ staging_rows: 104_800 }));
    expect(a.fatal).toHaveLength(1);
    expect(a.fatal[0]).toMatch(/holds 104800 rows but 104734 were inserted/);
    expect(a.info).toEqual([]);
  });

  it("chute des coordonnées ANS (couverture 90 %) → fatal", () => {
    const a = assessStagingDiff(realStats(), realDiff({ staging_geom_null: 10_500 }));
    expect(a.fatal[0]).toMatch(/Only 94234\/104734 rows have a geom \(89\.97%/);
  });

  it("fichier ANS partiel : > 10 % des établissements prod disparaissent → fatal", () => {
    const removed = Math.floor(93_403 * REMOVED_MAX_RATE) + 1;
    const a = assessStagingDiff(realStats(), realDiff({ removed }));
    expect(a.fatal[0]).toMatch(/établissements en prod absents de la staging/);
  });

  it("repli inopérant : 0,54 % des géolocalisés sans point après le repli → fatal, même si la couverture globale est bonne", () => {
    const lost = Math.floor(93_401 * LOST_GEOM_MAX_RATE) + 1;
    const a = assessStagingDiff(realStats(), realDiff({ lost_geom: lost }));
    expect(a.fatal).toHaveLength(1);
    expect(a.fatal[0]).toMatch(/sans point après le repli/);
  });

  it("le jour de migration, 6,18 % des communs bougent de > 500 m (recalage BAN) : sous les 20 %, informatif", () => {
    const a = assessStagingDiff(realStats(), realDiff());
    expect(a.fatal).toEqual([]);
    expect(a.info).toContain("[finess] points déplacés > 500 m : 5395/87284 communs (6.18%)");
  });

  it("inversion lat/lon upstream : couverture 100 %, lost_geom 0, mais TOUS les communs bougent → fatal", () => {
    // Depuis le domaine WGS84 complet, (2.27, 48.88) est un point « valide »
    // au large de la Somalie : seul le déplacement massif le trahit.
    const matched = 104_734 - 17_450;
    const a = assessStagingDiff(
      realStats(),
      realDiff({ staging_geom_null: 0, lost_geom: 0, moved_gt_500m: matched }),
    );
    expect(a.fatal).toHaveLength(1);
    expect(a.fatal[0]).toMatch(/déplacés de plus de 500 m \(100\.00% > 20\.00%\)/);
  });

  it("première ingestion (prod vide) : les gardes relatives à la prod sont sans objet", () => {
    const a = assessStagingDiff(
      realStats(),
      realDiff({ prod_rows: 0, prod_with_geom: 0, removed: 0, lost_geom: 0, added: 104_734 }),
    );
    expect(a.fatal).toEqual([]);
  });

  it("staging vide (staging_rows 0) : couverture 0 → fatal, pas de division par zéro", () => {
    const a = assessStagingDiff(
      realStats({ inserted: 0 }),
      realDiff({ staging_rows: 0, staging_geom_null: 0 }),
    );
    expect(a.fatal[0]).toMatch(/Only 0\/0 rows have a geom \(0\.00%/);
  });
});

describe("assessParsedRows — âge de la nomenclature TRE_R397 (post-mortem DREES transposé)", () => {
  const refreshed = Date.parse(FINESS_CATEGORIE_LABELS_REFRESHED_AT);
  const day = 86_400_000;

  it("info à chaque run ; warn (jamais fatal) au-delà de NOMENCLATURE_MAX_AGE_DAYS", () => {
    const fresh = assessParsedRows(realStats(), refreshed + 10 * day);
    expect(fresh.info.some((l) => /nomenclature TRE_R397 figée depuis 10 j/.test(l))).toBe(true);
    expect(fresh.warnings.some((l) => /nomenclature TRE_R397 vieille/.test(l))).toBe(false);
    const old = assessParsedRows(realStats(), refreshed + (NOMENCLATURE_MAX_AGE_DAYS + 1) * day);
    expect(old.warnings.some((l) => /vieille de 181 j/.test(l))).toBe(true);
    expect(old.fatal).toEqual([]);
    expect(nomenclatureAgeDays(refreshed + 5 * day)).toBe(5);
  });
});
