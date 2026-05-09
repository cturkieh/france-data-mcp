-- Migration v0.4.3 — RPCs de listage de la nomenclature Ameli
--
-- Pourquoi : la nomenclature Ameli (codes spécialité, codes type_ps) est
-- piégeuse côté caller MCP. Le libellé natif du `type_ps_code = "2"` est
-- `"Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…)"`,
-- libellé fourre-tout qui mentionne les chirurgiens-dentistes alors que
-- ceux-ci ont leur propre code (5 = "Dentistes"). Sans ces RPCs, un caller
-- (Claude.ai, Cursor, etc.) doit deviner les codes ou cross-référencer une
-- doc qui peut diverger du contenu réel de la base.
--
-- Les deux RPCs renvoient la nomenclature live, avec un count par couple et
-- — pour `ameli_lister_types_ps()` — un agrégat des spécialités effectivement
-- présentes sous chaque type_ps (résout l'ambiguïté du libellé code "2"
-- empiriquement, sans dictionnaire inventé).

CREATE OR REPLACE FUNCTION ameli_lister_specialites()
RETURNS TABLE (
  code TEXT,
  libelle TEXT,
  type_ps_code TEXT,
  type_ps_libelle TEXT,
  count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    a.specialite_code AS code,
    a.specialite_libelle AS libelle,
    a.type_ps_code,
    a.type_ps_libelle,
    COUNT(*)::BIGINT AS count
  FROM annuaire_ameli a
  WHERE a.specialite_code IS NOT NULL
  GROUP BY a.specialite_code, a.specialite_libelle, a.type_ps_code, a.type_ps_libelle
  ORDER BY count DESC, a.specialite_code ASC;
$$;

GRANT EXECUTE ON FUNCTION ameli_lister_specialites() TO anon, authenticated, service_role;

-- ameli_lister_types_ps — version enrichie avec specialites_presentes (jsonb)
-- Le caller obtient ainsi la liste réelle des métiers regroupés sous chaque
-- type_ps, avec leur count individuel. Plus besoin de deviner que type_ps=2
-- regroupe IDE + kinés + sages-femmes + podologues + orthophonistes + IPA.

CREATE OR REPLACE FUNCTION ameli_lister_types_ps()
RETURNS TABLE (
  code TEXT,
  libelle_source TEXT,
  count BIGINT,
  specialites_presentes JSONB
)
LANGUAGE sql
STABLE
AS $$
  WITH spec_per_type AS (
    SELECT
      a.type_ps_code,
      a.type_ps_libelle,
      a.specialite_code,
      a.specialite_libelle,
      COUNT(*)::BIGINT AS spec_count
    FROM annuaire_ameli a
    WHERE a.type_ps_code IS NOT NULL
    GROUP BY a.type_ps_code, a.type_ps_libelle, a.specialite_code, a.specialite_libelle
  ),
  spec_agg AS (
    SELECT
      s.type_ps_code,
      s.type_ps_libelle,
      jsonb_agg(
        jsonb_build_object(
          'code', s.specialite_code,
          'libelle', s.specialite_libelle,
          'count', s.spec_count
        )
        ORDER BY s.spec_count DESC, s.specialite_code ASC
      ) AS specialites_presentes,
      SUM(s.spec_count)::BIGINT AS total_count
    FROM spec_per_type s
    GROUP BY s.type_ps_code, s.type_ps_libelle
  )
  SELECT
    sa.type_ps_code AS code,
    sa.type_ps_libelle AS libelle_source,
    sa.total_count AS count,
    sa.specialites_presentes
  FROM spec_agg sa
  ORDER BY sa.total_count DESC, sa.type_ps_code ASC;
$$;

GRANT EXECUTE ON FUNCTION ameli_lister_types_ps() TO anon, authenticated, service_role;

-- Pas de modification de `ingest_create_annuaire_ameli_staging` ici : ces
-- RPCs ne touchent que la table prod, pas le staging — donc le swap atomic
-- ne les invalide pas. Convention "migration superset" satisfaite.
