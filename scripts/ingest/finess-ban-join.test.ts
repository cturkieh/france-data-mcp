import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTED_PRECISION_TYPES } from "../../src/core/ban-bulk-client.js";
import {
  allMigrationsSql,
  ingestDir,
  latestFunctionBody,
  latestFunctionDef,
} from "./migration-sql.js";

// @ts-expect-error import .mjs sans déclaration de types (même patron que ban-backfill.test.ts)
const { SOURCES } = (await import("../ban-backfill.mjs")) as {
  SOURCES: Record<string, Record<string, unknown>>;
};

/**
 * Garde-fous de la pose BAN FINESS (migration 20260906T120000, chiffres mesurés
 * dans son en-tête) :
 *  - le prédicat d'éligibilité vit dans UNE fonction (`finess_is_ban_eligible`)
 *    appelée par la pose, le count et l'énumération — un jumeau qui dérive =
 *    drain qui énumère des lignes que la pose ignore, ou l'inverse, en silence ;
 *  - la pose n'accepte que la précision de `ACCEPTED_PRECISION_TYPES` (parité
 *    avec le TS qui remplit le cache) — JAMAIS `municipality` (un centroïde dans
 *    finess.geom contaminerait le RPPS sous l'étiquette `finess_join`) ;
 *  - la clé d'adresse est `voie` SEULE via le MÊME wrapper des deux côtés ;
 *  - le curseur texte `num_finess` est bien une colonne de la RETURNS TABLE
 *    (sinon `after = undefined` → 1re page en boucle, prouvé par harnais) ;
 *  - `finess.ts` appelle la pose APRÈS le repli previous_ingest et AVANT la diff.
 * Timeouts ≤ 55 s : `enrichment-statement-timeout.test.ts` (boucle partagée).
 */
const RPCS = [
  "ingest_apply_finess_ban_join",
  "finess_count_ban_eligible_rows",
  "finess_eligible_rows_after_id",
] as const;
const sql = allMigrationsSql(); // lowercased (contrat du helper) → attendus en minuscules
const bodies = Object.fromEntries(
  RPCS.map((fn) => [fn, latestFunctionBody(sql, fn, { stripComments: true, compact: true })]),
) as Record<(typeof RPCS)[number], string>;

