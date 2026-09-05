/**
 * Parité `COLUMN_RULES` (finess-ans-parse.ts) ↔ DDL de `finess_staging`
 * (`ingest_create_finess_staging`, dernière def dans les migrations).
 *
 * Pourquoi : les bornes des colonnes texte sont recopiées en TS pour que le
 * parseur mette à `null` (et compte) une valeur qui violerait sa colonne au
 * lieu de faire échouer 104 734 lignes en 22001 — ce qui est arrivé au premier
 * dry-run (2026-09-05, un téléphone de 21 caractères). Une vérité SQL recopiée
 * en TS dérive : un élargissement de colonne en phase 2 laisserait la règle
 * trop étroite (champs nullés sans erreur), un rétrécissement la laisserait
 * trop large (22001 de retour). Même famille de garde que `staging-parity`.
 */

import { describe, expect, it } from "vitest";
import { COLUMN_RULES, GEOM_SOURCES, type OverflowField } from "./finess-ans-parse.js";
import { allMigrationsSql, latestFunctionBody } from "./migration-sql.js";

interface DdlTextColumn {
  kind: "VARCHAR" | "CHAR";
  length: number;
}

/** Colonnes `VARCHAR(n)` / `CHAR(n)` de `finess_staging`, depuis la dernière def SQL. */
function stagingTextColumns(): Map<string, DdlTextColumn> {
  const body = latestFunctionBody(allMigrationsSql(), "ingest_create_finess_staging", {
    stripComments: true,
  });
  const columnsSql = /CREATE TABLE finess_staging\s*\(([\s\S]*?)\);/i.exec(body)?.[1];
  if (columnsSql === undefined) {
    throw new Error("CREATE TABLE finess_staging introuvable dans la dernière def");
  }
  const out = new Map<string, DdlTextColumn>();
  for (const [, name, kind, length] of columnsSql.matchAll(
    /^\s*(\w+)\s+(VARCHAR|CHAR)\((\d+)\)/gim,
  )) {
    if (name === undefined || kind === undefined || length === undefined) continue;
    out.set(name, { kind: kind.toUpperCase() as DdlTextColumn["kind"], length: Number(length) });
  }
  return out;
}

/**
 * Colonnes texte bornées de la DDL validées AILLEURS que par `COLUMN_RULES`
 * (une valeur hors format y écarte l'EGE au lieu de nuller le champ) :
 *  - `num_finess` CHAR(9) : PK, regex `NUM_FINESS_EGE` → skip `bad_finess_id` ;
 *  - `code_insee` CHAR(5) / `code_departement` CHAR(3) : `isValidCodeInsee` +
 *    `deptFromCodeInsee` (`territoire/dept-codes.ts`) → skip `bad_commune`.
 */
const VALIDATED_ELSEWHERE = new Set(["num_finess", "code_insee", "code_departement"]);

describe("COLUMN_RULES ↔ DDL finess_staging", () => {
  const ddl = stagingTextColumns();

  it("la DDL expose bien des colonnes texte bornées (le test n'est pas aveugle)", () => {
    expect(ddl.size).toBeGreaterThanOrEqual(6);
    expect(ddl.get("telephone")).toEqual({ kind: "VARCHAR", length: 20 });
  });

  it("chaque règle correspond à une colonne de la DDL et à sa borne exacte", () => {
    for (const [field, rule] of Object.entries(COLUMN_RULES) as [
      OverflowField,
      (v: string) => boolean,
    ][]) {
      const col = ddl.get(field);
      expect(col, `${field} : colonne absente de la DDL`).toBeDefined();
      if (!col) continue;
      const atBound = "x".repeat(col.length);
      const overBound = "x".repeat(col.length + 1);
      expect(rule(atBound), `${field} : doit accepter ${col.length} caractères`).toBe(true);
      expect(rule(overBound), `${field} : doit refuser ${col.length + 1} caractères`).toBe(false);
      if (col.kind === "CHAR") {
        // CHAR(n) padde en silence une valeur plus courte : la règle doit
        // exiger la longueur exacte, pas seulement une borne haute.
        expect(
          rule("x".repeat(col.length - 1)),
          `${field} : CHAR(${col.length}) exige la longueur exacte`,
        ).toBe(false);
      }
    }
  });

  it("le littéral SQL de provenance `previous_ingest` (RPC de repli) = la constante TS (source unique)", () => {
    // `raw->>'geom_source'` est écrit par deux producteurs : le parseur TS
    // (`GEOM_SOURCES.ANS`) et le PL/pgSQL du repli. Une divergence de
    // libellé ne se verrait que dans la clé `staging_geom_source` du log de
    // diff, que personne ne relit ligne à ligne.
    // Déclarée schéma-qualifiée (`public.…`) : `latestFunctionBody` matche le
    // nom tel qu'écrit après `FUNCTION`, préfixe compris.
    const body = latestFunctionBody(
      allMigrationsSql(),
      "public.ingest_apply_finess_geom_previous",
      {
        stripComments: true,
      },
    );
    expect(body, "def de la RPC introuvable dans les migrations").not.toBe("");
    expect(body).toContain(`jsonb_build_object('geom_source', '${GEOM_SOURCES.PREVIOUS_INGEST}')`);
  });

  it("toute colonne texte bornée de la DDL est couverte par une règle ou validée ailleurs", () => {
    const uncovered = [...ddl.keys()].filter(
      (c) => !(c in COLUMN_RULES) && !VALIDATED_ELSEWHERE.has(c),
    );
    expect(uncovered, "colonnes VARCHAR/CHAR sans garde côté parseur").toEqual([]);
  });
});
