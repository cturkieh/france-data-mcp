-- Fix FRANCE-DATA-MCP-T — `cout_foncier` / `dynamique_immobiliere` → RPC
-- `dvf_in_radius` coupée en 57014 (statement_timeout) : 11 events en 1 jour.
--
-- CAUSE RACINE (prouvée prod, EXPLAIN ANALYZE + catalogue, 2026-10-05) :
--   1. Index inutilisable : la RPC filtrait `ST_DWithin(m.geom::geography, …)`
--      alors que le seul index spatial est `GIST (geom)` (geometry). Le cast
--      runtime `::geography` produit une EXPRESSION que l'index geometry ne
--      couvre pas → `Parallel Seq Scan` sur toute `dvf_mutations` (~223 K
--      lignes, ~67 MB) : ~317 ms à chaud, > 3 s à froid / sous contention.
--      Même piège que le gotcha « colonne calculée geog GEOGRAPHY STORED +
--      GIST (cast runtime tue le plan) » déjà résolu pour `finess`
--      (20260508000013_finess_v2_schema.sql + 20260508000014).
--   2. Budget : la fonction n'avait AUCUN `SET statement_timeout` → elle
--      hérite du rôle `anon` = 3 s (rolconfig prod), plafond franchi à froid.
--
-- FIX :
--   a. Colonne `geog GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED`
--      + `GIST (geog)` — idiome finess v2. Colonne générée : JAMAIS écrite
--      par `upsertMutations` (payload à colonnes explicites, `geom` en est
--      déjà absent — src/immobilier/dvf.ts).
--   b. RPC réécrite sur `m.geog` (index-able) + `SET statement_timeout='15s'`
--      (parité `rpps_in_radius`, < 60 s passerelle PostgREST).
--   c. Sortie : `RETURNS TABLE` EXPLICITE calquée sur le type TS `DvfMutation`
--      au lieu de `RETURNS SETOF dvf_mutations`. Avec SETOF, la nouvelle
--      colonne `geog` (et déjà `geom`) partaient sur le fil en hex EWKB string,
--      hors contrat TS, ×500 lignes, et vers les consommateurs de la lib npm
--      publique (`dvfInRadius` est exporté). Aucun consommateur ne lit
--      `geom`/`geog` (grep src/ : seuls aggregatePrix + date_mutation).
--      Changer le type de retour impose DROP + CREATE (CREATE OR REPLACE
--      refuse un changement de RETURNS) ; aucun objet ne dépend de la RPC.
--
-- COÛT D'APPLY : `ADD COLUMN … STORED` réécrit la table (ACCESS EXCLUSIVE,
-- quelques secondes sur ~223 K lignes) puis `CREATE INDEX` GiST (quelques
-- secondes). Pendant ce court verrou, `cout_foncier` peut attendre/échouer —
-- appliquer hors pic. Via MCP Supabase `apply_migration` (connexion directe,
-- pas la passerelle PostgREST 60 s).
--
-- VÉRIFICATION POST-APPLY (attendu : `Bitmap Index Scan on
-- dvf_mutations_geog_gist` ou `Index Scan using dvf_mutations_geog_gist`,
-- PLUS de `Seq Scan on dvf_mutations`) :
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM dvf_in_radius(48.8566, 2.3522, 1000, 500);
-- et le plan interne (la RPC plpgsql masque son plan) :
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT m.id_mutation FROM dvf_mutations m
--   WHERE m.geog IS NOT NULL
--     AND ST_DWithin(m.geog, ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography, 1000)
--   ORDER BY m.date_mutation DESC LIMIT 500;
--   SELECT proconfig FROM pg_proc WHERE proname = 'dvf_in_radius';
--   -- attendu : {"search_path=public, extensions",statement_timeout=15s}

ALTER TABLE dvf_mutations
  ADD COLUMN IF NOT EXISTS geog GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED;

CREATE INDEX IF NOT EXISTS dvf_mutations_geog_gist
  ON dvf_mutations USING GIST (geog);

DROP FUNCTION IF EXISTS dvf_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INT);

CREATE OR REPLACE FUNCTION dvf_in_radius(
  p_lat            DOUBLE PRECISION,
  p_lon            DOUBLE PRECISION,
  p_radius_meters  DOUBLE PRECISION,
  p_limit          INT DEFAULT 500
) RETURNS TABLE (
  id_mutation          TEXT,
  date_mutation        DATE,
  nature_mutation      TEXT,
  valeur_fonciere      NUMERIC,
  code_commune         TEXT,
  type_local           TEXT,
  surface_reelle_bati  NUMERIC,
  surface_terrain      NUMERIC,
  prix_m2              NUMERIC,
  longitude            DOUBLE PRECISION,
  latitude             DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    m.id_mutation,
    m.date_mutation,
    m.nature_mutation,
    m.valeur_fonciere,
    m.code_commune,
    m.type_local,
    m.surface_reelle_bati,
    m.surface_terrain,
    m.prix_m2,
    m.longitude,
    m.latitude
  FROM dvf_mutations m
  WHERE m.geog IS NOT NULL
    AND ST_DWithin(m.geog, v_point, p_radius_meters)
  ORDER BY m.date_mutation DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION dvf_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INT) TO anon;

-- Recharge le cache de schéma PostgREST (signature/retour de RPC modifiés).
NOTIFY pgrst, 'reload schema';
