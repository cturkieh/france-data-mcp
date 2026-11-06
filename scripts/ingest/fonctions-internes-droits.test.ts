import { describe, expect, it } from "vitest";
import { allMigrationsSql } from "./migration-sql.js";

// Supabase donne EXECUTE à anon et authenticated sur toute nouvelle fonction de `public`
// (`pg_default_acl`) : `REVOKE ... FROM PUBLIC` seul ne le retire pas. Une fonction interne
// qui oublie ces 2 rôles est appelable avec la clé publique, en SECURITY DEFINER.
const INTERNES_HORS_INGEST = [
  "ameli_count_ban_eligible_rows",
  "ameli_distinct_eligible_keys",
  "ameli_eligible_rows_after_id",
  "ameli_measure_ban_to_geocode",
  "rpps_count_ban_eligible_rows",
  "rpps_distinct_eligible_keys",
  "rpps_eligible_rows_after_id",
  "rpps_geocoded_cache_lookup",
  "rpps_measure_ban_to_geocode",
];

function fonctionsIngestVivantes(sql: string): string[] {
  const vivantes = new Set<string>();
  const declarations =
    /(create\s+(?:or\s+replace\s+)?|drop\s+)function\s+(?:if\s+exists\s+)?(?:public\.)?(ingest_\w+)/g;
  for (const [, geste, nom] of sql.matchAll(declarations)) {
    if (geste?.startsWith("drop")) vivantes.delete(nom as string);
    else vivantes.add(nom as string);
  }
  return [...vivantes];
}

function estReservee(sql: string, nom: string): boolean {
  const revocations = sql.matchAll(
    new RegExp(
      `revoke\\s+(?:execute|all)(?:\\s+privileges)?\\s+on\\s+function\\s+(?:public\\.)?${nom}\\b[^;]*?\\sfrom\\s+([^;]*);`,
      "g",
    ),
  );
  return [...revocations].some(
    (m) => /\banon\b/.test(m[1] as string) && /\bauthenticated\b/.test(m[1] as string),
  );
}

describe("droits des fonctions internes", () => {
  it("anon et authenticated ne peuvent lancer aucune fonction interne", () => {
    const sql = allMigrationsSql();
    const internes = [...fonctionsIngestVivantes(sql), ...INTERNES_HORS_INGEST];
    expect(internes.length).toBeGreaterThan(30);
    expect(internes.filter((nom) => !estReservee(sql, nom))).toEqual([]);
  });
});
