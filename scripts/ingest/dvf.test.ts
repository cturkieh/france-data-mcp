import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestLogEntry } from "./shared.js";

// Séquence de `main()` : ce qui doit arriver, et surtout ce qui ne doit JAMAIS arriver
// (swap sans contrôle du compte, ligne `success` d'un dry-run). Réseau, base et fichiers
// sont simulés ; le compte de la staging et la sélection des fichiers restent les vrais.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  stagingCount: 4_500 as unknown,
  lastChecksum: null as string | null,
  lastMonth: "2026-06",
  validationError: null as Error | null,
  latestProdDate: "2026-06-30" as unknown,
  latestProdError: null as { message: string } | null,
  successLogs: [] as unknown[],
  failureLogs: [] as unknown[],
}));

vi.mock("./load-env.js", () => ({}));

vi.mock("../../src/core/http.js", async (original) => ({
  ...(await original<typeof import("../../src/core/http.js")>()),
  fetchJson: vi.fn(async () => ({
    resources: [
      { url: "https://x.test/a/full-2025.csv.gz", checksum: { value: "aaa" } },
      { url: "https://x.test/b/full-2026-s1.csv.gz", checksum: { value: "bbb" } },
      { url: "https://x.test/c/dvf.csv.gz", checksum: { value: "ccc" } },
    ],
  })),
}));

vi.mock("./dvf-parse.js", async (original) => ({
  ...(await original<typeof import("./dvf-parse.js")>()),
  streamDvfFiles: vi.fn(() => []),
  aggregateDvfRecords: vi.fn(async () => ({
    rows: Array.from({ length: 4_500 }, (_, i) => ({ id_mutation: String(i) })),
    lignesLues: 10_000,
    sansCoords: 0,
    sansDate: 0,
    invalides: 0,
    inutiles: 0,
    doublons: 0,
    horsFenetre: 0,
    lastMonth: h.lastMonth,
    rowsByMonth: new Map(),
    rowsByCommune: new Map(),
    avecPrix: 0,
    avecTerrain: 0,
    dansCadreMetropole: 0,
    medianPrixM2: 2650,
  })),
  validateDvfAggregate: vi.fn(() => {
    h.calls.push("validate");
    if (h.validationError) throw h.validationError;
  }),
}));

vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  getLastSuccessChecksum: vi.fn(async () => h.lastChecksum),
  shortCircuitIfSameChecksum: vi.fn(
    async (
      log: IngestLogEntry,
      last: string | null,
      current: string,
      _t: string,
      force: boolean,
    ) => {
      h.calls.push("shortCircuit");
      if (force) {
        log.forced = true;
        return false;
      }
      return last === current;
    },
  ),
  downloadCsv: vi.fn(async (_url: string, name: string) => {
    h.calls.push(`download:${name}`);
    return { filePath: `/tmp/${name}`, sizeBytes: 100, url: _url, sha256: "x" };
  }),
  preValidateFile: vi.fn(async () => {}),
  getUntypedServiceClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string) => {
      h.calls.push(`rpc:${name}`);
      if (name === "ingest_dvf_latest_date") {
        return { data: h.latestProdDate, error: h.latestProdError };
      }
      return {
        data: name === "ingest_analyze_dvf_mutations_staging" ? h.stagingCount : null,
        error: null,
      };
    }),
  })),
  insertStagingBatchWithRetry: vi.fn(async (_c: unknown, table: string, batch: unknown[]) => {
    h.calls.push(`insert:${table}:${batch.length}`);
  }),
  atomicSwapTables: vi.fn(async (input: { prodTable: string }) => {
    h.calls.push(`swap:${input.prodTable}`);
  }),
  runAndRecordCanary: vi.fn(async () => {
    h.calls.push("canary");
  }),
  writeIngestLogSuccessSafe: vi.fn(async (log: unknown) => {
    h.successLogs.push({ ...(log as object) });
  }),
  writeIngestLogFailureFallback: vi.fn(async (log: unknown) => {
    h.failureLogs.push({ ...(log as object) });
  }),
}));

