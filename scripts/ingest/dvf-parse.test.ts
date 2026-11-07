import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DVF_COLUMNS,
  DVF_DEPARTEMENTS,
  type DvfAggregate,
  type DvfValidationContext,
  MAX_AVEC_PRIX,
  MAX_AVEC_TERRAIN,
  MAX_COMMUNES,
  MAX_INVALID_RATE,
  MAX_MEDIAN_PRIX_M2,
  MAX_NO_COORDS_RATE,
  MAX_ROWS,
  MIN_AVEC_PRIX,
  MIN_AVEC_TERRAIN,
  MIN_COMMUNES,
  MIN_MEDIAN_PRIX_M2,
  MIN_ROWS,
  PLM_ARRONDISSEMENTS,
  PLM_CODES_VILLE,
  aggregateDvfRecords,
  assertDvfDryRunAllowed,
  assertDvfNotReceding,
  assertDvfStagingCount,
  dvfDeliverySignature,
  dvfRowsByDepartement,
  dvfWindowMonths,
  selectDvfFiles,
  staleDvfReason,
  streamDvfCsvGz,
  streamDvfFiles,
  validateDvfAggregate,
} from "./dvf-parse.js";
import { IngestError } from "./ingest-error.js";

// Identifiants et communes inventés. `rec` = une vente d'appartement à 2 000 €/m².
function rec(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id_mutation: "2026-000001",
    date_mutation: "2026-03-15",
    nature_mutation: "Vente",
    valeur_fonciere: "100000",
    code_commune: "94076",
    type_local: "Appartement",
    surface_reelle_bati: "50",
    surface_terrain: "",
    longitude: "2.36",
    latitude: "48.79",
    ...overrides,
  };
}

/** `n` lignes distinctes sur un mois : assez pour peser dans le calcul du dernier mois. */
function monthRecs(month: string, n: number): Record<string, string>[] {
  return Array.from({ length: n }, (_, i) =>
    rec({ id_mutation: `${month}-${i}`, date_mutation: `${month}-10` }),
  );
}

describe("selectDvfFiles", () => {
  const resource = (name: string, checksum = "abc") => ({
    url: `https://static.data.gouv.fr/resources/dvf/20261020-114721/${name}`,
    checksum: { value: checksum },
  });

  it("prend les 2 derniers par (année, semestre), du plus ancien au plus récent", () => {
    const files = selectDvfFiles([
      resource("full-2026-s1.csv.gz"),
      resource("full-2021-s2.csv.gz"),
      resource("full-2025.csv.gz"),
      resource("full-2024.csv.gz"),
    ]);
    expect(files.map((f) => f.fileName)).toEqual(["full-2025.csv.gz", "full-2026-s1.csv.gz"]);
    expect(files[1]).toMatchObject({ year: 2026, semester: 1, checksum: "abc" });
  });

  it("ignore dvf.csv.gz, les ressources sans CSV et les URL illisibles", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const files = selectDvfFiles([
      resource("dvf.csv.gz"),
      resource("full-2025.csv.gz"),
      { url: "https://files.data.gouv.fr/geo-dvf/latest/csv/" },
      { url: "pas une url" },
      { url: null },
      resource("full-2026-s1.csv.gz"),
    ]);
    expect(files.map((f) => f.fileName)).toEqual(["full-2025.csv.gz", "full-2026-s1.csv.gz"]);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("full-Y retire full-Y-s1 et full-Y-s2 : lus ensemble, ils doubleraient les ventes", () => {
    const files = selectDvfFiles([
      resource("full-2025.csv.gz"),
      resource("full-2026-s1.csv.gz"),
      resource("full-2026-s2.csv.gz"),
      resource("full-2026.csv.gz"),
    ]);
    expect(files.map((f) => f.fileName)).toEqual(["full-2025.csv.gz", "full-2026.csv.gz"]);
  });

  it("les semestres d'une année sans annuel restent sélectionnables", () => {
    const files = selectDvfFiles([
      resource("full-2025.csv.gz"),
      resource("full-2026-s1.csv.gz"),
      resource("full-2026-s2.csv.gz"),
    ]);
    expect(files.map((f) => f.fileName)).toEqual(["full-2026-s1.csv.gz", "full-2026-s2.csv.gz"]);
  });

  it("un annuel et son semestre ne font qu'un fichier : refus plutôt que double compte", () => {
    expect(() =>
      selectDvfFiles([resource("full-2026.csv.gz"), resource("full-2026-s1.csv.gz")]),
    ).toThrow(/1 fichier/);
  });

  it("le même nom déposé deux fois compte pour un seul fichier", () => {
    expect(() =>
      selectDvfFiles([
        { url: "https://x.test/20261020/full-2025.csv.gz" },
        { url: "https://x.test/20261021/full-2025.csv.gz" },
      ]),
    ).toThrow(/1 fichier/);
  });

  it("moins de 2 fichiers : IngestError('download') explicite", () => {
    try {
      selectDvfFiles([resource("full-2025.csv.gz"), resource("dvf.csv.gz")]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).phase).toBe("download");
      expect((err as IngestError).message).toMatch(/1 fichier.*2 attendus/);
    }
  });
});

