-- Ajoute `lost_geom` à ingest_finess_staging_diff : nombre d'établissements
-- géolocalisés en prod dont la ligne de staging n'a PAS de point.
--
-- C'est l'invariant de non-régression de la migration ANS (dry-run n°2,
-- 2026-09-05) : la couverture globale est passée de 100 % (CSV DREES géocodé)
-- à 94,97 %, mais `lost_geom = 0` — les 5 271 sans point sont TOUS des
-- établissements nouveaux (3 797 métropole + 1 474 DOM), jamais présents en
-- prod. Un seuil de couverture global ne distingue pas « inventaire nouveau
-- pas encore géocodé » de « établissements existants qui perdent leur point » ;
-- `lost_geom` le fait. Le script bloque le swap si lost_geom > 0,5 % des
-- établissements géolocalisés en prod.
--
-- Recréation VERBATIM de la def 20260905T210000 + le champ (PostgreSQL n'a pas
-- d'héritage de corps de fonction).

CREATE OR REPLACE FUNCTION public.ingest_finess_staging_diff()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'staging_rows',      (SELECT count(*) FROM finess_staging),
    'prod_rows',         (SELECT count(*) FROM finess),
    'prod_with_geom',    (SELECT count(*) FROM finess WHERE geom IS NOT NULL),
    'added',             (SELECT count(*) FROM finess_staging s
                           WHERE NOT EXISTS (SELECT 1 FROM finess f WHERE f.num_finess = s.num_finess)),
    'removed',           (SELECT count(*) FROM finess f
                           WHERE NOT EXISTS (SELECT 1 FROM finess_staging s WHERE s.num_finess = f.num_finess)),
    'lost_geom',         (SELECT count(*) FROM finess f
                           JOIN finess_staging s ON s.num_finess = f.num_finess
                          WHERE f.geom IS NOT NULL AND s.geom IS NULL),
    'moved_gt_500m',     (SELECT count(*) FROM finess_staging s
                           JOIN finess f ON f.num_finess = s.num_finess
                          WHERE s.geog IS NOT NULL AND f.geog IS NOT NULL
                            AND NOT ST_DWithin(s.geog, f.geog, 500)),
    'staging_geom_null', (SELECT count(*) FROM finess_staging WHERE geom IS NULL),
    'staging_geom_source', (SELECT COALESCE(jsonb_object_agg(src, n), '{}'::jsonb)
                              FROM (SELECT COALESCE(raw->>'geom_source', 'none') AS src, count(*) AS n
                                      FROM finess_staging GROUP BY 1) t)
  ) INTO v;
  RETURN v;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.ingest_finess_staging_diff() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ingest_finess_staging_diff() TO service_role;
