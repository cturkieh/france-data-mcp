-- V0.5.4 — `rpps_par_specialite_dept` réécrite en `LANGUAGE plpgsql STABLE`
-- + `EXECUTE format(... %L ...)` pour interpoler `p_departement` comme
-- literal SQL et forcer un custom plan à chaque appel.
--
-- Root cause (V0.5.3 ne suffisait pas en LIVE) : PostgREST wrappe la query
-- dans `json_to_record LATERAL rpc(...)`. Les colonnes issues de
-- json_to_record sont des EXPRESSIONS pour le planner → il ne peut pas
-- connaître la valeur de `p_departement` au planning → plan generic biaisé
-- vers `rpps_insee_idx` (Presorted Key + LIMIT) → seq scan effectif sur
-- dept dense. Mean exec observé via pg_stat_statements : 8 937 ms (vs 39 ms
-- en EXPLAIN ANALYZE direct).
--
-- Avec `format(... %L ...)`, le planner voit `r.code_departement =
-- '75'::CHAR(3)` directement et utilise les MCV de pg_stats pour estimer
-- correctement la sélectivité → custom plan + Index Scan sur l'index
-- couvrant V0.5.3 → < 100 ms en prod.
--
-- Trade-off : `LANGUAGE plpgsql` au lieu de sql → fonction non-inlinable
-- (Function Scan dans le plan parent). C'est le but : `EXECUTE format`
-- force un plan custom à chaque appel. Coût planning ~0,1 ms/call.

DROP FUNCTION IF EXISTS rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, TEXT[], INT, INT);

CREATE OR REPLACE FUNCTION rpps_par_specialite_dept(
  p_departement        TEXT,
  p_profession_code    TEXT,
  p_savoir_faire_code  TEXT,
  p_mode_exercice_code TEXT,
  p_categorie_codes    TEXT[],
  p_limit              INT,
  p_offset             INT
) RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  raison_sociale           TEXT,
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  geom                     JSONB
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  -- Default actifs (Civil + Militaire) si NULL ou tableau vide. Cohérent
  -- avec le caller TS (rpps-db.ts CATEGORIE_CODES_ACTIFS) et la sémantique
  -- V0.5.0 documentée — un caller PostgREST direct passant `[]` ne
  -- recevra plus 0 rows silent (ANY([]) = false).
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C', 'M']);
BEGIN
  -- Garde stricte : caller PostgREST direct ne distingue pas "dept
  -- inexistant" de "aucun PS". Couvre 2 chiffres métropole (01-95),
  -- 3 chiffres DOM/COM (971-988), Corse 2A/2B.
  IF p_departement IS NULL OR p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT
      r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
      r.profession_code, r.profession_libelle,
      r.savoir_faire_code, r.savoir_faire_libelle,
      r.mode_exercice_code, r.mode_exercice_libelle,
      r.categorie_code, r.categorie_libelle,
      r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
      r.adresse, r.code_postal, r.ville,
      r.code_departement, r.code_insee, r.telephone,
      ST_AsGeoJSON(r.geom)::jsonb AS geom
    FROM rpps r
    WHERE r.code_departement = %L::CHAR(3)
      AND ($1 IS NULL OR r.profession_code    = $1)
      AND ($2 IS NULL OR r.savoir_faire_code  = $2)
      AND ($3 IS NULL OR r.mode_exercice_code = $3)
      AND (r.categorie_code = ANY($4) OR r.categorie_code IS NULL)
    ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
    LIMIT $5 OFFSET $6
  $q$, p_departement)
  USING p_profession_code, p_savoir_faire_code, p_mode_exercice_code, v_categorie_codes, p_limit, p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_par_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