describe("pose BAN FINESS — parité du prédicat et politique de précision", () => {
  it('les 3 corps existent ("" = introuvable : les assertions négatives seraient vacuës)', () => {
    for (const fn of RPCS) expect(bodies[fn], `${fn} : def introuvable`).not.toBe("");
  });

  it("les 3 fonctions passent par finess_is_ban_eligible(geom, voie) — prédicat écrit UNE fois", () => {
    for (const fn of RPCS)
      expect(bodies[fn], fn).toMatch(/finess_is_ban_eligible\((?:t|s)\.geom, (?:t|s)\.voie\)/);
    const pred = latestFunctionBody(sql, "finess_is_ban_eligible", {
      stripComments: true,
      compact: true,
    });
    expect(pred).toContain("p_geom is null and p_voie is not null");
  });

  it("la pose n'accepte que ACCEPTED_PRECISION_TYPES sur `accepted = true` — jamais municipality", () => {
    const body = bodies.ingest_apply_finess_ban_join;
    expect(body).toContain("g.accepted = true");
    const inList = body.match(/result_type in \(([^)]*)\)/)?.[1] ?? "";
    const sqlTypes = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlTypes).toEqual([...ACCEPTED_PRECISION_TYPES].sort());
    expect(sqlTypes).not.toContain("municipality");
    expect(body).toContain("'geom_source', 'ban_address'");
  });

  it("clé d'adresse = voie SEULE via rpps_address_key_for_index des deux côtés (jamais num_voie/type_voie, jamais le jumeau nu)", () => {
    const key = "rpps_address_key_for_index(s.voie, s.code_postal::text, s.code_insee::text)";
    expect(bodies.ingest_apply_finess_ban_join).toContain(key);
    expect(bodies.finess_eligible_rows_after_id).toContain(key.replaceAll("s.", "t."));
    for (const fn of RPCS) {
      expect(bodies[fn]).not.toMatch(/num_voie|type_voie/);
      expect(bodies[fn]).not.toContain("rpps_normalize_address_key");
    }
  });

  it("énumération : curseur TEXTE num_finess (ORDER BY et prédicat sur la MÊME expression), sentinelle NULL, p_limit ≥ 1", () => {
    const body = bodies.finess_eligible_rows_after_id;
    expect(body).toContain("($1 is null or t.num_finess::text > $1)");
    expect(body).toContain("order by t.num_finess::text");
    expect(body).toMatch(/p_limit is null or p_limit < 1/);
    expect(body).toContain("finess_resolve_source_table(p_source_table)");
  });

  it("droits : REVOKE FROM PUBLIC/anon/authenticated + GRANT service_role sur les 3 RPC (UPDATE SECURITY DEFINER)", () => {
    for (const fn of RPCS) {
      expect(sql).toMatch(
        new RegExp(
          `revoke execute on function ${fn}\\([^)]*\\)\\s+from public, anon, authenticated`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute on function ${fn}\\([^)]*\\)\\s+to service_role`),
      );
    }
  });
});

describe("ban-backfill.mjs — source `finess` câblée sur ces RPC, curseur texte = colonne de la RETURNS TABLE", () => {
  it("descripteur SOURCES.finess (objet réel, validé par assertSourcesValid au chargement)", () => {
    expect(SOURCES.finess).toEqual({
      table: "finess",
      enumRpc: "finess_eligible_rows_after_id",
      cursorParam: "p_after_id",
      cursorField: "num_finess",
      cursorInit: null,
      countRpc: "finess_count_ban_eligible_rows",
    });
  });

  it("pour CHAQUE source, cursorField et les 4 colonnes lues par le client figurent dans la RETURNS TABLE de enumRpc", () => {
    for (const [name, cfg] of Object.entries(SOURCES)) {
      const def = latestFunctionDef(String(cfg.enumRpc));
      expect(def, `${name} : def de ${String(cfg.enumRpc)} introuvable`).not.toBe("");
      const cols = def.match(/returns\s+table\s*\(([^)]*)\)/)?.[1] ?? "";
      for (const col of [
        String(cfg.cursorField),
        "address_key",
        "adresse",
        "code_postal",
        "code_insee",
      ]) {
        expect(cols, `${name} : colonne ${col} absente de RETURNS TABLE`).toMatch(
          new RegExp(`\\b${col}\\s+\\w+`),
        );
      }
    }
  });

  it("le workflow de drain FINESS existe, déclenché après « Ingest FINESS », même groupe de concurrence", () => {
    const wf = readFileSync(
      join(ingestDir, "../../.github/workflows/ban-backfill-finess.yml"),
      "utf8",
    );
    expect(wf).toContain('workflows: ["Ingest FINESS"]');
    expect(wf).toContain("group: ingest-finess");
    expect(wf).toMatch(/ban-backfill\.mjs --source finess/);
  });
});

describe("finess.ts — câblage de la pose (supprimer le bloc laisserait le drain remplir un cache que rien ne pose)", () => {
  const src = readFileSync(join(ingestDir, "finess.ts"), "utf8");
  it("appelle count + pose, APRÈS ingest_apply_finess_geom_previous et AVANT ingest_finess_staging_diff", () => {
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, `${needle} introuvable dans finess.ts`).toBeGreaterThan(-1);
      return i;
    };
    const previous = at('rpc(\n      "ingest_apply_finess_geom_previous"');
    const count = at('"finess_count_ban_eligible_rows"');
    const pose = at('rpc("ingest_apply_finess_ban_join")');
    const diff = at("fetchStagingDiff(supabase)");
    expect(previous).toBeLessThan(count);
    expect(count).toBeLessThan(pose);
    expect(pose).toBeLessThan(diff);
    // Sentinelle « 0 posé » : partial + trace en base, jamais un throw.
    expect(src).toContain("banEligible > 0 && banCount === 0");
    expect(src).toMatch(/evaluateBanJoinOutcome\(\{\s+source: "finess"/);
  });
});
