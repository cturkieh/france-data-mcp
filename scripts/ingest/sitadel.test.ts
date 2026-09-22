import { describe, expect, it } from "vitest";
import { IngestError } from "./shared.js";
import {
  type SitadelAggregate,
  aggregateSitadelRecords,
  buildSitadelUrl,
  staleSeriesReason,
  validateSitadelAggregate,
} from "./sitadel.js";

function rec(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    ANNEE: "2025",
    MOIS: "01",
    CODE_INSEE: "94076",
    TYPE_LGT: "Tous Logements",
    LOG_AUT: "10",
    LOG_COM: "4",
    SDP_AUT: "0",
    SDP_COM: "0",
    ...overrides,
  };
}

describe("buildSitadelUrl", () => {
  it("filtre côté serveur : « Tous Logements » + une année de PLUS que la fenêtre stockée", () => {
    const url = new URL(buildSitadelUrl(2026));
    expect(url.searchParams.get("TYPE_LGT")).toBe("eq:Tous Logements");
    expect(url.searchParams.get("ANNEE")).toBe("gte:2020");
    expect(url.searchParams.get("withColumnName")).toBe("true");
  });
});

describe("aggregateSitadelRecords", () => {
  it("somme les mois par (commune, année) et compte les mois DISTINCTS", async () => {
    const agg = await aggregateSitadelRecords([
      rec({ MOIS: "01", LOG_AUT: "10", LOG_COM: "4" }),
      rec({ MOIS: "02", LOG_AUT: "5", LOG_COM: "1" }),
      rec({ ANNEE: "2026", MOIS: "07", LOG_AUT: "3", LOG_COM: "0" }),
      rec({ CODE_INSEE: "2A004", MOIS: "03", LOG_AUT: "7", LOG_COM: "2" }),
    ]);

    expect(agg.rows).toEqual([
      { code_insee: "2A004", annee: 2025, log_aut: 7, log_com: 2, mois_couverts: 1 },
      { code_insee: "94076", annee: 2025, log_aut: 15, log_com: 5, mois_couverts: 2 },
      { code_insee: "94076", annee: 2026, log_aut: 3, log_com: 0, mois_couverts: 1 },
    ]);
    expect(agg.communes).toBe(2);
    expect(agg.lastMonth).toEqual({ annee: 2026, mois: 7 });
    expect(agg.nationalAutByYear.get(2025)).toBe(22);
  });

  it("mois en double (commune fusionnée, réel : 71042) → SOMMÉ comme l'appel live, compté, 1 mois distinct", async () => {
    const agg = await aggregateSitadelRecords([
      rec({ CODE_INSEE: "71042", LOG_AUT: "2", LOG_COM: "1" }),
      rec({ CODE_INSEE: "71042", LOG_AUT: "3", LOG_COM: "0" }),
    ]);

    expect(agg.rows).toEqual([
      { code_insee: "71042", annee: 2025, log_aut: 5, log_com: 1, mois_couverts: 1 },
    ]);
    expect(agg.duplicateMonths).toBe(1);
  });

  it("conserve une commune à zéro (0 logement ≠ commune absente)", async () => {
    const agg = await aggregateSitadelRecords([rec({ LOG_AUT: "0", LOG_COM: "0" })]);
    expect(agg.rows).toHaveLength(1);
    expect(agg.rows[0]?.log_aut).toBe(0);
  });

  it("écarte un sous-type SANS le sommer (double-comptage) et le compte", async () => {
    const agg = await aggregateSitadelRecords([
      rec(),
      rec({ TYPE_LGT: "Collectif", LOG_AUT: "999" }),
    ]);
    expect(agg.skippedOtherType).toBe(1);
    expect(agg.rows[0]?.log_aut).toBe(10);
  });

  it.each([
    ["code INSEE invalide", { CODE_INSEE: "9407" }],
    ["mois hors bornes", { MOIS: "13" }],
    ["compte négatif", { LOG_AUT: "-1" }],
    ["compte non numérique (secret stat)", { LOG_COM: "s" }],
    ["année illisible", { ANNEE: "20x5" }],
    ['année vide (Number("") vaut 0)', { ANNEE: "" }],
  ])("ligne illisible (%s) → comptée, jamais agrégée", async (_label, overrides) => {
    const agg = await aggregateSitadelRecords([rec(overrides)]);
    expect(agg.skippedInvalid).toBe(1);
    expect(agg.rows).toHaveLength(0);
  });
});

