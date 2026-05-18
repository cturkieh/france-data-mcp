import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeAddressKey3 } from "../../src/core/address-geocode.js";

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTIVE G5 (prod) — `rpps_distinct_eligible_keys` en SKIP-SCAN O(clés
// distinctes), IMMUNE aux groupes d'adresses GÉANTS. Migration 20260517T130000.
//
// DÉFAUT PROUVÉ (ne pas re-dériver) : l'ancienne RPC `DISTINCT ON (keyexpr)
// ... ORDER BY keyexpr, id LIMIT $2` sur un index `keyexpr`-only force un
// Incremental Sort qui trie INTÉGRALEMENT chaque groupe keyexpr par id ; les
// adresses massivement dupliquées (clusters centroïde commune denses, hotspot
// documenté « Paris ~77k lignes ») font qu'UNE page couvrant un groupe géant
// dépasse le statement_timeout ~60 s du pooler Supabase pendant que les autres
// pages tournent en 2-4 s. `ban-backfill.mjs --max 5000` réel a énuméré
// 20k→300k clés puis est mort `canceling statement due to statement timeout`.
//
// FIX : skip-scan — énumérer les clés DISTINCTES en O(clés), en sautant un
// groupe dupliqué géant en UNE descente B-tree (`keyexpr > prev ORDER BY
// keyexpr LIMIT 1`), représentant MIN(id) par clé via un seek corrélé sur
// l'index composite `(keyexpr, id)`. Boucle PL/pgSQL bornée `FOR i IN
// 1..p_limit` (PAS de CTE récursive : zéro pari sur le push-down du LIMIT).
// (Ce que le test prouve = les titres `it()` numérotés, auto-documentants.)
//
// ISOLATION : tout passe par `docker exec psql` (connexion DIRECTE, PAS
// PostgREST). Raison : (a) la RPC d'énumération + EXPLAIN ne sont pas
// exprimables proprement via supabase-js ; (b) `ingest_create_rpps_staging`
// DROP+CREATE la table et un autre fichier d'intégration (rpps-distinct-
// eligible-keys) recrée AUSSI `rpps_staging` — un seed/lecture via PostgREST
// subit la latence de reload du schema-cache ET une fenêtre de clobber
// inter-fichiers. Le seed psql via `generate_series` est ATOMIQUE et
// sub-seconde ; chaque `it` RE-SEED dans une transaction-libre juste avant ses
// lectures, bornant la fenêtre de clobber au strict minimum (et ré-asserte le
// row-count attendu = échec BRUYANT si un autre fichier a wipé entre-temps).
//
// FAIL-LOUD R5.2 : on ne SKIP que si la DB est génuinement injoignable. DB là
// + RPC absente (migration T-format non appliquée) = ÉCHEC explicite ci-bas,
// jamais skip silencieux (sinon garde-fou inerte alors que la DB est là).
// ─────────────────────────────────────────────────────────────────────────────

// `canRun` (joignabilité RÉELLE de la DB) est calculé plus bas, APRÈS la
// définition de `psql`/`DB_CONN` — PAS sur une variable d'env. Ce fichier
// n'utilise JAMAIS de clé service (tout passe par `docker exec psql`).

// Conteneur Postgres local Supabase (psql N'EST PAS sur le PATH host ; on
// shell-out via `docker exec` — execFileSync, PAS de shell → pas d'injection).
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_france-data-public";
const DB_CONN =
  process.env.SUPABASE_DB_DIRECT_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

/** Exécute du SQL serveur via docker exec psql (-tAc), renvoie stdout trimé. */
function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", DB_CONN, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

/**
 * Exécute un SCRIPT psql multi-instructions (via stdin -f -), renvoie stdout
 * complet. Utilisé pour reproduire le RÉGIME D'INDEX du DÉFAUT ORIGINEL
 * (index `keyexpr`-SEUL, SANS le composite) en transaction ROLLBACK —
 * méthode de diag prod établie (cf. CLAUDE.md « EXPLAIN ANALYZE prod,
 * transaction ROLLBACK »). Aucun effet de bord (ROLLBACK).
 */
function psqlScript(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", DB_CONN, "-v", "ON_ERROR_STOP=1", "-tAqXf", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: script },
  ).trim();
}

