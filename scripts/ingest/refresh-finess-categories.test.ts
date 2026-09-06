import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FINESS_CATEGORIE_LABELS_REFRESHED_AT,
  SMT_CATEGORIE_LABELS,
} from "../../src/sante/finess-categories-labels.js";
import {
  LABELS_MODULE_PATH,
  MIN_LABELS,
  parseLabelsModule,
  readGeneratedCount,
  refuseReason,
  renderLabelsModule,
} from "./refresh-finess-categories.js";

const committed = readFileSync(LABELS_MODULE_PATH, "utf8");

describe("module de libellés généré — reproductible par son générateur (revue 2026-09-06)", () => {
  it("le fichier committé est BYTE-IDENTIQUE au rendu de son propre contenu (ordre SMT, format Biome)", () => {
    // Sinon le prochain refresh noie un vrai changement de libellé dans un diff
    // de 428 lignes réordonnées/réindentées — et Biome ré-indente ce que le
    // générateur écrit, ce qui avait tué la garde anti-rétrécissement.
    const { labels, refreshedAt } = parseLabelsModule(committed);
    expect(renderLabelsModule(labels, refreshedAt)).toBe(committed);
    expect(labels).toEqual(SMT_CATEGORIE_LABELS);
    expect(refreshedAt).toBe(FINESS_CATEGORIE_LABELS_REFRESHED_AT);
  });

  it("le marqueur @generated-count dit le vrai nombre d'entrées (codes à 3 ET 4 chiffres)", () => {
    expect(readGeneratedCount(committed)).toBe(Object.keys(SMT_CATEGORIE_LABELS).length);
    expect(Object.keys(SMT_CATEGORIE_LABELS).length).toBeGreaterThan(400);
    // Plancher qui protège AUSSI le cron FINESS (categorie_libelle NULL en masse
    // si la nomenclature était tronquée) — ne pas le juger redondant.
    expect(Object.keys(SMT_CATEGORIE_LABELS).some((c) => c.length === 4)).toBe(true);
  });
});

describe("refuseReason — garde anti-rétrécissement", () => {
  const current = renderLabelsModule(
    Object.fromEntries(Array.from({ length: 428 }, (_, i) => [String(1000 + i), `L${i}`])),
    "2026-09-05T00:00:00.000Z",
  );

  it("SMT partiel (310 pour 428) → refus ; 95 % ou plus → accepté", () => {
    expect(refuseReason(310, current)).toMatch(/310 libellés reçus < 95 % des 428 actuels/);
    expect(refuseReason(406, current)).toMatch(/SMT partiel/);
    expect(refuseReason(407, current)).toBeNull();
    expect(refuseReason(440, current)).toBeNull();
  });

  it("plancher absolu sur les libellés RETENUS ; premier rendu sans référence accepté", () => {
    expect(refuseReason(MIN_LABELS - 1, null)).toMatch(/réponse SMT suspecte/);
    expect(refuseReason(MIN_LABELS, null)).toBeNull();
  });

  it("fichier actuel sans marqueur → refus explicite (une garde qui ne sait pas mesurer crie, ne se tait pas)", () => {
    expect(refuseReason(428, "export const SMT_CATEGORIE_LABELS = {\n} as const;")).toMatch(
      /garde de non-régression INOPÉRANTE/,
    );
  });
});
