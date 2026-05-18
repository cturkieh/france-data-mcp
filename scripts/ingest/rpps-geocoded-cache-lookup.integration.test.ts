import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTIVE G5bis — RPC `rpps_geocoded_cache_lookup(p_keys TEXT[])`
// (migration 20260518T120000).
//
// POURQUOI CE TEST : le backfill/cron lisaient le cache `geocoded_addresses`
// par chunks `.in("address_key", slice)` (clés en URL GET) ⇒ ~670 requêtes
// SÉQUENTIELLES (335k / 500). 3 runs prod morts `TypeError: fetch failed` sur
// cette phase. La RPC passe les clés en BODY POST (comme l'énumération) ⇒
// batch large, ~34 requêtes, immunisé URL-length + surface d'échec réduite.
// Ce test PROUVE : (1) ne retourne QUE les clés présentes, valeurs exactes ;
// (2) lot vide → 0 ligne sans erreur ; (3) GROS lot (clés majoritairement
// absentes) → OK, pas d'erreur transport/URL (le point central du correctif).
//
// FAIL-LOUD (R5.2) : skip UNIQUEMENT si DB génuinement injoignable (aucune clé
// service_role). DB là mais RPC absente (migration T-format non appliquée) →
// ÉCHEC explicite, jamais skip silencieux.
//
// `geocoded_addresses` vit HORS du swap atomique (table persistante, jamais
// recréée) ⇒ teardown OBLIGATOIRE des lignes de test (préfixe marqueur unique).
// CHECK table : `accepted=false OR (lat,lon NOT NULL)` → on seed `accepted`
// alternés mais lat/lon cohérents avec la contrainte.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "";
const canRun = SERVICE_KEY !== "";

const MARK = "ZZTESTCACHELOOKUP";
const K1 = `${MARK}|75001|75056`;
const K2 = `${MARK} 10 RUE DE LA PAIX|75011|75111`;
const K3 = `${MARK}|13001|13201`;
const K_ABSENT = `${MARK}_NEVER_INSERTED|00000|00000`;

const SEED = [
  // accepted=false → lat/lon NULL OK vs CHECK ; ban_attempt_count varié.
  { address_key: K1, accepted: false, ban_attempt_count: 2, lat: null, lon: null },
  { address_key: K3, accepted: false, ban_attempt_count: 0, lat: null, lon: null },
  // accepted=true → lat/lon NON NULL requis par le CHECK.
  { address_key: K2, accepted: true, ban_attempt_count: 1, lat: 48.86, lon: 2.34 },
];

