import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeAddressKey3 } from "../../src/core/address-geocode.js";

// ─────────────────────────────────────────────────────────────────────────────
// REFONTE ban_join (2026-05-19) — RPC `ingest_apply_rpps_ban_join_batch`
// (migration 20260519T180000). Cf. docs/plans/2026-05-19-ban-join-design.md.
//
// PROUVE le contrat fonctionnel de la pose ensembliste cache→staging :
//  (1) cache HIT (commune_centroid OU geom NULL) → geom_source='ban_address'
//      + geom posé aux coordonnées exactes du cache ;
//  (2) cache MISS → ligne INTACTE (garde son repli commune_centroid) ;
//  (3) ligne NON éligible (finess_join) → JAMAIS touchée ;
//  (4) CURSEUR KEYSET : converge sur une page vide (last_id NULL), `applied`
//      cumulé == nb réel posé ;
//  (5) IDEMPOTENCE : 2ᵉ passe complète → 0 posé, dataset inchangé (la 1ʳᵉ
//      passe a sorti A/B du prédicat via geom_source='ban_address').
//
// ISOLATION (même discipline que ban-eligibility-skipscan.integration) : tout
// passe par `docker exec psql` (connexion DIRECTE). `ingest_create_rpps_staging`
// recrée `rpps_staging` → un seed/lecture via PostgREST se heurterait au cache
// schema. `geocoded_addresses` vit HORS du swap (persistante) → teardown
// OBLIGATOIRE des lignes de test (préfixe marqueur unique).
//
// FAIL-LOUD : skip UNIQUEMENT si Postgres génuinement injoignable. DB là mais
// RPC absente (migration T-format non appliquée) → ÉCHEC explicite.
// ─────────────────────────────────────────────────────────────────────────────

const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_france-data-public";
const DB_CONN =
  process.env.SUPABASE_DB_DIRECT_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

/** SQL serveur via docker exec psql (-tAc), stdout trimé. execFileSync (pas de shell). */
function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", DB_CONN, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const MARK = "ZZBANJOIN";
// 4 lignes de test. A/B : cache HIT (doivent passer ban_address). C : MISS
// (reste commune_centroid). D : finess_join (NON éligible, intact).
const ADDR_A = `${MARK} 10 RUE DE LA PAIX`;
const ADDR_B = `${MARK} 5 AVENUE DES TESTS`;
const ADDR_C = `${MARK} 99 IMPASSE SANS CACHE`;
const ADDR_D = `${MARK} 1 PLACE FINESS`;
const CP = "75001";
const INSEE = "75101";
// Clé d'adresse via le JUMEAU JS (parité octet-à-octet avec
// rpps_address_key_for_index garantie par le HARD GATE) → ce que la RPC
// calculera côté SQL pour joindre geocoded_addresses.address_key.
const KEY_A = normalizeAddressKey3(ADDR_A, CP, INSEE);
const KEY_B = normalizeAddressKey3(ADDR_B, CP, INSEE);
// Coordonnées attendues posées par la RPC (depuis le cache).
const LAT_A = 48.8699;
const LON_A = 2.3308;
const LAT_B = 45.7589;
const LON_B = 4.8414;

/** Recrée rpps_staging + seed les 4 lignes. Idempotent (table partagée). */
function recreateAndSeed(): void {
  psql("SELECT ingest_create_rpps_staging()");
  // A : commune_centroid + adresse en cache → HIT attendu.
  // B : geom NULL + geom_source NULL + adresse en cache → HIT attendu.
  // C : commune_centroid + adresse PAS en cache → MISS (reste centroid).
  // D : finess_join → NON éligible (jamais visité par le prédicat).
  psql(
    `INSERT INTO rpps_staging (rpps_id, nom, prenom, adresse, code_postal, code_insee, geom_source, geom) VALUES
       ('${MARK}A','NOMA','PRA',${lit(ADDR_A)},'${CP}','${INSEE}','commune_centroid', ST_SetSRID(ST_MakePoint(2.3,48.8),4326)),
       ('${MARK}B','NOMB','PRB',${lit(ADDR_B)},'${CP}','${INSEE}',NULL,NULL),
       ('${MARK}C','NOMC','PRC',${lit(ADDR_C)},'${CP}','${INSEE}','commune_centroid', ST_SetSRID(ST_MakePoint(2.2,48.7),4326)),
       ('${MARK}D','NOMD','PRD',${lit(ADDR_D)},'${CP}','${INSEE}','finess_join', ST_SetSRID(ST_MakePoint(2.1,48.6),4326))`,
  );
  psql("ANALYZE rpps_staging");
  // Cache : SEULES les clés A et B, accepted=true (CHECK exige lat/lon non NULL).
  psql(`DELETE FROM geocoded_addresses WHERE address_key LIKE ${lit(`${MARK}%`)}`);
  psql(
    `INSERT INTO geocoded_addresses (address_key, lat, lon, accepted, ban_attempt_count, ban_last_status, geocoded_at) VALUES
       (${lit(KEY_A)}, ${LAT_A}, ${LON_A}, true, 1, 'accepted', now()),
       (${lit(KEY_B)}, ${LAT_B}, ${LON_B}, true, 1, 'accepted', now())`,
  );
}

