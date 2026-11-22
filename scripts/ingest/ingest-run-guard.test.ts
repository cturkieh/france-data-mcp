import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type WorkflowRunSummary,
  fetchRecentIngestRuns,
  findBlockingRuns,
  listIngestWorkflowFiles,
} from "./ingest-run-guard.js";
import { IngestError } from "./shared.js";

const NOW = new Date("2026-11-19T10:40:00Z"); // un jeudi
const MAX_AGE_DAYS = 4;

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    workflowFile: "ingest-rpps.yml",
    status: "completed",
    conclusion: "success",
    lastStartedAt: "2026-11-18T12:00:00Z",
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    ...overrides,
  };
}

describe("findBlockingRuns — aucun nettoyage tant qu'un run récent n'est pas un succès", () => {
  it("dernier run récent et réussi → ne bloque pas", () => {
    expect(findBlockingRuns([run()], NOW, MAX_AGE_DAYS)).toEqual([]);
  });

  it("run TUÉ après sa bascule (RPPS 2026-09-05) : `cancelled` récent → bloque", () => {
    const killed = run({ conclusion: "cancelled" });
    expect(findBlockingRuns([killed], NOW, MAX_AGE_DAYS)).toEqual([killed]);
  });

  it.each([
    ["en échec", { conclusion: "failure" }],
    ["timeout", { conclusion: "timed_out" }],
    ["en cours", { status: "in_progress", conclusion: null }],
    ["en file", { status: "queued", conclusion: null }],
    ["conclusion inconnue de ce code", { conclusion: "nouveau_statut_github" }],
  ] as const)("dernier run récent %s → bloque", (_label, overrides) => {
    expect(findBlockingRuns([run(overrides)], NOW, MAX_AGE_DAYS)).toHaveLength(1);
  });

  it("borne d'âge : 3 jours bloque encore, 4 jours (le seuil) ne bloque plus", () => {
    const failed3 = run({ conclusion: "failure", lastStartedAt: "2026-11-16T23:59:00Z" });
    const failed4 = run({ conclusion: "failure", lastStartedAt: "2026-11-15T00:01:00Z" });
    expect(findBlockingRuns([failed3], NOW, MAX_AGE_DAYS)).toEqual([failed3]);
    expect(findBlockingRuns([failed4], NOW, MAX_AGE_DAYS)).toEqual([]);
  });

  it("un succès APRÈS un run tué ne lève pas le blocage (il peut être un court-circuit same_checksum)", () => {
    const killed = run({ conclusion: "cancelled", lastStartedAt: "2026-11-17T12:00:00Z" });
    const laterSuccess = run({ lastStartedAt: "2026-11-18T12:00:00Z" });
    expect(findBlockingRuns([laterSuccess, killed], NOW, MAX_AGE_DAYS)).toEqual([killed]);
  });

  it("ne rend que les runs fautifs, les autres workflows restent hors de cause", () => {
    const ok = run({ workflowFile: "ingest-ameli.yml" });
    const bad = run({ workflowFile: "ingest-sitadel.yml", conclusion: "failure" });
    expect(findBlockingRuns([ok, bad], NOW, MAX_AGE_DAYS)).toEqual([bad]);
  });

  it("date de run illisible → throw (jamais « pas de run bloquant »)", () => {
    expect(() => findBlockingRuns([run({ lastStartedAt: "???" })], NOW, MAX_AGE_DAYS)).toThrow(
      IngestError,
    );
  });
});

describe("listIngestWorkflowFiles", () => {
  it("le dépôt : exactement les 7 workflows qui basculent une table", () => {
    expect(listIngestWorkflowFiles(new URL("../../.github/workflows/", import.meta.url))).toEqual([
      "ingest-ameli.yml",
      "ingest-cds.yml",
      "ingest-dvf.yml",
      "ingest-finess.yml",
      "ingest-iris.yml",
      "ingest-rpps.yml",
      "ingest-sitadel.yml",
    ]);
  });

  it("dossier sans workflow d'ingestion → throw : une garde sans rien à vérifier est cassée", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    fs.writeFileSync(path.join(dir, "ci.yml"), "name: CI\n");
    expect(() => listIngestWorkflowFiles(dir)).toThrow(IngestError);
  });
});