describe.skipIf(!canRun)("rpps_geocoded_cache_lookup — lecture cache via RPC (body POST)", () => {
  let svc: SupabaseClient;

  beforeAll(async () => {
    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // FAIL-LOUD R5.2 : DB joignable mais RPC absente → ÉCHEC explicite.
    const probe = await svc.rpc("rpps_geocoded_cache_lookup", { p_keys: [K_ABSENT] });
    if (probe.error) {
      throw new Error(
        `[france-data-mcp] GARDE-FOU INERTE : DB joignable mais RPC rpps_geocoded_cache_lookup absente — migration 20260518T120000_rpps_geocoded_cache_lookup.sql non appliquée (la CLI supabase SKIPPE les migrations T-format ; psql en local / SQL Editor en prod). Erreur : ${probe.error.message}`,
      );
    }

    // Idempotence : purge d'éventuels restes d'un run précédent, puis seed.
    await svc.from("geocoded_addresses").delete().like("address_key", `${MARK}%`);
    const ins = await svc.from("geocoded_addresses").upsert(
      SEED.map((s) => ({
        ...s,
        ban_last_status: s.accepted ? "accepted" : "unresolved",
        geocoded_at: new Date().toISOString(),
      })),
      { onConflict: "address_key" },
    );
    expect(ins.error, `seed geocoded_addresses a échoué: ${ins.error?.message}`).toBeNull();
  }, 30_000);

  afterAll(async () => {
    if (!canRun) return;
    // geocoded_addresses est PERSISTANTE (hors swap) → teardown obligatoire.
    await svc.from("geocoded_addresses").delete().like("address_key", `${MARK}%`);
  });

  it("T-only-present : ne retourne QUE les clés présentes, valeurs exactes", async () => {
    const { data, error } = await svc.rpc("rpps_geocoded_cache_lookup", {
      p_keys: [K1, K2, K3, K_ABSENT],
    });
    expect(error, error?.message).toBeNull();
    const byKey = new Map(
      (data as Array<{ address_key: string; accepted: boolean; ban_attempt_count: number }>).map(
        (r) => [r.address_key, r],
      ),
    );
    expect(byKey.size).toBe(3); // K_ABSENT exclu
    expect(byKey.get(K1)).toMatchObject({ accepted: false, ban_attempt_count: 2 });
    expect(byKey.get(K2)).toMatchObject({ accepted: true, ban_attempt_count: 1 });
    expect(byKey.get(K3)).toMatchObject({ accepted: false, ban_attempt_count: 0 });
    expect(byKey.has(K_ABSENT)).toBe(false);
  });

  it("T-empty : lot vide → 0 ligne, AUCUNE erreur (cap-agnostique)", async () => {
    const { data, error } = await svc.rpc("rpps_geocoded_cache_lookup", { p_keys: [] });
    expect(error, error?.message).toBeNull();
    expect(data).toEqual([]);
  });

  it("T-large-batch : 5000 clés (majorité absentes) en BODY POST → OK, pas d'erreur URL/transport (le cœur du correctif G5bis)", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `${MARK}_BULK_${i}|75001|75056`);
    // K1/K2 noyées dans le gros lot → doivent ressortir, sans fetch failed.
    big[1234] = K1;
    big[4567] = K2;
    const { data, error } = await svc.rpc("rpps_geocoded_cache_lookup", { p_keys: big });
    expect(error, error?.message).toBeNull();
    const keys = new Set((data as Array<{ address_key: string }>).map((r) => r.address_key));
    expect(keys.has(K1)).toBe(true);
    expect(keys.has(K2)).toBe(true);
    expect(keys.size).toBe(2); // seules les 2 présentes
  });

  it("T-no-maxrows-truncation : >1000 clés TOUTES présentes → TOUTES retournées (garde anti-S-1 : RETURNS TABLE serait tronqué à max_rows=1000 silencieusement)", async () => {
    // Le bug attrapé en /review P1 : une fonction RETURNS TABLE est plafonnée
    // SILENCIEUSEMENT à 1000 lignes par PostgREST max_rows ⇒ au run idempotent
    // (~335k clés en cache) les clés tronquées seraient re-soumises à BAN.
    // RETURNS jsonb (1 ligne scalaire) est immunisé. Ce test ÉCHOUERAIT sur
    // l'ancienne forme RETURNS TABLE (1100 attendus, 1000 reçus).
    const N = 1100;
    const capKeys = Array.from({ length: N }, (_, i) => `${MARK}_CAP_${i}|75001|75056`);
    const seed = capKeys.map((k) => ({
      address_key: k,
      accepted: false,
      ban_attempt_count: 0,
      lat: null,
      lon: null,
      ban_last_status: "unresolved",
      geocoded_at: new Date().toISOString(),
    }));
    // Upsert chunké (l'écriture seed, elle, n'est PAS l'objet du test).
    for (let i = 0; i < seed.length; i += 500) {
      const e = await svc
        .from("geocoded_addresses")
        .upsert(seed.slice(i, i + 500), { onConflict: "address_key" });
      expect(e.error, `seed cap a échoué: ${e.error?.message}`).toBeNull();
    }
    const { data, error } = await svc.rpc("rpps_geocoded_cache_lookup", { p_keys: capKeys });
    expect(error, error?.message).toBeNull();
    const got = new Set((data as Array<{ address_key: string }>).map((r) => r.address_key));
    expect(got.size).toBe(N); // 1100, PAS 1000 (preuve : pas de troncature max_rows)
  });
});
