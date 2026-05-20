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
    expect(insert.mock.calls[0]?.[0]).toMatchObject({ forced: true });
    // 2e appel (retry) : payload SANS forced
    expect(insert.mock.calls[1]?.[0]).not.toHaveProperty("forced");
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
    expect(insert.mock.calls[0]?.[0]).toMatchObject({ ban_eligible_distinct: 42 });
    expect(insert.mock.calls[1]?.[0]).not.toHaveProperty("ban_eligible_distinct");
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
    const retryPayload = insert.mock.calls[1]?.[0] as Record<string, unknown>;
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
