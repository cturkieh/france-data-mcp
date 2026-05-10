import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CATEGORIE_CODES_DEFAUT,
  CATEGORIE_CODES_OFFICIELS,
  CATEGORIE_CODE_AGENT_PUBLIC,
  CATEGORIE_CODE_CIVIL,
  CATEGORIE_CODE_ETUDIANT,
  buildCategorieCodes,
} from "./rpps-db.js";

// Pure unit tests pour les helpers catégorie ANS TRE_R09. Verrouille le
// contrat contre la dérive vers les codes fictifs `R`/`S`/`D` (jamais en
// base — l'ANS pré-filtre `PS_LibreAcces_Personne_activite` aux actifs).

describe("CATEGORIE_CODES_OFFICIELS", () => {
  it("matches the 3 codes effectively present in the ANS extraction (TRE_R09 minus deprecated F)", () => {
    expect([...CATEGORIE_CODES_OFFICIELS]).toEqual(["C", "E", "M"]);
  });

  it("never includes the deprecated F code (merged into M on 2026-02-23)", () => {
    expect(CATEGORIE_CODES_OFFICIELS).not.toContain("F");
  });

  it("never includes fictional codes R/S/D (active-only ANS pre-filter)", () => {
    for (const code of ["R", "S", "D"]) {
      expect(CATEGORIE_CODES_OFFICIELS).not.toContain(code);
    }
  });
});

describe("CATEGORIE_CODES_DEFAUT", () => {
  it("defaults to Civils only — agents publics and étudiants are opt-in", () => {
    expect([...CATEGORIE_CODES_DEFAUT]).toEqual([CATEGORIE_CODE_CIVIL]);
  });
});

describe("buildCategorieCodes", () => {
  it("returns Civils only when no flag is set", () => {
    expect(buildCategorieCodes({})).toEqual(["C"]);
    expect(buildCategorieCodes({ includeEtudiants: false, includeAgentsPublics: false })).toEqual([
      "C",
    ]);
  });

  it("adds Agents publics (M) when includeAgentsPublics is true", () => {
    expect(buildCategorieCodes({ includeAgentsPublics: true })).toEqual([
      CATEGORIE_CODE_CIVIL,
      CATEGORIE_CODE_AGENT_PUBLIC,
    ]);
  });

  it("adds Étudiants (E) when includeEtudiants is true", () => {
    expect(buildCategorieCodes({ includeEtudiants: true })).toEqual([
      CATEGORIE_CODE_CIVIL,
      CATEGORIE_CODE_ETUDIANT,
    ]);
  });

  it("includes all 3 codes when both flags are true", () => {
    const all = buildCategorieCodes({ includeEtudiants: true, includeAgentsPublics: true });
    expect(all).toEqual(["C", "M", "E"]);
    // Sanity check : same set as the official list (order-insensitive)
    expect([...all].sort()).toEqual([...CATEGORIE_CODES_OFFICIELS].sort());
  });

  it("never returns an empty array — the default Civil is always present", () => {
    // Empty array would silently cancel the SQL filter (cardinality = 0 →
    // default `[C]` SQL-side, but defensive contract here too).
    expect(buildCategorieCodes({}).length).toBeGreaterThan(0);
    expect(buildCategorieCodes({ includeEtudiants: true }).length).toBeGreaterThan(0);
  });
});

// Verrouille la 4-way sync entre TS const, TS function literal, SQL helper
// `rpps_categorie_match` et SQL RPC `rpps_par_specialite_dept` COALESCE.
// Sans ce test, un dev qui change `CATEGORIE_CODE_CIVIL = 'X'` côté TS
// passerait tsc/tests verts mais laisserait le SQL sur 'C' → résultat
// silencieusement vide ou incohérent en prod.
describe("V0.5.5 default — TS/SQL sync", () => {
  const migrationPath = join(
    __dirname,
    "../../supabase/migrations/20260510T040000_rpps_v055_categorie_codes_default_civil.sql",
  );
  // Strip les commentaires SQL (-- ... fin de ligne) pour ne matcher que le
  // code exécutable. Sinon un test passerait à vide tant qu'un commentaire
  // mentionne le pattern, même si le code SQL réel a divergé.
  const migrationSql = readFileSync(migrationPath, "utf-8").replace(/--[^\n]*/g, "");

  it("la migration SQL utilise le même default `[C]` que CATEGORIE_CODES_DEFAUT", () => {
    const defaultCode = CATEGORIE_CODES_DEFAUT[0];
    expect(defaultCode).toBe("C");
    // Helper SQL : `p_code = 'C' OR p_code IS NULL` quand cardinality(p_codes)=0
    expect(migrationSql).toMatch(new RegExp(`p_code\\s*=\\s*'${defaultCode}'\\s+OR`));
    // RPC EXECUTE format : COALESCE(NULLIF(...), ARRAY['C'])
    expect(migrationSql).toMatch(new RegExp(`ARRAY\\[\\s*'${defaultCode}'\\s*\\]`));
  });
});