describe("aggregateSitadelRecords — fenêtre ancrée sur la donnée, pas sur l'horloge", () => {
  /** Flux amont : 4 communes × 12 mois, de `from` à `to` inclus (`toMonth` = dernier mois publié). */
  function feed(from: number, to: number, toMonth: number): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    for (const insee of ["94076", "33063", "2A004", "59350"]) {
      for (let a = from; a <= to; a++) {
        for (let m = 1; m <= (a === to ? toMonth : 12); m++) {
          out.push(rec({ CODE_INSEE: insee, ANNEE: String(a), MOIS: String(m).padStart(2, "0") }));
        }
      }
    }
    return out;
  }
  const labels = (agg: SitadelAggregate) => [...new Set(agg.rows.map((r) => r.annee))].sort();

  it("cron du 10 décembre 2026 et du 10 janvier 2027 → MÊMES années stockées (sinon −17 % de lignes, swap refusé 2 mois/an)", async () => {
    // Décembre : URL gte:2020, dernier mois publié = octobre 2026.
    const decembre = await aggregateSitadelRecords(feed(2020, 2026, 10));
    // Janvier : URL gte:2021, 2027 PAS encore publié, dernier mois = novembre 2026.
    const janvier = await aggregateSitadelRecords(feed(2021, 2026, 11));

    expect(labels(decembre)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(labels(janvier)).toEqual(labels(decembre));
    expect(janvier.rows).toHaveLength(decembre.rows.length);
    expect(decembre.outOfWindowRows).toBe(4); // 2020, demandée en marge, non stockée
  });

  it("mars 2027 : janvier 2027 publié → la fenêtre glisse d'un cran (2022-2027)", async () => {
    const mars = await aggregateSitadelRecords(feed(2021, 2027, 1));
    expect(labels(mars)).toEqual([2022, 2023, 2024, 2025, 2026, 2027]);
    expect(mars.lastMonth).toEqual({ annee: 2027, mois: 1 });
  });

  it("UNE ligne mal datée (ANNEE=2030) ne déplace ni lastMonth ni la fenêtre, et n'est pas stockée", async () => {
    const agg = await aggregateSitadelRecords([
      ...feed(2021, 2026, 7),
      rec({ ANNEE: "2030", MOIS: "03" }),
    ]);
    expect(agg.lastMonth).toEqual({ annee: 2026, mois: 7 });
    expect(labels(agg)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(agg.outOfWindowRows).toBe(1);
  });
});

describe("validateSitadelAggregate", () => {
  const NOW = new Date("2026-09-21T00:00:00Z");

  /** Forme saine = chiffres MESURÉS le 2026-09-21. */
  function healthy(overrides: Partial<SitadelAggregate> = {}): SitadelAggregate {
    return {
      rows: [],
      rawRows: 2_342_479,
      skippedOtherType: 0,
      skippedInvalid: 0,
      duplicateMonths: 504,
      communes: 34_969,
      lastMonth: { annee: 2026, mois: 7 },
      outOfWindowRows: 0,
      nationalAutByYear: new Map([
        [2024, 336_671],
        [2025, 369_963],
        [2026, 211_447],
      ]),
      ...overrides,
    };
  }

  it("accepte la forme mesurée en prod (dernier mois = juillet, lu en septembre)", () => {
    expect(() => validateSitadelAggregate(healthy())).not.toThrow();
  });

  it("n'applique PAS la bande nationale à l'année en cours (partielle par nature)", () => {
    const agg = healthy({ nationalAutByYear: new Map([[2026, 12]]) });
    expect(() => validateSitadelAggregate(agg)).not.toThrow();
  });

  it.each([
    ["réponse vide", { rawRows: 0 }, /Aucune ligne lue/],
    ["filtre serveur inopérant", { skippedOtherType: 5 }, /filtre serveur DiDo/],
    ["trop de lignes illisibles", { skippedInvalid: 5_000 }, /lignes illisibles/],
    [
      "série republiée en double (aucune autre bande ne bouge)",
      { duplicateMonths: 2_342_479, nationalAutByYear: new Map([[2025, 739_926]]) },
      /série republiée en double/,
    ],
    ["fichier amputé", { communes: 20_000 }, /communes hors/],
    ["maille changée", { communes: 50_000 }, /communes hors/],
    [
      "double-comptage des sous-types",
      { nationalAutByYear: new Map([[2025, 1_500_000]]) },
      /hors \[150000, 900000\]/,
    ],
  ])("refuse le swap : %s", (_label, overrides, pattern) => {
    const agg = healthy(overrides as Partial<SitadelAggregate>);
    expect(() => validateSitadelAggregate(agg)).toThrow(IngestError);
    expect(() => validateSitadelAggregate(agg)).toThrow(pattern);
  });

  it("refuse le swap : années pleines amputées de mois (sous-comptage silencieux)", () => {
    const rows = [
      { code_insee: "94076", annee: 2025, log_aut: 300, log_com: 200, mois_couverts: 10 },
      { code_insee: "33063", annee: 2025, log_aut: 900, log_com: 500, mois_couverts: 12 },
    ];
    expect(() => validateSitadelAggregate(healthy({ rows }))).toThrow(/sans leurs 12 mois/);
  });

  it("l'année en cours, partielle par nature, n'est pas jugée sur ses 12 mois", () => {
    const rows = [
      { code_insee: "94076", annee: 2026, log_aut: 68, log_com: 126, mois_couverts: 7 },
    ];
    expect(() => validateSitadelAggregate(healthy({ rows }))).not.toThrow();
  });

  it("source tarie : 4 mois de retard = dans la cadence, 5 = raison rendue (→ partial, swap fait)", () => {
    expect(staleSeriesReason({ annee: 2026, mois: 7 }, NOW)).toBeNull();
    expect(staleSeriesReason({ annee: 2026, mois: 5 }, NOW)).toBeNull();
    expect(staleSeriesReason({ annee: 2026, mois: 4 }, NOW)).toMatch(
      /source tarie .*2026-04 = 5 mois de retard/,
    );
  });

  it("source tarie : le retard enjambe le changement d'année", () => {
    const janvier = new Date("2027-01-10T05:00:00Z");
    // Novembre 2026 lu le 10 janvier = 2 mois : cadence normale.
    expect(staleSeriesReason({ annee: 2026, mois: 11 }, janvier)).toBeNull();
    expect(staleSeriesReason({ annee: 2026, mois: 7 }, janvier)).toMatch(/6 mois de retard/);
  });

  it("une série figée NE bloque PAS le swap (les révisions des mois passés sont publiées)", () => {
    expect(() =>
      validateSitadelAggregate(healthy({ lastMonth: { annee: 2026, mois: 1 } })),
    ).not.toThrow();
  });
});
