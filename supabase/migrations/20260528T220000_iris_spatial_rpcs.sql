-- Phase B étape 5 — RPCs spatiales IRIS pour `profil_iris`.
-- Cf. docs/plans/iris-infracommunal.md §5 (contrat GEO Intel, règles R1/R2/R3).
--
-- VUE `iris_full` : jointure UNIQUE iris + 3 blocs stats (LEFT JOIN), source DRY
-- des 4 RPCs lookup/spatiales (évite 4 copies du join → anti-drift). VUE SIMPLE
-- (pas matview) → résolue PAR NOM à chaque requête, suit les tables swappées,
-- AUCUNE bombe OID. `security_invoker=true` : la vue s'exécute avec les droits
-- de l'appelant → les policies « anon read » des 4 tables s'appliquent
-- (cohérent RLS, pas de fuite via une vue owner-priviligiée).
--
-- Prédicats spatiaux sur les GiST EXISTANTS (pas de nouvel index) :
--   • point-in-polygon : ST_Covers(geog, point) → iris_geog_gist.
--   • bassin (R2) : ST_DWithin(centroid_geog, point, m) → iris_centroid_geog_gist.
--     R2 = inclusion PAR CENTROÏDE (chaque îlot compté 1 fois, biais de bord
--     équilibré) — JAMAIS « polygone intersectant le disque » (surcompte).

-- code_iris/code_commune exposés en CHAR BRUT (PAS ::text) : sinon le prédicat
-- `WHERE code_iris = p::char(9)` de iris_profil_by_code filtrerait une colonne
-- CASTÉE → index PK CHAR(9) inutilisable → seq scan 48K (gotcha CLAUDE.md). En
-- CHAR brut le prédicat reste indexable ; le RETURNS TABLE(... TEXT) caste au
-- retour (valeurs 9/5 car. pleines, aucun espace de padding). DROP+CREATE car
-- CREATE OR REPLACE VIEW interdit le changement de type de colonne.
DROP VIEW IF EXISTS iris_full;
CREATE VIEW iris_full
WITH (security_invoker = true) AS
SELECT
  i.code_iris             AS code_iris,
  i.code_commune          AS code_commune,
  i.libelle               AS libelle,
  i.type_iris             AS type_iris,
  i.geog                  AS geog,
  i.centroid_geog         AS centroid_geog,
  p.pop_total, p.pop_0_14, p.pop_15_29, p.pop_30_44, p.pop_45_59, p.pop_60_74,
  p.pop_75p, p.pop_65p, p.pop_15p,
  p.csp_agriculteurs, p.csp_artisans_comm, p.csp_cadres, p.csp_prof_interm,
  p.csp_employes, p.csp_ouvriers, p.csp_retraites, p.csp_autres,
  f.menages_total, f.couples_avec_enfants, f.couples_sans_enfants, f.familles_monoparentales,
  r.revenu_median, r.revenu_d1, r.revenu_d9, r.taux_pauvrete
FROM iris i
LEFT JOIN iris_population p ON p.code_iris = i.code_iris
LEFT JOIN iris_familles   f ON f.code_iris = i.code_iris
LEFT JOIN iris_revenu     r ON r.code_iris = i.code_iris;

GRANT SELECT ON iris_full TO anon, authenticated, service_role;

