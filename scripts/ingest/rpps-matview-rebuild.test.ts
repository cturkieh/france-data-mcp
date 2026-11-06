import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  allMigrationsSql,
  ingestDir,
  latestFunctionBodyLoose as latestFunctionBody,
  latestFunctionDef,
} from "./migration-sql.js";
import { rebuildRppsSearchLists } from "./rpps.js";
import type { IngestLogEntry } from "./shared.js";

// Garde-fou structurel — sans DB, lit les migrations + le pipeline ingest.
//
// Classe de bug visée (PROUVÉE en prod 2026-05-18, lecture seule) : les 3
// matviews RPPS (`rpps_commune_centroids`, `rpps_count_stats`,
// `rpps_savoir_faire_stats`) sont définies `... FROM rpps ...`. En PostgreSQL
// une matview référence sa table source par OID, pas par nom. Le swap
// `ingest_atomic_swap('rpps')` fait une rotation par RENAME
// (`rpps`→`rpps_previous`→`rpps_previous_OLD`→`DROP ... CASCADE`). Tant que le
// post-swap se contente d'un `REFRESH` (RPC `ingest_refresh_matview`,
// REFRESH-only) :
//   - 1er cron réussi : les matviews suivent l'OID → collées à l'ancienne
//     table → REFRESH recalcule depuis les données AVANT le cron → désync
//     SILENCIEUSE (status `success`), `rpps_in_radius` sert du périmé ;
//   - 2e cron réussi : `DROP rpps_previous_OLD CASCADE` détruit les 3
//     matviews → `REFRESH` lève `42P01` → `refreshRppsMatviews` l'avale en
//     `partial` → `rpps_in_radius` / `densite_professionnels_sante` /
//     `lister_specialites_medicales` DOWN jusqu'à recréation manuelle.
//   Jamais exercé jusqu'ici (0 cron RPPS réussi depuis le 2026-05-09) ;
//   réveillé par le désamorçage du timeout 57014 (`20260518T140000`).
//
// Invariant garanti ici : le post-swap RPPS RECONSTRUIT les 3 matviews
// (`DROP MATERIALIZED VIEW` + `CREATE ... FROM rpps` résolu PAR NOM = la
// nouvelle table + bascule atomique par RENAME), via une fonction dédiée
// `ingest_rebuild_rpps_matviews`, et n'utilise plus `ingest_refresh_matview`
// (REFRESH-only = la bombe) côté pipeline RPPS. Le `CREATE ... FROM rpps`
// post-swap résout `rpps` par nom (= nouvelle table) → corrige À LA FOIS la
// désync du 1er cron ET la destruction du 2e.
//
// Défaut SYMÉTRIQUE Ameli (`ameli_nomenclature_stats` FROM `annuaire_ameli`,
// même `ingest_atomic_swap`, même `refreshAmeliMatviews` REFRESH-only) :
// identique, mais masqué FORTUITEMENT par `shortCircuitIfSameChecksum`
// (`ameli.ts`, AVANT le swap : l'extract Ameli ne changeant quasi jamais, le
// 2e swap consécutif n'a pas lieu). NON imminent → backlog P1 explicite,
// PAS corrigé ici (décision de périmètre). Ce commentaire est l'ancrage
// anti-redécouverte : ne PAS « optimiser » ce short-circuit sans corriger
// d'abord Ameli par la même mécanique `ingest_rebuild_*`.

/**
 * Noyau d'une définition de matview : tout ce qui suit `as` jusqu'au `;`
 * terminal du `CREATE MATERIALIZED VIEW <name> ... AS <select> ;`, normalisé
 * (lowercase déjà fait par les sources, espaces compactés). Les 3 matviews
 * RPPS n'ont pas de `;` interne dans leur SELECT (agrégats simples) → borne
 * fiable. `name` peut contenir le suffixe `_rebuild`.
 */
