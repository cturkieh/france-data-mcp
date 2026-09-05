/**
 * Tests autour du script d'ingestion FINESS. Le mapping du flux ANS est testé
 * dans `finess-ans-parse.test.ts` (fonctions pures, fixtures réelles), la
 * pré-validation gzip dans `shared.test.ts` (`preValidateFile` + `magicBytes`) ;
 * ici : le canary non-bloquant partagé (`runCanaryCheck`).
 *
 * Les tests du parseur CSV DREES (v0.2.1 → V0.4.4) ont été retirés avec le
 * parseur : la DREES a arrêté ce flux le 2026-07-20 (cf. finess.ts).
 */

import { describe, expect, it } from "vitest";
import { type IngestLogEntry, runAndRecordCanary, runCanaryCheck } from "./shared.js";

describe("runAndRecordCanary — un canary manquant marque le run partial", () => {
  const freshLog = (): IngestLogEntry => ({
    source: "finess",
    started_at: "2026-09-05T21:24:40Z",
    // Statut INITIAL des scripts : `failed` jusqu'au succès final. Une garde
    // `if (log.status !== "failed")` ici était morte (revue 2026-09-05) —
    // le canary FINESS a échoué 4 mois en `success`.
    status: "failed",
  });

  it("cibles manquantes → status partial + canary_failures, sans throw", async () => {
    const supabase = {
      rpc: async () => ({ data: ["130786049"], error: null }),
    } as unknown as Parameters<typeof runAndRecordCanary>[0];
    const log = freshLog();
    await runAndRecordCanary(supabase, "finess", log, "finess");
    expect(log.status).toBe("partial");
    expect(log.canary_failures).toEqual(["130786049"]);
  });

  it("canary OK → log intact (le script posera success)", async () => {
    const supabase = {
      rpc: async () => ({ data: [], error: null }),
    } as unknown as Parameters<typeof runAndRecordCanary>[0];
    const log = freshLog();
    await runAndRecordCanary(supabase, "finess", log, "finess");
    expect(log.status).toBe("failed");
    expect(log.canary_failures).toBeUndefined();
  });
});

describe("runCanaryCheck (V0.4.4 — non-blocking canary)", () => {
  it("retourne le tableau des keys manquantes quand le RPC en signale", async () => {
    const fakeSupabase = {
      rpc: async (_fn: string, _args: { p_source: string }) => ({
        data: ["080010085", "080010093"],
        error: null,
      }),
    };
    const missing = await runCanaryCheck(
      fakeSupabase as unknown as Parameters<typeof runCanaryCheck>[0],
      "finess",
    );
    expect(missing).toEqual(["080010085", "080010093"]);
  });

  it("retourne [] quand le RPC indique 0 cibles manquantes (canary OK)", async () => {
    const fakeSupabase = {
      rpc: async (_fn: string, _args: { p_source: string }) => ({
        data: [],
        error: null,
      }),
    };
    const missing = await runCanaryCheck(
      fakeSupabase as unknown as Parameters<typeof runCanaryCheck>[0],
      "finess",
    );
    expect(missing).toEqual([]);
  });

  it("ne throw PAS et retourne ['__rpc_error__'] sur erreur RPC", async () => {
    const fakeSupabase = {
      rpc: async (_fn: string, _args: { p_source: string }) => ({
        data: null,
        error: { message: "function does not exist" },
      }),
    };
    // Le canary est non-bloquant by contract : la swap est déjà committée,
    // on alerte sans rollback. process.exit(1) ne doit JAMAIS être appelé
    // depuis cet helper — on vérifie juste qu'il retourne le sentinelle.
    const missing = await runCanaryCheck(
      fakeSupabase as unknown as Parameters<typeof runCanaryCheck>[0],
      "finess",
    );
    expect(missing).toEqual(["__rpc_error__"]);
  });

  it("retombe sur [] quand le RPC retourne null (defense-in-depth)", async () => {
    const fakeSupabase = {
      rpc: async (_fn: string, _args: { p_source: string }) => ({
        data: null,
        error: null,
      }),
    };
    const missing = await runCanaryCheck(
      fakeSupabase as unknown as Parameters<typeof runCanaryCheck>[0],
      "finess",
    );
    expect(missing).toEqual([]);
  });

  it("filtre les non-strings du tableau RPC (defense-in-depth)", async () => {
    const fakeSupabase = {
      rpc: async (_fn: string, _args: { p_source: string }) => ({
        // PostgREST ne devrait jamais retourner ça avec un TEXT[] côté SQL,
        // mais on défend explicitement.
        data: ["080010085", null, 42, "080010093"],
        error: null,
      }),
    };
    const missing = await runCanaryCheck(
      fakeSupabase as unknown as Parameters<typeof runCanaryCheck>[0],
      "finess",
    );
    expect(missing).toEqual(["080010085", "080010093"]);
  });

  it("appelle le RPC avec p_source aligné sur la source passée", async () => {
    let captured: { fn: string; args: unknown } | null = null;
    const fakeSupabase = {
      rpc: async (fn: string, args: { p_source: string }) => {
        captured = { fn, args };
        return { data: [], error: null };
      },
    };
    await runCanaryCheck(
      fakeSupabase as unknown as Parameters<typeof runCanaryCheck>[0],
      "ameli_ps",
    );
    expect(captured).toEqual({ fn: "check_ingest_canary", args: { p_source: "ameli_ps" } });
  });
});
