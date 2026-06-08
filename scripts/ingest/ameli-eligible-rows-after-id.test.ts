import { describe, expect, it } from "vitest";
import { allMigrationsSql, latestFunctionBodyLoose } from "./migration-sql.js";

// Garde-fou de la RPC d'énumération KEYSET SUR id `ameli_eligible_rows_after_id`
// (consommée par ban-backfill.mjs --source ameli — bouton drain BAN Ameli).
//
// JUMEAU EXACT du guard RPPS `rpps-eligible-rows-after-id.test.ts`, à UNE
// différence load-bearing près : le prédicat d'éligibilité AMELI est
// `geom_source='commune_centroid' AND adresse IS NOT NULL` — SANS la branche
// `OR (geom IS NULL ...)` de RPPS (Ameli n'a pas de FINESS-join → son seul état
// non géocodé est le centroïde commune). Copier la forme RPPS ferait diverger
// l'énumération du count `ameli_count_ban_eligible_rows` → backstop S-1 faussé.
//
// POURQUOI cette RPC existe (remplace l'énumération par CLÉ `ameli_distinct_
// eligible_keys`) : le keyset sur la clé d'adresse exigeait un index BAN sur la
// table LIVE `annuaire_ameli`, ORPHÉLINÉ à chaque swap du cron hebdo (recréation
// manuelle avant chaque drain). Le keyset sur la PK `id` (toujours indexée) borne
// le nb d'évals de la clé Unicode par page SANS aucun index BAN — cf.
// docs/plans/automatisation-backfill-ban.md.
//
// INVARIANTS GARDÉS (identiques au guard RPPS) :
//  (1) prédicat d'éligibilité Ameli byte-identique au canonique → set énuméré ==
//      set compté (sinon backstop S-1 faussé) ;
//  (2) clé via le WRAPPER `rpps_address_key_for_index` (parité octet-à-octet avec
//      le cache `geocoded_addresses.address_key` → JOIN qui matche) ;
//  (3) keyset SUR id : `id > $1 ... ORDER BY id LIMIT` (curseur PK, pas de tri
//      sur la clé coûteuse → pas de réévaluation Unicode = pas de 57014) ;
//  (4) whitelist source (annuaire_ameli | annuaire_ameli_staging) — anti-injection.
describe("ameli_eligible_rows_after_id : RPC keyset id (bouton drain Ameli)", () => {
  const body = latestFunctionBodyLoose("ameli_eligible_rows_after_id");
  const norm = body.toLowerCase().replace(/\s+/g, " ");

  it("présente dans les migrations", () => {
    expect(
      body.length,
      "ameli_eligible_rows_after_id introuvable — le bouton drain Ameli n'a plus d'énumération",
    ).toBeGreaterThan(0);
  });

  it("calcule la clé via le wrapper rpps_address_key_for_index", () => {
    expect(norm, "n'utilise PAS le wrapper → clés divergentes du cache").toContain(
      "rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)",
    );
  });

  it("prédicat d'éligibilité AMELI byte-identique au canonique (sans branche geom NULL)", () => {
    expect(
      norm,
      "prédicat divergent du canonique Ameli → énumère un set != du count (backstop S-1 faussé)",
    ).toContain("where (t.geom_source = 'commune_centroid' and t.adresse is not null)");
    // Ameli n'a PAS la branche RPPS `OR (geom IS NULL ...)` — la copier ferait
    // diverger l'énumération du ban_join Ameli (qui n'a pas cette branche).
    expect(norm, "contient la branche RPPS `geom IS NULL` (forme copiée par erreur)").not.toContain(
      "geom is null",
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

  it("whitelist source explicite (annuaire_ameli | annuaire_ameli_staging), sinon EXCEPTION", () => {
    expect(norm).toContain("when 'annuaire_ameli' then 'annuaire_ameli'");
    expect(norm).toContain("when 'annuaire_ameli_staging' then 'annuaire_ameli_staging'");
    expect(norm, "pas d'EXCEPTION sur source hors whitelist (anti-injection)").toContain(
      "raise exception",
    );
  });

  it("le drift guard reste ancré sur les migrations réelles (pas un faux vert)", () => {
    expect(allMigrationsSql()).toContain("ameli_eligible_rows_after_id");
  });
});
