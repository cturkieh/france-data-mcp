import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeAddressKey3 } from "../../src/core/address-geocode.js";

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 — RPC d'énumération SERVEUR des clés d'adresse ÉLIGIBLES au géocodage
// BAN (`rpps_distinct_eligible_keys` + `rpps_count_ban_eligible_rows` +
// `ingest_analyze_rpps_staging`), migration 20260517T120000.
//
// POURQUOI CE TEST :
// Le pipeline BAN rapatriait ~1,29 M lignes éligibles en RAM JS (paginé 1000)
// juste pour les dédupliquer en ~339 k clés distinctes (30 min, sans timeout,
// sans log, MÊME boucle dans le cron mensuel — pathologique). La RPC retourne
// directement les clés DISTINCTES éligibles, déléguant la normalisation au
// JUMEAU SQL `rpps_normalize_address_key` (UNIQUE source de vérité, déjà sous
// HARD GATE de parité octet-à-octet JS↔SQL). Ce test PROUVE que la RPC ne PERD
// aucune clé vs l'algorithme JS historique, pagine sans trou ni doublon, et
// rejette toute table hors whitelist (anti-injection).
//
// FAIL-LOUD (R5.2, repris de ban-geocode-parity.integration.test.ts) : on ne
// SKIP que si la DB est génuinement injoignable (aucune clé service_role). Si
// la DB est là MAIS la RPC est absente (migration T-format non appliquée — la
// CLI supabase SKIPPE les migrations `YYYYMMDDThhmmss_`, à appliquer via psql
// en local / SQL Editor en prod), le test ÉCHOUE avec un message clair : un
// garde-fou rouge-visible vaut mieux qu'un skip silencieux.
//
// ÉLIGIBILITÉ (byte-identique à ingest_apply_rpps_ban_geocoding_batch et au
// `.or(...)` PostgREST historique) :
//   geom_source = 'commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL)
// `finess_join` (geom non-NULL, ≠ commune_centroid) est exclu PAR CONSTRUCTION
// par ce prédicat — même WHERE que la RPC d'application (parité de prédicat).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "";

const canRun = SERVICE_KEY !== "";

// Espaces Unicode non-ASCII (sous-ensemble du `\s` JS) — la clé doit les
// collapser comme JS via `\s+`. Repris de ban-geocode-parity (formes ANS).
const NBSP = " "; // U+00A0
const NNBSP = " "; // U+202F
const LIGATURES = "ﬀﬁﬂﬃﬄﬅﬆ";

// Marqueurs ZZTEST… pour les colonnes NOT NULL de rpps_staging (rpps_id, nom,
// prenom) — uniques, faciles à filtrer/tracer (fixtures éphémères, staging
// recréée à chaque run via ingest_create_rpps_staging).
type SeedRow = {
  rpps_id: string;
  nom: string;
  prenom: string;
  adresse: string | null;
  code_postal: string | null;
  code_insee: string | null;
  geom_source: string | null;
  eligible: boolean; // attendu par le prédicat d'éligibilité
};

let seedSeq = 0;
function mk(
  adresse: string | null,
  code_postal: string | null,
  code_insee: string | null,
  geom_source: string | null,
  eligible: boolean,
): SeedRow {
  seedSeq += 1;
  return {
    rpps_id: `ZZTEST${String(seedSeq).padStart(6, "0")}`,
    nom: "ZZTESTNOM",
    prenom: "ZZTESTPRENOM",
    adresse,
    code_postal,
    code_insee,
    geom_source,
    eligible,
  };
}

