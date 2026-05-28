-- Phase B étape 6 — RPC `iris_by_commune` pour le bloc « demande » du panorama.
-- Cf. docs/plans/iris-infracommunal.md §4. Retourne TOUS les IRIS d'une commune
-- (via la vue iris_full) → agrégés en TS (aggregateIrisDemographics) pour le
-- profil démographique commune-niveau du panorama (âge/CSP/familles/revenu).
--
-- `code_commune = p::char(5)` : cast sur le PARAM → index `iris_commune_idx`
-- (btree code_commune) utilisable (même précaution que le lookup PK).

CREATE OR REPLACE FUNCTION iris_by_commune(p_code_commune TEXT)
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
  WHERE code_commune = p_code_commune::char(5);
$$;
GRANT EXECUTE ON FUNCTION iris_by_commune(TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
