import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Garde-fou statique du wiring du rebuild `finess_hosted_activities` côté
// cron FINESS. La fonction partagée `rebuildHostedActivities` est testée
// comportementalement via `rpps-hosted-rebuild.test.ts` (qui exerce le même
// code path, juste appelé depuis l'autre cron) — pas besoin de répliquer
// 7 tests de mock supabase ici. Ce qui DOIT être garanti côté FINESS :
//   (a) l'import de `rebuildHostedActivities` est présent ;
//   (b) la fonction est appelée APRÈS `atomicSwapTables({prodTable:"finess"})` ;
//   (c) la marque `log.status = "success"` est défensive (préserve un
//       éventuel "partial" posé par `rebuildHostedActivities`).
//
// Sans (b), un swap finess désynchroniserait silencieusement la matview
// (gotcha OID CLAUDE.md, prouvé prod RPPS 2026-05-18 — symétrique côté finess).
// Sans (c), un échec hosted serait écrasé par "success" et l'observabilité
// perdrait l'incident — régression V0.9 Passe 1 documentée dans rpps.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINESS_SRC = readFileSync(join(__dirname, "finess.ts"), "utf8");

describe("finess.ts wiring du rebuild finess_hosted_activities post-swap", () => {
  it("importe rebuildHostedActivities depuis ./shared.js", () => {
    expect(
      FINESS_SRC,
      "finess.ts n'importe pas rebuildHostedActivities — le hook post-swap est mort",
    ).toMatch(
      /import\s*{[\s\S]*?\brebuildHostedActivities\b[\s\S]*?}\s*from\s*["']\.\/shared\.js["']/,
    );
  });

  it('appelle rebuildHostedActivities(supabase, log, "finess") APRÈS atomicSwapTables({prodTable:"finess"})', () => {
    // Match ordonné : swap d'abord, puis rebuild hosted. Le `[\s\S]*?` non-greedy
    // garantit que le rebuild suit le swap (pas l'inverse) dans la fonction main.
    expect(
      FINESS_SRC,
      "rebuildHostedActivities n'est pas appelée APRÈS le swap finess — la matview restera collée à l'ancien OID",
    ).toMatch(
      /atomicSwapTables\s*\(\s*{\s*prodTable\s*:\s*["']finess["']\s*}\s*\)[\s\S]*?rebuildHostedActivities\s*\(\s*supabase\s*,\s*log\s*,\s*["']finess["']\s*\)/,
    );
  });

  it("préserve log.status='partial' (ne l'écrase pas avec 'success')", () => {
    // Pattern défensif : `if (log.status !== "partial") { log.status = "success" }`.
    // Régression observabilité prouvée V0.9 Passe 1 (cf. commentaire jumeau rpps.ts).
    expect(
      FINESS_SRC,
      "finess.ts marque 'success' sans vérifier 'partial' — un échec hosted serait silencieusement écrasé",
    ).toMatch(
      /if\s*\(\s*log\.status\s*!==\s*["']partial["']\s*\)\s*{?\s*log\.status\s*=\s*["']success["']/,
    );
  });
});
