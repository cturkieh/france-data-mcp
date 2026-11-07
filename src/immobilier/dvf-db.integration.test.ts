/**
 * Filet d'intégration PostGIS pour la RPC `dvf_stats_in_radius`.
 *
 * Exclu de `test:unit` et SKIPPÉ sans les clés. La RPC et la table vivent dans
 * des migrations au format T, que `supabase db reset` saute : ce test ne vaut
 * donc que contre une base où elles sont appliquées (checkpoint de déploiement).
 *
 * Ce qu'il prouve (impossible à couvrir avec un Supabase mocké) :
 *  - la colonne GÉNÉRÉE `geog` mesure des mètres réels (la ligne HORS rayon est exclue),
 *  - la RPC rend la ligne d'agrégat attendue sous le client anon et la coercition
 *    de `dvfStatsInRadius` accepte sa sérialisation réelle,
 *  - un point sans mutation rend bien UNE ligne, `n_lignes` = 0.
 *
 * Point de test en pleine mer : sur une table nationale, n'importe quel point à
 * terre mêlerait de vraies ventes aux lignes synthétiques. Préfixe distinctif +
 * nettoyage en fin de test pour ne jamais polluer la table.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetClientsForTesting, getUntypedServiceClient } from "../storage/supabase.js";
import { dvfStatsInRadius } from "./dvf.js";

// Golfe de Gascogne, à plus de 100 km de la côte.
const CENTER = { lat: 45.5, lon: -3.5 };
// DANS le rayon : ~55 m au nord du centre. HORS rayon : ~2 km.
const INSIDE = { lon: CENTER.lon, lat: CENTER.lat + 0.0005 };
const OUTSIDE = { lon: CENTER.lon, lat: CENTER.lat + 0.018 };
const RADIUS_KM = 0.5;
// Autre point en mer, sans aucune ligne synthétique.
const EMPTY_POINT = { lat: 45.0, lon: -4.0 };

const ITEST_PREFIX = "__itest_dvf__";
const INSIDE_ID = `${ITEST_PREFIX}inside`;
const OUTSIDE_ID = `${ITEST_PREFIX}outside`;
const TERRAIN_ID = `${ITEST_PREFIX}terrain`;
const ITEST_COMMUNE = "08105";
const ITEST_DATE = "2026-03-01";

// Écriture via service_role (anon n'a pas de policy INSERT), lecture via anon.
const hasKey =
  (process.env.SUPABASE_ANON_KEY ?? "") !== "" &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "") !== "";

beforeAll(() => {
  process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.SUPABASE_ANON_KEY ??= process.env.SUPABASE_LOCAL_ANON_KEY ?? ""; // overridden in CI
  __resetClientsForTesting();
});

async function cleanup(): Promise<void> {
  if (!hasKey) return;
  const { error } = await getUntypedServiceClient()
    .from("dvf_mutations")
    .delete()
    .in("id_mutation", [INSIDE_ID, OUTSIDE_ID, TERRAIN_ID]);
  if (error) {
    // Ne pas masquer un échec de nettoyage (sinon lignes de test laissées en base).
    console.error(`[dvf-db.integration] cleanup failed: ${error.message}`);
  }
}

afterAll(async () => {
  await cleanup();
});

describe.skipIf(!hasKey)("dvf_stats_in_radius (PostGIS integration)", () => {
  it("n'agrège que les mutations DANS le rayon, terrains compris", async () => {
    await cleanup();

    const commun = {
      date_mutation: ITEST_DATE,
      nature_mutation: "Vente",
      code_commune: ITEST_COMMUNE,
    };
    // `geom`/`geog` sont GENERATED : surtout pas dans le payload.
    const { error: insertError } = await getUntypedServiceClient()
      .from("dvf_mutations")
      .insert([
        {
          ...commun,
          id_mutation: INSIDE_ID,
          valeur_fonciere: 200000,
          type_local: "Appartement",
          surface_reelle_bati: 50,
          surface_terrain: null,
          prix_m2: 4000,
          longitude: INSIDE.lon,
          latitude: INSIDE.lat,
        },
        {
          ...commun,
          id_mutation: OUTSIDE_ID,
          valeur_fonciere: 900000,
          type_local: "Maison",
          surface_reelle_bati: 100,
          surface_terrain: null,
          prix_m2: 9000,
          longitude: OUTSIDE.lon,
          latitude: OUTSIDE.lat,
        },
        {
          ...commun,
          id_mutation: TERRAIN_ID,
          valeur_fonciere: 120000,
          type_local: "",
          surface_reelle_bati: null,
          surface_terrain: 300,
          prix_m2: null,
          longitude: INSIDE.lon,
          latitude: INSIDE.lat,
        },
      ]);
    expect(insertError).toBeNull();

    const stats = await dvfStatsInRadius(CENTER.lat, CENTER.lon, RADIUS_KM);

    expect(stats.n_lignes).toBe(2);
    expect(stats.n_ventes).toBe(1);
    expect(stats.prix_m2_median).toBe(4000);
    expect(stats.prix_m2_p25).toBe(4000);
    expect(stats.prix_m2_p75).toBe(4000);
    expect(stats.n_terrains).toBe(1);
    expect(stats.prix_terrain_median).toBe(120000);
    expect(stats.date_min).toBe(ITEST_DATE);
    expect(stats.date_max).toBe(ITEST_DATE);
  });

  it("point sans mutation → une ligne, n_lignes = 0, médianes et dates null", async () => {
    await expect(
      dvfStatsInRadius(EMPTY_POINT.lat, EMPTY_POINT.lon, RADIUS_KM),
    ).resolves.toStrictEqual({
      n_lignes: 0,
      n_ventes: 0,
      prix_m2_median: null,
      prix_m2_p25: null,
      prix_m2_p75: null,
      n_terrains: 0,
      prix_terrain_median: null,
      date_min: null,
      date_max: null,
    });
  });
});
