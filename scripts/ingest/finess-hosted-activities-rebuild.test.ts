import { describe, expect, it } from "vitest";
import {
  allMigrationsSql,
  latestFunctionBodyLoose as latestFunctionBody,
} from "./migration-sql.js";

// Garde-fou structurel — sans DB, lit les migrations.
//
// Classe de bug visée : `finess_hosted_activities` est une matview définie
// `... FROM rpps r JOIN finess f ON f.num_finess = r.num_finess ...`. En
// PostgreSQL une matview référence ses tables source par OID. La matview
// joint DEUX tables swappées :
//   - `rpps`  swap mensuel  (cron RPPS,  `ingest_atomic_swap('rpps')`)
//   - `finess` swap bimestriel (cron FINESS, `ingest_atomic_swap('finess')`)
// Un swap de l'une OU l'autre suffit à désynchroniser la matview (suit
// l'OID de la table swappée → données stales sans erreur, status `success`),
// puis le DROP CASCADE du 2e swap consécutif détruit la matview → `42P01`.
// Cf. gotcha CLAUDE.md « Matview FROM <table swappée> + post-swap REFRESH-only
// = bombe OID », prouvée prod RPPS 2026-05-18, fix appliqué via
// `ingest_rebuild_rpps_matviews` (modèle de cette fonction).
//
// Invariant garanti ici : le post-swap RECONSTRUIT la matview (DROP +
// CREATE _rebuild résolu PAR NOM + RENAME atomique) — JAMAIS REFRESH — via
// `ingest_rebuild_finess_hosted_activities`. Hookée dans les crons RPPS et
// FINESS (cf. tests d'intégration des crons).

function matviewSelectCore(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+materialized\\s+view\\s+(?:if\\s+not\\s+exists\\s+)?${name}\\b\\s+as\\b([\\s\\S]*?);`,
    "i",
  );
  const m = sql.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

describe("fix matview/swap finess_hosted_activities : reconstruction post-swap (pas REFRESH-only)", () => {
  it("ingest_rebuild_finess_hosted_activities DROP + CREATE _rebuild + RENAME (jamais REFRESH)", () => {
    const body = latestFunctionBody("ingest_rebuild_finess_hosted_activities");
    expect(
      body.length,
      "fonction ingest_rebuild_finess_hosted_activities absente — la matview suit l'OID des tables swappées (bombe armée)",
    ).toBeGreaterThan(0);

    // (a) reconstruction : CREATE MATERIALIZED VIEW finess_hosted_activities_rebuild
    //     ... FROM grouped g JOIN finess f ... — `rpps` (dans CTE bio/pharma/img)
    //     ET `finess` (join principal) résolus PAR NOM au moment du CREATE.
    expect(
      body,
      "pas de CREATE MATERIALIZED VIEW finess_hosted_activities_rebuild dans la fonction rebuild",
    ).toMatch(
      /create\s+materialized\s+view\s+finess_hosted_activities_rebuild\b[\s\S]*?from\s+grouped\s+g\b[\s\S]*?join\s+finess\s+f\b/i,
    );

    // (b) bascule atomique : DROP de la matview en place + RENAME du _rebuild
    expect(body, "pas de DROP MATERIALIZED VIEW finess_hosted_activities (étape bascule)").toMatch(
      /drop\s+materialized\s+view\s+(?:if\s+exists\s+)?finess_hosted_activities\b/i,
    );
    expect(
      body,
      "pas de ALTER MATERIALIZED VIEW finess_hosted_activities_rebuild RENAME TO finess_hosted_activities",
    ).toMatch(
      /alter\s+materialized\s+view\s+finess_hosted_activities_rebuild\s+rename\s+to\s+finess_hosted_activities\b/i,
    );

    // (c) JAMAIS REFRESH — le pattern OID exige reconstruction, pas refresh.
    expect(
      body,
      "ingest_rebuild_finess_hosted_activities contient REFRESH MATERIALIZED VIEW — bombe OID armée",
    ).not.toMatch(/refresh\s+materialized\s+view/i);
  });

  it("parité DDL : le SELECT _rebuild == celui de la matview canonique (anti-drift silencieux)", () => {
    const fnBody = latestFunctionBody("ingest_rebuild_finess_hosted_activities");
    const migs = allMigrationsSql();
    const canonical = matviewSelectCore(migs, "finess_hosted_activities");
    expect(
      canonical.length,
      "SELECT canonique de finess_hosted_activities introuvable",
    ).toBeGreaterThan(0);
    const rebuilt = matviewSelectCore(fnBody, "finess_hosted_activities_rebuild");
    expect(
      rebuilt,
      `SELECT de finess_hosted_activities_rebuild dans la fonction rebuild diverge de la migration canonique (drift = données fausses servies en prod). Canonique="${canonical}" Rebuild="${rebuilt}"`,
    ).toBe(canonical);
  });
});
