import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IngestError,
  type PreValidateConfig,
  getNonEmpty,
  parseDropStalePreviousOutcome,
  preValidateFile,
} from "./shared.js";

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