// Clé d'adresse partagée par le GROUPE GÉANT (toutes les lignes ont la MÊME
// adresse/cp/insee normalisée → 1 seule clé distincte malgré N lignes).
const GIANT_ADDR = "1 PLACE DU GROUPE GEANT";
const GIANT_CP = "75001";
const GIANT_INSEE = "75101";
const GIANT_KEY = normalizeAddressKey3(GIANT_ADDR, GIANT_CP, GIANT_INSEE);

// N ≫ p_limit : lignes au même point → 1 clé. p_limit=10 (≪ N). 50 singletons.
const GIANT_N = 8000;
const PAGE_LIMIT = 10;
const SINGLETON_COUNT = 50;
const EXPECTED_DISTINCT = 1 + SINGLETON_COUNT; // 1 clé géante + 50 singletons
// Lignes NON éligibles seedées (ZZSKIPN1..N3) : couplé au bloc d'INSERT
// 3-lignes de recreateAndSeed — dériver la constante évite qu'un ajout de
// ligne non-éligible fausse SILENCIEUSEMENT l'assertion de peuplement.
const INELIGIBLE_COUNT = 3;

// SCALE-INVARIANCE PROBE (le discriminant NON VACUEUX fix↔défaut). Mesuré :
// le skip-scan déployé hit ~980 Shared Hit Blocks INVARIANT du groupe géant
// (978/988/995 à N=500/8000/30000 — +1.7 % sur ×60), tandis que la forme
// DISTINCT ON scanne ≈N (509/8009/30009 — O(N) → timeout 60 s à 77k prod).
// Discriminant : la mesure à GIANT_N_BIG ne doit PAS croître vs GIANT_N_SMALL
// (skip-scan : ratio ≈ 1 ; DISTINCT ON : ratio ≈ GIANT_N_BIG/GIANT_N_SMALL).
const GIANT_N_SMALL = 500;
const GIANT_N_BIG = 16000; // ×32 — un O(N) exploserait, un O(p_limit) reste plat

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Recrée `rpps_staging` (superset prod, dont les 2 index partiels BAN) et la
 * peuple en UNE passe psql ATOMIQUE via generate_series. Idempotent : appelé
 * en tête de CHAQUE `it` (la table est partagée avec d'autres fichiers
 * d'intégration ; re-seed juste-avant + ré-assertion du count = fenêtre de
 * clobber minimale + échec BRUYANT si un autre fichier a wipé).
 */
function recreateAndSeed(giantN: number = GIANT_N): void {
  psql("SELECT ingest_create_rpps_staging()");
  // Groupe géant : giantN lignes, MÊME adresse, ids croissants, éligibles.
  psql(
    `INSERT INTO rpps_staging (rpps_id, nom, prenom, adresse, code_postal, code_insee, geom_source)
     SELECT 'ZZSKIPG' || g, 'N', 'P', ${lit(GIANT_ADDR)}, ${lit(GIANT_CP)}, ${lit(GIANT_INSEE)}, 'commune_centroid'
     FROM generate_series(1, ${giantN}) g`,
  );
  // 50 singletons distincts (clés uniques), éligibles.
  psql(
    `INSERT INTO rpps_staging (rpps_id, nom, prenom, adresse, code_postal, code_insee, geom_source)
     SELECT 'ZZSKIPS' || g, 'N', 'P', g || ' RUE SINGLETON UNIQUE', '69001', '69381', 'commune_centroid'
     FROM generate_series(1, ${SINGLETON_COUNT}) g`,
  );
  // Non éligibles (adresse NULL & geom_source ≠ commune_centroid) : NE doivent
  // PAS apparaître dans l'énumération ni le count.
  psql(
    `INSERT INTO rpps_staging (rpps_id, nom, prenom, adresse, code_postal, code_insee, geom_source) VALUES
       ('ZZSKIPN1','N','P', NULL, '75008','75108','finess_join'),
       ('ZZSKIPN2','N','P', NULL, '31000','31555','ban_address'),
       ('ZZSKIPN3','N','P', NULL, '13001','13201', NULL)`,
  );
  psql("ANALYZE rpps_staging");
  // Ré-assertion BRUYANTE du peuplement (si un autre fichier a clobberé, on
  // veut un échec explicite, pas un faux vert sur table tronquée).
  const expectedRows = giantN + SINGLETON_COUNT;
  const total = Number(psql("SELECT count(*) FROM rpps_staging"));
  if (total < expectedRows + INELIGIBLE_COUNT) {
    throw new Error(
      `[france-data-mcp] seed rpps_staging incomplet (${total} lignes) — clobber inter-fichiers d'intégration ? Attendu ≥ ${expectedRows + INELIGIBLE_COUNT}`,
    );
  }
}