describe("fetchRecentIngestRuns — toute réponse douteuse est une erreur, pas un feu vert", () => {
  const base = { repo: "o/r", token: "t", workflowFiles: ["ingest-rpps.yml"] };
  function fakeFetch(response: { ok?: boolean; status?: number; body?: unknown }) {
    return vi.fn(async () => ({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: "",
      json: async () => response.body,
    })) as unknown as typeof fetch;
  }

  it("lit les 20 runs les plus récents du workflow, avec le jeton, et les rend TOUS", async () => {
    const fetchImpl = fakeFetch({
      body: {
        workflow_runs: [
          {
            status: "completed",
            conclusion: "cancelled",
            created_at: "2026-11-18T12:00:00Z",
            html_url: "https://github.com/o/r/actions/runs/9",
          },
          { status: "completed", conclusion: "success", created_at: "2026-10-05T11:14:06Z" },
        ],
      },
    });
    await expect(fetchRecentIngestRuns({ ...base, fetchImpl })).resolves.toEqual([
      {
        workflowFile: "ingest-rpps.yml",
        status: "completed",
        conclusion: "cancelled",
        lastStartedAt: "2026-11-18T12:00:00Z",
        htmlUrl: "https://github.com/o/r/actions/runs/9",
      },
      {
        workflowFile: "ingest-rpps.yml",
        status: "completed",
        conclusion: "success",
        lastStartedAt: "2026-10-05T11:14:06Z",
        htmlUrl: "",
      },
    ]);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/o/r/actions/workflows/ingest-rpps.yml/runs?per_page=20",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("« Re-run » : la date retenue est `run_started_at` (relance), pas `created_at` (1re tentative)", async () => {
    // Run créé le 13, relancé le 18 et toujours en cours : avec `created_at` il
    // aurait 6 jours et ne bloquerait plus, alors qu'il vient peut-être de basculer.
    const fetchImpl = fakeFetch({
      body: {
        workflow_runs: [
          {
            status: "in_progress",
            conclusion: null,
            created_at: "2026-11-13T12:00:00Z",
            run_started_at: "2026-11-18T09:00:00Z",
          },
        ],
      },
    });
    const latest = await fetchRecentIngestRuns({ ...base, fetchImpl });
    expect(latest[0]?.lastStartedAt).toBe("2026-11-18T09:00:00Z");
    expect(findBlockingRuns(latest, NOW, MAX_AGE_DAYS)).toHaveLength(1);
  });

  it("workflow jamais lancé (liste vide) → aucun run, pas une erreur", async () => {
    const fetchImpl = fakeFetch({ body: { workflow_runs: [] } });
    await expect(fetchRecentIngestRuns({ ...base, fetchImpl })).resolves.toEqual([]);
  });

  it("HTTP 403 (permission actions: read manquante) → throw", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 403 });
    await expect(fetchRecentIngestRuns({ ...base, fetchImpl })).rejects.toThrow(/HTTP 403/);
  });

  it("un seul run illisible dans la page → throw (pas ignoré)", async () => {
    await expect(
      fetchRecentIngestRuns({
        ...base,
        fetchImpl: fakeFetch({
          body: {
            workflow_runs: [
              { status: "completed", conclusion: "success", created_at: "2026-11-18T12:00:00Z" },
              null,
            ],
          },
        }),
      }),
    ).rejects.toThrow(/run illisible/);
  });

  it("réponse sans `workflow_runs`, ou run sans statut → throw", async () => {
    await expect(
      fetchRecentIngestRuns({ ...base, fetchImpl: fakeFetch({ body: { message: "?" } }) }),
    ).rejects.toThrow(/sans workflow_runs/);
    await expect(
      fetchRecentIngestRuns({
        ...base,
        fetchImpl: fakeFetch({ body: { workflow_runs: [{ created_at: "2026-11-18T12:00:00Z" }] } }),
      }),
    ).rejects.toThrow(/illisible/);
  });

  it("réseau en panne → throw tracé", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch;
      await expect(fetchRecentIngestRuns({ ...base, fetchImpl })).rejects.toThrow(/injoignable/);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
