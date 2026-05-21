-- Chantier C — Géocodage Ameli. Cf. docs/plans/ameli-geocoding.md.
--
-- 4/4 : expose `geom_source` au caller via les 2 RPC Ameli servies en prod
-- (`ameli_in_radius`, `ameli_by_specialite_dept`). Sans cette migration, le
-- géocodage BAN est INVISIBLE côté tools MCP (`toAmeliResult` ne sait pas
-- distinguer `commune_centroid` vs `ban_address` et émet `geo_precision=
-- 'centroide_commune'` en dur quand coords présent) → l'utilisateur fait des
-- décisions sur des distances "centroïde commune" alors qu'elles sont à la
-- rue (régression UX silencieuse de la valeur du chantier C).
--
-- DIFF MINIMAL : on REPREND VERBATIM les dernières def des 2 RPC
-- (20260508000017 pour ameli_in_radius, 20260515T020000 pour
-- ameli_by_specialite_dept avec son EXECUTE format), on ajoute UNIQUEMENT :
--   • `geom_source TEXT` à la fin de `RETURNS TABLE`
--   • `a.geom_source` à la fin du SELECT
-- Aucune autre modif (ORDER BY, WHERE, GRANT, NOTIFY inchangés) — toute autre
-- divergence avec la dernière def est un bug de copie à corriger.
--
-- DROP préalable des deux signatures précédentes (Postgres traite la sig
-- complète comme identité de la fonction — ajouter une colonne à RETURNS
-- TABLE change la sig, le CREATE OR REPLACE échouerait sans DROP).
--
-- APPLICATION : naming `YYYYMMDDThhmmss` → CLI Supabase saute, applied
-- MANUELLEMENT en prod via dashboard SQL editor.

DROP FUNCTION IF EXISTS ameli_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT);
DROP FUNCTION IF EXISTS ameli_by_specialite_dept(TEXT, TEXT, TEXT, INT, INT);

-- ───────────────────────────────────────────────────────────────────────────
-- (1) ameli_in_radius — RETURNS + SELECT enrichis de `geom_source`
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ameli_in_radius(
  p_lat               DOUBLE PRECISION,
  p_lon               DOUBLE PRECISION,
  p_radius_meters     DOUBLE PRECISION,
  p_specialite_codes  TEXT[],
  p_type_ps_codes     TEXT[],
  p_limit             INT
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
    AND (cardinality(p_specialite_codes) = 0 OR a.specialite_code = ANY(p_specialite_codes))
    AND (cardinality(p_type_ps_codes)    = 0 OR a.type_ps_code    = ANY(p_type_ps_codes))
  ORDER BY a.geog <-> v_point
  LIMIT p_limit;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- (2) ameli_by_specialite_dept — REPREND VERBATIM 20260515T020000 + geom_source
-- ───────────────────────────────────────────────────────────────────────────
-- Garde stricte + EXECUTE format(%L::CHAR(3)) conservés byte-identiques. Le
-- seul ajout est `a.geom_source` en fin de SELECT.
CREATE OR REPLACE FUNCTION ameli_by_specialite_dept(
  p_departement     TEXT,
  p_specialite_code TEXT,
  p_type_ps_code    TEXT,
  p_limit           INT,
  p_offset          INT DEFAULT 0
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
BEGIN
  IF p_departement IS NULL OR p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE format($q$
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
      NULL::DOUBLE PRECISION       AS distance_meters,
      a.geom_source
    FROM annuaire_ameli a
    WHERE a.code_departement = %L::CHAR(3)
      AND ($1 IS NULL OR a.specialite_code = $1)
      AND ($2 IS NULL OR a.type_ps_code    = $2)
    ORDER BY a.code_insee NULLS LAST, a.nom, a.prenom, a.id
    LIMIT $3 OFFSET $4
  $q$, p_departement)
  USING p_specialite_code, p_type_ps_code, p_limit, p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION ameli_in_radius          TO anon;
GRANT EXECUTE ON FUNCTION ameli_by_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