function teardown(): void {
  psql(`DELETE FROM geocoded_addresses WHERE address_key LIKE ${lit(`${MARK}%`)}`);
  psql(`DELETE FROM rpps_staging WHERE rpps_id LIKE ${lit(`${MARK}%`)}`);
}

/** Pilote keyset JS de la RPC : boucle p_after jusqu'à last_id vide. */
function runBanJoinLoop(pLimit = 100): { totalApplied: number; iterations: number } {
  let after = 0;
  let totalApplied = 0;
  let iterations = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const row = psql(
      `SELECT coalesce(last_id::text,'') || '|' || applied::text
       FROM ingest_apply_rpps_ban_join_batch(${after}, ${pLimit})`,
    );
    iterations++;
    const [lastIdRaw, appliedRaw] = row.split("|");
    totalApplied += Number(appliedRaw);
    if (lastIdRaw === "") return { totalApplied, iterations };
    const lastId = Number(lastIdRaw);
    if (lastId <= after) throw new Error(`curseur figé (after=${after} last_id=${lastId})`);
    after = lastId;
  }
  throw new Error("runBanJoinLoop n'a pas convergé en 1000 itérations");
}

// Joignabilité RÉELLE : psql("SELECT 1") throw via execFileSync si injoignable.
let canRun = true;
try {
  psql("SELECT 1");
} catch {
  canRun = false;
}

describe.skipIf(!canRun)("ingest_apply_rpps_ban_join_batch — pose ensembliste keyset", () => {
  it("FAIL-LOUD : la RPC ban_join existe (migration 20260519T180000 appliquée)", () => {
    // DB joignable mais RPC absente → ÉCHEC explicite (garde-fou non inerte).
    const n = psql("SELECT count(*) FROM pg_proc WHERE proname='ingest_apply_rpps_ban_join_batch'");
    expect(
      Number(n),
      "[france-data-mcp] GARDE-FOU INERTE : RPC ingest_apply_rpps_ban_join_batch absente — migration 20260519T180000 non appliquée (CLI supabase SKIPPE les T-format ; appliquer via docker exec psql en local / canal psql en prod)",
    ).toBeGreaterThan(0);
  });

  it("HIT/MISS/non-éligible + convergence keyset (1 passe)", () => {
    recreateAndSeed();
    try {
      const { totalApplied, iterations } = runBanJoinLoop();
      expect(totalApplied, "2 lignes en cache (A,B) doivent être posées").toBe(2);
      expect(iterations, "converge en ≥1 itération + page vide finale").toBeGreaterThanOrEqual(1);

      // A : commune_centroid + HIT → ban_address + coords du cache.
      const a = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM rpps_staging WHERE rpps_id='${MARK}A'`,
      );
      expect(a).toBe(`ban_address|${LAT_A}|${LON_A}`);

      // B : geom NULL + HIT → ban_address + coords du cache.
      const b = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM rpps_staging WHERE rpps_id='${MARK}B'`,
      );
      expect(b).toBe(`ban_address|${LAT_B}|${LON_B}`);

      // C : MISS → INTACT (commune_centroid, geom d'origine 2.2/48.7).
      const c = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM rpps_staging WHERE rpps_id='${MARK}C'`,
      );
      expect(c).toBe("commune_centroid|48.7000|2.2000");

      // D : finess_join NON éligible → INTACT.
      const d = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM rpps_staging WHERE rpps_id='${MARK}D'`,
      );
      expect(d).toBe("finess_join|48.6000|2.1000");
    } finally {
      teardown();
    }
  });

  it("IDEMPOTENCE : 2ᵉ passe → 0 posé, dataset inchangé", () => {
    recreateAndSeed();
    try {
      const first = runBanJoinLoop();
      expect(first.totalApplied).toBe(2);
      // 2ᵉ passe complète : A/B sont désormais 'ban_address' → hors prédicat
      // d'éligibilité → rien à reposer.
      const second = runBanJoinLoop();
      expect(second.totalApplied, "2ᵉ passe ne doit RIEN reposer (A/B sortis du prédicat)").toBe(0);
      const banCount = psql(
        `SELECT count(*) FROM rpps_staging WHERE rpps_id LIKE ${lit(`${MARK}%`)} AND geom_source='ban_address'`,
      );
      expect(Number(banCount), "exactement A+B en ban_address après 2 passes").toBe(2);
    } finally {
      teardown();
    }
  });
});
