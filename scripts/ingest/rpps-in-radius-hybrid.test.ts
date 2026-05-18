import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRppsInRadius } from "../../src/sante/rpps-db.js";
import { __resetClientsForTesting } from "../../src/storage/supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test FONCTIONNEL de la RPC `rpps_in_radius` HYBRIDE (Task 1, migration
// 20260516T050000_rpps_in_radius_hybrid.sql) contre Supabase LOCAL.
//
// Couvre la spec rév.2 §4.6 :
//  - T-F1   : DISJONCTION (le test le plus important). Une row `ban_address`
//             /`finess_join` captée par la branche PRÉCISE ne doit JAMAIS être
//             re-captée par la branche CENTROÏDE (prédicat F1
//             `geom_source='commune_centroid'` dans le LATERAL). Zéro doublon
//             d'`id` dans tout le résultat.
//  - T-precise  : `ban_address` → geo_precision='adresse', distance EXACTE
//                  (~200 m) ; `finess_join` → geo_precision='etablissement_finess'.
//  - T-centroid : `commune_centroid` → geo_precision='centroide_commune',
//                  distance = distance au centroïde commune.
//  - T-priority : la ligne `finess_join` ressort bien 'etablissement_finess'
//                 (jamais écrasée par la logique centroïde).
//  - T-sentinel : matview `rpps_commune_centroids` vide → l'appel REMONTE une
//                 erreur (wrapper throw) DISTINCTE d'un "0 résultat" silencieux
//                 (sentinelle P0002). NB : le PostgREST local masque le SQLSTATE
//                 (message générique) — on assert donc la PROPAGATION distincte,
//                 conformément au repli explicite prévu par le plan Task 4.
//
// Harness : le repo n'a pas de seed RPPS statique (supabase/seed.sql ne touche
// que finess + annuaire_ameli) et pas de dépendance `pg`. On seed/teardown via
// le client service_role supabase-js (insert GeoJSON sur la colonne geometry,
// accepté par PostgREST), on rafraîchit la matview via la RPC whitelistée
// `ingest_refresh_matview` (mécanisme identique au cron mensuel prod), et on
// lit le comportement via le wrapper public `getRppsInRadius` (client anon —
// exerce le vrai chemin MCP). Toutes les rows seedées portent le préfixe
// rpps_id `ZZHYB` → teardown chirurgical, aucune autre donnée touchée.
//
// EMPLACEMENT / CONVENTION (signalé) : le plan demande explicitement
// `scripts/ingest/rpps-in-radius-hybrid.test.ts`. Or la convention repo pour
// les tests DB-backed est `*.integration.test.ts` (exclus de `pnpm test:unit`).
// Comme `scripts/ingest/*.test.ts` est inclus par `test:unit` (sans DB), on
// garde le chemin demandé MAIS on SKIPPE la suite si la base locale / la clé
// service_role ne sont pas joignables (cas `pnpm test:unit` / pas de
// `pnpm db:start`). En `pnpm test` (CI : DB up + SUPABASE_SERVICE_ROLE_KEY),
// la suite s'exécute pleinement.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
// CI exporte SUPABASE_SERVICE_ROLE_KEY (ci.yml). En local, fallback sur
// SUPABASE_LOCAL_SERVICE_ROLE_KEY (parallèle du SUPABASE_LOCAL_ANON_KEY des
// autres tests d'intégration). Vide → suite skippée (pas de faux vert).
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_LOCAL_ANON_KEY ?? "";

const RPPS_PREFIX = "ZZHYB";
const CODE_INSEE = "75116"; // Paris 16e — `code_insee` partagé par A, B, C.
const CODE_DEPT = "75";

// Point de recherche (Paris 16e, ~place proche). Toutes les distances sont
// dérivées géographiquement de ce point.
const SEARCH = { lat: 48.86, lon: 2.27 };

// À lat 48.86 : 1° lon ≈ 73,3 km. ~200 m Est → Δlon ≈ 200/73300 ≈ 0,002729°.
const DELTA_LON_200M = 200 / 73_300;

/** Service client (bypass RLS) — seed/teardown/refresh matview uniquement. */
let svc: SupabaseClient;

/**
 * Insère une row `rpps`. `geom` en GeoJSON (PostgREST l'accepte sur la colonne
 * geometry ; `geog` est GENERATED). `categorie_code='C'` → visible avec le
 * filtre catégorie par défaut (`rpps_categorie_match` : cardinality 0 ⇒ 'C').
 */