describe("dvfDeliverySignature", () => {
  const a = { url: "https://x.test/20261020/a.csv.gz", checksum: "1" };
  const b = { url: "https://x.test/20261020/b.csv.gz", checksum: "2" };

  it("sha256 hex, stable quel que soit l'ordre", () => {
    expect(dvfDeliverySignature([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(dvfDeliverySignature([b, a])).toBe(dvfDeliverySignature([a, b]));
  });

  it("change si le contenu change", () => {
    expect(dvfDeliverySignature([a, { ...b, checksum: "3" }])).not.toBe(
      dvfDeliverySignature([a, b]),
    );
  });

  it("contenu identique re-déposé sous une nouvelle URL horodatée : même signature", () => {
    const redepose = { ...b, url: "https://x.test/20261105/b.csv.gz" };
    expect(dvfDeliverySignature([a, redepose])).toBe(dvfDeliverySignature([a, b]));
  });

  it("checksum absent : repli sur l'URL de ce fichier seulement", () => {
    const sansChecksum = { url: b.url, checksum: "" };
    const redepose = { url: "https://x.test/20261105/b.csv.gz", checksum: "" };
    expect(dvfDeliverySignature([a, redepose])).not.toBe(dvfDeliverySignature([a, sansChecksum]));
    expect(dvfDeliverySignature([{ ...a, url: "https://x.test/autre" }, sansChecksum])).toBe(
      dvfDeliverySignature([a, sansChecksum]),
    );
  });
});

describe("aggregateDvfRecords : règles de ligne", () => {
  it("ignore les lignes sans coordonnées et les lignes sans date", async () => {
    const agg = await aggregateDvfRecords([
      rec({ longitude: "" }),
      rec({ latitude: "abc" }),
      rec({ date_mutation: " " }),
    ]);
    expect(agg).toMatchObject({ lignesLues: 3, sansCoords: 2, sansDate: 1, invalides: 0 });
    expect(agg.rows).toEqual([]);
    expect(agg.lastMonth).toBeNull();
  });

  it.each([
    ["id vide", { id_mutation: " " }],
    ["date hors format", { date_mutation: "15/03/2026" }],
    ["jour impossible", { date_mutation: "2026-02-30" }],
    ["année impossible en base", { date_mutation: "0000-01-01" }],
    ["commune hors motif", { code_commune: "7511" }],
    ["longitude hors plage", { longitude: "180.5" }],
    ["latitude hors plage", { latitude: "-90.5" }],
  ])("compte comme invalide : %s", async (_label, overrides) => {
    const agg = await aggregateDvfRecords([rec(overrides)]);
    expect(agg.invalides).toBe(1);
    expect(agg.rows).toEqual([]);
  });

  it("accepte un code corse", async () => {
    const agg = await aggregateDvfRecords([rec({ code_commune: "2A004" })]);
    expect(agg.invalides).toBe(0);
    expect(agg.rows[0]?.code_commune).toBe("2A004");
  });

  it("prix_m2 seulement pour Maison et Appartement, surface > 0, valeur finie", async () => {
    const agg = await aggregateDvfRecords([
      rec({ id_mutation: "a", type_local: "Maison", valeur_fonciere: "300000" }),
      rec({ id_mutation: "b", type_local: "Local industriel", surface_terrain: "100" }),
      rec({ id_mutation: "c", surface_reelle_bati: "0", surface_terrain: "100" }),
      rec({ id_mutation: "d", valeur_fonciere: "", surface_terrain: "100" }),
    ]);
    const byId = new Map(agg.rows.map((r) => [r.id_mutation, r]));
    expect(byId.get("a")?.prix_m2).toBe(6000);
    expect(byId.get("b")?.prix_m2).toBeNull();
    expect(byId.get("c")?.prix_m2).toBeNull();
    expect(byId.get("d")?.prix_m2).toBeNull();
    expect(agg.avecPrix).toBe(1);
  });

  it("surfaces nulles si non finies ou ≤ 0, valeur nulle si non finie, type_local nettoyé", async () => {
    const agg = await aggregateDvfRecords([
      rec({
        id_mutation: "a",
        valeur_fonciere: "abc",
        surface_reelle_bati: "-3",
        surface_terrain: "250",
        type_local: "  Dépendance ",
      }),
      rec({ id_mutation: "b", surface_terrain: "0", type_local: "Maison" }),
    ]);
    const byId = new Map(agg.rows.map((r) => [r.id_mutation, r]));
    expect(byId.get("a")).toMatchObject({
      valeur_fonciere: null,
      surface_reelle_bati: null,
      surface_terrain: 250,
      type_local: "Dépendance",
    });
    expect(byId.get("b")?.surface_terrain).toBeNull();
    expect(agg.avecTerrain).toBe(1);
  });

  it("type_local absent devient chaîne vide (NOT NULL en base)", async () => {
    const agg = await aggregateDvfRecords([rec({ type_local: "", surface_terrain: "10" })]);
    expect(agg.rows[0]?.type_local).toBe("");
  });

  it("filtre utile : ni prix ni terrain, la ligne est comptée et jetée", async () => {
    const agg = await aggregateDvfRecords([
      rec({ id_mutation: "garde-prix" }),
      rec({ id_mutation: "garde-terrain", type_local: "", surface_terrain: "500" }),
      rec({ id_mutation: "inutile", type_local: "Dépendance" }),
    ]);
    expect(agg.inutiles).toBe(1);
    expect(agg.rows.map((r) => r.id_mutation).sort()).toEqual(["garde-prix", "garde-terrain"]);
  });

  it("les lignes portent exactement les colonnes de la staging, jamais geog", async () => {
    const agg = await aggregateDvfRecords([rec()]);
    expect(Object.keys(agg.rows[0] ?? {}).sort()).toEqual(
      [
        "code_commune",
        "date_mutation",
        "id_mutation",
        "latitude",
        "longitude",
        "nature_mutation",
        "prix_m2",
        "surface_reelle_bati",
        "surface_terrain",
        "type_local",
        "valeur_fonciere",
      ].sort(),
    );
  });
});

describe("aggregateDvfRecords : dédoublonnage", () => {
  it("garde la dernière ligne d'une même clé", async () => {
    const agg = await aggregateDvfRecords([
      rec({ valeur_fonciere: "100000" }),
      rec({ valeur_fonciere: "150000" }),
    ]);
    expect(agg.doublons).toBe(1);
    expect(agg.rows).toHaveLength(1);
    expect(agg.rows[0]?.valeur_fonciere).toBe(150000);
  });

  it("dédoublonne APRÈS le filtre utile : une ligne inutile n'efface pas une ligne utile", async () => {
    const agg = await aggregateDvfRecords([
      rec({ valeur_fonciere: "100000" }),
      rec({ valeur_fonciere: "abc", surface_reelle_bati: "" }),
    ]);
    expect(agg.inutiles).toBe(1);
    expect(agg.doublons).toBe(0);
    expect(agg.rows[0]?.valeur_fonciere).toBe(100000);
  });

  it("chaque composant de la clé distingue", async () => {
    const agg = await aggregateDvfRecords([
      rec(),
      rec({ id_mutation: "2026-000002" }),
      rec({ code_commune: "94077" }),
      rec({ date_mutation: "2026-03-16" }),
      rec({ type_local: "Maison" }),
    ]);
    expect(agg.doublons).toBe(0);
    expect(agg.rows).toHaveLength(5);
  });
});

describe("aggregateDvfRecords : fenêtre ancrée sur la donnée", () => {
  it("une ligne isolée datée 2030 ne déplace ni le dernier mois ni la fenêtre", async () => {
    const agg = await aggregateDvfRecords([
      ...monthRecs("2026-06", 10),
      rec({ id_mutation: "faux", date_mutation: "2030-01-01" }),
    ]);
    expect(agg.lastMonth).toBe("2026-06");
    expect(agg.rows).toHaveLength(10);
    expect(agg.horsFenetre).toBe(1);
  });

  it("garde exactement les 12 mois finissant au dernier mois, à cheval sur deux années", async () => {
    const agg = await aggregateDvfRecords([
      ...monthRecs("2025-06", 10),
      ...monthRecs("2025-07", 10),
      ...monthRecs("2026-06", 10),
    ]);
    expect(agg.lastMonth).toBe("2026-06");
    expect([...agg.rowsByMonth.keys()].sort()).toEqual(["2025-07", "2026-06"]);
    expect(agg.horsFenetre).toBe(10);
  });

  it("un mois récent encore maigre n'est pas le dernier mois publié (seuil 50 %)", async () => {
    const agg = await aggregateDvfRecords([
      ...monthRecs("2026-03", 100),
      ...monthRecs("2026-04", 49),
    ]);
    expect(agg.lastMonth).toBe("2026-03");
    expect(agg.horsFenetre).toBe(49);
  });

  it("le seuil de 50 % est inclusif", async () => {
    const agg = await aggregateDvfRecords([
      ...monthRecs("2026-03", 100),
      ...monthRecs("2026-04", 50),
    ]);
    expect(agg.lastMonth).toBe("2026-04");
  });

  // La leçon Sit@del : une fenêtre calée sur l'horloge perd des mois en début
  // d'année. Ici, janvier comme avril, la fenêtre ne dépend que des fichiers.
  it.each([
    ["janvier, fichiers arrêtés à juin", "2026-06", "2025-07"],
    ["avril, fichiers arrêtés à décembre", "2026-12", "2026-01"],
  ])("cas %s : 12 mois complets", async (_label, last, first) => {
    const months = dvfWindowMonths(last);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe(first);
    expect(months[11]).toBe(last);
    const agg = await aggregateDvfRecords(months.flatMap((m) => monthRecs(m, 5)));
    expect(agg.lastMonth).toBe(last);
    expect(agg.rowsByMonth.size).toBe(12);
    expect(agg.horsFenetre).toBe(0);
  });
});

describe("aggregateDvfRecords : tri et statistiques", () => {
  it("cadre métropole : bornes incluses, outre-mer et coordonnées permutées dehors", async () => {
    const coords = [
      ["2.36", "48.79"],
      ["-5.5", "41"],
      ["10", "51.5"],
      ["-5.51", "48"],
      ["10.01", "48"],
      ["2", "40.99"],
      ["2", "51.51"],
      ["55.45", "-20.88"],
      ["48.79", "2.36"],
    ];
    const agg = await aggregateDvfRecords(
      coords.map(([longitude, latitude], i) =>
        rec({ id_mutation: `c${i}`, longitude: longitude ?? "", latitude: latitude ?? "" }),
      ),
    );
    expect(agg.rows).toHaveLength(coords.length);
    expect(agg.dansCadreMetropole).toBe(3);
  });

  it("tri par (commune, date, id, type), indépendant de l'ordre d'entrée", async () => {
    const lignes = [
      rec({ code_commune: "94076", date_mutation: "2026-03-02", id_mutation: "b" }),
      rec({ code_commune: "01001", date_mutation: "2026-03-20", id_mutation: "z" }),
      rec({ code_commune: "94076", date_mutation: "2026-03-01", id_mutation: "z" }),
      rec({ code_commune: "94076", date_mutation: "2026-03-02", id_mutation: "a" }),
      rec({
        code_commune: "94076",
        date_mutation: "2026-03-02",
        id_mutation: "a",
        type_local: "Maison",
      }),
    ];
    const cle = (r: { code_commune: string; date_mutation: string; id_mutation: string }) =>
      `${r.code_commune} ${r.date_mutation} ${r.id_mutation}`;
    const direct = await aggregateDvfRecords(lignes);
    const inverse = await aggregateDvfRecords([...lignes].reverse());
    expect(direct.rows.map(cle)).toEqual([
      "01001 2026-03-20 z",
      "94076 2026-03-01 z",
      "94076 2026-03-02 a",
      "94076 2026-03-02 a",
      "94076 2026-03-02 b",
    ]);
    expect(direct.rows[2]?.type_local).toBe("Appartement");
    expect(direct.rows[3]?.type_local).toBe("Maison");
    expect(inverse.rows).toEqual(direct.rows);
  });

  it("médiane nationale : impaire, paire, absente", async () => {
    const prix = (vals: string[]) =>
      vals.map((v, i) => rec({ id_mutation: `p${i}`, valeur_fonciere: v }));
    expect((await aggregateDvfRecords(prix(["100", "300", "9000"]))).medianPrixM2).toBe(6);
    expect((await aggregateDvfRecords(prix(["100", "300"]))).medianPrixM2).toBe(4);
    const sansPrix = await aggregateDvfRecords([rec({ type_local: "", surface_terrain: "9" })]);
    expect(sansPrix.medianPrixM2).toBeNull();
  });

  it("compte les communes dans la fenêtre seulement", async () => {
    const agg = await aggregateDvfRecords([
      ...monthRecs("2026-06", 3),
      rec({ id_mutation: "vieux", date_mutation: "2020-01-01", code_commune: "01001" }),
    ]);
    expect([...agg.rowsByCommune.keys()]).toEqual(["94076"]);
  });
});

describe("validateDvfAggregate", () => {
  const LAST = "2026-06";
  /** Mesuré le 2026-11-06 : `full-2025` + `full-2026-s1`. */
  const LUES = 5_491_055;
  const GARDEES = 1_609_828;
  const CONTEXTE: DvfValidationContext = {
    newestFile: { year: 2026, semester: 1 },
    now: new Date("2026-11-07T00:00:00Z"),
  };

  const communes = (n = 32_635): Map<string, number> => {
    const base = new Map<string, number>(PLM_ARRONDISSEMENTS.map((c) => [c, 100]));
    for (const d of DVF_DEPARTEMENTS) base.set(d.length === 3 ? `${d}01` : `${d}001`, 1_783);
    for (let i = 0; base.size < n; i++) base.set(`99${String(i).padStart(4, "0")}`, 10);
    return base;
  };

  const moisDeLaFenetre = (last: string) =>
    new Map(dvfWindowMonths(last).map((m) => [m, 130_000] as const));

  /** Agrégat sain aux chiffres mesurés. Sans lignes réelles : seules les longueurs comptent. */
  function sain(overrides: Partial<DvfAggregate> = {}): DvfAggregate {
    return {
      rows: new Array(GARDEES),
      lignesLues: LUES,
      sansCoords: 108_859,
      sansDate: 0,
      invalides: 0,
      inutiles: 1_080_713,
      doublons: 1_920_393,
      horsFenetre: 771_262,
      lastMonth: LAST,
      rowsByMonth: moisDeLaFenetre(LAST),
      rowsByCommune: communes(),
      avecPrix: 875_291,
      avecTerrain: 1_217_931,
      dansCadreMetropole: 1_595_071,
      medianPrixM2: 2_650,
      ...overrides,
    };
  }

  const accepte = (agg: DvfAggregate, contexte = CONTEXTE) =>
    expect(() => validateDvfAggregate(agg, contexte)).not.toThrow();

  function refus(agg: DvfAggregate, contexte = CONTEXTE): IngestError {
    try {
      validateDvfAggregate(agg, contexte);
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).phase).toBe("validate");
      expect((err as IngestError).message).toMatch(/Swap refusé/);
      return err as IngestError;
    }
    throw new Error("swap accepté alors qu'un refus était attendu");
  }

  it("accepte les chiffres mesurés le 2026-11-06", () => {
    accepte(sain());
  });

  it("lignes gardées : bornes incluses, hors bornes refusées", () => {
    const avec = (n: number) => sain({ rows: new Array(n), dansCadreMetropole: n });
    accepte(avec(MIN_ROWS));
    accepte(avec(MAX_ROWS));
    expect(refus(avec(MIN_ROWS - 1)).message).toMatch(/lignes gardées/);
    expect(refus(avec(MAX_ROWS + 1)).message).toMatch(/lignes gardées/);
  });

  it("communes : bornes incluses, hors bornes refusées", () => {
    accepte(sain({ rowsByCommune: communes(MIN_COMMUNES) }));
    accepte(sain({ rowsByCommune: communes(MAX_COMMUNES) }));
    expect(refus(sain({ rowsByCommune: communes(MIN_COMMUNES - 1) })).message).toMatch(/communes/);
    expect(refus(sain({ rowsByCommune: communes(MAX_COMMUNES + 1) })).message).toMatch(/communes/);
  });

  it("les 45 arrondissements sont exigés", () => {
    expect(PLM_ARRONDISSEMENTS).toHaveLength(45);
    for (const code of ["75101", "75120", "69381", "69389", "13201", "13216"]) {
      const rowsByCommune = communes();
      rowsByCommune.delete(code);
      expect(refus(sain({ rowsByCommune })).message).toContain(code);
    }
  });

  it("aucune ligne sur un code ville", () => {
    for (const code of PLM_CODES_VILLE) {
      const rowsByCommune = communes();
      rowsByCommune.set(code, 1);
      expect(refus(sain({ rowsByCommune })).message).toContain(code);
    }
  });

  it("les 12 mois doivent être présents", () => {
    const rowsByMonth = moisDeLaFenetre(LAST);
    rowsByMonth.delete("2026-02");
    expect(refus(sain({ rowsByMonth })).message).toContain("2026-02=0");
  });

  it("chaque mois ≥ 30 % du mois le plus fourni, borne incluse", () => {
    const avec = (n: number) =>
      sain({
        rowsByMonth: new Map(
          dvfWindowMonths(LAST).map((m) => [m, m === "2025-09" ? n : 100_000] as const),
        ),
      });
    accepte(avec(30_000));
    expect(refus(avec(29_999)).message).toContain("2025-09=29999");
  });

  it("aucun mois : refus", () => {
    expect(refus(sain({ lastMonth: null })).message).toMatch(/Aucun mois/);
  });

  it("médiane : bornes incluses, hors bornes et absence refusées", () => {
    accepte(sain({ medianPrixM2: MIN_MEDIAN_PRIX_M2 }));
    accepte(sain({ medianPrixM2: MAX_MEDIAN_PRIX_M2 }));
    for (const medianPrixM2 of [MIN_MEDIAN_PRIX_M2 - 1, MAX_MEDIAN_PRIX_M2 + 1, null]) {
      expect(refus(sain({ medianPrixM2 })).message).toMatch(/Médiane/);
    }
  });

  it("invalides ≤ 0,1 % : seuil inclus, au-delà refusé", () => {
    const seuil = Math.floor(LUES * MAX_INVALID_RATE);
    accepte(sain({ invalides: seuil }));
    expect(refus(sain({ invalides: seuil + 1 })).message).toMatch(/invalides/);
  });

  it("sans coordonnées ≤ 15 % : seuil inclus, au-delà refusé", () => {
    const seuil = Math.floor(LUES * MAX_NO_COORDS_RATE);
    accepte(sain({ sansCoords: seuil, doublons: 0 }));
    expect(refus(sain({ sansCoords: seuil + 1 })).message).toMatch(/coordonnées/);
  });

  it("aucune ligne lue : refus", () => {
    expect(refus(sain({ lignesLues: 0 })).message).toMatch(/Aucune ligne/);
  });

  it("sans date ≤ 1 % : seuil inclus, fichier récent sans date refusé", () => {
    const seuil = Math.floor(LUES * 0.01);
    accepte(sain({ sansDate: seuil, doublons: 0 }));
    expect(refus(sain({ sansDate: seuil + 1 })).message).toMatch(/sans date/);
    // Le fichier le plus récent (1,7 M lignes) sans aucune date.
    expect(refus(sain({ sansDate: 1_700_000 })).message).toMatch(/sans date/);
  });

  it("lignes avec prix : bornes acceptées, hors bornes refusées", () => {
    accepte(sain({ avecPrix: MIN_AVEC_PRIX }));
    accepte(sain({ avecPrix: MAX_AVEC_PRIX }));
    expect(refus(sain({ avecPrix: MIN_AVEC_PRIX - 1 })).message).toMatch(/avec prix/);
    expect(refus(sain({ avecPrix: MAX_AVEC_PRIX + 1 })).message).toMatch(/avec prix/);
  });

  it("lignes avec terrain : bornes acceptées, `surface_terrain` vide partout refusée", () => {
    accepte(sain({ avecTerrain: MIN_AVEC_TERRAIN }));
    accepte(sain({ avecTerrain: MAX_AVEC_TERRAIN }));
    expect(refus(sain({ avecTerrain: 0 })).message).toMatch(/avec terrain/);
    expect(refus(sain({ avecTerrain: MIN_AVEC_TERRAIN - 1 })).message).toMatch(/avec terrain/);
    expect(refus(sain({ avecTerrain: MAX_AVEC_TERRAIN + 1 })).message).toMatch(/avec terrain/);
  });

  it("inutiles ≤ 35 % : 19,7 % mesuré accepté, seuil inclus, au-delà refusé", () => {
    expect(1_080_713 / LUES).toBeCloseTo(0.197, 3);
    const seuil = Math.floor(LUES * 0.35);
    accepte(sain({ inutiles: seuil, doublons: 0 }));
    expect(refus(sain({ inutiles: seuil + 1 })).message).toMatch(/inutiles/);
  });

  it("doublons ≤ 60 % des lignes utiles : 44,6 % mesuré accepté, au-delà refusé", () => {
    const utiles = LUES - 108_859 - 1_080_713;
    expect(utiles).toBe(4_301_483);
    expect(1_920_393 / utiles).toBeCloseTo(0.446, 3);
    const seuil = Math.floor(utiles * 0.6);
    accepte(sain({ doublons: seuil }));
    expect(refus(sain({ doublons: seuil + 1 })).message).toMatch(/doublons/);
  });

  it("le dénominateur des doublons sort les lignes écartées avant dédoublonnage", () => {
    // Même nombre de doublons : accepté avec 4,3 M lignes utiles, refusé avec 3,2 M.
    accepte(sain({ doublons: 2_000_000 }));
    expect(
      refus(sain({ doublons: 2_000_000, sansCoords: 700_000, inutiles: 1_500_000 })).message,
    ).toMatch(/doublons/);
  });

  it("cadre métropole ≥ 95 % : 99,083 % mesuré accepté, permutation refusée", () => {
    expect(1_595_071 / GARDEES).toBeCloseTo(0.99083, 5);
    const seuil = Math.ceil(GARDEES * 0.95);
    accepte(sain({ dansCadreMetropole: seuil }));
    expect(refus(sain({ dansCadreMetropole: seuil - 1 })).message).toMatch(/permutées/);
    expect(refus(sain({ dansCadreMetropole: 0 })).message).toMatch(/permutées/);
  });

  describe("départements", () => {
    it("liste exacte des 97 attendus, sans les absents légitimes", () => {
      expect(DVF_DEPARTEMENTS).toHaveLength(97);
      expect(new Set(DVF_DEPARTEMENTS).size).toBe(97);
      for (const d of ["01", "19", "2A", "2B", "21", "56", "58", "66", "69", "95", "971", "974"]) {
        expect(DVF_DEPARTEMENTS).toContain(d);
      }
      for (const d of ["20", "57", "67", "68", "96", "975", "976"]) {
        expect(DVF_DEPARTEMENTS).not.toContain(d);
      }
    });

    it("compte par département depuis le compte par commune, Corse et outre-mer compris", () => {
      const byDept = dvfRowsByDepartement(
        new Map([
          ["75115", 10],
          ["75101", 5],
          ["2A004", 3],
          ["97411", 7],
        ]),
      );
      expect(Object.fromEntries(byDept)).toEqual({ "75": 15, "2A": 3, "974": 7 });
    });

    it("le seuil de 300 passe", () => {
      const rowsByCommune = communes();
      rowsByCommune.set("48001", 300);
      accepte(sain({ rowsByCommune }));
    });

    it("299 lignes dans un département : refus qui le nomme", () => {
      const rowsByCommune = communes();
      rowsByCommune.set("48001", 299);
      expect(refus(sain({ rowsByCommune })).message).toContain("48=299");
    });

    it("une région entière absente : refus, même avec assez de communes", () => {
      const rowsByCommune = communes();
      rowsByCommune.delete("29001");
      rowsByCommune.delete("22001");
      const message = refus(sain({ rowsByCommune })).message;
      expect(message).toContain("29=0");
      expect(message).toContain("22=0");
    });

    it("un département d'outre-mer absent : refus", () => {
      const rowsByCommune = communes();
      rowsByCommune.delete("97301");
      expect(refus(sain({ rowsByCommune })).message).toContain("973=0");
    });

    it("un département en plus ne bloque pas", () => {
      const rowsByCommune = communes();
      rowsByCommune.set("97601", 5);
      rowsByCommune.set("57001", 5);
      accepte(sain({ rowsByCommune }));
    });
  });

  describe("cohérence du dernier mois", () => {
    const avecDernierMois = (lastMonth: string) =>
      sain({ lastMonth, rowsByMonth: moisDeLaFenetre(lastMonth) });
    const fichier = (year: number, semester: 1 | 2 | null, now = "2027-12-01T00:00:00Z") => ({
      newestFile: { year, semester },
      now: new Date(now),
    });

    it("`-s1` : `2026-06` mesuré et `2026-04` passent, `2026-03` et 2025 refusés", () => {
      accepte(avecDernierMois("2026-06"), fichier(2026, 1));
      accepte(avecDernierMois("2026-04"), fichier(2026, 1));
      expect(refus(avecDernierMois("2026-03"), fichier(2026, 1)).message).toMatch(/incohérent/);
      // Le fichier récent n'apporte aucune ligne utile : seul ce contrôle le voit.
      expect(refus(avecDernierMois("2025-12"), fichier(2026, 1)).message).toMatch(/incohérent/);
    });

    it("annuel : décembre mesuré et octobre passent, septembre refusé", () => {
      accepte(avecDernierMois("2025-12"), fichier(2025, null));
      accepte(avecDernierMois("2025-10"), fichier(2025, null));
      expect(refus(avecDernierMois("2025-09"), fichier(2025, null)).message).toMatch(/incohérent/);
    });

    it("`-s2` : octobre passe, septembre refusé", () => {
      accepte(avecDernierMois("2026-10"), fichier(2026, 2));
      expect(refus(avecDernierMois("2026-09"), fichier(2026, 2)).message).toMatch(/incohérent/);
    });

    it("une autre année que celle du fichier le plus récent est refusée", () => {
      expect(refus(avecDernierMois("2027-01"), fichier(2026, 1)).message).toMatch(/incohérent/);
    });

    it("jamais postérieur au mois courant, mois courant accepté", () => {
      accepte(avecDernierMois("2026-06"), fichier(2026, 1, "2026-06-15T00:00:00Z"));
      expect(
        refus(avecDernierMois("2026-06"), fichier(2026, 1, "2026-05-31T23:00:00Z")).message,
      ).toMatch(/postérieur/);
    });
  });
});

describe("assertDvfNotReceding", () => {
  it("table vide : pas de garde", () => {
    expect(() => assertDvfNotReceding("2025-12", null)).not.toThrow();
  });

  it("même mois ou plus récent : accepté", () => {
    expect(() => assertDvfNotReceding("2026-06", "2026-06-30")).not.toThrow();
    expect(() => assertDvfNotReceding("2026-12", "2026-06-30")).not.toThrow();
  });

  it("livraison qui recule (`full-2024` + `full-2025` après `full-2026-s1`) : refus", () => {
    try {
      assertDvfNotReceding("2025-12", "2026-06-30");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).phase).toBe("validate");
      expect((err as IngestError).message).toMatch(/recul.*2025-12.*2026-06.*Swap refusé/);
    }
  });
});