interface PlanNode {
  "Node Type"?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
  [k: string]: unknown;
}

function explainJson(sql: string): Array<{ Plan: PlanNode }> {
  return JSON.parse(psql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)) as Array<{
    Plan: PlanNode;
  }>;
}
function flattenPlan(node: PlanNode): PlanNode[] {
  const acc: PlanNode[] = [node];
  for (const child of node.Plans ?? []) acc.push(...flattenPlan(child));
  return acc;
}
/** Somme des `Actual Rows` des nœuds de SCAN — proxy du volume parcouru. */
function totalActualScanRows(root: PlanNode): number {
  let total = 0;
  for (const n of flattenPlan(root)) {
    if (/scan/i.test(String(n["Node Type"] ?? ""))) total += Number(n["Actual Rows"] ?? 0);
  }
  return total;
}

/**
 * Coût RÉEL d'un APPEL de la RPC : `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM
 * fn(...)` agrège dans le nœud `Function Scan` les métriques de TOUTES les
 * requêtes imbriquées plpgsql (auto_explain interdit en session sur ce
 * Postgres : `access to library "auto_explain" is not allowed` ⇒ on ne voit
 * pas les nœuds internes, mais l'agrégat racine suffit). Mesuré :
 *  - `Actual Total Time` (ms) : DISCRIMINANT PRIMAIRE — le défaut EST un
 *    timeout. Skip-scan O(p_limit) ⇒ temps INVARIANT du groupe géant (5,3→5,5
 *    ms sur ×32) ; DISTINCT ON keyexpr-only ⇒ temps O(N) (70→2070 ms, ×29).
 *    Le RATIO entre deux tailles est ROBUSTE en CI (≠ temps absolu flaky).
 *  - `Shared Hit Blocks` : corroborant (l'Incremental Sort travaille en
 *    work_mem, pas en shared buffers ⇒ sous-compte le défaut — ne PAS s'y
 *    fier seul, mais utile en garde de cohérence).
 */
function rpcCost(pAfter: string | null, pLimit: number): { ms: number; blocks: number } {
  const afterSql = pAfter === null ? "NULL" : lit(pAfter);
  const plan = explainJson(
    `SELECT * FROM rpps_distinct_eligible_keys('rpps_staging', ${afterSql}, ${pLimit})`,
  )[0].Plan;
  return {
    ms: Number(plan["Actual Total Time"] ?? 0),
    blocks: Number(plan["Shared Hit Blocks"] ?? 0),
  };
}

