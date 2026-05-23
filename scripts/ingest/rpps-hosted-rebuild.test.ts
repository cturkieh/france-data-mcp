import { describe, expect, it, vi } from "vitest";
import { IngestError, type IngestLogEntry } from "./shared.js";

const { __TESTING__ } = await import("./rpps.js");
const { rebuildRppsMatviews } = __TESTING__;

// --- rebuildRppsMatviews chaîne finess_hosted_activities (Phase 2 — Tâche 2) -
//
// Garde-fou du hook ajouté Phase 2 (chantier « Complétude territoriale &
// lentilles ») : la matview `finess_hosted_activities` JOIN `rpps` ET
// `finess` → suit l'OID des DEUX → DOIT être REBUILT (jamais REFRESH)
// post-swap des deux côtés. Ce fichier teste le hook côté RPPS ; un fichier
// symétrique vivra côté FINESS (Tâche 3).
//
// Trois invariants critiques codifiés ici :
//   1. ORDRE STRICT : ingest_rebuild_rpps_matviews PUIS
//      ingest_rebuild_finess_hosted_activities (jamais l'inverse — sinon on
//      rebuilderait hosted sur un état rpps périmé).
//   2. ÉCHEC HOSTED ≠ THROW : la couche hosted est secondaire (3 tools de
//      complétude, pas les tools RPPS core) → dégradation en `partial` SANS
//      throw, le cron RPPS LUI a réussi.
//   3. ÉCHEC RPPS_MATVIEWS COURT-CIRCUITE HOSTED : si rpps_matviews échoue
//      (transitoire OU structurel), hosted NE doit PAS être appelé (rpps
//      désynchronisé → propagerait le périmé / aggravation du structurel).

function makeLog(): IngestLogEntry {
  return {
    source: "rpps",
    started_at: "2026-05-23T10:00:00Z",
    status: "success",
  };
}

function makeSupabaseStub(rpcImpl: (name: string, args: unknown) => { error: unknown }) {
  return { rpc: vi.fn(rpcImpl) } as unknown as Parameters<typeof rebuildRppsMatviews>[0];
}

describe("rebuildRppsMatviews — chaîne finess_hosted_activities (Phase 2)", () => {
  it("chemin nominal : appelle ingest_rebuild_rpps_matviews PUIS ingest_rebuild_finess_hosted_activities (ordre strict)", async () => {
    const calls: string[] = [];
    const supabase = makeSupabaseStub((name) => {
      calls.push(name);
      return { error: null };
    });
    const log = makeLog();

    await rebuildRppsMatviews(supabase, log);

    // Ordre load-bearing : rebuild hosted sur un rpps non encore reconstruit
    // = matview hosted périmée déterministe au prochain JOIN.
    expect(calls).toEqual([
      "ingest_rebuild_rpps_matviews",
      "ingest_rebuild_finess_hosted_activities",
    ]);
    expect(log.status).toBe("success");
    expect(log.error_message).toBeUndefined();
  });

  it("échec hosted (code transitoire 55P03) → partial + appendLogMessage, SANS throw (couche secondaire, cron RPPS réussi sur le reste)", async () => {
    const supabase = makeSupabaseStub((name) => {
      if (name === "ingest_rebuild_finess_hosted_activities") {
        return { error: { code: "55P03", message: "lock not available" } };
      }
      return { error: null };
    });
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("finess_hosted_activities");
    expect(log.error_message).toContain("55P03");
  });

  it("échec hosted (code structurel 42P01) → partial + appendLogMessage, SANS throw (différent de rpps_matviews : hosted est secondaire, jamais failed+exit(1))", async () => {
    // Discriminant clé vs `rebuildRppsMatviews` Strategy 1 (42P01 sur la matview
    // rpps principale → throw → failed+exit(1)) : hosted en 42P01 ne casse PAS
    // le cron, le tool hosted_activities_in_radius répondra 42P01 LOUD côté
    // serveur jusqu'au prochain cron.
    const supabase = makeSupabaseStub((name) => {
      if (name === "ingest_rebuild_finess_hosted_activities") {
        return { error: { code: "42P01", message: 'relation "rpps" does not exist' } };
      }
      return { error: null };
    });
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("finess_hosted_activities");
    expect(log.error_message).toContain("42P01");
  });

  it("échec hosted sans code → partial avec fallback 'no-code' dans le logMessage (audit DB lisible)", async () => {
    const supabase = makeSupabaseStub((name) => {
      if (name === "ingest_rebuild_finess_hosted_activities") {
        return { error: { message: "boom without code" } };
      }
      return { error: null };
    });
    const log = makeLog();

    await rebuildRppsMatviews(supabase, log);

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("finess_hosted_activities");
    expect(log.error_message).toContain("no-code");
    expect(log.error_message).toContain("boom without code");
  });

  it("échec rpps_matviews TRANSITOIRE (55P03) → court-circuite hosted (jamais appelé, sinon on rebuilderait sur rpps désynchronisé)", async () => {
    const calls: string[] = [];
    const supabase = makeSupabaseStub((name) => {
      calls.push(name);
      if (name === "ingest_rebuild_rpps_matviews") {
        return { error: { code: "55P03", message: "lock not available" } };
      }
      return { error: null };
    });
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).resolves.toBeUndefined();

    expect(calls).toEqual(["ingest_rebuild_rpps_matviews"]);
    expect(calls).not.toContain("ingest_rebuild_finess_hosted_activities");
    expect(log.status).toBe("partial");
  });

  it("échec rpps_matviews STRUCTUREL (42P01) → throw IngestError + court-circuite hosted (jamais appelé)", async () => {
    const calls: string[] = [];
    const supabase = makeSupabaseStub((name) => {
      calls.push(name);
      if (name === "ingest_rebuild_rpps_matviews") {
        return { error: { code: "42P01", message: 'relation "rpps" does not exist' } };
      }
      return { error: null };
    });
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).rejects.toBeInstanceOf(IngestError);
    expect(calls).toEqual(["ingest_rebuild_rpps_matviews"]);
    expect(calls).not.toContain("ingest_rebuild_finess_hosted_activities");
  });

  it("préserve un error_message préexistant et concatène (cas échec hosted)", async () => {
    const supabase = makeSupabaseStub((name) => {
      if (name === "ingest_rebuild_finess_hosted_activities") {
        return {
          error: { code: "57014", message: "canceling statement due to statement timeout" },
        };
      }
      return { error: null };
    });
    const log = makeLog();
    log.error_message = "earlier non-fatal warning";

    await rebuildRppsMatviews(supabase, log);

    expect(log.status).toBe("partial");
    expect(log.error_message?.startsWith("earlier non-fatal warning;")).toBe(true);
    expect(log.error_message).toContain("finess_hosted_activities");
  });
});
