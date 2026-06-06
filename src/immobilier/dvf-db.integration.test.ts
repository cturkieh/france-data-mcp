/**
 * Filet d'intégration PostGIS pour la RPC `dvf_in_radius` (domaine immobilier).
 *
 * Miroir de `src/sante/finess-db.integration.test.ts` : exclu de `test:unit`
 * (suffixe `*.integration.test.ts`) et SKIPPÉ tant que `SUPABASE_ANON_KEY` est
 * vide. Il ne tourne donc qu'au checkpoint de déploiement, une fois la migration
 * `20260606T120000_immobilier.sql` appliquée et la clé anon présente — c'est
 * attendu.
 *
 * Ce qu'il prouve (impossible à couvrir en unitaire avec un Supabase mocké) :
 *  - la colonne GÉNÉRÉE `geom` est bien calculée depuis longitude/latitude,
 *  - le cast `::geography` du RPC mesure des mètres réels (la row HORS rayon est
 *    exclue, la row DANS le rayon est retournée),
 *  - la position dérivée du `geom` (longitude/latitude) remonte peuplée.
 *
 * Données synthétiques préfixées `__itest__` + nettoyées en `finally` pour ne
 * jamais polluer la table de prod.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetClientsForTesting, getUntypedAnonClient } from "../storage/supabase.js";

// Point de test : centre de Charleville-Mézières (aligné finess integration).
const CENTER = { lat: 49.7724, lon: 4.7203 };
// Row DANS le rayon : ~50 m du centre (delta lon ≈ 0.0007° ≈ 50 m à cette latitude).
const INSIDE = { lon: CENTER.lon + 0.0007, lat: CENTER.lat };
// Row HORS rayon : ~2 km du centre (delta lat ≈ 0.018° ≈ 2 km) — exclue à 500 m.
const OUTSIDE = { lon: CENTER.lon, lat: CENTER.lat + 0.018 };

const RADIUS_METERS = 500;

// Identifiants synthétiques (préfixe distinctif → cleanup ciblé, zéro collision
// avec des id_mutation réels DVF qui sont des hex de 12 caractères).
const ITEST_PREFIX = "__itest_dvf__";
const INSIDE_ID = `${ITEST_PREFIX}inside`;
const OUTSIDE_ID = `${ITEST_PREFIX}outside`;
const ITEST_COMMUNE = "08105";

// Skip tant que la clé anon n'est pas fournie (web/remote ou CI sans secret).
const hasKey = (process.env.SUPABASE_ANON_KEY ?? "") !== "";

beforeAll(() => {
  // Tests run against Supabase Local (started by `pnpm db:start`) ou la prod au
  // checkpoint deploy. Defaults alignés sur finess-db.integration.test.ts.
  process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.SUPABASE_ANON_KEY ??= process.env.SUPABASE_LOCAL_ANON_KEY ?? ""; // overridden in CI
  __resetClientsForTesting();
});

async function cleanup(): Promise<void> {
  if (!hasKey) return;
  const supabase = getUntypedAnonClient();
  // `geom` est GENERATED → on ne supprime que par les colonnes de la PK.
  const { error } = await supabase
    .from("dvf_mutations")
    .delete()
    .in("id_mutation", [INSIDE_ID, OUTSIDE_ID]);
  if (error) {
    // Ne pas masquer un échec de nettoyage (sinon rows de test laissées en base).
    console.error(`[dvf-db.integration] cleanup failed: ${error.message}`);
  }
}

afterAll(async () => {
  await cleanup();
});

describe.skipIf(!hasKey)("dvf_in_radius (PostGIS integration)", () => {
  it("ne retourne que la mutation DANS le rayon, avec une position geom peuplée", async () => {
    const supabase = getUntypedAnonClient();

    // Idempotence : purge d'éventuels résidus d'un run précédent interrompu.
    await cleanup();

    // Insert 2 rows synthétiques (geom calculé par Postgres depuis lon/lat —
    // surtout PAS dans le payload : colonne GENERATED, write rejetée).
    const rows = [
      {
        id_mutation: INSIDE_ID,
        date_mutation: "2024-03-01",
        nature_mutation: "Vente",
        valeur_fonciere: 200000,
        code_commune: ITEST_COMMUNE,
        type_local: "Appartement",
        surface_reelle_bati: 50,
        surface_terrain: null,
        prix_m2: 4000,
        longitude: INSIDE.lon,
        latitude: INSIDE.lat,
      },
      {
        id_mutation: OUTSIDE_ID,
        date_mutation: "2024-03-02",
        nature_mutation: "Vente",
        valeur_fonciere: 300000,
        code_commune: ITEST_COMMUNE,
        type_local: "Maison",
        surface_reelle_bati: 100,
        surface_terrain: null,
        prix_m2: 3000,
        longitude: OUTSIDE.lon,
        latitude: OUTSIDE.lat,
      },
    ];

    const { error: insertError } = await supabase.from("dvf_mutations").upsert(rows, {
      onConflict: "id_mutation,code_commune,date_mutation,type_local",
    });
    expect(insertError).toBeNull();

    // RPC via getUntypedAnonClient : `dvf_in_radius` n'est pas encore dans les
    // types générés (pattern documenté du projet — cf. dvf.ts production).
    const { data, error } = await supabase.rpc("dvf_in_radius", {
      p_lat: CENTER.lat,
      p_lon: CENTER.lon,
      p_radius_meters: RADIUS_METERS,
      p_limit: 500,
    });

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);

    const returned = (data as Array<{ id_mutation: string }>).filter((r) =>
      r.id_mutation.startsWith(ITEST_PREFIX),
    );

    // (a) Seule la row DANS le rayon est retournée (le cast ::geography mesure
    //     des mètres réels : la row à ~2 km est exclue d'un rayon de 500 m).
    expect(returned).toHaveLength(1);
    const inside = returned[0] as {
      id_mutation: string;
      longitude: number | null;
      latitude: number | null;
    };
    expect(inside.id_mutation).toBe(INSIDE_ID);

    // (b) La position dérivée du geom (longitude/latitude alimentant la colonne
    //     GENERATED) remonte peuplée et correspond au point inséré → preuve que
    //     la colonne générée + le cast ::geography ont fonctionné de bout en bout.
    expect(inside.longitude).not.toBeNull();
    expect(inside.latitude).not.toBeNull();
    expect(inside.longitude).toBeCloseTo(INSIDE.lon, 4);
    expect(inside.latitude).toBeCloseTo(INSIDE.lat, 4);
  });
});
