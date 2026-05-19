import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  IngestError,
  type IngestLogEntry,
  type PreValidateConfig,
  getNonEmpty,
  insertStagingBatchWithRetry,
  isForceReingestEnv,
  parseDropStalePreviousOutcome,
  preValidateFile,
  runBatchedRpc,
  runKeysetRpc,
  shortCircuitIfSameChecksum,
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

describe("shortCircuitIfSameChecksum — levier force", () => {
  const baseLog = (): IngestLogEntry =>
    ({ source: "rpps", started_at: "t0", status: "failed", csv_url: "u" }) as IngestLogEntry;

  it("force=true : retourne false MÊME si checksums identiques, SANS muter log ni écrire (audit intact)", async () => {
    const log = baseLog();
    // force=true sort AVANT writeIngestLog → aucun I/O DB, branche pure.
    const short = await shortCircuitIfSameChecksum(log, "deadbeef", "deadbeef", "rpps", true);
    expect(short).toBe(false);
    // log non touché : pas de bascule en skip success.
    expect(log.status).toBe("failed");
    expect(log.skip_reason).toBeUndefined();
    expect(log.finished_at).toBeUndefined();
  });

  it("force=false + checksum différent : retourne false (pas de short-circuit, branche pure)", async () => {
    const log = baseLog();
    const short = await shortCircuitIfSameChecksum(log, "aaaa", "bbbb", "rpps", false);
    expect(short).toBe(false);
    expect(log.skip_reason).toBeUndefined();
  });

  it("force=false + pas de lastSha : retourne false (1er run, branche pure)", async () => {
    const log = baseLog();
    const short = await shortCircuitIfSameChecksum(log, null, "bbbb", "rpps");
    expect(short).toBe(false);
    expect(log.skip_reason).toBeUndefined();
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
