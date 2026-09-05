import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  GZIP_MAGIC,
  IngestError,
  type IngestLogEntry,
  type PreValidateConfig,
  ROW_BAND_MAX_RATIO,
  ROW_BAND_MIN_RATIO,
  type RowCountReference,
  SEVENZIP_MAGIC,
  ZIP_MAGIC,
  assertStagingRowBand,
  getLastRealIngestRowCount,
  getNonEmpty,
  insertStagingBatchWithRetry,
  isForceReingestEnv,
  parseDropStalePreviousOutcome,
  preValidateFile,
  runBatchedRpc,
  runKeysetRpc,
  shortCircuitIfSameChecksum,
  writeGithubOutput,
  writeIngestLog,
  writeIngestLogFailureFallback,
  writeIngestLogSuccessSafe,
} from "./shared.js";

/**
 * Faux client Supabase minimal : `from(table).insert(rows)` renvoie l'erreur
 * programmée pour le n-ième appel (ou null = succès).
 */
function fakeSupabase(errorsByAttempt: Array<{ code?: string; message: string } | null>) {
  const insert = vi.fn(async () => {
    const err = errorsByAttempt.shift() ?? null;
    return { error: err };
  });
  return {
    client: { from: vi.fn(() => ({ insert })) } as never,
    insert,
  };
}

function tempFileWith(content: string): string {
  const file = path.join(
    os.tmpdir(),
    `ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`,
  );
  fs.writeFileSync(file, content);
  return file;
}

describe("preValidateFile", () => {
  const baseConfig: PreValidateConfig = {
    minSizeBytes: 100,
    expectedHeaderColumns: ["num_finess", "raison_sociale"],
    delimiter: ";",
  };

  it("passes when size and headers match", async () => {
    const file = tempFileWith(
      `num_finess;raison_sociale\n080000017;CH Charleville\n${"x".repeat(200)}`,
    );
    await expect(preValidateFile(file, baseConfig)).resolves.toBeUndefined();
  });

  it("minSizeBytes invalide (0, négatif, NaN) → IngestError, jamais un contrôle éteint en silence", async () => {
    const file = tempFileWith(`num_finess;raison_sociale\n${"x".repeat(200)}`);
    for (const minSizeBytes of [0, -1, Number.NaN, 1.5]) {
      await expect(preValidateFile(file, { ...baseConfig, minSizeBytes })).rejects.toMatchObject({
        phase: "pre_validate",
        message: expect.stringContaining("minSizeBytes invalide"),
      });
    }
  });

  it("throws IngestError(phase=pre_validate) when file too small", async () => {
    const file = tempFileWith("tiny");
    await expect(preValidateFile(file, baseConfig)).rejects.toMatchObject({
      phase: "pre_validate",
      message: expect.stringContaining("size"),
    });
  });

  it("throws IngestError(phase=pre_validate) when headers missing", async () => {
    const file = tempFileWith(`wrong;cols\n${"x".repeat(200)}`);
    await expect(preValidateFile(file, baseConfig)).rejects.toMatchObject({
      phase: "pre_validate",
      message: expect.stringContaining("header"),
    });
  });

  // Variante binaire (flux FINESS ANS, JSON.gz) : signature au lieu d'en-tête.
  const gzConfig: PreValidateConfig = { minSizeBytes: 1, magicBytes: GZIP_MAGIC };
  const binFile = (content: Buffer): string => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prevalidate-gz-")), "f.json.gz");
    fs.writeFileSync(p, content);
    return p;
  };

  it("magicBytes : accepte un gzip (1f 8b) sans contrôle d'en-tête CSV", async () => {
    const file = binFile(gzipSync(Buffer.from('{"pmej":[]}')));
    await expect(preValidateFile(file, gzConfig)).resolves.toBeUndefined();
  });

  it("magicBytes : la taille minimale s'applique aussi au binaire", async () => {
    const file = binFile(gzipSync(Buffer.from("{}")));
    await expect(
      preValidateFile(file, { minSizeBytes: 10_000, magicBytes: GZIP_MAGIC }),
    ).rejects.toMatchObject({ phase: "pre_validate", message: expect.stringContaining("size") });
  });

  it("magicBytes : rejette un contenu non-gzip même gros (page HTML de maintenance en 200)", async () => {
    const file = binFile(Buffer.from(`<!doctype html>${"x".repeat(5000)}`));
    await expect(preValidateFile(file, gzConfig)).rejects.toMatchObject({
      phase: "pre_validate",
      message: expect.stringContaining("signature"),
    });
  });

  // Archives IRIS (backlog phase 2 item 6) : `.7z` IGN et `.zip` INSEE. Les
  // signatures sont celles des formats (7z : 37 7A BC AF 27 1C ; zip local
  // file header : 50 4B 03 04) — un test qui les recopierait depuis la
  // constante ne prouverait rien, elles sont écrites ici en dur.
  it("SEVENZIP_MAGIC / ZIP_MAGIC : valeurs des formats, acceptées par preValidateFile", async () => {
    expect([...SEVENZIP_MAGIC]).toEqual([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    expect([...ZIP_MAGIC]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const sevenZip = binFile(Buffer.concat([Buffer.from(SEVENZIP_MAGIC), Buffer.alloc(64)]));
    await expect(
      preValidateFile(sevenZip, { minSizeBytes: 1, magicBytes: SEVENZIP_MAGIC }),
    ).resolves.toBeUndefined();
    const zip = binFile(Buffer.concat([Buffer.from(ZIP_MAGIC), Buffer.alloc(64)]));
    await expect(
      preValidateFile(zip, { minSizeBytes: 1, magicBytes: ZIP_MAGIC }),
    ).resolves.toBeUndefined();
  });

  it("archive IRIS : une page de maintenance de 2 Mo en 200 passe la taille mais PAS la signature, et le label nomme le fichier", async () => {
    const file = binFile(
      Buffer.from(`<!doctype html><title>Maintenance</title>${"x".repeat(2_000_000)}`),
    );
    await expect(
      preValidateFile(file, {
        minSizeBytes: 300_000,
        magicBytes: SEVENZIP_MAGIC,
        label: "contours .7z",
      }),
    ).rejects.toMatchObject({
      phase: "pre_validate",
      message: expect.stringMatching(/^contours \.7z: file signature 3c21646f6374 does not match/),
    });
  });

  it("label absent → le nom du fichier préfixe le message (taille et en-tête)", async () => {
    const file = tempFileWith("tiny");
    await expect(preValidateFile(file, baseConfig)).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`^${path.basename(file)}: file size`)),
    });
  });
});

