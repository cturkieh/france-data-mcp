import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  IngestError,
  type PreValidateConfig,
  getNonEmpty,
  insertStagingBatchWithRetry,
  parseDropStalePreviousOutcome,
  preValidateFile,
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
