import { describe, expect, it } from "vitest";
import { latestFunctionBody, readAllMigrationsSql } from "./migration-sql.js";

// Garde-fou structurel SANS DB (V0.12.0) — verrouille la PARITÉ du mapping
// `geom_source → geo_precision` sur les 4 RPC RPPS qui le calculent désormais
// + le hardcode `'centroide_commune'::text` de la branche centroïde de
// `rpps_in_radius`. Pattern aligné sur `ban-eligibility-predicate-parity.test.ts`.
//
// Pourquoi : un drift entre les 4 RPC (ex. on rebrande `'etablissement_finess'`
// → `'finess_etab'` dans UNE migration future et on oublie les 3 autres)
// briserait silencieusement le contrat client (`PerResultGeoPrecision` côté
// TS ne narrowait plus, `geo_precision` apparaîtrait inconnu à l'inférence
// LLM, descriptions tools mentent). Aucun TEST runtime ne catche ça (pas de
// fixture seed RPPS en local) → c'est exactement la classe « drift de
// prédicat SQL inter-migrations » que ce repo a déjà identifié comme P1
// (cf. post-mortem 2026-05-18 `ban-eligibility-predicate-parity`).
//
// Méthode : on lit la DERNIÈRE définition de chaque RPC via `latestFunctionBody`
// (strict, ancre `$$…$$` tolérante au tag), on compacte les espaces, et on
// valide la présence BYTE-IDENTIQUE des fragments canoniques. Pas de regex
// fragile sur du texte free-form — on cherche des substrings normalisés.
//
// SOURCE DE VÉRITÉ du mapping (= ce que `PerResultGeoPrecision` côté TS attend
// au boundary public) :
//
//   ban_address      → 'adresse'
//   finess_join      → 'etablissement_finess'
//   commune_centroid → 'centroide_commune'
//
// Si UN futur PR change UNE de ces 3 valeurs dans UNE seule RPC, ce test
// échoue bruyamment AVANT le merge. Le fix est ALORS soit revert (drift
// involontaire), soit propager les 5 sites en cohérence + adapter
// `PerResultGeoPrecision` + `RawRppsRow.geo_precision` + descriptions tools
// + tests régression (un changement de contrat public, majeur).

const MAPPING_CANONICAL = [
  { source: "'ban_address'", precision: "'adresse'" },
  { source: "'finess_join'", precision: "'etablissement_finess'" },
  { source: "'commune_centroid'", precision: "'centroide_commune'" },
] as const;

/**
 * Compacte le corps d'une fonction : whitespace collapsé, lowercased. Préserve
 * les littéraux SQL (quotes simples) pour qu'un `WHEN 'ban_address' THEN 'adresse'`
 * reste détectable même réparti sur plusieurs lignes verbatim dans la migration.
 */
function compactBody(body: string): string {
  return body.replace(/\s+/g, " ").toLowerCase().trim();
}