// Lignes ÉLIGIBLES : geom_source='commune_centroid' OU (geom NULL ET adresse
// NOT NULL). On insère geom=NULL partout (supabase-js ne pose pas de geometry
// PostGIS facilement) ; l'éligibilité est donc pilotée par geom_source/adresse.
const SEEDS: SeedRow[] = [
  // — commune_centroid : éligibles (quel que soit adresse, même NULL) —
  mk("12 RUE DE LA REPUBLIQUE", "75001", "75101", "commune_centroid", true),
  mk("1 PLACE DE L HOTEL DE VILLE CEDEX 04", "75004", "75104", "commune_centroid", true),
  mk("3 RUE DU CŒUR DE VILLE", "06400", "06029", "commune_centroid", true),
  mk("STRAßE 5 STRASBOURG", "67000", "67482", "commune_centroid", true),
  mk(`OFFICE ${LIGATURES} STRASBOURG`, "67000", "67482", "commune_centroid", true),
  mk(`RUE DE LA GARE 67000 STRASBOURG CEDEX${NBSP}08`, "67000", "67482", "commune_centroid", true),
  mk(`10${NBSP}RUE${NNBSP}DE STRASBOURG`, "67000", "67482", "commune_centroid", true),
  mk(null, "13001", "13201", "commune_centroid", true), // adresse NULL OK car commune_centroid
  // Code COURT stocké en CHAR(5) (blank-pad) — round-trip btrim↔trim.
  mk("12 RUE DE LA REPUBLIQUE", "751", "750", "commune_centroid", true),

  // — geom NULL + adresse NOT NULL, geom_source NULL : éligibles —
  mk("8 AVENUE DES TERNES", "75017", "75117", null, true),
  // Adresse à espaces de bord (TEXT, trimmée par la clé) + codes ≤5 chars
  // (colonnes CHAR(5) : un code >5 chars lèverait 22001 — non représentatif
  // d'un code RPPS réel ; le round-trip pad/trim est couvert par les codes
  // COURTS '751'/'750' plus haut).
  mk("   2 BIS BD VOLTAIRE   ", "75011", "75111", null, true),

  // — geom NULL + adresse NOT NULL, geom_source='ban_address' SANS geom :
  //   éligible par le prédicat tel qu'écrit (geom NULL & adresse NOT NULL).
  //   (En prod ban_address pose un geom → exclu ; ici on teste le PRÉDICAT,
  //   pas la sémantique métier de l'UPDATE — parité avec le WHERE de
  //   ingest_apply_rpps_ban_geocoding_batch qui n'a pas non plus de geom ici.)
  mk("99 RUE BAN SANS GEOM", "75009", "75109", "ban_address", true),

  // — NON éligibles : adresse NULL ET geom_source ≠ commune_centroid —
  mk(null, "75008", "75108", "finess_join", false), // finess_join, adresse NULL → exclu
  mk(null, "69001", "69381", "ban_address", false), // ban_address, adresse NULL → exclu
  mk(null, "31000", "31555", null, false), // geom_source NULL, adresse NULL → exclu
];

// Doublons de clé : 3 lignes pointant la même adresse normalisée (variantes
// d'espaces/casse) → la RPC DOIT n'en retourner qu'UNE (représentant MIN(id)).
const DUP_ADDR_VARIANTS: SeedRow[] = [
  mk("50   RUE   DUPONT", "75002", "75102", "commune_centroid", true),
  mk("50 rue dupont", "75002", "75102", "commune_centroid", true),
  mk(`50${NBSP}RUE${NBSP}DUPONT`, "75002", "75102", "commune_centroid", true),
];

const ALL_SEEDS = [...SEEDS, ...DUP_ADDR_VARIANTS];

/** Énumère TOUTES les clés via la RPC en pagination KEYSET (cap-agnostique). */
async function enumerateKeys(
  svc: SupabaseClient,
  table: string,
  pageLimit: number,
): Promise<string[]> {
  const keys: string[] = [];
  let after: string | null = null;
  // Garde anti-boucle infinie (le set de test est petit ; >10 000 = bug RPC).
  for (let guard = 0; guard < 10_000; guard += 1) {
    const { data, error } = await svc.rpc("rpps_distinct_eligible_keys", {
      p_source_table: table,
      p_after: after,
      p_limit: pageLimit,
    });
    if (error) throw new Error(`rpps_distinct_eligible_keys a échoué: ${error.message}`);
    const page = (data ?? []) as Array<{ address_key: string }>;
    if (page.length === 0) break; // terminaison cap-agnostique sur page VIDE
    for (const r of page) keys.push(r.address_key);
    after = (page[page.length - 1] as { address_key: string }).address_key;
  }
  return keys;
}

/**
 * `ingest_create_rpps_staging` DROP+CREATE la table et `NOTIFY pgrst, 'reload
 * schema'` — mais PostgREST recharge son schema-cache de façon ASYNCHRONE. Un
 * `.from("rpps_staging")` immédiat échoue en PGRST205 (table absente du cache)
 * tant que le reload n'a pas convergé. On poll jusqu'à visibilité REST (borné,
 * ÉCHEC BRUYANT au timeout — jamais un test vert sur une table non vue).
 */
