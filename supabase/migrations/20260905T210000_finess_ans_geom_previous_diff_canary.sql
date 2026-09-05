-- Migration FINESS DREES (CSV, flux arrêté le 2026-07-20) → ANS (JSON quotidien).
-- Cf. docs/plans/finess-migration-ans.md. Trois briques côté base :
--
-- (1) ingest_apply_finess_geom_previous — repli de géolocalisation. Le flux ANS
--     ne porte des coordonnées que pour 74,9 % des EGE en service (78 429 /
--     104 734 le 2026-09-05) contre 100 % dans la table actuelle (géocodage
--     DREES). Pour les lignes de staging sans point dont le num_finess est déjà
--     en prod AVEC un point, on reprend ce point (mesuré : 86 % des manquants
--     sont récupérables → couverture projetée ≈ 96,6 %). La provenance est
--     tracée dans raw->>'geom_source' = 'previous_ingest' pour ne jamais
--     confondre un point ANS frais et un point hérité.
--
--     PAS de repli centroïde commune ici : `ingest_apply_rpps_finess_enrichment_batch`
--     copie finess.geom vers le RPPS sous l'étiquette `finess_join` (tier PRÉCIS,
--     indexé dans le GiST partiel). Un centroïde dans finess.geom contaminerait
--     la précision RPPS sous une étiquette « précis ».
--
--     Un seul UPDATE : jointure PK↔PK sur ~26 K lignes, largement sous les 55 s.
--     Pas d'id séquentiel sur finess_staging → pas de keyset (runKeysetRpc
--     attend un curseur entier).
--
-- (2) ingest_finess_staging_diff — comparaison staging ↔ prod AVANT swap,
--     renvoyée au script qui la logue et bloque si `removed` dépasse son seuil.
--     Un fichier ANS tronqué mais > MIN_ROWS passerait sinon jusqu'au swap.
--
-- (3) Canary : 130786049 (« Timone ») n'a JAMAIS existé dans FINESS (échec
--     canary logué à chaque run depuis le 2026-05-15, ni en prod ni dans le
--     flux ANS). Le vrai numéro de l'hôpital de la Timone est 130783293.
--     750100166 est le site Cochin, pas la Pitié — description corrigée.

CREATE OR REPLACE FUNCTION public.ingest_apply_finess_geom_previous()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE finess_staging s
     SET geom             = f.geom,
         coordx_lambert93 = COALESCE(s.coordx_lambert93, f.coordx_lambert93),
         coordy_lambert93 = COALESCE(s.coordy_lambert93, f.coordy_lambert93),
         raw              = COALESCE(s.raw, '{}'::jsonb)
                            || jsonb_build_object('geom_source', 'previous_ingest')
    FROM finess f
   WHERE f.num_finess = s.num_finess
     AND s.geom IS NULL
     AND f.geom IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous() TO service_role;

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
    'added',             (SELECT count(*) FROM finess_staging s
                           WHERE NOT EXISTS (SELECT 1 FROM finess f WHERE f.num_finess = s.num_finess)),
    'removed',           (SELECT count(*) FROM finess f
                           WHERE NOT EXISTS (SELECT 1 FROM finess_staging s WHERE s.num_finess = f.num_finess)),
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

UPDATE ingest_canary_targets
   SET key_value   = '130783293',
       description = 'AP-HM — Hôpital de la Timone (130783293 ; l''ancien 130786049 n''a jamais existé dans FINESS, canary en échec depuis 2026-05-15)'
 WHERE source = 'finess' AND key_value = '130786049';

UPDATE ingest_canary_targets
   SET description = 'AP-HP — HU Paris Centre, site Cochin (cible nationale stable)'
 WHERE source = 'finess' AND key_value = '750100166';