function matviewSelectCore(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+materialized\\s+view\\s+(?:if\\s+not\\s+exists\\s+)?${name}\\b\\s+as\\b([\\s\\S]*?);`,
    "i",
  );
  const m = sql.match(re);
  return m ? (m[1] as string).replace(/\s+/g, " ").trim() : "";
}

const RPPS_MATVIEWS = ["rpps_savoir_faire_stats", "rpps_count_stats", "rpps_commune_centroids"];

describe("fix matview/swap RPPS : reconstruction post-swap (pas REFRESH-only)", () => {
  it("ingest_rebuild_rpps_matviews reconstruit les 3 matviews FROM rpps avec bascule atomique RENAME", () => {
    const body = latestFunctionBody("ingest_rebuild_rpps_matviews");
    expect(
      body.length,
      "fonction ingest_rebuild_rpps_matviews absente — le post-swap reste REFRESH-only (bombe matview armée)",
    ).toBeGreaterThan(0);

    for (const mv of RPPS_MATVIEWS) {
      // (a) reconstruction : CREATE MATERIALIZED VIEW <mv>_rebuild ... FROM rpps
      //     → résout `rpps` PAR NOM au moment du CREATE (post-swap = nouvelle
      //     table), ce qui élimine le suivi d'OID (cause du double défaut).
      expect(
        body,
        `${mv} : pas de "CREATE MATERIALIZED VIEW ${mv}_rebuild ... FROM rpps" dans ingest_rebuild_rpps_matviews`,
      ).toMatch(
        new RegExp(
          `create\\s+materialized\\s+view\\s+${mv}_rebuild\\b[\\s\\S]*?from\\s+rpps\\b`,
          "i",
        ),
      );
      // (b) bascule atomique : DROP de la matview en place + RENAME du _rebuild
      //     (dans le corps PL/pgSQL = une transaction → atomique pour les
      //     lecteurs : aucun 42P01 transitoire sur rpps_in_radius).
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

  it("le pipeline rpps.ts reconstruit post-swap (ingest_rebuild_rpps_matviews) et n'est plus REFRESH-only", () => {
    const src = readFileSync(`${ingestDir}/rpps.ts`, "utf8");
    expect(src, "rpps.ts n'appelle pas ingest_rebuild_rpps_matviews post-swap").toContain(
      "ingest_rebuild_rpps_matviews",
    );
    expect(
      src,
      "rpps.ts utilise encore ingest_refresh_matview (REFRESH-only = bombe matview au 2e swap)",
    ).not.toContain("ingest_refresh_matview");
  });

  it("parité DDL : le SELECT de chaque matview dans ingest_rebuild == sa migration canonique (anti-drift)", () => {
    const fnBody = latestFunctionBody("ingest_rebuild_rpps_matviews");
    const migs = allMigrationsSql();
    for (const mv of RPPS_MATVIEWS) {
      const canonical = matviewSelectCore(migs, mv);
      expect(canonical.length, `SELECT canonique de ${mv} introuvable`).toBeGreaterThan(0);
      // Dans la fonction rebuild la matview s'appelle <mv>_rebuild ; on
      // compare le noyau SELECT (identique modulo le nom).
      const rebuilt = matviewSelectCore(fnBody, `${mv}_rebuild`);
      expect(
        rebuilt,
        `${mv} : SELECT de ${mv}_rebuild dans ingest_rebuild_rpps_matviews diverge de la migration canonique (drift de définition matview = données fausses servies en prod). Canonique="${canonical}" Rebuild="${rebuilt}"`,
      ).toBe(canonical);
    }
  });
});

// Les listes de `rpps_search_by_name` suivent le même patron de reconstruction, dans
// un appel séparé : voir `20261106T120000` et `docs/experiences/2026-11-06-rpps-noms-distincts.md`.
describe("listes de rpps_search_by_name", () => {
  const LISTES = ["rpps_noms", "rpps_prenoms"];
  const REBUILD = "ingest_rebuild_rpps_search_lists";

  it("chaque liste est reconstruite FROM rpps, bascule par RENAME, SELECT identique à sa création", () => {
    const body = latestFunctionBody(REBUILD);
    const migs = allMigrationsSql();
    for (const liste of LISTES) {
      const canonical = matviewSelectCore(migs, liste);
      expect(canonical, `${liste} : création introuvable`).toMatch(/from rpps\b/i);
      expect(matviewSelectCore(body, `${liste}_rebuild`)).toBe(canonical);
      expect(body).toMatch(
        new RegExp(`drop\\s+materialized\\s+view\\s+if\\s+exists\\s+${liste}\\s*;`, "i"),
      );
      expect(body).toMatch(
        new RegExp(
          `alter\\s+materialized\\s+view\\s+${liste}_rebuild\\s+rename\\s+to\\s+${liste}\\b`,
          "i",
        ),
      );
      // Sans ce GIN, chaque recherche parcourrait toute la liste après le premier cron.
      expect(body).toMatch(
        new RegExp(`on\\s+${liste}_rebuild\\s+using\\s+gin\\s*\\(\\s*\\w+_lower\\b`, "i"),
      );
      // Sans ce GRANT, la RPC appelée par `anon` échoue après la première reconstruction.
      expect(body).toMatch(
        new RegExp(`grant\\s+select\\s+on\\s+${liste}_rebuild\\s+to\\s+anon`, "i"),
      );
    }
  });

  it("la reconstruction reste sous la coupure de la passerelle, réservée à service_role", () => {
    expect(latestFunctionDef(REBUILD)).toMatch(/set\s+statement_timeout\s*=\s*'55s'/i);
    expect(allMigrationsSql()).toMatch(
      new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+${REBUILD}\\s+from\\s+public,\\s*anon,\\s*authenticated\\s*;`,
        "i",
      ),
    );
  });

  it("la RPC lit les listes, garde ses SET et n'applique plus de plafond avant le tri", () => {
    const body = latestFunctionBody("rpps_search_by_name");
    expect(body).toMatch(/from\s+rpps_noms\b/i);
    expect(body).toMatch(/from\s+rpps_prenoms\b/i);
    expect(body).not.toMatch(/lower\(r\.(nom|prenom)\)\s*%/i);
    expect(body).not.toContain("v_candidate_cap");
    // Un appel `anon` direct reste borné à 501 lignes, quelle que soit la limite demandée.
    expect(body).toMatch(/v_reste\s+int\s*:=\s*least\(/i);
    expect(body).not.toMatch(/limit\s+p_limit/i);
    expect(latestFunctionDef("rpps_search_by_name")).toMatch(
      /set\s+statement_timeout\s*=\s*'10s'\s+set\s+plan_cache_mode\s*=\s*force_custom_plan/i,
    );
  });

  it("la bascule vient après toute construction : le verrou du DROP tient jusqu'au commit", () => {
    const body = latestFunctionBody(REBUILD);
    const derniereConstruction = body.lastIndexOf("analyze rpps_prenoms_rebuild");
    expect(derniereConstruction).toBeGreaterThan(-1);
    for (const liste of LISTES) {
      const bascule = body.search(
        new RegExp(`drop\\s+materialized\\s+view\\s+if\\s+exists\\s+${liste}\\s*;`, "i"),
      );
      expect(bascule).toBeGreaterThan(derniereConstruction);
    }
  });

  it("rpps.ts reconstruit les listes après les matviews", () => {
    const src = readFileSync(`${ingestDir}/rpps.ts`, "utf8");
    const matviews = src.indexOf("await rebuildRppsMatviews(supabase, log)");
    const listes = src.indexOf("await rebuildRppsSearchLists(supabase, log)");
    expect(matviews).toBeGreaterThan(-1);
    expect(listes).toBeGreaterThan(matviews);
  });

  it("un échec dégrade en partial sans interrompre l'ingestion", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = { status: "success" } as IngestLogEntry;
    const supabase = {
      rpc: async () => ({ data: null, error: { code: "57014", message: "timeout" } }),
    } as unknown as SupabaseClient;
    await expect(rebuildRppsSearchLists(supabase, log)).resolves.toBeUndefined();
    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("SELECT ingest_rebuild_rpps_search_lists()");
    expect(log.error_message).toContain("nettoyage du dimanche");
    consoleError.mockRestore();
  });
});