describe("staleDvfReason", () => {
  it("rien tant que le retard ne dépasse pas 12 mois", () => {
    expect(staleDvfReason("2026-06", new Date("2027-01-12T05:00:00Z"))).toBeNull();
    expect(staleDvfReason("2026-06", new Date("2027-04-12T05:00:00Z"))).toBeNull();
    expect(staleDvfReason("2026-06", new Date("2027-06-30T05:00:00Z"))).toBeNull();
  });

  it("au-delà : raison lisible avec le retard", () => {
    const reason = staleDvfReason("2026-06", new Date("2027-07-01T05:00:00Z"));
    expect(reason).toContain("2026-06");
    expect(reason).toContain("13 mois");
  });
});

describe("assertDvfStagingCount", () => {
  it("accepte le compte attendu, en nombre comme en string (BIGINT PostgREST)", () => {
    expect(() => assertDvfStagingCount(1_609_828, 1_609_828)).not.toThrow();
    expect(() => assertDvfStagingCount("1609828", 1_609_828)).not.toThrow();
  });

  it("refuse un écart : lot dupliqué ou perdu, pas de swap", () => {
    for (const count of [1_611_828, "1607828"]) {
      expect(() => assertDvfStagingCount(count, 1_609_828)).toThrow(IngestError);
      expect(() => assertDvfStagingCount(count, 1_609_828)).toThrow(/Swap refusé/);
    }
  });

  it("refuse une réponse illisible en phase validate", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      assertDvfStagingCount(null, 10);
      expect.unreachable();
    } catch (err) {
      expect((err as IngestError).phase).toBe("validate");
    }
    spy.mockRestore();
  });
});