async function waitForRestTable(svc: SupabaseClient, table: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastErr = "";
  while (Date.now() < deadline) {
    const { error } = await svc.from(table).select("id").limit(1);
    if (!error) return;
    lastErr = error.message;
    if (error.code !== "PGRST205") {
      throw new Error(`[france-data-mcp] ${table} REST inattendu (non PGRST205) : ${lastErr}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `[france-data-mcp] PostgREST n'a pas rechargé le schema-cache pour ${table} sous 30 s (NOTIFY pgrst non convergé) — dernier message : ${lastErr}`,
  );
}

describe.skipIf(!canRun)("rpps_distinct_eligible_keys — énumération serveur éligibles", () => {
  let svc: SupabaseClient;

  beforeAll(async () => {
    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Staging propre D'ABORD (table éphémère — pas de teardown nécessaire).
    // FAIL-LOUD R5.2 : absente/échouée = migration 20260516T050000 (ou la
    // T-format de cette tâche) non appliquée → ÉCHEC explicite, jamais skip.
    const created = await svc.rpc("ingest_create_rpps_staging");
    if (created.error) {
      throw new Error(
        `[france-data-mcp] GARDE-FOU INERTE : ingest_create_rpps_staging absente/échouée — migration 20260516T050000 / 20260517T120000 non appliquée ? ${created.error.message}`,
      );
    }
    // Attendre que PostgREST voie la table recréée AVANT tout `.from()`.
    await waitForRestTable(svc, "rpps_staging");

    // FAIL-LOUD R5.2 : DB joignable + staging créée mais RPC absente
    // (migration T-format non appliquée) → ÉCHEC explicite, jamais skip
    // silencieux (sinon garde-fou inerte alors que la DB est là).
    const probe = await svc.rpc("rpps_distinct_eligible_keys", {
      p_source_table: "rpps_staging",
      p_after: null,
      p_limit: 1,
    });
    if (probe.error) {
      throw new Error(
        `[france-data-mcp] GARDE-FOU INERTE : la DB est joignable mais la RPC rpps_distinct_eligible_keys est absente — la migration 20260517T120000_rpps_distinct_eligible_keys.sql n'a pas été appliquée (la CLI supabase SKIPPE les migrations T-format ; appliquer via psql en local / SQL Editor en prod). Erreur RPC : ${probe.error.message}`,
      );
    }
    const ins = await svc.from("rpps_staging").insert(
      ALL_SEEDS.map((s) => ({
        rpps_id: s.rpps_id,
        nom: s.nom,
        prenom: s.prenom,
        adresse: s.adresse,
        code_postal: s.code_postal,
        code_insee: s.code_insee,
        geom_source: s.geom_source,
      })),
    );
    expect(ins.error, `seed rpps_staging a échoué: ${ins.error?.message}`).toBeNull();
  }, 60_000); // hook long : recreate staging + attente reload schema-cache PostgREST

  it("T-equivalence : le SET de clés RPC == le SET de l'algo JS historique", async () => {
    // Algo JS HISTORIQUE : tous les éligibles via le `.or(...)` PostgREST
    // d'origine, dédupliqués par normalizeAddressKey3 (forme 3-arg, contrat).
    const { data: rows, error } = await svc
      .from("rpps_staging")
      .select("adresse, code_postal, code_insee")
      .or("geom_source.eq.commune_centroid,and(geom.is.null,adresse.not.is.null)");
    expect(error, `select éligibles (.or) a échoué: ${error?.message}`).toBeNull();

    const expected = new Set<string>();
    for (const r of (rows ?? []) as Array<{
      adresse: string | null;
      code_postal: string | null;
      code_insee: string | null;
    }>) {
      expected.add(normalizeAddressKey3(r.adresse, r.code_postal, r.code_insee));
    }

    // RPC en keyset paginé (p_limit petit pour exercer la pagination).
    const enumerated = await enumerateKeys(svc, "rpps_staging", 3);
    const got = new Set(enumerated);

    // Aucune perte ni ajout : ÉGALITÉ STRICTE des deux ensembles.
    expect(got.size).toBe(expected.size);
    for (const k of expected) expect(got.has(k)).toBe(true);
    for (const k of got) expect(expected.has(k)).toBe(true);
    // Sanity : il y a bien des clés (sinon faux vert sur 2 ensembles vides).
    expect(expected.size).toBeGreaterThan(0);
  });

  it("T-keyset-no-gap-no-dup : pagination p_limit=2 sans trou ni doublon, ordre stable", async () => {
    // Réutilise le helper keyset (même boucle cap-agnostique) avec p_limit=2.
    const keys = await enumerateKeys(svc, "rpps_staging", 2);

    // Aucun doublon inter-pages (le keyset `> $1` strict garantit qu'aucune
    // clé n'est rejouée d'une page à l'autre).
    expect(new Set(keys).size).toBe(keys.length);

    // Ordre & complétude SANS imposer l'ordre UTF-16 de JS : le keyset de la
    // RPC trie par la COLLATION de la base (le `ORDER BY keyexpr` + `> $1` y
    // opèrent), PAS par `>` JavaScript (qui compare en code-units UTF-16 — un
    // ordre DIFFÉRENT pour les clés non-ASCII : Œ, ß→SS, ligatures→ASCII...).
    // Asserter `keys[i] > keys[i-1]` en JS testerait l'ordre JS, pas la
    // correction de la RPC (faux rouge sur données réelles accentuées). La
    // VRAIE invariance, indépendante de la collation : la SÉQUENCE paginée
    // (p_limit=2) doit être EXACTEMENT la séquence d'une page unique large
    // (même ORDER BY serveur) — prouve simultanément : pas de trou, pas de
    // doublon, pas de réordonnancement entre pages.
    const full = await enumerateKeys(svc, "rpps_staging", 1000);
    expect(keys).toEqual(full);
    expect(keys.length).toBeGreaterThan(2); // pagination réellement exercée
  });

  it("T-representative-deterministic : 1 clé multi-lignes → 1 seule ligne, address_key = clé JS", async () => {
    // dupKey = clé JS des 3 variantes DUPONT (espaces/casse). Sa présence
    // EXACTEMENT 1 fois dans l'énumération prouve simultanément : (a) le
    // DISTINCT ON ne rend qu'un représentant pour 3 lignes, (b) address_key
    // == clé JS des inputs (btrim ≡ .trim()). Pas de 2e fetch (tautologique).
    const dupKey = normalizeAddressKey3("50 RUE DUPONT", "75002", "75102");
    const all = await enumerateKeys(svc, "rpps_staging", 1000);
    expect(all.filter((k) => k === dupKey).length).toBe(1);
  });

  it("T-CHAR(5)-roundtrip : codes courts CHAR(5) → address_key == clé JS brute", async () => {
    // La fixture cp '751' / insee '750' est stockée en CHAR(5) (blank-pad).
    // JS reçoit la valeur BRUTE ('751','750') ; btrim SQL ↔ .trim() JS doivent
    // neutraliser le pad symétriquement → clé identique.
    const jsKey = normalizeAddressKey3("12 RUE DE LA REPUBLIQUE", "751", "750");
    const all = await enumerateKeys(svc, "rpps_staging", 1000);
    expect(all).toContain(jsKey);
  });

  it("T-whitelist : table hors whitelist → ERREUR (jamais lignes silencieuses)", async () => {
    const bad = await svc.rpc("rpps_distinct_eligible_keys", {
      p_source_table: "rpps_savoir_faire_stats",
      p_after: null,
      p_limit: 10,
    });
    expect(
      bad.error,
      "rpps_distinct_eligible_keys a accepté une table hors whitelist",
    ).not.toBeNull();
    expect(bad.data ?? null).toBeNull();

    const badCount = await svc.rpc("rpps_count_ban_eligible_rows", {
      p_source_table: "rpps_savoir_faire_stats",
    });
    expect(
      badCount.error,
      "rpps_count_ban_eligible_rows a accepté une table hors whitelist",
    ).not.toBeNull();
  });

  it("T-count-rows-not-keys : count = N lignes éligibles, énumération = M clés distinctes", async () => {
    // N attendu = nb de lignes seed marquées eligible=true (oracle dérivé de
    // l'INTENTION des fixtures, indépendant du SUT) — le prédicat SQL de
    // rpps_count_ban_eligible_rows doit le retrouver exactement.
    const expectedRows = ALL_SEEDS.filter((s) => s.eligible).length;

    const { data: cnt, error } = await svc.rpc("rpps_count_ban_eligible_rows", {
      p_source_table: "rpps_staging",
    });
    expect(error, `rpps_count_ban_eligible_rows a échoué: ${error?.message}`).toBeNull();
    expect(Number(cnt)).toBe(expectedRows);

    // M (clés distinctes) DOIT être < N : les 3 variantes DUPONT
    // (espaces/casse) collapsent en 1 seule clé → prouve que count = LIGNES,
    // jamais clés distinctes (M < N par construction du seed).
    const distinct = await enumerateKeys(svc, "rpps_staging", 1000);
    expect(distinct.length).toBeLessThan(expectedRows);
    // Cohérence : count >= nb de clés distinctes (jamais l'inverse).
    expect(Number(cnt)).toBeGreaterThanOrEqual(distinct.length);
  });
});
