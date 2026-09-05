import { describe, expect, it } from "vitest";
import {
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  PG_STATEMENT_TIMEOUT,
  PG_TOO_MANY_CONNECTIONS,
  PG_TRANSIENT_REBUILD_CODES,
  isStatementTimeoutError,
} from "./pg-errors.js";

// Classifieur consommé par la relance de la jauge BAN post-swap (`rpps.ts` 6d,
// via `retryTransient.isRetryableResult`) : il ne doit relancer QU'un 57014
// (contention I/O transitoire post-run, prouvée prod run #33954453629) — jamais
// un échec structurel (RPC absente, permission, contrat), sinon 60 s d'attente
// qui masquent une vraie panne.
describe("isStatementTimeoutError", () => {
  it("reconnaît le code SQLSTATE 57014 (contrat typé, prioritaire)", () => {
    expect(isStatementTimeoutError({ code: PG_STATEMENT_TIMEOUT, message: "anything" })).toBe(true);
    expect(PG_STATEMENT_TIMEOUT).toBe("57014");
  });

  it("reconnaît le message PostgREST sans code (filet, insensible à la casse)", () => {
    expect(
      isStatementTimeoutError({ message: "canceling statement due to statement timeout" }),
    ).toBe(true);
    expect(
      isStatementTimeoutError({ message: "Canceling Statement Due To STATEMENT TIMEOUT" }),
    ).toBe(true);
    expect(isStatementTimeoutError(new Error("canceling statement due to statement timeout"))).toBe(
      true,
    );
  });

  it("reconnaît le code rangé dans details/hint ou sérialisé en nombre (filets)", () => {
    expect(isStatementTimeoutError({ message: "query failed", details: "statement timeout" })).toBe(
      true,
    );
    expect(
      isStatementTimeoutError({
        message: "x",
        hint: "canceling statement due to statement timeout",
      }),
    ).toBe(true);
    // `code` sérialisé en nombre par un transport : le type dit string, le
    // runtime peut mentir → `String()` défensif.
    expect(isStatementTimeoutError({ code: 57014 as unknown as string, message: "x" })).toBe(true);
  });

  it("refuse un échec structurel (RPC absente, permission, contrat) et l'absence d'erreur", () => {
    expect(
      isStatementTimeoutError({
        code: "PGRST202",
        message:
          "Could not find the function public.rpps_measure_ban_to_geocode(p_source_table) in the schema cache",
      }),
    ).toBe(false);
    expect(isStatementTimeoutError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isStatementTimeoutError({ message: "invalid_parameter_value" })).toBe(false);
    expect(isStatementTimeoutError({ message: "" })).toBe(false);
    expect(isStatementTimeoutError(null)).toBe(false);
    expect(isStatementTimeoutError(undefined)).toBe(false);
    // Une string n'est PAS une erreur SQL : refusée à la COMPILATION (type
    // structurel `PgErrorLike`), et `false` à l'exécution si on force le cast.
    // @ts-expect-error — mésusage volontaire : string au lieu de `result.error`
    expect(isStatementTimeoutError("statement timeout")).toBe(false);
  });
});

describe("PG_TRANSIENT_REBUILD_CODES — source unique rpps.ts / ameli.ts", () => {
  it("contient exactement les 4 codes transitoires historiques (lock, deadlock, timeout, connexions)", () => {
    expect([...PG_TRANSIENT_REBUILD_CODES].sort()).toEqual(
      [
        PG_LOCK_NOT_AVAILABLE,
        PG_DEADLOCK_DETECTED,
        PG_STATEMENT_TIMEOUT,
        PG_TOO_MANY_CONNECTIONS,
      ].sort(),
    );
    expect(PG_TRANSIENT_REBUILD_CODES.has("42P01")).toBe(false); // undefined_table = structurel
  });
});
