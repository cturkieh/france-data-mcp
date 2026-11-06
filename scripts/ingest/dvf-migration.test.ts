import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latestFunctionBody, migrationsDir, readAllMigrationsSql } from "./migration-sql.js";

// Garde-fou sur le TEXTE de la migration du chargement national DVF. La parité
// staging/prod, en lisant toutes les migrations, vit dans `staging-parity.test.ts`.

const MIGRATION = "20261106T230000_dvf_chargement_national.sql";
const PREVIOUS_CANARY = "20260922T000500_sitadel_canary_anon_read.sql";

const migration = readFileSync(`${migrationsDir}/${MIGRATION}`, "utf8");
const lower = migration.toLowerCase();
const allSql = readAllMigrationsSql();

/** En-tête d'une fonction : tout ce qui précède son corps (donc ses clauses `SET`). */
function header(fnName: string): string {
  const m = lower.match(
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+${fnName}\\b([\\s\\S]*?)\\bas\\s+\\$\\$`),
  );
  if (!m?.[1]) throw new Error(`en-tête de ${fnName} introuvable`);
  return m[1];
}

describe("dvf_stats_in_radius", () => {
  const body = latestFunctionBody(lower, "dvf_stats_in_radius", {
    stripComments: true,
    compact: true,
  });

  it("porte son budget et son search_path (anon est coupé à 3 s sans lui)", () => {
    const h = header("dvf_stats_in_radius");
    expect(h).toMatch(/set\s+statement_timeout\s*=\s*'15s'/);
    expect(h).toMatch(/set\s+search_path\s*=\s*public,\s*extensions/);
  });

  it("filtre sur la colonne geog indexée, jamais sur un cast", () => {
    expect(body).toContain("st_dwithin(m.geog, v_point, p_radius_meters)");
    expect(body).not.toMatch(/geom/);
  });

  it("agrège sur toute la zone, sans LIMIT : c'est sa raison d'être", () => {
    expect(body).not.toMatch(/\blimit\b/);
  });

  it("reste lisible par anon", () => {
    expect(lower).toMatch(
      /grant execute on function dvf_stats_in_radius\(double precision, double precision, double precision\) to anon;/,
    );
  });
});

describe("fonctions d'ingestion", () => {
  it("les index de la staging précèdent le chargement", () => {
    const body = latestFunctionBody(lower, "ingest_create_dvf_mutations_staging");
    expect(body).toMatch(/create index dvf_mutations_staging_geog_gist .* using gist \(geog\)/);
    expect(body).toMatch(/create index dvf_mutations_staging_code_commune_idx .*\(code_commune\)/);
    expect(body).toMatch(/notify pgrst/);
  });

  it("la staging est reconstruite à chaque run", () => {
    const body = latestFunctionBody(lower, "ingest_create_dvf_mutations_staging");
    expect(body).toMatch(/drop table if exists dvf_mutations_staging cascade/);
  });

  it("l'analyze rend le compte, avec un budget sous le plafond passerelle", () => {
    const h = header("ingest_analyze_dvf_mutations_staging");
    expect(h).toMatch(/returns bigint/);
    expect(h).toMatch(/security definer/);
    expect(h).toMatch(/set\s+statement_timeout\s*=\s*'55s'/);
    const body = latestFunctionBody(lower, "ingest_analyze_dvf_mutations_staging");
    expect(body).toMatch(/analyze dvf_mutations_staging/);
    expect(body).toMatch(/count\(\*\)/);
  });

  it.each(["ingest_create_dvf_mutations_staging", "ingest_analyze_dvf_mutations_staging"])(
    "%s : réservée à service_role",
    (fn) => {
      expect(lower).toContain(
        `revoke execute on function ${fn}() from public, anon, authenticated;`,
      );
      expect(lower).toContain(`grant execute on function ${fn}() to service_role;`);
    },
  );
});

describe("check_ingest_canary", () => {
  // `latestFunctionBody` attend du SQL en minuscules : un corps vide serait un faux vert.
  const body = latestFunctionBody(allSql.toLowerCase(), "check_ingest_canary");
  const previous = latestFunctionBody(
    readFileSync(`${migrationsDir}/${PREVIOUS_CANARY}`, "utf8").toLowerCase(),
    "check_ingest_canary",
  );

  it("la dernière définition est celle de cette migration", () => {
    expect(body).not.toBe("");
    expect(body).toBe(latestFunctionBody(lower, "check_ingest_canary"));
  });

  it("toutes les branches précédentes sont conservées à l'identique", () => {
    const at = previous.indexOf("\n  else\n");
    expect(at).toBeGreaterThan(0);
    expect(body).toContain(previous.slice(0, at));
    for (const source of ["finess", "ameli_ps", "cds", "rpps", "iris", "sitadel", "dvf"]) {
      expect(body).toContain(`p_source = '${source}'`);
    }
  });

  it("branche dvf : communes témoins et lecture anon, avec array_append", () => {
    const at = body.indexOf("p_source = 'dvf'");
    const branch = body.slice(at, body.indexOf("\n  else\n", at));
    expect(branch).toMatch(/d\.code_commune = t\.key_value/);
    expect(branch).toContain("has_table_privilege('anon', 'public.dvf_mutations', 'select')");
    expect(branch).toContain("p.tablename = 'dvf_mutations'");
    expect(branch).toContain(
      "array_append(coalesce(missing, array[]::text[]), 'anon_read_perdue')",
    );
    // `|| 'x'` : 22P02 uniquement dans la branche rouge, donc invisible tant que tout va bien.
    expect(branch).not.toMatch(/\|\|\s*'/);
  });

  it("les 5 canaris sont semés", () => {
    for (const code of ["75115", "69383", "13206", "2A004", "97411"]) {
      expect(migration).toContain(`('dvf', 'code_insee', '${code}',`);
    }
    expect(lower).toMatch(/on conflict do nothing/);
  });
});