describe("assertDvfDryRunAllowed", () => {
  it("refuse un dry-run sur un déclenchement schedule", () => {
    expect(() => assertDvfDryRunAllowed(true, "schedule")).toThrow(/cron vert/);
  });

  it("autorise un dry-run manuel et tout run normal", () => {
    expect(() => assertDvfDryRunAllowed(true, "workflow_dispatch")).not.toThrow();
    expect(() => assertDvfDryRunAllowed(true, undefined)).not.toThrow();
    expect(() => assertDvfDryRunAllowed(false, "schedule")).not.toThrow();
  });
});

describe("streamDvfCsvGz", () => {
  const dir = mkdtempSync(join(tmpdir(), "dvf-parse-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Chaque lecture en échec trace sur stderr, à dessein.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const EXTRA = ["adresse_nom_voie", "code_postal"];
  const header = [...DVF_COLUMNS, ...EXTRA].join(",");
  const line = (id: string) =>
    `${id},2026-03-15,Vente,100000,94076,Appartement,50,,2.36,48.79,"RUE, AVEC VIRGULE",94800`;

  const writeGz = (name: string, content: Buffer | string): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === "string" ? gzipSync(content) : content);
    return path;
  };

  /** Assez volumineux pour que la coupure tombe en plein flux gzip. */
  const grosGzip = (): Buffer => {
    const lines = Array.from({ length: 50_000 }, (_, i) => line(`id-${i}-${i * 7919}`)).join("\n");
    return gzipSync(`${header}\n${lines}\n`);
  };

  const collect = async (gen: AsyncIterable<Record<string, string>>) => {
    const out: Record<string, string>[] = [];
    for await (const r of gen) out.push(r);
    return out;
  };

  it("lit le fichier et ne garde que les colonnes utiles", async () => {
    const path = writeGz("ok.csv.gz", `${header}\n${line("a")}\n${line("b")}\n`);
    const records = await collect(streamDvfCsvGz(path));
    expect(records.map((r) => r.id_mutation)).toEqual(["a", "b"]);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([...DVF_COLUMNS].sort());
    expect(records[0]).toMatchObject({ code_commune: "94076", surface_terrain: "" });
  });

  it("enchaîne les fichiers dans l'ordre donné", async () => {
    const a = writeGz("a.csv.gz", `${header}\n${line("a")}\n`);
    const b = writeGz("b.csv.gz", `${header}\n${line("b")}\n`);
    const records = await collect(streamDvfFiles([b, a]));
    expect(records.map((r) => r.id_mutation)).toEqual(["b", "a"]);
  });

  it("en-tête incomplet : IngestError('pre_validate'), même sans aucune ligne", async () => {
    const path = writeGz("entete.csv.gz", "id_mutation,date_mutation\n");
    const err = await collect(streamDvfCsvGz(path)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).phase).toBe("pre_validate");
    expect((err as IngestError).message).toContain("valeur_fonciere");
  });

  it("un gzip réellement tronqué fait échouer la lecture, jamais un jeu partiel", async () => {
    const gz = grosGzip();
    const path = writeGz("tronque.csv.gz", gz.subarray(0, Math.floor(gz.length * 0.6)));
    const err = await collect(streamDvfCsvGz(path)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).phase).toBe("pre_validate");
    expect((err as IngestError).message).toMatch(/tronque\.csv\.gz.*unexpected end of file/);
  });

  it("le même gzip tronqué fait échouer une agrégation, y compris sur le 2e fichier", async () => {
    const gz = grosGzip();
    const entier = writeGz("entier.csv.gz", gz);
    const tronque = writeGz("tronque2.csv.gz", gz.subarray(0, gz.length - 100));
    await expect(aggregateDvfRecords(streamDvfFiles([entier, tronque]))).rejects.toThrow(
      /tronque2\.csv\.gz/,
    );
  });

  it("un fichier qui n'est pas du gzip échoue aussi", async () => {
    const path = writeGz("html.csv.gz", Buffer.from("<html>maintenance</html>"));
    await expect(collect(streamDvfCsvGz(path))).rejects.toBeInstanceOf(IngestError);
  });

  it("une ligne au nombre de colonnes incohérent fait échouer la lecture", async () => {
    const path = writeGz("colonnes.csv.gz", `${header}\n${line("a")}\na,b,c\n`);
    await expect(collect(streamDvfCsvGz(path))).rejects.toBeInstanceOf(IngestError);
  });

  it("arrêter la lecture en cours de route ne laisse aucune rejection flottante", async () => {
    const path = writeGz("arret.csv.gz", `${header}\n${line("a")}\n${line("b")}\n`);
    for await (const _ of streamDvfCsvGz(path)) break;
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe("pureté de dvf-parse.ts", () => {
  /** Modules réellement chargés à l'exécution : les `import type` s'effacent à la compilation. */
  function runtimeImports(file: string): string[] {
    const src = readFileSync(file, "utf8");
    return [
      ...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"|^import\s+"([^"]+)"/gm),
    ].map((m) => m[1] ?? m[2] ?? "");
  }

  it("aucun load-env ni client Supabase dans la chaîne d'import", () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = [fileURLToPath(new URL("./dvf-parse.ts", import.meta.url))];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of runtimeImports(file)) {
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec).replace(/\.js$/, ".ts"));
        else bare.add(spec);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    const fichiers = [...seen].join("\n");
    expect(fichiers).not.toMatch(/load-env|supabase|shared\.ts/);
    expect([...bare].filter((m) => /supabase|dotenv/.test(m))).toEqual([]);
  });
});
