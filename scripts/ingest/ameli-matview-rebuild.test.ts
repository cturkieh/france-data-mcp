import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allMigrationsSql,
  ingestDir,
  latestFunctionBodyLoose as latestFunctionBody,
} from "./migration-sql.js";

// Garde-fou structurel — sans DB, lit les migrations + le pipeline ingest.
//
// Classe de bug visée (symétrique EXACT du défaut RPPS prouvé prod
// 2026-05-18, cf. rpps-matview-rebuild.test.ts) : `ameli_nomenclature_stats`
// est définie `... FROM annuaire_ameli ...` (migration canonique
// 20260515T020100). En PostgreSQL une matview référence sa table source par
// OID, pas par nom. Le swap `ingest_atomic_swap('annuaire_ameli')` fait une
// rotation par RENAME (`annuaire_ameli`→`_previous`→`_previous_OLD`→
// `DROP ... CASCADE`). Tant que le post-swap se contente d'un `REFRESH`
// (RPC `ingest_refresh_matview`, REFRESH-only) :
//   - 1er cron réussi : la matview suit l'OID → collée à l'ancienne table →
//     REFRESH recalcule depuis les données AVANT le cron → désync
//     SILENCIEUSE (status `success`), `lister_specialites_ameli` /
//     `lister_types_ps_ameli` servent du périmé ;
//   - 2e cron réussi : `DROP <t>_previous_OLD CASCADE` détruit la matview →
//     `REFRESH` lève `42P01` → avalé en `partial` → les 2 tools DOWN
//     jusqu'à recréation manuelle.
//   Masqué FORTUITEMENT par `shortCircuitIfSameChecksum` (ameli.ts, AVANT
//   le swap) — NON garanti (Ameli hebdo sur ~485 k PS, l'extrait change).
//   Backlog P1 explicite (CLAUDE.md, header 20260518T150000) clôturé ici.
//
// Invariant garanti : le post-swap Ameli RECONSTRUIT la matview
// (`DROP MATERIALIZED VIEW` + `CREATE ... FROM annuaire_ameli` résolu PAR
// NOM = la nouvelle table + bascule atomique par RENAME) via la fonction
// dédiée `ingest_rebuild_ameli_matviews`, et n'utilise plus
// `ingest_refresh_matview` (REFRESH-only = la bombe) côté pipeline Ameli.

/**
 * Noyau d'une définition de matview : tout ce qui suit `as` jusqu'au `;`
 * terminal du `CREATE MATERIALIZED VIEW <name> ... AS <select> ;`, normalisé
 * (espaces compactés). `ameli_nomenclature_stats` n'a pas de `;` interne
 * dans son SELECT (agrégat simple) → borne fiable. `name` peut contenir le
 * suffixe `_rebuild` (le `\b` après le nom empêche `ameli_nomenclature_stats`
 * de matcher `ameli_nomenclature_stats_rebuild`).
 */
function matviewSelectCore(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+materialized\\s+view\\s+(?:if\\s+not\\s+exists\\s+)?${name}\\b\\s+as\\b([\\s\\S]*?);`,
    "i",
  );
  const m = sql.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

const AMELI_MATVIEWS = ["ameli_nomenclature_stats"];

describe("fix matview/swap Ameli : reconstruction post-swap (pas REFRESH-only)", () => {
  it("ingest_rebuild_ameli_matviews reconstruit la matview FROM annuaire_ameli avec bascule atomique RENAME", () => {
    const body = latestFunctionBody("ingest_rebuild_ameli_matviews");
    expect(
      body.length,
      "fonction ingest_rebuild_ameli_matviews absente — le post-swap Ameli reste REFRESH-only (bombe matview armée)",
    ).toBeGreaterThan(0);

    for (const mv of AMELI_MATVIEWS) {
      expect(
        body,
        `${mv} : pas de "CREATE MATERIALIZED VIEW ${mv}_rebuild ... FROM annuaire_ameli" dans ingest_rebuild_ameli_matviews`,
      ).toMatch(
        new RegExp(
          `create\\s+materialized\\s+view\\s+${mv}_rebuild\\b[\\s\\S]*?from\\s+annuaire_ameli\\b`,
          "i",
        ),
      );
      expect(body, `${mv} : pas de "DROP MATERIALIZED VIEW ... ${mv}" (bascule)`).toMatch(
        new RegExp(`drop\\s+materialized\\s+view\\s+(?:if\\s+exists\\s+)?${mv}\\b`, "i"),
      );
      expect(
        body,
        `${mv} : pas de "ALTER MATERIALIZED VIEW ${mv}_rebuild RENAME TO ${mv}"`,
      ).toMatch(
        new RegExp(
          `alter\\s+materialized\\s+view\\s+${mv}_rebuild\\s+rename\\s+to\\s+${mv}\\b`,
          "i",
        ),
      );
    }
  });

  it("le pipeline ameli.ts reconstruit post-swap (ingest_rebuild_ameli_matviews) et n'est plus REFRESH-only", () => {
    const src = readFileSync(`${ingestDir}/ameli.ts`, "utf8");
    expect(src, "ameli.ts n'appelle pas ingest_rebuild_ameli_matviews post-swap").toContain(
      "ingest_rebuild_ameli_matviews",
    );
    expect(
      src,
      "ameli.ts utilise encore ingest_refresh_matview (REFRESH-only = bombe matview au 2e swap)",
    ).not.toContain("ingest_refresh_matview");
  });

  it("parité DDL : le SELECT de la matview dans ingest_rebuild == sa migration canonique (anti-drift)", () => {
    const fnBody = latestFunctionBody("ingest_rebuild_ameli_matviews");
    const migs = allMigrationsSql();
    for (const mv of AMELI_MATVIEWS) {
      const canonical = matviewSelectCore(migs, mv);
      expect(canonical.length, `SELECT canonique de ${mv} introuvable`).toBeGreaterThan(0);
      const rebuilt = matviewSelectCore(fnBody, `${mv}_rebuild`);
      expect(
        rebuilt,
        `${mv} : SELECT de ${mv}_rebuild dans ingest_rebuild_ameli_matviews diverge de la migration canonique (drift de définition matview = données fausses servies en prod). Canonique="${canonical}" Rebuild="${rebuilt}"`,
      ).toBe(canonical);
    }
  });
});
