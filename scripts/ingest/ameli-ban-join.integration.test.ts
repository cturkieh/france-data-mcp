import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeAddressKey3 } from "../../src/core/address-geocode.js";

// ─────────────────────────────────────────────────────────────────────────────
// Chantier C — ban_join Ameli. Clone strict de ban-join.integration.test.ts
// (RPPS) adapté au prédicat éligibilité Ameli (`commune_centroid AND adresse
// NOT NULL`, pas de finess_join à exclure).
//
// PROUVE le contrat fonctionnel de la pose ensembliste cache → staging :
//  (1) cache HIT (commune_centroid) → geom_source='ban_address' + coords cache
//  (2) cache MISS → ligne INTACTE (garde son repli commune_centroid)
//  (3) ligne déjà ban_address → JAMAIS retouchée (préfixe d'éligibilité)
//  (4) CURSEUR KEYSET : converge sur page vide, applied cumulé = nb posé
//  (5) IDEMPOTENCE : 2ᵉ passe → 0 posé, dataset inchangé
//
// ISOLATION : tout passe par `docker exec psql` (connexion DIRECTE), même
// discipline que `ban-join.integration.test.ts`. `ingest_create_annuaire_
// ameli_staging` recrée la table → un seed via PostgREST se heurterait au
// cache schema. `geocoded_addresses` vit HORS du swap (persistant) →
// teardown OBLIGATOIRE avec préfixe marqueur unique.
//
// FAIL-LOUD : skip UNIQUEMENT si Postgres injoignable. DB là mais RPC absente
// (migration T-format non appliquée localement) → échec explicite.
// ─────────────────────────────────────────────────────────────────────────────

const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_france-data-public";
const DB_CONN =
  process.env.SUPABASE_DB_DIRECT_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", DB_CONN, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const MARK = "ZZAMELIBJ";
// 4 PS de test sur Charleville (08105). A/B : cache HIT → ban_address.
// C : MISS → reste commune_centroid. D : déjà ban_address → intouché.
const ADDR_A = `${MARK} 10 RUE DE LA PAIX`;
const ADDR_B = `${MARK} 5 AVENUE DES TESTS`;
const ADDR_C = `${MARK} 99 IMPASSE SANS CACHE`;
const ADDR_D = `${MARK} 1 RUE DEJA BAN`;
const CP = "08000";
const INSEE = "08105";
const KEY_A = normalizeAddressKey3(ADDR_A, CP, INSEE);
const KEY_B = normalizeAddressKey3(ADDR_B, CP, INSEE);
const LAT_A = 49.7724;
const LON_A = 4.7203;
const LAT_B = 49.775;
const LON_B = 4.72;

function recreateAndSeed(): void {
  psql("SELECT ingest_create_annuaire_ameli_staging()");
  // A/B : commune_centroid + adresse en cache → HIT
  // C : commune_centroid + adresse PAS en cache → MISS (reste centroid)
  // D : déjà ban_address → exclu du prédicat (ne doit JAMAIS être retouché)
  // code_departement requis NOT NULL.
  psql(
    `INSERT INTO annuaire_ameli_staging (nom, prenom, adresse, code_postal, code_insee, code_departement, geom_source, geom) VALUES
       ('NOMA','PRA',${lit(ADDR_A)},'${CP}','${INSEE}','08 ','commune_centroid', ST_SetSRID(ST_MakePoint(4.70,49.77),4326)),
       ('NOMB','PRB',${lit(ADDR_B)},'${CP}','${INSEE}','08 ','commune_centroid', ST_SetSRID(ST_MakePoint(4.71,49.77),4326)),
       ('NOMC','PRC',${lit(ADDR_C)},'${CP}','${INSEE}','08 ','commune_centroid', ST_SetSRID(ST_MakePoint(4.72,49.77),4326)),
       ('NOMD','PRD',${lit(ADDR_D)},'${CP}','${INSEE}','08 ','ban_address',      ST_SetSRID(ST_MakePoint(4.73,49.77),4326))`,
  );
  psql("ANALYZE annuaire_ameli_staging");
  psql(`DELETE FROM geocoded_addresses WHERE address_key LIKE ${lit(`${MARK}%`)}`);
  psql(
    `INSERT INTO geocoded_addresses (address_key, lat, lon, accepted, ban_attempt_count, ban_last_status, geocoded_at) VALUES
       (${lit(KEY_A)}, ${LAT_A}, ${LON_A}, true, 1, 'accepted', now()),
       (${lit(KEY_B)}, ${LAT_B}, ${LON_B}, true, 1, 'accepted', now())`,
  );
}

