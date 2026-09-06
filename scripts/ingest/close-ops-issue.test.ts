import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Branche `close` de l'émetteur unique d'issues ops. Le fichier est un `.cjs`
// (contrainte `actions/github-script`, qui charge un module externe par
// `require` sans transpilation) : on le charge ICI comme le runner le fait,
// par `require` — le test prouve donc AUSSI que le module est chargeable en
// CommonJS, la panne qui rendrait la fermeture muette en prod.
const require_ = createRequire(import.meta.url);

type Outcome = "closed" | "absent" | "failed";
interface CloseArgs {
  github: unknown;
  context: unknown;
  core: unknown;
  labels: string[];
  comment: string;
  runUrl: string;
}
const { closeOpsIssue } = require_(
  "../../.github/actions/upsert-ops-issue/close-ops-issue.cjs",
) as { closeOpsIssue: (args: CloseArgs) => Promise<Outcome> };

const context = { repo: { owner: "cturkieh", repo: "france-data-mcp" } };

function fakeCore() {
  return { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
}

interface IssueRow {
  number: number;
  pull_request?: unknown;
}

function fakeGithub(
  rows: IssueRow[],
  fail?: { on: "list" | "comment" | "update"; message: string },
) {
  const listForRepo = vi.fn(async (params: unknown) => {
    if (fail?.on === "list") throw new Error(fail.message);
    void params;
    return { data: rows };
  });
  const createComment = vi.fn(async (params: unknown) => {
    if (fail?.on === "comment") throw new Error(fail.message);
    void params;
    return {};
  });
  const update = vi.fn(async (params: unknown) => {
    if (fail?.on === "update") throw new Error(fail.message);
    void params;
    return {};
  });
  return {
    github: { rest: { issues: { listForRepo, createComment, update } } },
    calls: { listForRepo, createComment, update },
  };
}

const RUN_URL = "https://github.com/cturkieh/france-data-mcp/actions/runs/42";

describe("closeOpsIssue — fermeture best-effort de l'issue de surveillance", () => {
  it("labels VIDES → refus BRUYANT, AUCUN appel API (un filtre vide fermerait tout le dépôt)", async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([{ number: 1 }]);
    const outcome = await closeOpsIssue({
      github,
      context,
      core,
      labels: [],
      comment: "peu importe",
      runUrl: RUN_URL,
    });
    expect(outcome).toBe("failed");
    expect(calls.listForRepo).not.toHaveBeenCalled();
    expect(core.error).toHaveBeenCalledTimes(1);
    expect(core.error.mock.calls[0]?.[0]).toMatch(/labels VIDES/);
  });

  it("aucune issue ouverte → `absent` (cas nominal : rien à fermer, aucun bruit)", async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([]);
    const outcome = await closeOpsIssue({
      github,
      context,
      core,
      labels: ["pending-geocode", "ameli"],
      comment: "✅ File vidée",
      runUrl: RUN_URL,
    });
    expect(outcome).toBe("absent");
    expect(calls.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ state: "open", labels: "pending-geocode,ameli" }),
    );
    expect(calls.createComment).not.toHaveBeenCalled();
    expect(calls.update).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.error).not.toHaveBeenCalled();
  });

  it("issue ouverte → commentaire PUIS fermeture `completed` (le commentaire explique la fermeture)", async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([{ number: 56 }]);
    const outcome = await closeOpsIssue({
      github,
      context,
      core,
      labels: ["pending-geocode", "ameli"],
      comment:
        "✅ File vidée par le drain du 2026-09-06 12:00 UTC : 0 adresses traitées, 0 acceptées.",
      runUrl: RUN_URL,
    });
    expect(outcome).toBe("closed");
    expect(calls.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 56, body: expect.stringContaining("File vidée") }),
    );
    expect(calls.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 56, state: "closed", state_reason: "completed" }),
    );
    // Ordre : commenter AVANT de fermer (sinon la trace arrive sur une issue close).
    expect(calls.createComment.mock.invocationCallOrder[0]).toBeLessThan(
      calls.update.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("plusieurs issues ouvertes portant les labels → toutes fermées (aucune orpheline)", async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([{ number: 56 }, { number: 63 }]);
    const outcome = await closeOpsIssue({
      github,
      context,
      core,
      labels: ["pending-geocode", "rpps"],
      comment: "✅ File vidée",
      runUrl: RUN_URL,
    });
    expect(outcome).toBe("closed");
    expect(
      calls.update.mock.calls.map((c) => (c[0] as { issue_number: number }).issue_number),
    ).toEqual([56, 63]);
  });

  it("les pull requests renvoyées par listForRepo sont ÉCARTÉES (même endpoint côté API)", async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([{ number: 70, pull_request: { url: "…" } }]);
    const outcome = await closeOpsIssue({
      github,
      context,
      core,
      labels: ["pending-geocode", "ameli"],
      comment: "✅ File vidée",
      runUrl: RUN_URL,
    });
    expect(outcome).toBe("absent");
    expect(calls.update).not.toHaveBeenCalled();
  });

  it("API en panne → `failed` + LOUD (warning), JAMAIS de throw (le drain a réussi)", async () => {
    const core = fakeCore();
    const { github } = fakeGithub([{ number: 56 }], { on: "update", message: "503 upstream" });
    const outcome = await closeOpsIssue({
      github,
      context,
      core,
      labels: ["pending-geocode", "ameli"],
      comment: "✅ File vidée",
      runUrl: RUN_URL,
    });
    expect(outcome).toBe("failed");
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning.mock.calls[0]?.[0]).toMatch(/503 upstream/);
    expect(core.warning.mock.calls[0]?.[0]).toMatch(/pending-geocode,ameli/);
  });

  it("commentaire vide → repli explicite pointant le run (jamais un commentaire vide)", async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([{ number: 56 }]);
    await closeOpsIssue({
      github,
      context,
      core,
      labels: ["pending-geocode", "ameli"],
      comment: "",
      runUrl: RUN_URL,
    });
    expect((calls.createComment.mock.calls[0]?.[0] as { body: string }).body).toContain(RUN_URL);
  });
});
