import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `load-env.js` lit le `.env` du poste : sans effet voulu dans un test.
vi.mock("./load-env.js", () => ({}));

import { runCleanup } from "./drop-stale-previous.js";

const NOW = new Date("2026-11-19T10:40:00Z"); // un jeudi
const ENV = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };
const TABLES = 10; // `SOURCES` de la CLI

/** GitHub : chaque workflow `ingest-*` rend `runs` (les mêmes pour tous). */
function fakeGithub(runs: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "",
    json: async () => ({ workflow_runs: runs }),
  })) as unknown as typeof fetch;
}

/** Supabase : `ingest_log` rend un run vieux de 45 jours, la RPC rend `absent`. */
function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order"]) chain[m] = () => chain;
  chain.limit = async () => ({ data: [{ started_at: "2026-10-05T11:14:25Z" }], error: null });
  const from = vi.fn(() => chain);
  const rpc = vi.fn(async (_name: string, args: { p_prod_table: string }) => ({
    data: `absent:${args.p_prod_table}_previous`,
    error: null,
  }));
  return { client: { from, rpc } as never, from, rpc };
}

const SUCCESS_RUN = {
  status: "completed",
  conclusion: "success",
  created_at: "2026-11-16T12:24:24Z",
};
const KILLED_RUN = {
  status: "completed",
  conclusion: "cancelled",
  created_at: "2026-11-17T11:56:46Z",
};

describe("runCleanup — l'enchaînement des gardes décide si une copie part", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tous les runs récents en succès → chaque table est soumise à la RPC, seuil 4 jours", async () => {
    const { client, rpc } = fakeSupabase();
    const result = await runCleanup({
      argv: [],
      env: ENV,
      now: NOW,
      fetchImpl: fakeGithub([SUCCESS_RUN]),
      client,
    });
    expect(result).toEqual({ blockedByIngestRuns: false, failureCount: 0 });
    expect(rpc).toHaveBeenCalledTimes(TABLES);
    expect(rpc).toHaveBeenCalledWith("ingest_drop_stale_previous", {
      p_prod_table: "rpps",
      p_source: "rpps",
      p_max_age_days: 4,
    });
  });

  it("un run d'ingestion tué il y a 2 jours → RIEN n'est soumis, ni lu en base", async () => {
    const { client, rpc, from } = fakeSupabase();
    const result = await runCleanup({
      argv: [],
      env: ENV,
      now: NOW,
      fetchImpl: fakeGithub([SUCCESS_RUN, KILLED_RUN]),
      client,
    });
    expect(result).toEqual({ blockedByIngestRuns: true, failureCount: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("--max-age-days=1 ne raccourcit pas la fenêtre de la garde : le run tué il y a 2 jours bloque encore", async () => {
    const { client, rpc } = fakeSupabase();
    const result = await runCleanup({
      argv: ["--max-age-days=1"],
      env: ENV,
      now: NOW,
      fetchImpl: fakeGithub([KILLED_RUN]),
      client,
    });
    expect(result.blockedByIngestRuns).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("--dry-run : la RPC n'est JAMAIS appelée, garde passante ou bloquante", async () => {
    for (const runs of [[SUCCESS_RUN], [KILLED_RUN]]) {
      const { client, rpc, from } = fakeSupabase();
      const result = await runCleanup({
        argv: ["--dry-run"],
        env: ENV,
        now: NOW,
        fetchImpl: fakeGithub(runs),
        client,
      });
      expect(result.failureCount).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
      // Le détail par table est bien calculé (lecture seule d'`ingest_log`).
      expect(from).toHaveBeenCalled();
    }
  });

  it("jeton GitHub absent → throw avant toute lecture ou suppression", async () => {
    const { client, rpc, from } = fakeSupabase();
    const fetchImpl = fakeGithub([SUCCESS_RUN]);
    await expect(
      runCleanup({ argv: [], env: { GITHUB_REPOSITORY: "o/r" }, now: NOW, fetchImpl, client }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("API GitHub en erreur → throw, rien n'est supprimé", async () => {
    const { client, rpc } = fakeSupabase();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(runCleanup({ argv: [], env: ENV, now: NOW, fetchImpl, client })).rejects.toThrow(
      /HTTP 403/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("--no-ingest-guard : GitHub n'est pas interrogé, le nettoyage a lieu (opérateur seulement)", async () => {
    const { client, rpc } = fakeSupabase();
    const fetchImpl = fakeGithub([KILLED_RUN]);
    const result = await runCleanup({
      argv: ["--no-ingest-guard"],
      env: {},
      now: NOW,
      fetchImpl,
      client,
    });
    expect(result.blockedByIngestRuns).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(TABLES);
  });

  it("une table en erreur n'arrête pas les autres et remonte dans failureCount", async () => {
    const { client, rpc } = fakeSupabase();
    rpc.mockImplementationOnce(async () => ({ data: 42 as never, error: null }));
    const result = await runCleanup({
      argv: [],
      env: ENV,
      now: NOW,
      fetchImpl: fakeGithub([SUCCESS_RUN]),
      client,
    });
    expect(result.failureCount).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(TABLES);
  });
});