function teardown(): void {
  psql(`DELETE FROM geocoded_addresses WHERE address_key LIKE ${lit(`${MARK}%`)}`);
  // annuaire_ameli_staging est recréée à chaque test → pas besoin de DELETE
  // (DROP TABLE IF EXISTS dans ingest_create_annuaire_ameli_staging).
}

/** Pilote keyset JS : boucle p_after jusqu'à last_id vide. */
function runBanJoinLoop(pLimit = 100): { totalApplied: number; iterations: number } {
  let after = 0;
  let totalApplied = 0;
  let iterations = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const row = psql(
      `SELECT coalesce(last_id::text,'') || '|' || applied::text
       FROM ingest_apply_ameli_ban_join_batch(${after}, ${pLimit})`,
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

// Skip propre quand Postgres injoignable (env CI sans docker, container
// renommé, etc.) — MAIS log explicite : un catch vide rendrait le garde-fou
// FAIL-LOUD ci-dessous silencieusement skippé sans trace (cf. silent-failure
// hunter L-2 Passe 1).
let canRun = true;
try {
  psql("SELECT 1");
} catch (err) {
  canRun = false;
  console.error(
    `[france-data-mcp][ameli-ban-join.integration] skipped: Postgres unreachable via docker exec — ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

describe.skipIf(!canRun)("ingest_apply_ameli_ban_join_batch — pose ensembliste keyset", () => {
  it("FAIL-LOUD : la RPC ban_join Ameli existe (migration 20260521T102000 appliquée)", () => {
    const n = psql(
      "SELECT count(*) FROM pg_proc WHERE proname='ingest_apply_ameli_ban_join_batch'",
    );
    expect(
      Number(n),
      "[france-data-mcp] GARDE-FOU INERTE : RPC ingest_apply_ameli_ban_join_batch absente — migration 20260521T102000 non appliquée (CLI supabase SKIPPE les T-format ; appliquer via docker exec psql localement / dashboard SQL editor en prod)",
    ).toBeGreaterThan(0);
  });

  it("HIT/MISS/déjà-ban + convergence keyset (1 passe)", () => {
    recreateAndSeed();
    try {
      const { totalApplied, iterations } = runBanJoinLoop();
      expect(totalApplied, "2 lignes en cache (A,B) doivent être posées").toBe(2);
      expect(iterations).toBeGreaterThanOrEqual(1);

      const a = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM annuaire_ameli_staging WHERE nom='NOMA'`,
      );
      expect(a).toBe(`ban_address|${LAT_A}|${LON_A}`);

      const b = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM annuaire_ameli_staging WHERE nom='NOMB'`,
      );
      expect(b).toBe(`ban_address|${LAT_B}|${LON_B}`);

      // C : MISS → INTACT (commune_centroid + geom 4.72/49.77).
      const c = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM annuaire_ameli_staging WHERE nom='NOMC'`,
      );
      expect(c).toBe("commune_centroid|49.7700|4.7200");

      // D : déjà ban_address → INTACT (exclu du prédicat).
      const d = psql(
        `SELECT geom_source || '|' || round(ST_Y(geom)::numeric,4) || '|' || round(ST_X(geom)::numeric,4)
         FROM annuaire_ameli_staging WHERE nom='NOMD'`,
      );
      expect(d).toBe("ban_address|49.7700|4.7300");
    } finally {
      teardown();
    }
  });

  it("IDEMPOTENCE : 2ᵉ passe → 0 posé, dataset inchangé", () => {
    recreateAndSeed();
    try {
      const first = runBanJoinLoop();
      expect(first.totalApplied).toBe(2);
      const second = runBanJoinLoop();
      expect(
        second.totalApplied,
        "2ᵉ passe ne doit RIEN reposer (A/B sortis du prédicat via geom_source=ban_address)",
      ).toBe(0);
      const banCount = psql(
        `SELECT count(*) FROM annuaire_ameli_staging WHERE geom_source='ban_address'`,
      );
      // 2 nouveaux (A/B) + 1 pré-existant (D) = 3.
      expect(Number(banCount), "exactement A+B+D en ban_address après 2 passes").toBe(3);
    } finally {
      teardown();
    }
  });
});
