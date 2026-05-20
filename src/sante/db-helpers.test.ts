import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectSingleRow } from "./db-helpers.js";

// Pure unit tests pour les helpers partagés `db-helpers.ts`. Pas de DB ni
// Supabase Local — les fonctions sont pures (validation + warn console).

describe("expectSingleRow", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("retourne null sur 0 row, sans warn (cas not_found géré par le caller)", () => {
    const result = expectSingleRow(
      "finess_by_num_finess",
      [],
      "999999999",
      "Investigate finess table for duplicate num_finess.",
    );
    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("retourne la seule row sur 1 row, sans warn (cas nominal)", () => {
    const row = { num_finess: "080010085", raison_sociale: "BIO ARD'AISNE" };
    const result = expectSingleRow(
      "finess_by_num_finess",
      [row],
      "080010085",
      "Investigate finess table for duplicate num_finess.",
    );
    expect(result).toBe(row);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warne et retourne la première row sur N > 1 rows (violation PK defense-in-depth)", () => {
    const rows = [
      { num_finess: "080010085", raison_sociale: "BIO ARD'AISNE 1" },
      { num_finess: "080010085", raison_sociale: "BIO ARD'AISNE 2" },
    ];
    const result = expectSingleRow(
      "finess_by_num_finess",
      rows,
      "080010085",
      "Investigate finess table for duplicate num_finess.",
    );
    expect(result).toBe(rows[0]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    // Le message doit contenir : prefix codebase, nom RPC, identifier, count
    // d'investigation pour préserver la traçabilité ops.
    expect(warnMessage).toContain("[france-data-mcp]");
    expect(warnMessage).toContain("finess_by_num_finess");
    expect(warnMessage).toContain("080010085");
    expect(warnMessage).toContain("2 rows");
    expect(warnMessage).toContain("Investigate finess table for duplicate num_finess.");
  });
});