describe("RPPS geo_precision mapping parity (V0.12.0)", () => {
  // `latestFunctionBody` matche un pattern lowercased (`create or replace
  // function`) — on lui passe le SQL lowercased pour qu'il trouve les corps
  // RPC déclarés en `CREATE OR REPLACE FUNCTION` (idem pattern d'usage de
  // `ban-eligibility-predicate-parity.test.ts:153`).
  const sql = readAllMigrationsSql().toLowerCase();

  // 4 RPC + le 5e site = hardcode `'centroide_commune'::text AS geo_precision`
  // dans la branche centroïde de `rpps_in_radius` (cas commune_centroid n'est
  // PAS dans le CASE de la branche `precise` — il appartient à la CTE
  // `centroid` qui ne mappe pas un geom_source mais émet directement la
  // valeur — d'où la dissymétrie 2-WHEN dans precise vs 3-WHEN dans les 3 autres).
  const FUNCTIONS_WITH_FULL_3WAY_MAPPING = [
    "rpps_search_by_name",
    "rpps_par_specialite_dept",
    "rpps_lookup_by_id",
  ] as const;

  for (const fnName of FUNCTIONS_WITH_FULL_3WAY_MAPPING) {
    it(`${fnName} : dernière def contient les 3 paires canoniques du mapping`, () => {
      const body = compactBody(latestFunctionBody(sql, fnName, { stripComments: true }));
      expect(body, `corps de ${fnName} introuvable (regex \\$tag\\$ ?)`).not.toBe("");

      for (const { source, precision } of MAPPING_CANONICAL) {
        // Forme canonique normalisée : `when 'ban_address' then 'adresse'` etc.
        // Le `lower()` (compactBody) + l'absence d'alias dans le pattern sont
        // robustes aux variations de quoting / alias `c.`/`r.` (la quote
        // SQL ne change pas et le pattern matche juste la PAIRE).
        const fragment = `when ${source} then ${precision}`;
        expect(
          body.includes(fragment),
          `${fnName} : fragment manquant ou modifié — attendu "${fragment}" (CASE WHEN canonique V0.12.0). Si le wording du label public change, propager les 5 sites + PerResultGeoPrecision + descriptions tools.`,
        ).toBe(true);
      }
    });
  }

  it("rpps_in_radius : branche precise mappe ban_address + finess_join, branche centroid hardcode 'centroide_commune'", () => {
    const body = compactBody(latestFunctionBody(sql, "rpps_in_radius", { stripComments: true }));
    expect(body, "corps de rpps_in_radius introuvable").not.toBe("");

    // La branche `precise` mappe UNIQUEMENT 2 sources (ban_address, finess_join)
    // — `commune_centroid` est filtré OUT par `WHERE r.geom_source IN
    // ('finess_join','ban_address')`. La 3e valeur est posée par la CTE
    // `centroid` ailleurs comme literal.
    for (const source of ["'ban_address'", "'finess_join'"] as const) {
      const precision = MAPPING_CANONICAL.find((m) => m.source === source)?.precision;
      expect(precision, "invariant test : source attendue connue").toBeDefined();
      const fragment = `when ${source} then ${precision}`;
      expect(
        body.includes(fragment),
        `rpps_in_radius branche precise : fragment manquant "${fragment}"`,
      ).toBe(true);
    }

    // Et la branche centroïde hardcode le label final (pas un CASE WHEN, juste
    // une projection literal). Forme canonique compactée.
    expect(
      body.includes("'centroide_commune'::text as geo_precision"),
      "rpps_in_radius branche centroid : literal 'centroide_commune'::text AS geo_precision absent ou modifié",
    ).toBe(true);
  });

  it("aucune RPC n'utilise une source OU une valeur de precision en dehors du set canonique", () => {
    // Filet contre :
    //  (a) une 4e PRÉCISION introduite par étourderie (ex. `THEN 'imprecis'`,
    //      `'iris'`, `'pkn'`) — le LLM caller ne saurait pas la mapper sur ses
    //      3 narrations connues ;
    //  (b) un 4e GEOM_SOURCE introduit côté DB (ex. `WHEN 'iris_address'`)
    //      sans mise à jour du set canonique — la PRÉCISION peut être valide
    //      mais le test S1 code-reviewer pointait le faux vert latent : avec
    //      un regex LHS whitelisté, l'ajout de `WHEN 'new_source' THEN 'imprecis'`
    //      ne serait PAS détecté (LHS hors whitelist court-circuite la capture).
    // Le regex est donc LARGE (`WHEN '<any>' THEN '<any>'`) et la validation
    // se fait par appartenance aux DEUX sets canoniques (sources + valeurs).
    const allBodies = [
      "rpps_in_radius",
      "rpps_search_by_name",
      "rpps_par_specialite_dept",
      "rpps_lookup_by_id",
    ]
      .map((fn) => compactBody(latestFunctionBody(sql, fn, { stripComments: true })))
      .join("\n");

    const allowedSources = new Set<string>(MAPPING_CANONICAL.map((m) => m.source));
    const allowedValues = new Set<string>(MAPPING_CANONICAL.map((m) => m.precision));
    const pairRe = /when\s+'([^']+)'\s+then\s+'([^']+)'/g;
    const violations: string[] = [];
    for (const m of allBodies.matchAll(pairRe)) {
      const [, source, value] = m;
      const sourceLit = `'${source}'`;
      const valueLit = `'${value}'`;
      // Filtre : on ne ramasse QUE les paires `WHEN '<x>' THEN '<y>'` qui
      // ressemblent à un mapping geom_source/geo_precision (la source ou la
      // valeur appartiennent au set canonique). Sinon faux positifs sur des
      // CASE WHEN non liés (statuts, libellés, …) ailleurs dans le corps.
      const looksLikeMapping = allowedSources.has(sourceLit) || allowedValues.has(valueLit);
      if (!looksLikeMapping) continue;
      if (!allowedSources.has(sourceLit)) {
        violations.push(`source '${source}' → '${value}' (source hors set canonique)`);
      } else if (!allowedValues.has(valueLit)) {
        violations.push(`'${source}' → valeur '${value}' (valeur hors set canonique)`);
      }
    }
    expect(
      violations,
      `mapping non canonique détecté : ${violations.join(", ")}. Sets autorisés : sources={ban_address, finess_join, commune_centroid}, précisions={adresse, etablissement_finess, centroide_commune}.`,
    ).toEqual([]);
  });
});
