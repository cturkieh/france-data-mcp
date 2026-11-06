import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DVF_COLUMNS,
  type DvfAggregate,
  MAX_COMMUNES,
  MAX_INVALID_RATE,
  MAX_MEDIAN_PRIX_M2,
  MAX_NO_COORDS_RATE,
  MAX_ROWS,
  MIN_COMMUNES,
  MIN_MEDIAN_PRIX_M2,
  MIN_ROWS,
  PLM_ARRONDISSEMENTS,
  PLM_CODES_VILLE,
  aggregateDvfRecords,
  assertDvfDryRunAllowed,
  assertDvfStagingCount,
  dvfDeliverySignature,
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

const repoFile = (rel: string): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../..", rel);

describe("selectDvfFiles", () => {
  const resource = (name: string, checksum = "abc") => ({
    url: `https://static.data.gouv.fr/resources/dvf/20261020-114721/${name}`,
    filesize: 1000,
    checksum: { type: "sha1", value: checksum },
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

  it("une année pleine se range après ses semestres", () => {
    const files = selectDvfFiles([
      resource("full-2026-s1.csv.gz"),
      resource("full-2026.csv.gz"),
      resource("full-2025.csv.gz"),
    ]);
    expect(files.map((f) => f.fileName)).toEqual(["full-2026-s1.csv.gz", "full-2026.csv.gz"]);
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
  const a = { url: "https://x.test/a.csv.gz", checksum: "1" };
  const b = { url: "https://x.test/b.csv.gz", checksum: "2" };

  it("sha256 hex, stable quel que soit l'ordre", () => {
    expect(dvfDeliverySignature([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(dvfDeliverySignature([b, a])).toBe(dvfDeliverySignature([a, b]));
  });

  it("change si l'URL ou le checksum change", () => {
    const base = dvfDeliverySignature([a, b]);
    expect(dvfDeliverySignature([a, { ...b, checksum: "3" }])).not.toBe(base);
    expect(dvfDeliverySignature([a, { ...b, url: "https://x.test/c.csv.gz" }])).not.toBe(base);
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

  /** Agrégat sain aux chiffres mesurés. Sans lignes réelles : seules les longueurs comptent. */
  function sain(overrides: Partial<DvfAggregate> = {}): DvfAggregate {
    const rowsByCommune = new Map<string, number>(PLM_ARRONDISSEMENTS.map((c) => [c, 100]));
    for (let i = 0; rowsByCommune.size < 32_635; i++) {
      rowsByCommune.set(`9${String(i).padStart(4, "0")}`, 10);
    }
    return {
      rows: new Array(1_609_828),
      lignesLues: 5_500_000,
      sansCoords: 100_000,
      sansDate: 0,
      invalides: 0,
      inutiles: 3_000_000,
      doublons: 500_000,
      horsFenetre: 800_000,
      lastMonth: LAST,
      rowsByMonth: new Map(dvfWindowMonths(LAST).map((m) => [m, 130_000])),
      rowsByCommune,
      avecPrix: 875_291,
      avecTerrain: 1_217_931,
      medianPrixM2: 2_650,
      ...overrides,
    };
  }

  function refus(agg: DvfAggregate): IngestError {
    try {
      validateDvfAggregate(agg);
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).phase).toBe("validate");
      expect((err as IngestError).message).toMatch(/Swap refusé/);
      return err as IngestError;
    }
    throw new Error("swap accepté alors qu'un refus était attendu");
  }

  const communes = (n: number): Map<string, number> => {
    const base = new Map<string, number>(PLM_ARRONDISSEMENTS.map((c) => [c, 100]));
    for (let i = 0; base.size < n; i++) base.set(`9${String(i).padStart(4, "0")}`, 10);
    return base;
  };

  it("accepte les chiffres mesurés le 2026-11-06", () => {
    expect(() => validateDvfAggregate(sain())).not.toThrow();
  });

  it("lignes gardées : bornes incluses, hors bornes refusées", () => {
    expect(() => validateDvfAggregate(sain({ rows: new Array(MIN_ROWS) }))).not.toThrow();
    expect(() => validateDvfAggregate(sain({ rows: new Array(MAX_ROWS) }))).not.toThrow();
    expect(refus(sain({ rows: new Array(MIN_ROWS - 1) })).message).toMatch(/lignes gardées/);
    expect(refus(sain({ rows: new Array(MAX_ROWS + 1) })).message).toMatch(/lignes gardées/);
  });

  it("communes : bornes incluses, hors bornes refusées", () => {
    expect(() =>
      validateDvfAggregate(sain({ rowsByCommune: communes(MIN_COMMUNES) })),
    ).not.toThrow();
    expect(() =>
      validateDvfAggregate(sain({ rowsByCommune: communes(MAX_COMMUNES) })),
    ).not.toThrow();
    expect(refus(sain({ rowsByCommune: communes(MIN_COMMUNES - 1) })).message).toMatch(/communes/);
    expect(refus(sain({ rowsByCommune: communes(MAX_COMMUNES + 1) })).message).toMatch(/communes/);
  });

  it("les 45 arrondissements sont exigés", () => {
    expect(PLM_ARRONDISSEMENTS).toHaveLength(45);
    for (const code of ["75101", "75120", "69381", "69389", "13201", "13216"]) {
      const rowsByCommune = communes(32_635);
      rowsByCommune.delete(code);
      expect(refus(sain({ rowsByCommune })).message).toContain(code);
    }
  });

  it("aucune ligne sur un code ville", () => {
    for (const code of PLM_CODES_VILLE) {
      const rowsByCommune = communes(32_635);
      rowsByCommune.set(code, 1);
      expect(refus(sain({ rowsByCommune })).message).toContain(code);
    }
  });

  it("les 12 mois doivent être présents", () => {
    const rowsByMonth = new Map(dvfWindowMonths(LAST).map((m) => [m, 130_000]));
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
    expect(() => validateDvfAggregate(avec(30_000))).not.toThrow();
    expect(refus(avec(29_999)).message).toContain("2025-09=29999");
  });

  it("aucun mois : refus", () => {
    expect(refus(sain({ lastMonth: null })).message).toMatch(/Aucun mois/);
  });

  it("médiane : bornes incluses, hors bornes et absence refusées", () => {
    expect(() => validateDvfAggregate(sain({ medianPrixM2: MIN_MEDIAN_PRIX_M2 }))).not.toThrow();
    expect(() => validateDvfAggregate(sain({ medianPrixM2: MAX_MEDIAN_PRIX_M2 }))).not.toThrow();
    for (const medianPrixM2 of [MIN_MEDIAN_PRIX_M2 - 1, MAX_MEDIAN_PRIX_M2 + 1, null]) {
      expect(refus(sain({ medianPrixM2 })).message).toMatch(/Médiane/);
    }
  });

  it("invalides ≤ 0,1 % : seuil inclus, au-delà refusé", () => {
    const lignesLues = 1_000_000;
    const seuil = lignesLues * MAX_INVALID_RATE;
    expect(() => validateDvfAggregate(sain({ lignesLues, invalides: seuil }))).not.toThrow();
    expect(refus(sain({ lignesLues, invalides: seuil + 1 })).message).toMatch(/invalides/);
  });

  it("sans coordonnées ≤ 15 % : seuil inclus, au-delà refusé", () => {
    const lignesLues = 1_000_000;
    const seuil = lignesLues * MAX_NO_COORDS_RATE;
    expect(() => validateDvfAggregate(sain({ lignesLues, sansCoords: seuil }))).not.toThrow();
    expect(refus(sain({ lignesLues, sansCoords: seuil + 1 })).message).toMatch(/coordonnées/);
  });

  it("aucune ligne lue : refus", () => {
    expect(refus(sain({ lignesLues: 0 })).message).toMatch(/Aucune ligne/);
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
    expect(assertDvfStagingCount(1_609_828, 1_609_828)).toBe(1_609_828);
    expect(assertDvfStagingCount("1609828", 1_609_828)).toBe(1_609_828);
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

  const EXTRA = ["adresse_nom_voie", "code_postal"];
  const header = [...DVF_COLUMNS, ...EXTRA].join(",");
  const line = (id: string) =>
    `${id},2026-03-15,Vente,100000,94076,Appartement,50,,2.36,48.79,"RUE, AVEC VIRGULE",94800`;

  const writeGz = (name: string, content: Buffer | string): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === "string" ? gzipSync(content) : content);
    return path;
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
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = writeGz("entete.csv.gz", "id_mutation,date_mutation\n");
    const err = await collect(streamDvfCsvGz(path)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).phase).toBe("pre_validate");
    expect((err as IngestError).message).toContain("valeur_fonciere");
    spy.mockRestore();
  });

  it("un gzip réellement tronqué fait échouer la lecture, jamais un jeu partiel", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const lines = Array.from({ length: 50_000 }, (_, i) => line(`id-${i}-${i * 7919}`)).join("\n");
    const gz = gzipSync(`${header}\n${lines}\n`);
    const path = writeGz("tronque.csv.gz", gz.subarray(0, Math.floor(gz.length * 0.6)));
    const err = await collect(streamDvfCsvGz(path)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).phase).toBe("pre_validate");
    expect((err as IngestError).message).toMatch(/tronque\.csv\.gz.*unexpected end of file/);
    spy.mockRestore();
  });

  it("le même gzip tronqué fait échouer une agrégation, y compris sur le 2e fichier", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const lines = Array.from({ length: 50_000 }, (_, i) => line(`id-${i}-${i * 7919}`)).join("\n");
    const gz = gzipSync(`${header}\n${lines}\n`);
    const entier = writeGz("entier.csv.gz", gz);
    const tronque = writeGz("tronque2.csv.gz", gz.subarray(0, gz.length - 100));
    await expect(aggregateDvfRecords(streamDvfFiles([entier, tronque]))).rejects.toThrow(
      /tronque2\.csv\.gz/,
    );
    spy.mockRestore();
  });

  it("un fichier qui n'est pas du gzip échoue aussi", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = writeGz("html.csv.gz", Buffer.from("<html>maintenance</html>"));
    await expect(collect(streamDvfCsvGz(path))).rejects.toBeInstanceOf(IngestError);
    spy.mockRestore();
  });

  it("une ligne au nombre de colonnes incohérent fait échouer la lecture", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = writeGz("colonnes.csv.gz", `${header}\n${line("a")}\na,b,c\n`);
    await expect(collect(streamDvfCsvGz(path))).rejects.toBeInstanceOf(IngestError);
    spy.mockRestore();
  });

  it("arrêter la lecture en cours de route ne laisse aucune rejection flottante", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = writeGz("arret.csv.gz", `${header}\n${line("a")}\n${line("b")}\n`);
    for await (const _ of streamDvfCsvGz(path)) break;
    await new Promise((r) => setTimeout(r, 20));
    spy.mockRestore();
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
    const queue = [repoFile("scripts/ingest/dvf-parse.ts")];
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