/** Pagine la RPC en keyset via psql (cap-agnostique : page VIDE = fin). */
function enumerateRows(pageLimit: number): Array<{ key: string; adresse: string }> {
  const out: Array<{ key: string; adresse: string }> = [];
  let after: string | null = null;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const afterSql = after === null ? "NULL" : lit(after);
    // Séparateurs robustes : \t entre colonnes, \n entre lignes (les clés
    // d'adresse normalisées n'ont ni tab ni newline — collapse via \s+).
    const raw = psql(
      `SELECT string_agg(address_key || E'\\t' || coalesce(adresse,''), E'\\n')
       FROM rpps_distinct_eligible_keys('rpps_staging', ${afterSql}, ${pageLimit})`,
    );
    if (raw === "") break; // page vide → terminaison cap-agnostique
    const lines = raw.split("\n");
    for (const ln of lines) {
      const [key, adresse] = ln.split("\t");
      out.push({ key, adresse: adresse ?? "" });
    }
    after = out[out.length - 1].key;
  }
  return out;
}

// FAIL-LOUD R5.2 : on ne SKIP QUE si la DB est génuinement injoignable —
// jamais sur une variable d'env (SERVICE_KEY n'est pas utilisé ici). DB up =
// le filet anti-G5 DOIT s'exécuter (sinon garde-fou inerte alors que la DB
// est là). `psql("SELECT 1")` throw via execFileSync si Postgres injoignable.
let canRun: boolean;
try {
  psql("SELECT 1");
  canRun = true;
} catch {
  canRun = false;
}

