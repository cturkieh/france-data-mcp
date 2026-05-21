-- `ameli_in_radius` gagne un param `p_precise_only BOOLEAN DEFAULT FALSE` —
-- jumeau du `p_precise_only` de `rpps_in_radius` (V0.12.0, migration
-- 20260520T100000_rpps_in_radius_precise_only.sql).
--
-- Quand true : seuls les PS géocodés à l'adresse BAN (`geom_source =
-- 'ban_address'`, ~77 % du référentiel post-Chantier C V0.14.0) sont
-- retournés — `distance_km` exacte au m près, classement intra-commune
-- fiable. Les ~23 % au centroïde commune (`geom_source = 'commune_centroid'`)
-- sont exclus.
--
-- Quand false (= défaut) : comportement V0.14.0 inchangé byte-pour-byte. La
-- clause `AND (NOT p_precise_only OR ...)` devient `AND (NOT FALSE OR ...)` =
-- `AND TRUE` → Postgres l'élimine, plan identique à la def 20260521T103000.
--
-- POURQUOI une requête plate (pas le split precise/centroid CTE de RPPS) :
-- `rpps_in_radius` a dû éclater en 2 CTE + matview `rpps_commune_centroids`
-- parce que RPPS pré-V0.12 avait 2,2 M lignes TOUTES au centroïde commune
-- (cluster Paris ~77 K lignes co-localisées au même point → 57014, cf.
-- gotchas CLAUDE.md). `annuaire_ameli` est à une autre échelle : ~462 K
-- lignes, ~77 % déjà en adresse BAN précise (éparpillées) depuis le
-- Chantier C, les ~23 % résiduels au centroïde sont répartis sur ~35 K
-- communes — pire cluster commune ≈ quelques milliers de lignes. La requête
-- plate KNN `geog <-> v_point` actuelle absorbe déjà ces clusters en prod
-- dans le budget `statement_timeout` 3 s du rôle `anon`. `precise_only=true`
-- n'ajoute qu'un filtre de ligne `geom_source` bon marché sur le même flux
-- KNN — il RÉDUIT le travail (moins de lignes candidates), il ne l'augmente
-- pas.
--
-- ⚠️ GATE PRÉ-APPLICATION (obligatoire — discipline CLAUDE.md « prouver la
-- cause par la prod avant de coder/appliquer ») : `annuaire_ameli` porte À LA
-- FOIS un GiST global `annuaire_ameli_geog_gist` ET le GiST partiel
-- `annuaire_ameli_geog_precise_gist` (WHERE geom_source = 'ban_address').
-- C'est la configuration qui a causé les 57014 RPPS (le planner peut préférer
-- le global et reléguer `geom_source` en Filter post-index). À l'échelle
-- Ameli le risque est faible (clusters ~25-75× plus petits), mais NON prouvé.
-- Exécuter d'ABORD le EXPLAIN ANALYZE de `docs/plans/ameli-precise-only.md`
-- (zone Paris centre, rayon 1 km, geom_source='ban_address') et confirmer :
--   • temps d'exécution < ~500 ms (cap budget anon 3 s) ;
--   • un Index Scan GiST (partiel OU global), PAS un Seq Scan ;
--   • PAS de « Rows Removed by Filter » à 6 chiffres.
-- Si le plan dérape → NE PAS appliquer, basculer sur le plan B documenté
-- (split CTE + matview `ameli_commune_centroids` + DROP du GiST global).
--
-- ⚠️ Postgres INTERDIT `CREATE OR REPLACE FUNCTION` quand la signature change
-- (ajout d'un param, même avec DEFAULT) → ERROR 42P13. DROP explicite
-- obligatoire AVANT le CREATE. Le DROP révoque le GRANT → re-GRANT après.
--
-- DIFF MINIMAL vs 20260521T103000 : seuls 3 ajouts — le param `p_precise_only`
-- dans la signature, la clause `AND (NOT p_precise_only OR ...)` dans le
-- WHERE, et la mise à jour GRANT/COMMENT. RETURNS TABLE, ORDER BY, autres
-- clauses WHERE inchangés. `ameli_by_specialite_dept` n'est PAS touchée
-- (precise_only n'a pas de sens pour un listing départemental non spatial).
--
-- APPLICATION : naming `YYYYMMDDThhmmss` → CLI Supabase `db push` saute, à
-- appliquer MANUELLEMENT en prod via dashboard SQL editor.

DROP FUNCTION IF EXISTS ameli_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT);

CREATE OR REPLACE FUNCTION ameli_in_radius(
  p_lat               DOUBLE PRECISION,
  p_lon               DOUBLE PRECISION,
  p_radius_meters     DOUBLE PRECISION,
  p_specialite_codes  TEXT[],
  p_type_ps_codes     TEXT[],
  p_limit             INT,
  p_precise_only      BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id                            BIGINT,
  nom                           TEXT,
  prenom                        TEXT,
  civilite                      TEXT,
  raison_sociale                TEXT,
  specialite_code               TEXT,
  specialite_libelle            TEXT,
  type_ps_code                  TEXT,
  type_ps_libelle               TEXT,
  adresse                       TEXT,
  code_postal                   CHAR(5),
  ville                         TEXT,
  code_departement              CHAR(3),
  code_insee                    CHAR(5),
  secteur_conventionnel_code    TEXT,
  secteur_conventionnel_libelle TEXT,
  nature_exercice_code          TEXT,
  nature_exercice_libelle       TEXT,
  option_tarifaire_code         TEXT,
  option_tarifaire_libelle      TEXT,
  telephone                     TEXT,
  geom                          JSONB,
  distance_meters               DOUBLE PRECISION,
  geom_source                   TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.nom, a.prenom, a.civilite, a.raison_sociale,
    a.specialite_code, a.specialite_libelle,
    a.type_ps_code, a.type_ps_libelle,
    a.adresse, a.code_postal, a.ville,
    a.code_departement, a.code_insee,
    a.secteur_conventionnel_code, a.secteur_conventionnel_libelle,
    a.nature_exercice_code, a.nature_exercice_libelle,
    a.option_tarifaire_code, a.option_tarifaire_libelle,
    a.telephone,
    ST_AsGeoJSON(a.geom)::jsonb AS geom,
    ST_Distance(a.geog, v_point) AS distance_meters,
    a.geom_source
  FROM annuaire_ameli a
  WHERE a.geog IS NOT NULL
    AND ST_DWithin(a.geog, v_point, p_radius_meters)
    AND (NOT p_precise_only OR a.geom_source = 'ban_address')
    AND (cardinality(p_specialite_codes) = 0 OR a.specialite_code = ANY(p_specialite_codes))
    AND (cardinality(p_type_ps_codes)    = 0 OR a.type_ps_code    = ANY(p_type_ps_codes))
  ORDER BY a.geog <-> v_point
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION ameli_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT, BOOLEAN
) TO anon;

COMMENT ON FUNCTION ameli_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT, BOOLEAN
) IS
  'Recherche PS libéraux Ameli dans un rayon (PostGIS KNN). p_precise_only true → seuls les PS geom_source=ban_address (~77 % post-Chantier C), distance exacte. false (défaut) = comportement V0.14.0 inchangé (hybride adresse + centroïde commune).';

NOTIFY pgrst, 'reload schema';
