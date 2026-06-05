import { describe, expect, it } from "vitest";
import { allMigrationsSql, latestFunctionBodyLoose } from "./migration-sql.js";

// Garde-fou de la RPC d'énumération KEYSET SUR id `rpps_eligible_rows_after_id`
// (consommée par ban-backfill.mjs — bouton drain BAN RPPS).
//
// POURQUOI elle existe (2 dead-ends prouvés prod 2026-06-05) : (1) keyset sur la
// CLÉ exige un index BAN (orphelin au swap, build-via-RPC = cap passerelle 60 s) ;
// (2) passe unique = ~147k évals de la clé Unicode (~880 µs) en 1 requête > 55 s.
// Le keyset sur la PK `id` borne le nb d'évals/page (~5000 → 4,4 s, MESURÉ).
//
// INVARIANTS GARDÉS :
//  (1) prédicat d'éligibilité BYTE-IDENTIQUE au canonique des sites BAN — sinon
//      l'énumération couvre un set DIFFÉRENT du count → backstop S-1 de
//      ban-backfill.mjs faussé (count>0 mais clés ratées NON détecté) ;
//  (2) clé via le WRAPPER `rpps_address_key_for_index` (parité octet-à-octet avec
//      le cache `geocoded_addresses.address_key` → JOIN qui matche) ;
//  (3) keyset SUR id : `id > $1 ... ORDER BY id LIMIT` (curseur PK, pas de tri
//      sur la clé coûteuse → pas de réévaluation) ;
//  (4) whitelist source (rpps | rpps_staging) — anti-injection.
describe("rpps_eligible_rows_after_id : RPC keyset id (bouton drain RPPS)", () => {
  const body = latestFunctionBodyLoose("rpps_eligible_rows_after_id");
  const norm = body.toLowerCase().replace(/\s+/g, " ");

  it("présente dans les migrations", () => {
    expect(
      body.length,
      "rpps_eligible_rows_after_id introuvable — le bouton drain n'a plus d'énumération",
    ).toBeGreaterThan(0);
  });

  it("calcule la clé via le wrapper rpps_address_key_for_index", () => {
    expect(norm, "n'utilise PAS le wrapper → clés divergentes du cache").toContain(
      "rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)",
    );
  });

  it("prédicat d'éligibilité byte-identique au canonique des sites BAN", () => {
    expect(
      norm,
      "prédicat divergent du canonique → énumère un set != du count (backstop S-1 faussé)",
    ).toContain(
      "where (t.geom_source = 'commune_centroid' or (t.geom is null and t.adresse is not null))",
    );
  });

  it("keyset SUR id : id > $1 ... ORDER BY id LIMIT (curseur PK, pas de tri sur la clé)", () => {
    expect(norm, "pas de borne keyset `id > $1`").toContain("t.id > $1");
    expect(norm, "pas d'ORDER BY id (le keyset PK exige l'ordre id)").toContain("order by t.id");
    expect(norm, "pas de LIMIT $2 (page bornée)").toContain("limit $2");
    // NE DOIT PAS trier sur la clé (réévaluation Unicode = 57014, dead-end prouvé).
    expect(
      norm,
      "ORDER BY sur la clé Unicode → réévaluation par comparaison = 57014 (dead-end)",
    ).not.toMatch(/order by[^;]*rpps_address_key_for_index/);
  });

  it("whitelist source explicite (rpps | rpps_staging), sinon EXCEPTION", () => {
    expect(norm).toContain("when 'rpps' then 'rpps'");
    expect(norm).toContain("when 'rpps_staging' then 'rpps_staging'");
    expect(norm, "pas d'EXCEPTION sur source hors whitelist (anti-injection)").toContain(
      "raise exception",
    );
  });

  it("le drift guard reste ancré sur les migrations réelles (pas un faux vert)", () => {
    expect(allMigrationsSql()).toContain("rpps_eligible_rows_after_id");
  });
});