-- Liste de colonnes profil (hors geog/centroid_geog) partagée par les 4 RPCs.
-- iris_profil_by_code : REFACTORÉE sur la vue (sortie IDENTIQUE à l'étape 4).
CREATE OR REPLACE FUNCTION iris_profil_by_code(p_code_iris TEXT)
RETURNS TABLE (
  code_iris TEXT, code_commune TEXT, libelle TEXT, type_iris TEXT,
  pop_total NUMERIC, pop_0_14 NUMERIC, pop_15_29 NUMERIC, pop_30_44 NUMERIC,
  pop_45_59 NUMERIC, pop_60_74 NUMERIC, pop_75p NUMERIC, pop_65p NUMERIC, pop_15p NUMERIC,
  csp_agriculteurs NUMERIC, csp_artisans_comm NUMERIC, csp_cadres NUMERIC, csp_prof_interm NUMERIC,
  csp_employes NUMERIC, csp_ouvriers NUMERIC, csp_retraites NUMERIC, csp_autres NUMERIC,
  menages_total NUMERIC, couples_avec_enfants NUMERIC, couples_sans_enfants NUMERIC, familles_monoparentales NUMERIC,
  revenu_median NUMERIC, revenu_d1 NUMERIC, revenu_d9 NUMERIC, taux_pauvrete NUMERIC
)
LANGUAGE sql STABLE SET search_path = public, extensions AS $$
  SELECT
    code_iris, code_commune, libelle, type_iris,
    pop_total, pop_0_14, pop_15_29, pop_30_44, pop_45_59, pop_60_74, pop_75p, pop_65p, pop_15p,
    csp_agriculteurs, csp_artisans_comm, csp_cadres, csp_prof_interm,
    csp_employes, csp_ouvriers, csp_retraites, csp_autres,
    menages_total, couples_avec_enfants, couples_sans_enfants, familles_monoparentales,
    revenu_median, revenu_d1, revenu_d9, taux_pauvrete
  FROM iris_full
  WHERE code_iris = p_code_iris::char(9);
$$;
GRANT EXECUTE ON FUNCTION iris_profil_by_code(TEXT) TO anon, authenticated, service_role;

-- iris_at_point : l'IRIS contenant le point (point-in-polygon, mode îlot/point).
CREATE OR REPLACE FUNCTION iris_at_point(p_lon DOUBLE PRECISION, p_lat DOUBLE PRECISION)
RETURNS TABLE (
  code_iris TEXT, code_commune TEXT, libelle TEXT, type_iris TEXT,
  pop_total NUMERIC, pop_0_14 NUMERIC, pop_15_29 NUMERIC, pop_30_44 NUMERIC,
  pop_45_59 NUMERIC, pop_60_74 NUMERIC, pop_75p NUMERIC, pop_65p NUMERIC, pop_15p NUMERIC,
  csp_agriculteurs NUMERIC, csp_artisans_comm NUMERIC, csp_cadres NUMERIC, csp_prof_interm NUMERIC,
  csp_employes NUMERIC, csp_ouvriers NUMERIC, csp_retraites NUMERIC, csp_autres NUMERIC,
  menages_total NUMERIC, couples_avec_enfants NUMERIC, couples_sans_enfants NUMERIC, familles_monoparentales NUMERIC,
  revenu_median NUMERIC, revenu_d1 NUMERIC, revenu_d9 NUMERIC, taux_pauvrete NUMERIC
)
LANGUAGE sql STABLE SET search_path = public, extensions AS $$
  SELECT
    code_iris, code_commune, libelle, type_iris,
    pop_total, pop_0_14, pop_15_29, pop_30_44, pop_45_59, pop_60_74, pop_75p, pop_65p, pop_15p,
    csp_agriculteurs, csp_artisans_comm, csp_cadres, csp_prof_interm,
    csp_employes, csp_ouvriers, csp_retraites, csp_autres,
    menages_total, couples_avec_enfants, couples_sans_enfants, familles_monoparentales,
    revenu_median, revenu_d1, revenu_d9, taux_pauvrete
  FROM iris_full
  WHERE ST_Covers(geog, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography)
  ORDER BY code_iris
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION iris_at_point(DOUBLE PRECISION, DOUBLE PRECISION) TO anon, authenticated, service_role;

-- iris_in_radius : R2 — îlots dont le CENTROÏDE est dans le disque (bassin/point).
CREATE OR REPLACE FUNCTION iris_in_radius(
  p_lon DOUBLE PRECISION, p_lat DOUBLE PRECISION, p_rayon_m DOUBLE PRECISION
)
RETURNS TABLE (
  code_iris TEXT, code_commune TEXT, libelle TEXT, type_iris TEXT,
  pop_total NUMERIC, pop_0_14 NUMERIC, pop_15_29 NUMERIC, pop_30_44 NUMERIC,
  pop_45_59 NUMERIC, pop_60_74 NUMERIC, pop_75p NUMERIC, pop_65p NUMERIC, pop_15p NUMERIC,
  csp_agriculteurs NUMERIC, csp_artisans_comm NUMERIC, csp_cadres NUMERIC, csp_prof_interm NUMERIC,
  csp_employes NUMERIC, csp_ouvriers NUMERIC, csp_retraites NUMERIC, csp_autres NUMERIC,
  menages_total NUMERIC, couples_avec_enfants NUMERIC, couples_sans_enfants NUMERIC, familles_monoparentales NUMERIC,
  revenu_median NUMERIC, revenu_d1 NUMERIC, revenu_d9 NUMERIC, taux_pauvrete NUMERIC
)
LANGUAGE sql STABLE SET search_path = public, extensions AS $$
  SELECT
    code_iris, code_commune, libelle, type_iris,
    pop_total, pop_0_14, pop_15_29, pop_30_44, pop_45_59, pop_60_74, pop_75p, pop_65p, pop_15p,
    csp_agriculteurs, csp_artisans_comm, csp_cadres, csp_prof_interm,
    csp_employes, csp_ouvriers, csp_retraites, csp_autres,
    menages_total, couples_avec_enfants, couples_sans_enfants, familles_monoparentales,
    revenu_median, revenu_d1, revenu_d9, taux_pauvrete
  FROM iris_full
  WHERE ST_DWithin(centroid_geog, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography, p_rayon_m);
$$;
GRANT EXECUTE ON FUNCTION iris_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO anon, authenticated, service_role;

-- iris_in_radius_of_code : bassin centré sur le CENTROÏDE d'un IRIS (mode code_iris + rayon).
CREATE OR REPLACE FUNCTION iris_in_radius_of_code(p_code_iris TEXT, p_rayon_m DOUBLE PRECISION)
RETURNS TABLE (
  code_iris TEXT, code_commune TEXT, libelle TEXT, type_iris TEXT,
  pop_total NUMERIC, pop_0_14 NUMERIC, pop_15_29 NUMERIC, pop_30_44 NUMERIC,
  pop_45_59 NUMERIC, pop_60_74 NUMERIC, pop_75p NUMERIC, pop_65p NUMERIC, pop_15p NUMERIC,
  csp_agriculteurs NUMERIC, csp_artisans_comm NUMERIC, csp_cadres NUMERIC, csp_prof_interm NUMERIC,
  csp_employes NUMERIC, csp_ouvriers NUMERIC, csp_retraites NUMERIC, csp_autres NUMERIC,
  menages_total NUMERIC, couples_avec_enfants NUMERIC, couples_sans_enfants NUMERIC, familles_monoparentales NUMERIC,
  revenu_median NUMERIC, revenu_d1 NUMERIC, revenu_d9 NUMERIC, taux_pauvrete NUMERIC
)
LANGUAGE sql STABLE SET search_path = public, extensions AS $$
  SELECT
    f.code_iris, f.code_commune, f.libelle, f.type_iris,
    f.pop_total, f.pop_0_14, f.pop_15_29, f.pop_30_44, f.pop_45_59, f.pop_60_74, f.pop_75p, f.pop_65p, f.pop_15p,
    f.csp_agriculteurs, f.csp_artisans_comm, f.csp_cadres, f.csp_prof_interm,
    f.csp_employes, f.csp_ouvriers, f.csp_retraites, f.csp_autres,
    f.menages_total, f.couples_avec_enfants, f.couples_sans_enfants, f.familles_monoparentales,
    f.revenu_median, f.revenu_d1, f.revenu_d9, f.taux_pauvrete
  FROM iris_full f
  WHERE ST_DWithin(
    f.centroid_geog,
    (SELECT centroid_geog FROM iris WHERE code_iris = p_code_iris::char(9)),
    p_rayon_m
  );
$$;
GRANT EXECUTE ON FUNCTION iris_in_radius_of_code(TEXT, DOUBLE PRECISION) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
