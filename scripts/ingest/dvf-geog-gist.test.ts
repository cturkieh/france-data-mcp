import { describe, expect, it } from "vitest";
import { readAllMigrationsSql } from "./migration-sql.js";

// Garde-fou structurel SANS DB (FRANCE-DATA-MCP-T, migration 20261005T100000) :
// un filtre spatial sur un cast runtime `geom::geography` rend l'index GiST(geom)
// inutilisable → Parallel Seq Scan sur toute la table, prouvé prod. Les lectures
// DVF s'appuient sur la colonne `geog` et son index.

const sql = readAllMigrationsSql().toLowerCase();

describe("dvf_mutations — colonne geog indexée", () => {
  it("une colonne geog GÉNÉRÉE et son index GiST existent sur dvf_mutations", () => {
    expect(sql).toMatch(
      /alter\s+table\s+dvf_mutations\s+add\s+column\s+if\s+not\s+exists\s+geog\s+geography\s+generated\s+always\s+as\s+\(\s*case\s+when\s+longitude\s+is\s+not\s+null\s+and\s+latitude\s+is\s+not\s+null\s+then\s+st_setsrid\(st_makepoint\(longitude,\s*latitude\),\s*4326\)::geography\s+end\s*\)\s+stored/,
    );
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+dvf_mutations_geog_gist\s+on\s+dvf_mutations\s+using\s+gist\s*\(\s*geog\s*\)/,
    );
  });
});
