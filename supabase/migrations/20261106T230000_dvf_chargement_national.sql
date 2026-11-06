-- DVF : chargement national semestriel dans `dvf_mutations` (staging + swap atomique).
--
-- POURQUOI : le cache paresseux par commune lit des fichiers annoncés supprimés au
-- 31/11/2026, et rend 0 vente à Paris, Lyon et Marseille (leur code ville n'a pas
-- de fichier, seuls les arrondissements en ont). Cron `ingest-dvf.yml`.
--
-- POURQUOI CALCULER DANS LA BASE (`dvf_stats_in_radius`) : `dvf_in_radius` rend les
-- 500 lignes les plus récentes, et une médiane sur ces lignes est fausse dès que le
-- rayon dépasse le centre-ville. Mesure sur les vraies données, à 50 km de Paris
-- 15e : médiane exacte 4 833 €/m², 500 lignes les plus récentes 8 370 €/m² (biais
-- +73 %, +39 % à 20 km, +11 % à 10 km). La RPC agrège sur TOUTE la zone.
--
-- PAS DE CLÉ PRIMAIRE, PAS DE `geom` : inutilisées en lecture, gain disque mesuré.
-- Le dédoublonnage vit dans `scripts/ingest/dvf-parse.ts`. Sans PK, un lot rejoué se
-- dupliquerait sans erreur : `ingest_analyze_dvf_mutations_staging` rend le compte,
-- le script refuse le swap s'il diffère des lignes insérées.
--
-- `geom` et `dvf_mutations_geom_idx` disparaissent donc au premier swap, à dessein.
-- La prod garde son ancienne structure tant que ce swap n'a pas eu lieu : la
-- migration elle-même ne modifie ni `dvf_mutations` ni ses lignes.

CREATE OR REPLACE FUNCTION ingest_create_dvf_mutations_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS dvf_mutations_staging CASCADE;
  CREATE TABLE dvf_mutations_staging (
    id_mutation         TEXT NOT NULL,
    date_mutation       DATE NOT NULL,
    nature_mutation     TEXT,
    valeur_fonciere     NUMERIC,
    code_commune        TEXT NOT NULL,
    type_local          TEXT NOT NULL DEFAULT '',
    surface_reelle_bati NUMERIC,
    surface_terrain     NUMERIC,
    prix_m2             NUMERIC,
    longitude           DOUBLE PRECISION NOT NULL,
    latitude            DOUBLE PRECISION NOT NULL,
    geog GEOGRAPHY GENERATED ALWAYS AS (
      ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
    ) STORED
  );
  ALTER TABLE dvf_mutations_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read dvf_mutations" ON dvf_mutations_staging FOR SELECT TO anon USING (true);
  -- Index créés AVANT le chargement : un `CREATE INDEX` lourd via PostgREST est
  -- impossible (plafond passerelle de 60 s, cf. skill db-gotchas).
  CREATE INDEX dvf_mutations_staging_geog_gist ON dvf_mutations_staging USING GIST (geog);
  CREATE INDEX dvf_mutations_staging_code_commune_idx ON dvf_mutations_staging (code_commune);
  NOTIFY pgrst, 'reload schema';
END;
$$;
REVOKE EXECUTE ON FUNCTION ingest_create_dvf_mutations_staging() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ingest_create_dvf_mutations_staging() TO service_role;

-- `SET statement_timeout` au niveau fonction : sans lui, PostgREST impose 8 s
-- (`authenticator`). 55 s reste sous le plafond passerelle de 60 s.
CREATE OR REPLACE FUNCTION ingest_analyze_dvf_mutations_staging()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  ANALYZE dvf_mutations_staging;
  SELECT count(*) INTO v_count FROM dvf_mutations_staging;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION ingest_analyze_dvf_mutations_staging() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ingest_analyze_dvf_mutations_staging() TO service_role;

-- Dernière date servie, pour refuser une livraison qui recule. Budget propre : sans
-- index sur `date_mutation`, une lecture directe via PostgREST serait coupée à 8 s sur
-- la table nationale froide, et le cron échouerait dès la 2e livraison.
CREATE OR REPLACE FUNCTION ingest_dvf_latest_date()
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
  SELECT max(date_mutation) FROM dvf_mutations;
$$;
REVOKE EXECUTE ON FUNCTION ingest_dvf_latest_date() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ingest_dvf_latest_date() TO service_role;

-- Marche aussi sur la table actuelle : la colonne `geog` y existe déjà.
CREATE OR REPLACE FUNCTION dvf_stats_in_radius(
  p_lat DOUBLE PRECISION,
  p_lon DOUBLE PRECISION,
  p_radius_meters DOUBLE PRECISION
) RETURNS TABLE (
  n_lignes INT,
  n_ventes INT,
  prix_m2_median DOUBLE PRECISION,
  prix_m2_p25 DOUBLE PRECISION,
  prix_m2_p75 DOUBLE PRECISION,
  n_terrains INT,
  prix_terrain_median DOUBLE PRECISION,
  date_min DATE,
  date_max DATE
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
    count(*)::int,
    count(m.prix_m2)::int,
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY m.prix_m2::float8),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY m.prix_m2::float8),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY m.prix_m2::float8),
    (count(*) FILTER (WHERE m.surface_terrain > 0))::int,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY m.valeur_fonciere::float8) FILTER (WHERE m.surface_terrain > 0),
    min(m.date_mutation),
    max(m.date_mutation)
  FROM dvf_mutations m
  WHERE ST_DWithin(m.geog, v_point, p_radius_meters);