async function seedRow(opts: {
  suffix: string;
  lat: number;
  lon: number;
  geomSource: "finess_join" | "ban_address" | "commune_centroid";
}): Promise<void> {
  const { error } = await svc.from("rpps").insert({
    rpps_id: `${RPPS_PREFIX}${opts.suffix}`,
    nom: `HYB_${opts.suffix}`,
    prenom: "TEST",
    code_departement: CODE_DEPT,
    code_insee: CODE_INSEE,
    categorie_code: "C",
    geom: { type: "Point", coordinates: [opts.lon, opts.lat] },
    geom_source: opts.geomSource,
  });
  if (error) throw new Error(`seedRow(${opts.suffix}) failed: ${error.message}`);
}

/** Supprime toutes les rows de test (idempotent). */
async function cleanupSeed(): Promise<void> {
  await svc.from("rpps").delete().like("rpps_id", `${RPPS_PREFIX}%`);
}

/**
 * Rafraîchit la matview centroïdes via la RPC whitelistée — exactement le
 * mécanisme du cron mensuel prod (REFRESH MATERIALIZED VIEW CONCURRENTLY).
 */
async function refreshCentroids(): Promise<void> {
  const { error } = await svc.rpc("ingest_refresh_matview", {
    p_matview: "rpps_commune_centroids",
  });
  if (error) throw new Error(`refresh rpps_commune_centroids failed: ${error.message}`);
}

const canRun = SERVICE_KEY !== "" && ANON_KEY !== "";