const { main } = await import("./dvf.js");
const { dvfDeliverySignature } = await import("./dvf-parse.js");

const SIGNATURE = dvfDeliverySignature([
  { url: "https://x.test/a/full-2025.csv.gz", checksum: "aaa" },
  { url: "https://x.test/b/full-2026-s1.csv.gz", checksum: "bbb" },
]);

let exitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
  h.calls.length = 0;
  h.successLogs.length = 0;
  h.failureLogs.length = 0;
  h.stagingCount = 4_500;
  h.lastChecksum = null;
  h.lastMonth = "2026-06";
  h.validationError = null;
  h.latestProdDate = "2026-06-30";
  h.latestProdError = null;
  vi.stubEnv("DVF_DRY_RUN", "");
  vi.stubEnv("FORCE_REINGEST", "");
  vi.stubEnv("GITHUB_EVENT_NAME", "");
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  // La pause de 2 s après la création de la staging.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as never);
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T05:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const swapped = () => h.calls.some((c) => c.startsWith("swap:"));
const downloaded = () => h.calls.some((c) => c.startsWith("download:"));
const dbWrites = () =>
  h.calls.filter(
    (c) => (c.startsWith("rpc:") && c !== "rpc:ingest_dvf_latest_date") || c.startsWith("insert:"),
  );