describe.skipIf(!canRun)(
  "rpps_distinct_eligible_keys — skip-scan O(distinct) immune aux groupes géants",
  () => {
    it("0. FAIL-LOUD : la RPC skip-scan existe (migration 20260517T130000 appliquée)", () => {
      // Si la migration corrective n'est pas appliquée, la RPC peut exister
      // sous l'ANCIENNE forme : on ne peut pas distinguer ici, mais l'absence
      // totale (proc inexistante) = ÉCHEC explicite (jamais skip silencieux).
      const exists = psql(
        "SELECT count(*) FROM pg_proc WHERE proname = 'rpps_distinct_eligible_keys'",
      );
      expect(
        Number(exists),
        "[france-data-mcp] GARDE-FOU INERTE : rpps_distinct_eligible_keys absente — migration 20260517T130000 (ou 20260517T120000) non appliquée (CLI supabase SKIPPE les T-format ; appliquer via docker exec psql en local / SQL Editor en prod)",
      ).toBeGreaterThan(0);
    });

    it("1. CORRECTNESS : énumération exhaustive = set exact des clés distinctes, MIN(id) du groupe géant", () => {
      recreateAndSeed();
      const rows = enumerateRows(PAGE_LIMIT);
      const keys = rows.map((r) => r.key);

      // Aucun doublon inter-pages (keyset `> prev` strict).
      expect(new Set(keys).size, "doublon inter-pages : keyset > prev cassé").toBe(keys.length);
      // 1 clé géante + 50 singletons = 51, chacune EXACTEMENT une fois.
      expect(keys.length, "nombre de clés distinctes énumérées inattendu").toBe(EXPECTED_DISTINCT);
      expect(new Set(keys).has(GIANT_KEY), "clé du groupe géant absente").toBe(true);
      expect(
        keys.filter((k) => k === GIANT_KEY).length,
        "clé géante émise ≠ exactement 1 fois (DISTINCT cassé)",
      ).toBe(1);

      // Représentant émis pour la clé géante = ligne MIN(id) du groupe. Oracle
      // indépendant : on lit MIN(id) côté serveur puis sa ligne.
      const minId = psql(
        `SELECT min(id) FROM rpps_staging WHERE rpps_address_key_for_index(adresse, code_postal, code_insee) = ${lit(GIANT_KEY)} AND (geom_source = 'commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL))`,
      );
      const minIdAddr = psql(
        `SELECT btrim(adresse) || '|' || btrim(code_postal) || '|' || btrim(code_insee) FROM rpps_staging WHERE id = ${minId}`,
      );
      const giant = rows.find((r) => r.key === GIANT_KEY);
      expect(giant, "ligne géante introuvable dans l'énumération").toBeDefined();
      expect(
        `${giant?.adresse}|${GIANT_CP}|${GIANT_INSEE}`,
        `représentant émis ≠ ligne MIN(id) du groupe géant (min id=${minId})`,
      ).toBe(minIdAddr);
    });

    it("4. RÉFÉRENCE DISTINCT : set skip-scan == SELECT DISTINCT keyexpr WHERE éligibilité (off-by-one du > prev)", () => {
      recreateAndSeed();
      const got = new Set(enumerateRows(PAGE_LIMIT).map((r) => r.key));
      const distinctCount = Number(
        psql(
          "SELECT count(*) FROM (SELECT DISTINCT rpps_address_key_for_index(adresse, code_postal, code_insee) FROM rpps_staging WHERE geom_source = 'commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL)) s",
        ),
      );
      expect(got.size, "set skip-scan ≠ |SELECT DISTINCT keyexpr| (clé manquée/dupliquée)").toBe(
        distinctCount,
      );
      expect(distinctCount, "oracle de fixture (1 géante + 50 singletons)").toBe(EXPECTED_DISTINCT);
    });

    it("2. COÛT INVARIANT du groupe géant : RPC temps(BIG) ≈ temps(SMALL) (O(p_limit), PAS O(N))", () => {
      // DISCRIMINANT NON VACUEUX (G3-blind-spot) : on EXPLAIN (ANALYZE)
      // l'APPEL RÉEL de la RPC DÉPLOYÉE (Function Scan agrégeant les métriques
      // des stmts plpgsql imbriqués) pour la page couvrant le groupe géant
      // (p_after=NULL ⇒ 1re page = global-min, la clé géante y tombe car
      // p_limit ≪ N), à DEUX tailles de groupe (×${GIANT_N_BIG / GIANT_N_SMALL}).
      //
      // SIGNAL PRIMAIRE = `Actual Total Time` (le défaut EST un timeout). Le
      // skip-scan O(p_limit) est INVARIANT du groupe géant (mesuré 5,3→5,5 ms
      // sur ×32) ; la forme DISTINCT ON keyexpr-only est O(N) (mesuré 70→2070
      // ms, ×29 — la matérialisation de tout le groupe en work_mem ⇒ pas
      // captée par Shared Hit Blocks, qui sous-compte ce défaut). On asserte
      // donc le RATIO temps(BIG)/temps(SMALL) (robuste en CI ≠ temps absolu) :
      // un skip-scan ⇒ ratio ≈ 1 ; une RPC O(N) (DISTINCT ON encore en place /
      // retombée / migration non appliquée) ⇒ ratio ≈ ×N ⇒ ROUGE. La
      // non-vacuité est PROUVÉE par le test (3) : la forme morte SCALE bien.
      recreateAndSeed(GIANT_N_SMALL);
      const small = rpcCost(null, PAGE_LIMIT);
      recreateAndSeed(GIANT_N_BIG);
      const big = rpcCost(null, PAGE_LIMIT);

      const timeRatio = big.ms / Math.max(small.ms, 0.1);
      // Le groupe a été multiplié par ${GIANT_N_BIG / GIANT_N_SMALL}. Un coût
      // O(N) suivrait ~ce facteur (×29 mesuré sur la forme morte). Un coût
      // O(p_limit) reste plat. Seuil 5 : très en deçà de ×32 (large marge
      // anti-flakiness CI sur le bruit de petits temps), très au-dessus de ≈1
      // (skip-scan) ⇒ sépare nettement fix vs défaut.
      expect(
        timeRatio,
        `RPC déployée : Actual Total Time ${small.ms.toFixed(1)} ms (groupe ${GIANT_N_SMALL}) → ${big.ms.toFixed(1)} ms (groupe ${GIANT_N_BIG}, ×${GIANT_N_BIG / GIANT_N_SMALL}). Ratio ${timeRatio.toFixed(2)} ≥ 5 ⇒ le coût CROÎT avec le groupe géant = signature O(N) : la RPC déployée n'est PAS le skip-scan corrigé (DISTINCT ON encore en place / retombée / migration 20260517T130000 non appliquée). À 77k prod ⇒ timeout 60 s (le défaut G5).`,
      ).toBeLessThan(5);
      // Garde-fou de non-vacuité : mesures réelles (EXPLAIN non cassé).
      expect(small.ms, "temps mesuré nul = EXPLAIN cassé").toBeGreaterThan(0);
      expect(big.ms, "temps mesuré nul = EXPLAIN cassé").toBeGreaterThan(0);
    });

    it("3. CONTRÔLE NÉGATIF : la forme DISTINCT ON (régime d'index originel) scanne ≈N — prouve que (2) discrimine", () => {
      // Prouve que l'invariance de (2) discrimine GENUINEMENT fix vs défaut :
      // la MÊME fixture via la forme MORTE `DISTINCT ON ... ORDER BY
      // keyexpr,id LIMIT`, dans le RÉGIME D'INDEX DU DÉFAUT ORIGINEL (SANS le
      // composite — il n'existait PAS quand le défaut prod a frappé ; on le
      // DROP en transaction ROLLBACK, méthode de diag prod établie, zéro effet
      // de bord), DOIT scanner ≈N (la cause RÉELLE du timeout 60 s : DISTINCT
      // ON matérialise tout le groupe keyexpr). On le mesure à DEUX tailles :
      // la forme morte SCALE (≈N), donc l'invariance que (2) exige du
      // skip-scan EST un test qui sépare réellement fix/défaut (non vacueux).
      const deadScan = (giantN: number): { scanned: number; hasSort: boolean } => {
        recreateAndSeed(giantN);
        const raw = psqlScript(
          [
            "BEGIN;",
            "DROP INDEX IF EXISTS rpps_ban_eligible_normkey_id_idx;",
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
            "SELECT DISTINCT ON (rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee))",
            "  rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)",
            "FROM rpps_staging t",
            "WHERE (t.geom_source = 'commune_centroid' OR (t.geom IS NULL AND t.adresse IS NOT NULL))",
            "ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id LIMIT 10;",
            "ROLLBACK;",
          ].join("\n"),
        );
        const plan = (JSON.parse(raw) as Array<{ Plan: PlanNode }>)[0].Plan;
        return {
          scanned: totalActualScanRows(plan),
          hasSort: flattenPlan(plan).some((n) => /sort/i.test(String(n["Node Type"]))),
        };
      };
      const small = deadScan(GIANT_N_SMALL);
      const big = deadScan(GIANT_N_BIG);
      // Signature O(N) du défaut : scan ≈ taille du groupe géant, et il SCALE
      // (≈×32 entre SMALL et BIG). Le nœud Sort est plan-dépendant
      // (corroborant journalisé, pas asserté en dur : un Index Scan
      // keyexpr-only lisant ≈N sans Sort reste le DÉFAUT).
      expect(
        small.scanned,
        `contrôle négatif : DISTINCT ON DEVRAIT scanner ≈${GIANT_N_SMALL} (vu ${small.scanned}, Sort=${small.hasSort})`,
      ).toBeGreaterThan(GIANT_N_SMALL / 2);
      expect(
        big.scanned,
        `contrôle négatif : DISTINCT ON DEVRAIT scanner ≈${GIANT_N_BIG} (vu ${big.scanned}, Sort=${big.hasSort})`,
      ).toBeGreaterThan(GIANT_N_BIG / 2);
      // ET il SCALE avec le groupe (≈ proportionnel) — c'est CE comportement
      // O(N) que (2) exige que le skip-scan n'ait PAS ⇒ (2) est non vacueux.
      expect(
        big.scanned / Math.max(small.scanned, 1),
        `contrôle négatif INVALIDE : la forme DISTINCT ON DEVRAIT SCALER avec le groupe (×${GIANT_N_BIG / GIANT_N_SMALL}) — sans ce O(N), l'invariance exigée en (2) ne discrimine rien (vacuité G3)`,
      ).toBeGreaterThan(5);
    });
  },
);