END;
$$;
GRANT EXECUTE ON FUNCTION dvf_stats_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO anon;

-- Canaris : 5 communes mesurées présentes le 2026-11-06 dans `full-2025` +
-- `full-2026-s1` (trois arrondissements, un code alphanumérique, un outre-mer).
INSERT INTO ingest_canary_targets (source, key_type, key_value, description) VALUES
  ('dvf', 'code_insee', '75115', 'Paris 15e — arrondissement, jamais le code ville'),
  ('dvf', 'code_insee', '69383', 'Lyon 3e — arrondissement, jamais le code ville'),
  ('dvf', 'code_insee', '13206', 'Marseille 6e — arrondissement, jamais le code ville'),
  ('dvf', 'code_insee', '2A004', 'Ajaccio — code INSEE alphanumérique (Corse)'),
  ('dvf', 'code_insee', '97411', 'Saint-Denis de La Réunion — outre-mer')
ON CONFLICT DO NOTHING;

-- check_ingest_canary : def COMPLÈTE recopiée VERBATIM de 20260922T000500 (toutes
-- les branches) + la branche `dvf`. Un CREATE OR REPLACE qui oublie une branche tue
-- un canari en silence.
CREATE OR REPLACE FUNCTION check_ingest_canary(p_source TEXT) RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  missing TEXT[];
BEGIN
  IF p_source = 'finess' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN finess f
      ON t.key_type = 'num_finess'
     AND f.num_finess = t.key_value
    WHERE t.source = 'finess'
      AND t.key_type = 'num_finess'
      AND f.num_finess IS NULL;

  ELSIF p_source = 'ameli_ps' THEN
    missing := NULL;

  ELSIF p_source = 'cds' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN centres_sante c
      ON t.key_type = 'etab_finess'
     AND c.etab_finess = t.key_value
    WHERE t.source = 'cds'
      AND t.key_type = 'etab_finess'
      AND c.etab_finess IS NULL;

  ELSIF p_source = 'rpps' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN rpps r
      ON t.key_type = 'rpps_id'
     AND r.rpps_id = t.key_value
    WHERE t.source = 'rpps'
      AND t.key_type = 'rpps_id'
      AND r.rpps_id IS NULL;

  ELSIF p_source = 'iris' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN iris i
      ON t.key_type = 'code_iris'
     AND i.code_iris = t.key_value
    WHERE t.source = 'iris'
      AND t.key_type = 'code_iris'
      AND i.code_iris IS NULL;

  ELSIF p_source = 'sitadel' THEN
    -- Pivot key_type 'code_insee' : la commune doit avoir ≥ 1 ligne.
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    WHERE t.source = 'sitadel'
      AND t.key_type = 'code_insee'
      AND NOT EXISTS (
        SELECT 1 FROM sitadel_logements s WHERE s.code_insee = t.key_value
      );

    -- Lecture ANON : le tool lit `sitadel_logements` sous `anon`. Table sans
    -- policy = default-deny = 200 OK avec `[]`, PAS une erreur → l'outil
    -- rendrait `indisponible:no_data` pour TOUTE la France, cron vert.
    IF NOT has_table_privilege('anon', 'public.sitadel_logements', 'SELECT')
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = 'sitadel_logements'
           AND p.cmd = 'SELECT'
           AND 'anon' = ANY (p.roles)
       ) THEN
      -- `array_append`, PAS `|| 'x'` : un littéral nu est lu comme un TABLEAU
      -- (22P02 « malformed array literal », prouvé en rejouant la branche rouge).
      missing := array_append(COALESCE(missing, ARRAY[]::TEXT[]), 'anon_read_perdue');
    END IF;

  ELSIF p_source = 'dvf' THEN
    -- Pivot key_type 'code_insee' : la commune doit avoir ≥ 1 ligne.
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    WHERE t.source = 'dvf'
      AND t.key_type = 'code_insee'
      AND NOT EXISTS (
        SELECT 1 FROM dvf_mutations d WHERE d.code_commune = t.key_value
      );

    -- Lecture ANON : les tools lisent `dvf_mutations` sous `anon`. Table sans
    -- policy = default-deny = 200 OK avec `[]`, PAS une erreur → 0 vente pour
    -- TOUTE la France, cron vert.
    IF NOT has_table_privilege('anon', 'public.dvf_mutations', 'SELECT')
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = 'dvf_mutations'
           AND p.cmd = 'SELECT'
           AND 'anon' = ANY (p.roles)
       ) THEN
      missing := array_append(COALESCE(missing, ARRAY[]::TEXT[]), 'anon_read_perdue');
    END IF;

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

NOTIFY pgrst, 'reload schema';
