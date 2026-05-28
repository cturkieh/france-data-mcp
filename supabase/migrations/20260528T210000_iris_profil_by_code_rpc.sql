-- Phase B étape 4-5 — lookup IRIS par code (mode « îlot seul »).
-- Cf. docs/plans/iris-infracommunal.md. RPC RÉUTILISÉE :
--   • étape 4 : tool `population` granularité iris (extrait pop_total).
--   • étape 5 : tool `profil_iris` SANS rayon (profil complet de l'îlot).
--
-- Joint `iris` (PK code_iris) à ses 3 tables stats en LEFT JOIN : un IRIS sans
-- population (1 cas), sans familles, ou hors couverture FILOSOFI (~68 %) sort
-- avec les colonnes correspondantes à NULL — fait brut, jamais 0 silencieux.
-- 0 ligne = code_iris absent du référentiel (→ lookupNotFound côté lib).
--
-- Index : `i.code_iris = p_code_iris::char(9)` — le cast porte sur le PARAM
-- (constante) → l'index PK CHAR(9) reste utilisable (gotcha CLAUDE.md : un
-- `col_char = $text` casterait la COLONNE et tuerait l'index).

CREATE OR REPLACE FUNCTION iris_profil_by_code(p_code_iris TEXT)
RETURNS TABLE (
  code_iris               TEXT,
  code_commune            TEXT,
  libelle                 TEXT,
  type_iris               TEXT,
  pop_total               NUMERIC,
  pop_0_14                NUMERIC,
  pop_15_29               NUMERIC,
  pop_30_44               NUMERIC,
  pop_45_59               NUMERIC,
  pop_60_74               NUMERIC,
  pop_75p                 NUMERIC,
  pop_65p                 NUMERIC,
  pop_15p                 NUMERIC,
  csp_agriculteurs        NUMERIC,
  csp_artisans_comm       NUMERIC,
  csp_cadres              NUMERIC,
  csp_prof_interm         NUMERIC,
  csp_employes            NUMERIC,
  csp_ouvriers            NUMERIC,
  csp_retraites           NUMERIC,
  csp_autres              NUMERIC,
  menages_total           NUMERIC,
  couples_avec_enfants    NUMERIC,
  couples_sans_enfants    NUMERIC,
  familles_monoparentales NUMERIC,
  revenu_median           NUMERIC,
  revenu_d1               NUMERIC,
  revenu_d9               NUMERIC,
  taux_pauvrete           NUMERIC
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT
    i.code_iris::text, i.code_commune::text, i.libelle, i.type_iris,
    p.pop_total, p.pop_0_14, p.pop_15_29, p.pop_30_44, p.pop_45_59, p.pop_60_74,
    p.pop_75p, p.pop_65p, p.pop_15p,
    p.csp_agriculteurs, p.csp_artisans_comm, p.csp_cadres, p.csp_prof_interm,
    p.csp_employes, p.csp_ouvriers, p.csp_retraites, p.csp_autres,
    f.menages_total, f.couples_avec_enfants, f.couples_sans_enfants, f.familles_monoparentales,
    r.revenu_median, r.revenu_d1, r.revenu_d9, r.taux_pauvrete
  FROM iris i
  LEFT JOIN iris_population p ON p.code_iris = i.code_iris
  LEFT JOIN iris_familles   f ON f.code_iris = i.code_iris
  LEFT JOIN iris_revenu     r ON r.code_iris = i.code_iris
  WHERE i.code_iris = p_code_iris::char(9);
$$;

GRANT EXECUTE ON FUNCTION iris_profil_by_code(TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
