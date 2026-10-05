import { describe, expect, it } from "vitest";
import { latestFunctionBody, readAllMigrationsSql } from "./migration-sql.js";

// Garde-fou structurel SANS DB — RPC `dvf_in_radius` (FRANCE-DATA-MCP-T,
// migration 20261005T100000). Le budget `statement_timeout` est gardé par
// `lookup-statement-timeout.test.ts` ; ici, les deux invariants propres à DVF :
//  1. le filtre spatial porte sur la colonne `geog` indexée GiST, JAMAIS sur un
//     cast runtime `geom::geography` (l'index GiST(geom) devient inutilisable →
//     Parallel Seq Scan sur toute la table, prouvé prod) ;
//  2. la sortie est un RETURNS TABLE explicite sans `geom` ni `geog` (avec
//     `SETOF dvf_mutations`, ces colonnes partiraient en hex EWKB hors du
//     contrat TS `DvfMutation`, vers les consommateurs de la lib publique).

const sql = readAllMigrationsSql().toLowerCase();

describe("dvf_in_radius — filtre indexable et sortie conforme à DvfMutation", () => {
  it("filtre sur m.geog, jamais sur un cast geom::geography", () => {
    const body = latestFunctionBody(sql, "dvf_in_radius", { stripComments: true, compact: true });
    expect(body, "corps de dvf_in_radius introuvable").not.toBe("");
    expect(
      body,
      "cast runtime geom::geography → index GiST(geom) inutilisable → Parallel Seq Scan (FRANCE-DATA-MCP-T)",
    ).not.toMatch(/geom\s*::\s*geography/);
    expect(body).toMatch(/st_dwithin\(\s*m\.geog\s*,/);
  });

  it("déclare un RETURNS TABLE explicite sans geom ni geog", () => {
    const re =
      /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?dvf_in_radius\b([\s\S]*?)\bas\s+\$/g;
    let header = "";
    for (const m of sql.matchAll(re)) header = m[1] ?? "";
    expect(header, "en-tête de dvf_in_radius introuvable").not.toBe("");
    expect(header, "RETURNS SETOF dvf_mutations exposerait geom/geog").not.toMatch(/setof/);
    const at = header.indexOf("returns table");
    expect(at, "dvf_in_radius doit déclarer un RETURNS TABLE explicite").toBeGreaterThanOrEqual(0);
    const returns = header.slice(at);
    expect(returns).not.toMatch(/\bgeom\b/);
    expect(returns).not.toMatch(/\bgeog\b/);
  });

  it("une colonne geog GÉNÉRÉE et son index GiST existent sur dvf_mutations", () => {
    expect(sql).toMatch(
      /alter\s+table\s+dvf_mutations\s+add\s+column\s+if\s+not\s+exists\s+geog\s+geography\s+generated\s+always\s+as\s+\(\(geom::geography\)\)\s+stored/,
    );
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+dvf_mutations_geog_gist\s+on\s+dvf_mutations\s+using\s+gist\s*\(\s*geog\s*\)/,
    );
  });
});