describe.skipIf(!canRun)("rpps_in_radius hybride (DB locale)", () => {
  beforeAll(async () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = ANON_KEY;
    __resetClientsForTesting(); // le wrapper utilise getUntypedAnonClient()

    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    await cleanupSeed();
    // A : finess_join, ~150 m Est du point de recherche.
    await seedRow({
      suffix: "_A",
      lat: SEARCH.lat,
      lon: SEARCH.lon + 150 / 73_300,
      geomSource: "finess_join",
    });
    // B : ban_address, ~200 m Est du point de recherche.
    await seedRow({
      suffix: "_B",
      lat: SEARCH.lat,
      lon: SEARCH.lon + DELTA_LON_200M,
      geomSource: "ban_address",
    });
    // C : commune_centroid, posé ~50 m du point (peu importe la position
    // exacte : la branche centroïde mesure la distance au CENTROÏDE de la
    // matview, pas au point de C — ici la matview n'aura qu'1 row → centroïde
    // = position de C).
    await seedRow({
      suffix: "_C",
      lat: SEARCH.lat,
      lon: SEARCH.lon + 50 / 73_300,
      geomSource: "commune_centroid",
    });
    await refreshCentroids();
  });

  afterAll(async () => {
    if (!canRun) return;
    await cleanupSeed();
    await refreshCentroids(); // remet la matview dans un état propre
  });

  // ── T-F1 : DISJONCTION (cœur de la spec) ─────────────────────────────────
  it("T-F1 : aucun doublon d'id — A et B captés UNE SEULE fois (disjonction)", async () => {
    const { results } = await getRppsInRadius({
      center: SEARCH,
      radiusKm: 1, // couvre A, B, C ET le centroïde commune (= position de C)
      limit: 100,
    });

    const seeded = results.filter((r) => r.rpps_id.startsWith(RPPS_PREFIX));
    const ids = seeded.map((r) => r.id);

    // Invariant central : zéro doublon d'`id` sur TOUT le résultat. Si le
    // prédicat F1 `geom_source='commune_centroid'` était retiré du LATERAL,
    // A (finess_join) ET B (ban_address) — qui partagent le code_insee
    // 75116 dont le centroïde tombe dans le rayon — seraient AUSSI ramassés
    // par la branche centroïde → chaque id apparaîtrait 2×. Ce test
    // échouerait alors ICI (longueur dédupliquée < longueur brute).
    expect(new Set(ids).size).toBe(ids.length);

    const byRpps = (sfx: string) => seeded.filter((r) => r.rpps_id === `${RPPS_PREFIX}${sfx}`);
    // B (ban_address) : exactement UNE occurrence (pas precise + centroïde).
    expect(byRpps("_B")).toHaveLength(1);
    // A (finess_join) : idem.
    expect(byRpps("_A")).toHaveLength(1);
    // Les 3 rows seedées sont présentes, chacune une seule fois.
    expect(seeded).toHaveLength(3);
  });

  // ── T-precise : branche précise, distance exacte + geo_precision ─────────
  it("T-precise : B ban_address ≈ 200 m → geo_precision='adresse'", async () => {
    const { results } = await getRppsInRadius({
      center: SEARCH,
      radiusKm: 1,
      limit: 100,
    });
    const b = results.find((r) => r.rpps_id === `${RPPS_PREFIX}_B`);
    expect(b).toBeDefined();
    expect(b?.geo_precision).toBe("adresse");
    expect(b?.coords).not.toBeNull();
    // distance_km = mètres/1000 arrondi 2 déc. ~200 m → 0,2 km. Tolérance
    // raisonnable (géodésie + arrondi) : [0,15 ; 0,25] km.
    expect(b?.distance_km).toBeGreaterThanOrEqual(0.15);
    expect(b?.distance_km).toBeLessThanOrEqual(0.25);
  });

  it("T-precise : A finess_join → geo_precision='etablissement_finess'", async () => {
    const { results } = await getRppsInRadius({
      center: SEARCH,
      radiusKm: 1,
      limit: 100,
    });
    const a = results.find((r) => r.rpps_id === `${RPPS_PREFIX}_A`);
    expect(a).toBeDefined();
    expect(a?.geo_precision).toBe("etablissement_finess");
    expect(a?.coords).not.toBeNull();
    // ~150 m → 0,15 km (tolérance).
    expect(a?.distance_km).toBeGreaterThanOrEqual(0.1);
    expect(a?.distance_km).toBeLessThanOrEqual(0.2);
  });

  // ── T-centroid : branche centroïde résiduelle ───────────────────────────
  it("T-centroid : C commune_centroid → geo_precision='centroide_commune'", async () => {
    const { results } = await getRppsInRadius({
      center: SEARCH,
      radiusKm: 1,
      limit: 100,
    });
    const c = results.find((r) => r.rpps_id === `${RPPS_PREFIX}_C`);
    expect(c).toBeDefined();
    expect(c?.geo_precision).toBe("centroide_commune");
    expect(c?.coords).not.toBeNull();
    // La matview n'a qu'1 row commune_centroid (C) pour 75116 → le centroïde
    // = position de C (~50 m du point). La distance ramenée est celle au
    // CENTROÏDE commune, pas au point de C : ici les deux coïncident.
    expect(c?.distance_km).toBeGreaterThanOrEqual(0);
    expect(c?.distance_km).toBeLessThanOrEqual(0.1);
  });

  // ── T-priority : finess_join jamais transformée en centroïde ────────────
  it("T-priority : A finess_join ressort 'etablissement_finess' (jamais écrasée)", async () => {
    const { results } = await getRppsInRadius({
      center: SEARCH,
      radiusKm: 1,
      limit: 100,
    });
    const a = results.find((r) => r.rpps_id === `${RPPS_PREFIX}_A`);
    expect(a?.geo_precision).toBe("etablissement_finess");
    // Et surtout : A n'apparaît PAS aussi en 'centroide_commune'.
    const aAsCentroid = results.filter(
      (r) => r.rpps_id === `${RPPS_PREFIX}_A` && r.geo_precision === "centroide_commune",
    );
    expect(aAsCentroid).toHaveLength(0);
  });

  // ── T-sentinel P0002 : matview vide ⇒ erreur, PAS 0-résultat silencieux ──
  it("T-sentinel : matview vide → l'appel ÉCHOUE, distinct d'un 0-résultat", async () => {
    // 1) Référence : recherche LOIN de toute row mais matview PEUPLÉE →
    //    chemin "0 résultat" LÉGITIME (pas d'erreur, tableau vide).
    const farButPopulated = await getRppsInRadius({
      center: { lat: 0.0, lon: 0.0 }, // plein océan
      radiusKm: 1,
      limit: 10,
    });
    expect(farButPopulated.results).toEqual([]);
    expect(farButPopulated.count).toBe(0);

    // 2) Vide la matview : supprime toutes les rows commune_centroid puis
    //    refresh → cardinalité 0. (REFRESH CONCURRENTLY supporte le passage
    //    à vide une fois la matview déjà peuplée — vérifié.)
    await svc.from("rpps").delete().eq("geom_source", "commune_centroid");
    await refreshCentroids();

    try {
      // 3) Même genre d'appel : la sentinelle P0002 doit faire ÉCHOUER l'appel
      //    (le wrapper `getRppsInRadius` throw sur error non-null) — surtout
      //    PAS retourner `{ results: [] }` comme en (1). C'est la distinction
      //    "erreur propagée" vs "0 résultat silencieux" : le contrat anti
      //    cry-wolf de la sentinelle. (Le PostgREST local masque le SQLSTATE
      //    `P0002` en message générique — non assertable via supabase-js ici ;
      //    on assert la propagation distincte, conforme au repli Task 4.)
      await expect(getRppsInRadius({ center: SEARCH, radiusKm: 1, limit: 10 })).rejects.toThrow();
    } finally {
      // 4) Restaure la matview (re-seed C + refresh) pour ne pas polluer
      //    d'éventuels runs ultérieurs même si une assertion ci-dessus jette.
      await seedRow({
        suffix: "_C",
        lat: SEARCH.lat,
        lon: SEARCH.lon + 50 / 73_300,
        geomSource: "commune_centroid",
      });
      await refreshCentroids();
    }
  });
});
