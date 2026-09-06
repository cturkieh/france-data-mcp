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
import { SIRET_PATTERN } from "../../src/sante/db-helpers.js";
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
 *    `deptFromCodeInsee` (`territoire/dept-codes.ts`) → skip `bad_commune` ;
 *  - `siret` CHAR(14) : `SIRET_PATTERN` (14 chiffres, `db-helpers`) → `null` +
 *    compteur `siretMalformed` (la borne DDL est impliquée par la regex ; la
 *    parité regex TS ↔ SQL est assertée ci-dessous).
 */
const VALIDATED_ELSEWHERE = new Set(["num_finess", "code_insee", "code_departement", "siret"]);

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

  it("vocabulaire `geom_source` FERMÉ : le CHECK de la staging = les constantes TS, geom ⇔ geom_source, et le repli PROPAGE un point BAN hérité", () => {
    // Depuis 20260906T160000 le garde RÉEL du vocabulaire est la contrainte
    // CHECK (une valeur fantôme fait échouer l'INSERT/UPDATE) : plus besoin de
    // deviner les producteurs en scannant le texte SQL (revue altitude
    // 2026-09-06 — une liste blanche de fonctions mentait sur sa couverture
    // et un `CASE` sans rapport la faisait rougir). Reste ce que le CHECK ne
    // donne pas : sa parité avec `GEOM_SOURCES` TS (un libellé TS absent du
    // CHECK ferait échouer l'INSERT du parseur ; un libellé CHECK absent du TS
    // serait un fantôme côté lib), et la propagation par le repli.
    const sqlSrc = allMigrationsSql();
    const staging = latestFunctionBody(sqlSrc, "ingest_create_finess_staging", {
      stripComments: true,
      compact: true,
    });
    const check = /check \(geom_source in \(([^)]*)\)\)/.exec(staging)?.[1];
    expect(
      check,
      "CHECK du vocabulaire geom_source absent de ingest_create_finess_staging",
    ).toBeDefined();
    const checkValues = [...(check ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "").sort();
    expect(checkValues).toEqual([...Object.values(GEOM_SOURCES)].sort());
    expect(staging, "contrainte geom ⇔ geom_source absente de la staging").toMatch(
      /check \(\(geom is null\) = \(geom_source is null\)\)/,
    );

    // Le repli PROPAGE un point BAN hérité (sinon la pose serait réétiquetée au
    // cron suivant et la feature deviendrait invisible en SQL) — sur la
    // colonne, plus dans `raw`.
    const previous = latestFunctionBody(sqlSrc, "public.ingest_apply_finess_geom_previous", {
      stripComments: true,
      compact: true,
    });
    expect(previous, "dernière def du repli introuvable").not.toBe("");
    // SANS `else` (20260906T180000) : une provenance hors des cas énumérés
    // donne NULL sur un point → contrainte violée → échec LOUD du cron, jamais
    // une dégradation muette en `previous_ingest`.
    expect(previous).toMatch(
      /case when f\.geom_source = 'ban_address' then 'ban_address' when f\.geom_source in \('ans', 'previous_ingest'\) then 'previous_ingest' end/,
    );
    expect(previous).not.toMatch(/\belse\b/);
    expect(previous, "le repli ne doit plus écrire la provenance dans raw").not.toMatch(
      /jsonb_build_object\(\s*'geom_source'/,
    );
  });

  it("format SIRET : la regex TS (`SIRET_PATTERN`) et celle du peuplement SQL (migration 20260906T160000) sont identiques", () => {
    // Le SIRET est validé à trois endroits : le parseur (TS), le peuplement
    // one-shot depuis `raw` (SQL) et, implicitement, la borne CHAR(14). Sans
    // parité, un assouplissement d'un côté (SIREN à 9 chiffres toléré, par
    // ex.) laisserait l'autre nuller en silence. Même discipline que le
    // vocabulaire `geom_source` ci-dessus.
    const sqlSrc = allMigrationsSql();
    const populate =
      /set siret\s*=\s*case when raw->>'siret' ~ '([^']+)' then raw->>'siret' end/.exec(
        sqlSrc.replace(/\s+/g, " "),
      )?.[1];
    expect(populate, "peuplement SQL de finess.siret introuvable").toBeDefined();
    expect(populate).toBe(SIRET_PATTERN.source);
    expect(SIRET_PATTERN.test("x".repeat(14)), "la regex implique la borne CHAR(14)").toBe(false);
    expect(SIRET_PATTERN.test("1".repeat(14))).toBe(true);
    expect(SIRET_PATTERN.test("1".repeat(15))).toBe(false);
  });

  it("toute colonne texte bornée de la DDL est couverte par une règle ou validée ailleurs", () => {
    const uncovered = [...ddl.keys()].filter(
      (c) => !(c in COLUMN_RULES) && !VALIDATED_ELSEWHERE.has(c),
    );
    expect(uncovered, "colonnes VARCHAR/CHAR sans garde côté parseur").toEqual([]);
  });
});