describe("main : chemin nominal", () => {
  it("enchaîne téléchargement, gardes, staging, compte, swap, canari, journal", async () => {
    await main();
    expect(h.calls).toEqual([
      "shortCircuit",
      "download:full-2025.csv.gz",
      "download:full-2026-s1.csv.gz",
      "validate",
      "rpc:ingest_dvf_latest_date",
      "rpc:ingest_create_dvf_mutations_staging",
      "insert:dvf_mutations_staging:2000",
      "insert:dvf_mutations_staging:2000",
      "insert:dvf_mutations_staging:500",
      "rpc:ingest_analyze_dvf_mutations_staging",
      "swap:dvf_mutations",
      "canary",
    ]);
    expect(h.successLogs).toHaveLength(1);
    expect(h.successLogs[0]).toMatchObject({
      source: "dvf",
      status: "success",
      row_count: 4_500,
      csv_sha256: SIGNATURE,
      csv_size_bytes: 200,
      csv_url: "https://x.test/a/full-2025.csv.gz https://x.test/b/full-2026-s1.csv.gz",
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("la validation reçoit le fichier le plus récent et l'horloge du run", async () => {
    const { validateDvfAggregate } = await import("./dvf-parse.js");
    await main();
    expect(validateDvfAggregate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        newestFile: expect.objectContaining({ year: 2026, semester: 1 }),
        now: new Date("2026-11-12T05:00:00Z"),
      }),
    );
  });

  it("table prod vide (premier chargement) : pas de garde de recul", async () => {
    h.latestProdDate = null;
    await main();
    expect(swapped()).toBe(true);
  });

  it("source tarie : swap fait, run `partial`, raison dans le journal", async () => {
    h.latestProdDate = "2025-06-30";
    h.lastMonth = "2025-06";
    await main();
    expect(swapped()).toBe(true);
    expect(h.successLogs[0]).toMatchObject({ status: "partial" });
    expect((h.successLogs[0] as IngestLogEntry).error_message).toMatch(/source tarie/);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("main : court-circuit sur la signature de livraison", () => {
  it("livraison inchangée : aucun téléchargement, aucune écriture", async () => {
    h.lastChecksum = SIGNATURE;
    await main();
    expect(h.calls).toEqual(["shortCircuit"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("FORCE_REINGEST contourne le court-circuit et le marque", async () => {
    h.lastChecksum = SIGNATURE;
    vi.stubEnv("FORCE_REINGEST", "1");
    await main();
    expect(downloaded()).toBe(true);
    expect(swapped()).toBe(true);
    expect(h.successLogs[0]).toMatchObject({ forced: true });
  });
});

describe("main : le swap est refusé", () => {
  it("compte de la staging différent : lot dupliqué, pas de swap, run `failed`", async () => {
    h.stagingCount = 6_500;
    await main();
    expect(h.calls).toContain("rpc:ingest_analyze_dvf_mutations_staging");
    expect(swapped()).toBe(false);
    expect(h.successLogs).toEqual([]);
    expect(h.failureLogs[0]).toMatchObject({ status: "failed", error_phase: "validate" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("le compte en string (BIGINT PostgREST) est accepté", async () => {
    h.stagingCount = "4500";
    await main();
    expect(swapped()).toBe(true);
  });

  it("livraison qui recule : aucune écriture, pas de swap, run `failed`", async () => {
    h.lastMonth = "2025-12";
    await main();
    expect(dbWrites()).toEqual([]);
    expect(swapped()).toBe(false);
    expect(h.failureLogs[0]).toMatchObject({ status: "failed", error_phase: "validate" });
    expect((h.failureLogs[0] as IngestLogEntry).error_message).toMatch(/recul/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("FORCE_REINGEST ne contourne pas la garde de recul", async () => {
    h.lastMonth = "2025-12";
    vi.stubEnv("FORCE_REINGEST", "1");
    await main();
    expect(swapped()).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("lecture de la prod en erreur : échec visible, pas de contournement", async () => {
    h.latestProdError = { message: "canceling statement due to statement timeout" };
    await main();
    expect(dbWrites()).toEqual([]);
    expect(swapped()).toBe(false);
    expect((h.failureLogs[0] as IngestLogEntry).error_message).toMatch(/statement timeout/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("garde en échec : la base n'est même pas touchée", async () => {
    const { IngestError } = await import("./ingest-error.js");
    h.validationError = new IngestError("validate", "médiane hors bande");
    await main();
    expect(dbWrites()).toEqual([]);
    expect(swapped()).toBe(false);
    expect(h.failureLogs[0]).toMatchObject({ error_message: "médiane hors bande" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("main : dry-run", () => {
  beforeEach(() => vi.stubEnv("DVF_DRY_RUN", "1"));

  it("va jusqu'au compte, sans swap, sans canari, sans aucune ligne de journal", async () => {
    await main();
    expect(h.calls).toContain("rpc:ingest_analyze_dvf_mutations_staging");
    expect(swapped()).toBe(false);
    expect(h.calls).not.toContain("canary");
    expect(h.successLogs).toEqual([]);
    expect(h.failureLogs).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("ignore le court-circuit, qui écrirait une ligne `success`", async () => {
    h.lastChecksum = SIGNATURE;
    await main();
    expect(h.calls).not.toContain("shortCircuit");
    expect(downloaded()).toBe(true);
    expect(h.successLogs).toEqual([]);
  });

  it("en échec : `exit 1` et stderr, mais aucune ligne de journal", async () => {
    h.stagingCount = 1;
    await main();
    expect(h.failureLogs).toEqual([]);
    expect(h.successLogs).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/DRY RUN FAILED at validate/));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("source tarie : le verdict sort en `::warning::` avant la fin", async () => {
    // Prod vide : un `lastMonth` ancien ne déclenche pas la garde de recul.
    h.latestProdDate = null;
    h.lastMonth = "2025-06";
    await main();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::.*source tarie/));
    expect(swapped()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("source à jour : aucun `::warning::`", async () => {
    await main();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/^::warning::/));
  });

  it("livraison qui recule : le dry-run échoue aussi, avant d'écrire la staging", async () => {
    h.lastMonth = "2025-12";
    await main();
    expect(dbWrites()).toEqual([]);
    expect(h.failureLogs).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("refusé sur un `schedule`, avant tout téléchargement", async () => {
    vi.stubEnv("GITHUB_EVENT_NAME", "schedule");
    await main();
    expect(h.calls).toEqual([]);
    expect(h.failureLogs).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