describe("bande de volume relative à la dernière ingestion réelle (backlog FINESS phase 2 item 5)", () => {
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});
  const known = (rows: number): RowCountReference => ({ kind: "known", rows });

  it("bande [0,9 ; 1,3] — commune aux sources, jamais une constante absolue", () => {
    expect([ROW_BAND_MIN_RATIO, ROW_BAND_MAX_RATIO]).toEqual([0.9, 1.3]);
  });

  it("troncature Ameli : 400 K lignes pour 485 K réels passe MIN_ROWS=400 K mais PAS la bande", () => {
    // Le cas exact du backlog : plancher absolu 400 K, réel ~485 K → −85 K PS
    // perdus en silence. La bande à 0,9 refuse (82,5 %).
    expect(() => assertStagingRowBand(400_000, known(485_000), "ameli")).toThrow(
      expect.objectContaining({
        phase: "validate",
        message: expect.stringMatching(
          /82\.5% of the last real ingestion \(485000\) — below 0\.9 band/,
        ),
      }),
    );
  });

  it("troncature RPPS : 2,0 M pour 2,28 M réels (−230 K) est refusée ; croissance +0,7 %/mois acceptée", () => {
    const log = quiet();
    try {
      expect(() => assertStagingRowBand(2_000_000, known(2_280_000), "rpps")).toThrow(IngestError);
      expect(() => assertStagingRowBand(2_296_000, known(2_280_000), "rpps")).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("plafond : +30 % = dénormalisation amont, refusé ; juste en dessous accepté", () => {
    const log = quiet();
    try {
      expect(() => assertStagingRowBand(3_251, known(2_500), "cds")).toThrow(/above 1\.3 band/);
      expect(() => assertStagingRowBand(3_250, known(2_500), "cds")).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("`none` (première ingestion) : warn simple, aucun refus — jamais un faux refus au 1er run", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = quiet();
    try {
      expect(() => assertStagingRowBand(10, { kind: "none" }, "cds")).not.toThrow();
      expect(warn.mock.calls[0]?.[0]).toMatch(/^\[cds\] aucune ingestion réelle antérieure/);
      // Pas d'annotation GitHub : c'est normal, pas une dégradation.
      expect(log.mock.calls.some((c) => String(c[0]).startsWith("::warning::"))).toBe(false);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("`unavailable` (ingest_log illisible) : garde DÉSACTIVÉ → warn + annotation ::warning:: nommant la raison", () => {
    // « pas de résultat » ≠ « erreur » : ici le garde anti-troncature ne tourne
    // pas sur ce run, ce doit être visible sur la page du run, pas dans 50 000
    // lignes de log.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = quiet();
    try {
      expect(() =>
        assertStagingRowBand(10, { kind: "unavailable", reason: "boom" }, "rpps"),
      ).not.toThrow();
      expect(warn.mock.calls[0]?.[0]).toMatch(
        /INDISPONIBLE \(boom\) — bande relative NON vérifiée/,
      );
      expect(log.mock.calls[0]?.[0]).toMatch(
        /^::warning::\[rpps\] référence de volume INDISPONIBLE/,
      );
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("dans la bande : log info avec le ratio, pas de throw", () => {
    const log = quiet();
    try {
      expect(() => assertStagingRowBand(485_000, known(480_000), "ameli")).not.toThrow();
      expect(log.mock.calls[0]?.[0]).toMatch(
        /^\[ameli\] volume vs dernière ingestion réelle : 485000\/480000 \(101\.0%\)/,
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe("writeGithubOutput — encodeur UNIQUE de $GITHUB_OUTPUT (heredoc, délimiteur aléatoire)", () => {
  it("écrit chaque clé en heredoc au délimiteur aléatoire par appel ; une valeur multi-ligne reste intacte", () => {
    const out = tempFileWith("");
    vi.stubEnv("GITHUB_OUTPUT", out);
    try {
      writeGithubOutput("t", { should_notify: "true", body: "ligne 1\n\nligne 3" });
      const written = fs.readFileSync(out, "utf8");
      const m =
        /^should_notify<<(__OPS_[0-9a-f-]{36}__)\ntrue\n\1\nbody<<\1\nligne 1\n\nligne 3\n\1\n$/.exec(
          written,
        );
      expect(m, written).not.toBeNull();
      // Un délimiteur FIXE (`__OPS_EOF__`) qu'une valeur venue de la base
      // contiendrait fermerait le heredoc et injecterait des outputs.
      expect(written).not.toContain("__OPS_EOF__");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("GITHUB_OUTPUT absent → warn préfixé, rien d'écrit, pas de throw (run local)", () => {
    vi.stubEnv("GITHUB_OUTPUT", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => writeGithubOutput("notify-x", { a: "1" })).not.toThrow();
      expect(warn.mock.calls[0]?.[0]).toMatch(/^\[notify-x\] GITHUB_OUTPUT absent/);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("écriture impossible → ::error:: (le canal de sortie est mort, l'annotation est le seul repli)", () => {
    vi.stubEnv("GITHUB_OUTPUT", path.join(os.tmpdir(), "inexistant-dir-xyz", "out.txt"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => writeGithubOutput("t", { a: "1" })).not.toThrow();
      expect(log.mock.calls[0]?.[0]).toMatch(/^::error::\[t\] écriture \$GITHUB_OUTPUT échouée/);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("getLastRealIngestRowCount — référence prod pour la bande (résultat DISCRIMINÉ)", () => {
  /** Faux client : capture la chaîne de filtres, renvoie `result` au `limit`. */
  function fakeIngestLog(result: { data?: unknown; error?: { message: string } | null }) {
    const calls: Array<[string, unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "order"]) {
      chain[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return chain;
      };
    }
    chain.limit = async (...args: unknown[]) => {
      calls.push(["limit", args]);
      return { data: result.data ?? null, error: result.error ?? null };
    };
    return { client: { from: vi.fn(() => chain) } as never, calls };
  }

  it("`known` : filtres load-bearing (ingestion RÉELLE) et coercition par parseRpcCount (string acceptée)", async () => {
    const { client, calls } = fakeIngestLog({ data: [{ row_count: "485123" }] });
    await expect(getLastRealIngestRowCount("ameli_ps", client)).resolves.toEqual({
      kind: "known",
      rows: 485_123,
    });
    // Sinon un skip same_checksum (row_count null) serait la référence.
    expect(calls).toContainEqual(["eq", ["source", "ameli_ps"]]);
    // Statuts = `REAL_INGEST_STATUSES` (règle partagée avec data_freshness).
    expect(calls).toContainEqual(["in", ["status", ["success", "partial"]]]);
    expect(calls).toContainEqual(["is", ["skip_reason", null]]);
    expect(calls).toContainEqual(["not", ["row_count", "is", null]]);
    expect(calls).toContainEqual(["order", ["started_at", { ascending: false }]]);
  });

  it("erreur de lecture → `unavailable` + raison + console.error (jamais un throw : ingestion continue)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client } = fakeIngestLog({ error: { message: "boom" } });
      await expect(getLastRealIngestRowCount("rpps", client)).resolves.toEqual({
        kind: "unavailable",
        reason: "lecture ingest_log échouée: boom",
      });
      expect(error.mock.calls[0]?.[0]).toMatch(
        /getLastRealIngestRowCount\(rpps\) lecture ingest_log échouée: boom/,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("aucune ligne → `none` ; valeur non numérique ou `1e5` → `unavailable` (parseRpcCount, jamais NaN)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        getLastRealIngestRowCount("cds", fakeIngestLog({ data: [] }).client),
      ).resolves.toEqual({ kind: "none" });
      const bad = await getLastRealIngestRowCount(
        "cds",
        fakeIngestLog({ data: [{ row_count: "N/A" }] }).client,
      );
      expect(bad.kind).toBe("unavailable");
      const sci = await getLastRealIngestRowCount(
        "cds",
        fakeIngestLog({ data: [{ row_count: "1e5" }] }).client,
      );
      expect(sci).toMatchObject({
        kind: "unavailable",
        reason: expect.stringMatching(/non-decimal string/),
      });
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("IngestError", () => {
  it("carries phase + cause", () => {
    const cause = new Error("network fail");
    const err = new IngestError("pre_validate", "msg", cause);
    expect(err.phase).toBe("pre_validate");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("msg");
  });
});

describe("getNonEmpty", () => {
  it("returns null for missing or empty values", () => {
    expect(getNonEmpty({}, "x")).toBeNull();
    expect(getNonEmpty({ x: "" }, "x")).toBeNull();
  });

  it("returns the value untouched when no control chars present", () => {
    expect(getNonEmpty({ x: "Hello World" }, "x")).toBe("Hello World");
    expect(getNonEmpty({ x: "Dr DUPONT  Jean" }, "x")).toBe("Dr DUPONT  Jean");
  });

  it("strips ASCII control characters that break JSON serialization", () => {
    // Real cases observed in upstream CSV: \r leftover from Windows line
    // endings inside a quoted cell, \n inside a multi-line raison_sociale.
    expect(getNonEmpty({ x: "AVENUE\rDE PARIS" }, "x")).toBe("AVENUE DE PARIS");
    expect(getNonEmpty({ x: "DR\nDUPONT" }, "x")).toBe("DR DUPONT");
    expect(getNonEmpty({ x: "CABINET\tMEDICAL" }, "x")).toBe("CABINET MEDICAL");
    expect(getNonEmpty({ x: "TEXT\x01CTRL\x1FCHAR" }, "x")).toBe("TEXT CTRL CHAR");
    expect(getNonEmpty({ x: "TEXTCTRL" }, "x")).toBe("TEXT CTRL");
  });

  it("collapses runs of control chars into a single space", () => {
    expect(getNonEmpty({ x: "AVENUE\r\nDE PARIS" }, "x")).toBe("AVENUE DE PARIS");
    expect(getNonEmpty({ x: "A\r\n\r\nB" }, "x")).toBe("A B");
  });

  it("trims surrounding whitespace and returns null when empty after cleanup", () => {
    expect(getNonEmpty({ x: "  spaced  " }, "x")).toBe("spaced");
    expect(getNonEmpty({ x: "\r\n\t" }, "x")).toBeNull();
    expect(getNonEmpty({ x: "   " }, "x")).toBeNull();
  });
});

describe("parseDropStalePreviousOutcome", () => {
  it("parse 'dropped:<table>:<n>d' avec ageDays numeric", () => {
    expect(parseDropStalePreviousOutcome("dropped:rpps_previous:14d")).toEqual({
      kind: "dropped",
      table: "rpps_previous",
      ageDays: 14,
    });
  });

  it("parse 'kept:<table>:<n>d' avec ageDays numeric", () => {
    expect(parseDropStalePreviousOutcome("kept:finess_previous:3d")).toEqual({
      kind: "kept",
      table: "finess_previous",
      ageDays: 3,
    });
  });

  it("parse 'absent:<table>' (pas de previous existant)", () => {
    expect(parseDropStalePreviousOutcome("absent:ameli_ps_previous")).toEqual({
      kind: "absent",
      table: "ameli_ps_previous",
    });
  });

  it("parse 'no_history:<table>' (premier déploiement, aucun ingest_log success)", () => {
    expect(parseDropStalePreviousOutcome("no_history:rpps_previous")).toEqual({
      kind: "no_history",
      table: "rpps_previous",
    });
  });

  it("throw IngestError sur format inattendu (drift contrat SQL)", () => {
    expect(() => parseDropStalePreviousOutcome("unknown_format")).toThrow(IngestError);
    expect(() => parseDropStalePreviousOutcome("")).toThrow(IngestError);
    expect(() => parseDropStalePreviousOutcome("dropped:no_age")).toThrow(IngestError);
    expect(() => parseDropStalePreviousOutcome("dropped:table:nan_d")).toThrow(IngestError);
  });
});

describe("insertStagingBatchWithRetry", () => {
  const row = [{ a: 1 }];

  it("batch vide → aucun appel insert, pas d'erreur", async () => {
    const { client, insert } = fakeSupabase([]);
    await insertStagingBatchWithRetry(client, "t_staging", [], {
      logPrefix: "t",
      isFirstBatch: true,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("succès au 1er essai → 1 seul insert, pas de throw", async () => {
    const { client, insert } = fakeSupabase([null]);
    await insertStagingBatchWithRetry(client, "t_staging", row, {
      logPrefix: "t",
      isFirstBatch: true,
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("erreur non-cache-miss → throw IngestError immédiat (1 essai, cause préservée)", async () => {
    const supaErr = { code: "23505", message: "duplicate key" };
    const { client, insert } = fakeSupabase([supaErr]);
    await expect(
      insertStagingBatchWithRetry(client, "t_staging", row, {
        logPrefix: "t",
        isFirstBatch: true,
      }),
    ).rejects.toMatchObject({ name: "IngestError", phase: "copy", cause: supaErr });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("non-1er-batch ne retry pas, même sur cache-miss (maxAttempts=1)", async () => {
    const { client, insert } = fakeSupabase([{ code: "PGRST205", message: "no cache" }]);
    await expect(
      insertStagingBatchWithRetry(client, "t_staging", row, {
        logPrefix: "t",
        isFirstBatch: false,
      }),
    ).rejects.toThrow(IngestError);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("1er batch : retry sur cache-miss PGRST205 puis succès", async () => {
    vi.useFakeTimers();
    try {
      const { client, insert } = fakeSupabase([{ code: "PGRST205", message: "no cache" }, null]);
      const p = insertStagingBatchWithRetry(client, "t_staging", row, {
        logPrefix: "t",
        isFirstBatch: true,
      });
      await vi.runAllTimersAsync();
      await p;
      expect(insert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("extraCacheMissCodes : PGRST204 (colonne) retryé comme PGRST205 (RPPS)", async () => {
    vi.useFakeTimers();
    try {
      const { client, insert } = fakeSupabase([{ code: "PGRST204", message: "no col" }, null]);
      const p = insertStagingBatchWithRetry(client, "rpps_staging", row, {
        logPrefix: "rpps",
        isFirstBatch: true,
        extraCacheMissCodes: ["PGRST204"],
      });
      await vi.runAllTimersAsync();
      await p;
      expect(insert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runBatchedRpc — borne anti-hang (perCallTimeoutMs)", () => {
  type RbrArgs = Parameters<typeof runBatchedRpc>;

  it("perCallTimeoutMs posé + RPC qui ne résout jamais ⇒ IngestError fail-loud (PAS un hang muet)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = {
      rpc: vi.fn(() => new Promise(() => {})),
    } as unknown as RbrArgs[0];

    await expect(
      runBatchedRpc(supabase, "ingest_apply_rpps_ban_geocoding_batch", {}, 1, 1, 20),
    ).rejects.toMatchObject({
      name: "IngestError",
      phase: "validate",
      message: expect.stringContaining("anti-silent-hang bound"),
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp][ingest]"));
    errSpy.mockRestore();
  });

  it("erreur NON-timeout ⇒ re-raise telle quelle (pas de masquage), log [france-data-mcp][ingest]", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("network exploded");
    const supabase = {
      rpc: vi.fn(() => Promise.reject(boom)),
    } as unknown as RbrArgs[0];

    await expect(
      runBatchedRpc(supabase, "ingest_apply_rpps_ban_geocoding_batch", {}, 1, 1, 5000),
    ).rejects.toBe(boom);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("threw a non-timeout error, re-raising"),
    );
    errSpy.mockRestore();
  });

  it("perCallTimeoutMs ABSENT (FINESS/Ameli) ⇒ comportement inchangé (aucun timeout, convergence normale)", async () => {
    const supabase = {
      rpc: vi.fn(() => Promise.resolve({ data: 0, error: null })),
    } as unknown as RbrArgs[0];

    await expect(
      runBatchedRpc(supabase, "ingest_apply_rpps_finess_enrichment_batch", {}, 100, 50),
    ).resolves.toEqual({ totalUpdated: 0, iterations: 1 });
  });
});

// Contrat audit `forced` : `SELECT * FROM ingest_log WHERE forced=true` doit
// retourner UNIQUEMENT les runs ops déclenchés via FORCE_REINGEST, jamais le
// bruit des crons normaux. D'où les 3 garde-fous below (force=true → set ;
// force=false ou défaut → reste undefined).
describe("shortCircuitIfSameChecksum — levier force", () => {
  const baseLog = (): IngestLogEntry =>
    ({ source: "rpps", started_at: "t0", status: "failed", csv_url: "u" }) as IngestLogEntry;

  it("force=true + checksums identiques : retourne false, log.forced=true, pas de bascule skip", async () => {
    const log = baseLog();
    const short = await shortCircuitIfSameChecksum(log, "deadbeef", "deadbeef", "rpps", true);
    expect(short).toBe(false);
    expect(log.forced).toBe(true);
    expect(log.status).toBe("failed");
    expect(log.skip_reason).toBeUndefined();
    expect(log.finished_at).toBeUndefined();
  });

  it("force=false + checksum différent : retourne false, log.forced reste undefined", async () => {
    const log = baseLog();
    const short = await shortCircuitIfSameChecksum(log, "aaaa", "bbbb", "rpps", false);
    expect(short).toBe(false);
    expect(log.skip_reason).toBeUndefined();
    expect(log.forced).toBeUndefined();
  });

  it("force=false + pas de lastSha (1er run) : retourne false, log.forced reste undefined", async () => {
    const log = baseLog();
    const short = await shortCircuitIfSameChecksum(log, null, "bbbb", "rpps");
    expect(short).toBe(false);
    expect(log.skip_reason).toBeUndefined();
    expect(log.forced).toBeUndefined();
  });

  it("court-circuit DÉCLENCHÉ : retourne true, écrit log via writeIngestLogSuccessSafe (5e site V0.12.3)", async () => {
    // Garde-fou contre régression : si demain le 5e site repasse à writeIngestLog
    // direct (au lieu du helper safe), un throw catastrophique avalerait l'audit.
    // Le test valide le contrat protégé : insert appelé + status=success +
    // skip_reason=same_checksum + return true.
    const log = baseLog();
    const { client, insert } = fakeSupabase([null]);
    const short = await shortCircuitIfSameChecksum(log, "abcdef", "abcdef", "rpps", false, client);
    expect(short).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(log.status).toBe("success");
    expect(log.skip_reason).toBe("same_checksum");
    expect(log.row_count).toBeNull();
  });

  it("court-circuit DÉCLENCHÉ + writeIngestLog throw : retourne true SANS rejeter + fallback stderr distinct success", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = baseLog();
    const throwingClient = {
      from: () => ({
        insert: () => {
          throw new Error("ECONNREFUSED post-skip");
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat injecté
    } as any;
    const short = await shortCircuitIfSameChecksum(
      log,
      "abcdef",
      "abcdef",
      "rpps",
      false,
      throwingClient,
    );
    // Le caller (main) attend `true` pour return early — un throw casserait la
    // sémantique. Le helper safe protège ça.
    expect(short).toBe(true);
    // Le fallback stderr DISTINCT du failed path est émis.
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("[rpps][ingest_log_success_fallback]")),
    ).toBe(true);
    errSpy.mockRestore();
  });
});

describe("writeIngestLog — retry défensif PGRST204 (review P1 silent-failure-hunter)", () => {
  const baseEntry = (overrides: Partial<IngestLogEntry> = {}): IngestLogEntry => ({
    source: "rpps",
    started_at: "t0",
    status: "success",
    ...overrides,
  });

  it("PGRST204 + forced=true → retry sans forced → succès + warn (migration en transition)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([
      { code: "PGRST204", message: "Could not find the 'forced' column" },
      null, // retry success
    ]);
    await writeIngestLog(baseEntry({ forced: true }), client);
    expect(insert).toHaveBeenCalledTimes(2);
    // 1er appel : payload avec forced=true (échoue)
    expect((insert.mock.calls[0] as unknown[])?.[0]).toMatchObject({ forced: true });
    // 2e appel (retry) : payload SANS forced
    expect((insert.mock.calls[1] as unknown[])?.[0]).not.toHaveProperty("forced");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("PGRST204");
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("PGRST204 + forced=true → retry échoue aussi → console.error (audit perdu mais run préservé)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([
      { code: "PGRST204", message: "col missing" },
      { code: "PGRST200", message: "other failure" },
    ]);
    await writeIngestLog(baseEntry({ forced: true }), client);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("retry failed");
    errSpy.mockRestore();
  });

  it("PGRST204 sans forced (autre colonne manquante) → pas de retry → console.error direct", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([
      { code: "PGRST204", message: "Could not find some other column" },
    ]);
    await writeIngestLog(baseEntry(), client);
    // Pas de forced dans entry → pas de retry, fallback direct au console.error.
    expect(insert).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("failed to write ingest_log");
    errSpy.mockRestore();
  });

  it("autre erreur (non-PGRST204) → pas de retry → console.error direct (comportement legacy préservé)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([{ code: "23505", message: "unique violation" }]);
    await writeIngestLog(baseEntry({ forced: true }), client);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("succès au 1er appel → aucun log, aucune retry (chemin nominal)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([null]);
    await writeIngestLog(baseEntry({ forced: true }), client);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("PGRST204 + ban_eligible_distinct (autre champ récent) → retry sans ce champ → succès", async () => {
    // Garde-fou contre régression de la classe close en V0.12.2 : tout champ
    // optionnel listé dans PGRST204_RECOVERABLE_FIELDS doit déclencher le retry.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([
      { code: "PGRST204", message: "col missing: ban_eligible_distinct" },
      null,
    ]);
    await writeIngestLog(baseEntry({ ban_eligible_distinct: 42 }), client);
    expect(insert).toHaveBeenCalledTimes(2);
    expect((insert.mock.calls[0] as unknown[])?.[0]).toMatchObject({ ban_eligible_distinct: 42 });
    expect((insert.mock.calls[1] as unknown[])?.[0]).not.toHaveProperty("ban_eligible_distinct");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("ban_eligible_distinct");
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("PGRST204 + plusieurs champs recoverable → retry sans aucun → warn liste tous les droppés", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([{ code: "PGRST204", message: "col missing" }, null]);
    await writeIngestLog(
      baseEntry({ forced: true, ban_eligible_distinct: 100, ban_to_geocode_distinct: 50 }),
      client,
    );
    expect(insert).toHaveBeenCalledTimes(2);
    const retryPayload = (insert.mock.calls[1] as unknown[])?.[0] as Record<string, unknown>;
    expect(retryPayload).not.toHaveProperty("forced");
    expect(retryPayload).not.toHaveProperty("ban_eligible_distinct");
    expect(retryPayload).not.toHaveProperty("ban_to_geocode_distinct");
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain("forced");
    expect(warnMessage).toContain("ban_eligible_distinct");
    expect(warnMessage).toContain("ban_to_geocode_distinct");
    warnSpy.mockRestore();
  });
});

describe("writeIngestLogFailureFallback — pattern défensif uniforme V0.12.3 (4 callers ingest)", () => {
  // Contrat : émet d'abord un snapshot stderr structuré ([source][ingest_log_fallback]
  // pour le script auto-issue), PUIS tente writeIngestLog dans try/catch. Si
  // writeIngestLog throw (env Supabase absente, exception réseau brute), log
  // proprement sans laisser une UnhandledRejection avaler le process.exit(1)
  // du caller. Source unique du pattern précédemment inline-only dans cds.ts.

  const failedLog = (): IngestLogEntry => ({
    source: "rpps",
    started_at: "t0",
    status: "failed",
    error_phase: "validate",
    error_message: "boom",
  });

  it("émet le fallback stderr AVANT writeIngestLog (ordre = survie), puis insert OK", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([null]);
    await writeIngestLogFailureFallback(failedLog(), "rpps", client);
    // Ordre garanti : 1er stderr = fallback structuré, AVANT l'insert.
    const fallbackCallIdx = errSpy.mock.calls.findIndex((c) =>
      String(c[0]).includes("[rpps][ingest_log_fallback]"),
    );
    expect(fallbackCallIdx).toBeGreaterThanOrEqual(0);
    expect(insert).toHaveBeenCalledTimes(1);
    // Pas de "writeIngestLog threw" (success path).
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("writeIngestLog threw"))).toBe(
      false,
    );
    errSpy.mockRestore();
  });

  it("writeIngestLog throw → fallback stderr préservé + log d'erreur, jamais d'UnhandledRejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // fakeSupabase ne throw pas naturellement — on injecte un client qui
    // throw sur insert pour simuler getIngestLogClient/réseau brut.
    const throwingClient = {
      from: () => ({
        insert: () => {
          throw new Error("ECONNREFUSED supabase.co");
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat injecté
    } as any;
    await expect(
      writeIngestLogFailureFallback(failedLog(), "finess", throwingClient),
    ).resolves.toBeUndefined(); // PAS de throw — c'est ça le contrat
    // Fallback structuré ÉMIS malgré le throw.
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("[finess][ingest_log_fallback]")),
    ).toBe(true);
    // Log d'erreur dédié pour le throw.
    expect(
      errSpy.mock.calls.some(
        (c) =>
          String(c[0]).includes("writeIngestLog threw") && String(c[0]).includes("ECONNREFUSED"),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("writeIngestLog retourne error (insert error géré en interne) → pas de double-log 'threw'", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Erreur retournée par supabase mais writeIngestLog la catche en interne
    // (console.error + return) — pas un throw. Le helper ne doit PAS émettre
    // un 2e log "threw" (le writeIngestLog interne a déjà loggué).
    const { client } = fakeSupabase([{ code: "23505", message: "duplicate key" }]);
    await writeIngestLogFailureFallback(failedLog(), "ameli", client);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("writeIngestLog threw"))).toBe(
      false,
    );
    errSpy.mockRestore();
  });

  it("préfixe `source` correctement propagé pour les 4 sources (rpps/finess/ameli/cds)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // `as const` : force le type littéral `IngestStderrPrefix` à l'inférence
    // (sinon `string[]` faiblement typé, et un éventuel "ameli_ps" passerait
    // — les .test.ts ne sont pas typecheckés par le CI, cf. tsconfig.api.json).
    for (const source of ["rpps", "finess", "ameli", "cds"] as const) {
      const { client } = fakeSupabase([null]);
      await writeIngestLogFailureFallback({ ...failedLog(), source }, source, client);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes(`[${source}][ingest_log_fallback]`)),
      ).toBe(true);
    }
    errSpy.mockRestore();
  });
});

describe("writeIngestLogSuccessSafe — protège la branche success contre throw catastrophique V0.12.3", () => {
  // Contrat : sur chemin success, writeIngestLog peut throw (env Supabase
  // absente, réseau coupé post-SWAP). Sans filet, l'`await` rejette → process
  // exit non-déterministe → audit row LOST sans signal opérateur. Le helper
  // try/catch writeIngestLog ; en cas de throw émet un fallback stderr DISTINCT
  // du failed path (`[source][ingest_log_success_fallback]`) pour que l'ops
  // sache qu'un run RÉUSSI côté prod a perdu son audit.

  const successLog = (): IngestLogEntry => ({
    source: "rpps",
    started_at: "t0",
    status: "success",
    row_count: 1000,
  });

  it("succès nominal → aucun stderr (pas de bruit en chemin nominal)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeSupabase([null]);
    await writeIngestLogSuccessSafe(successLog(), "rpps", client);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("writeIngestLog throw → fallback stderr DISTINCT du failed path + log d'erreur, jamais d'UnhandledRejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingClient = {
      from: () => ({
        insert: () => {
          throw new Error("ECONNREFUSED supabase.co");
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat injecté
    } as any;
    await expect(
      writeIngestLogSuccessSafe(successLog(), "finess", throwingClient),
    ).resolves.toBeUndefined();
    // Préfixe success_fallback : permet à l'ops de distinguer "audit perdu sur run réussi"
    // (situation pire que failed perdu) d'un failed path normal.
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("[finess][ingest_log_success_fallback]")),
    ).toBe(true);
    expect(
      errSpy.mock.calls.some(
        (c) =>
          String(c[0]).includes("writeIngestLog threw on SUCCESS path") &&
          String(c[0]).includes("ECONNREFUSED"),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("writeIngestLog retourne error supabase (insert error géré en interne) → pas de stderr success_fallback", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase([{ code: "23505", message: "duplicate key" }]);
    await writeIngestLogSuccessSafe(successLog(), "ameli", client);
    // writeIngestLog gère déjà en interne (console.error préfixé) ; le
    // helper ne doit PAS émettre son propre fallback stderr.
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("[ameli][ingest_log_success_fallback]")),
    ).toBe(false);
    errSpy.mockRestore();
  });
});

describe("isForceReingestEnv — contrat var d'env (anti faux négatif opérateur)", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["  1  ", true],
    [" true ", true],
    ["0", false],
    ["false", false],
    ["yes", false],
    ["", false],
    [undefined, false],
  ])("FORCE_REINGEST=%j → force=%s", (value, expected) => {
    expect(isForceReingestEnv(value as string | undefined)).toBe(expected);
  });
});

describe("runKeysetRpc — pilote keyset générique (anti re-scan quadratique)", () => {
  type RkrArgs = Parameters<typeof runKeysetRpc>;

  it("avance le curseur p_after et s'arrête sur last_id NULL (page vide)", async () => {
    const calls: number[] = [];
    const supabase = {
      rpc: (_n: string, p: { p_after: number; p_limit: number }) => {
        calls.push(p.p_after);
        if (p.p_after === 0)
          return Promise.resolve({ data: [{ last_id: 100, applied: 7 }], error: null });
        if (p.p_after === 100)
          return Promise.resolve({ data: [{ last_id: 250, applied: 3 }], error: null });
        return Promise.resolve({ data: [{ last_id: null, applied: 0 }], error: null });
      },
    } as unknown as RkrArgs[0];
    const res = await runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 2000);
    expect(calls).toEqual([0, 100, 250]);
    expect(res).toEqual({ totalApplied: 10, iterations: 3 });
  });

  it("throw IngestError si le curseur ne progresse pas (régression contrat)", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: [{ last_id: 50, applied: 0 }], error: null }),
    } as unknown as RkrArgs[0];
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(
      /did not progress|non-progress/i,
    );
  });

  it("throw IngestError sur erreur RPC", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    } as unknown as RkrArgs[0];
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(/boom/);
  });

  it("throw IngestError si la forme de retour est inattendue (contrat)", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: 42, error: null }),
    } as unknown as RkrArgs[0];
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(
      /contract regression/i,
    );
  });

  it("garde de convergence : maxIterations dépassé → IngestError", async () => {
    // last_id croît toujours (curseur progresse) mais ne renvoie jamais NULL :
    // la garde maxIterations doit couper (sinon boucle infinie).
    let cur = 0;
    const supabase = {
      rpc: () => {
        cur += 1;
        return Promise.resolve({ data: [{ last_id: cur, applied: 1 }], error: null });
      },
    } as unknown as RkrArgs[0];
    // expectedTotal=10, p_limit=100 → maxIterations = ceil(10/100)+5 = 6
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(
      /did not converge/i,
    );
  });

  it("fail-loud si p_limit absent/invalide (garde maxIterations sinon aveugle)", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: [{ last_id: null, applied: 0 }], error: null }),
    } as unknown as RkrArgs[0];
    // p_limit absent → throw AVANT toute itération (pas de Number()||1 muet).
    await expect(runKeysetRpc(supabase, "rpc_x", {}, 100)).rejects.toThrow(
      /p_limit doit être un entier positif/i,
    );
    // p_limit non-entier / ≤0 → idem.
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 0 }, 100)).rejects.toThrow(
      /p_limit doit être un entier positif/i,
    );
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 1.5 }, 100)).rejects.toThrow(
      /p_limit doit être un entier positif/i,
    );
  });

  it("throw IngestError sur tableau VIDE (≠ page vide qui renvoie 1 ligne last_id=null)", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as RkrArgs[0];
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(
      /empty array.*contract regression/i,
    );
  });
});
