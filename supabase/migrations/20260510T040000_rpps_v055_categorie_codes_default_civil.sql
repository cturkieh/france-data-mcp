-- Aligne le default SQL du filtre catégorie professionnelle RPPS sur la
-- nomenclature ANS officielle TRE_R09 :
-- https://mos.esante.gouv.fr/NOS/TRE_R09-CategorieProfessionnelle/
--
-- Default V0.5.4 = `IN ('C','M')` mélangeait Civils et Agents publics sans
-- flag possible pour dissocier. V0.5.5 = `IN ('C')` ; les flags MCP
-- `include_agents_publics` / `include_etudiants` ajoutent M/E à la demande.
-- Idempotente : CREATE OR REPLACE sur les 2 fonctions, pas de DDL table.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) Helper rpps_categorie_match — default `[C]` au lieu de `[C, M]`.
--     `OR IS NULL` conservé : défense en profondeur si l'ANS introduit un
--     nouveau code non documenté ; on préfère sur-inclure plutôt que
--     d'exclure silencieusement.
--
--     NOTE branche `cardinality(p_codes) = 0` : depuis V0.5.5 les 3 handlers
--     MCP passent toujours au moins `[C]` via `categorieCodesFromArgs`, donc
--     cette branche n'est plus atteignable par MCP. Elle reste utile pour les
--     callers PostgREST direct (REST public anon) et la lib OSS appelée en
--     TypeScript avec `categorieCodes: []`. Ne pas supprimer sans casser ces
--     deux surfaces externes.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rpps_categorie_match(
  p_code  TEXT,
  p_codes TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  -- cardinality(p_codes) = 0 → default V0.5.5 = `[C]` Civil seulement.
  -- L'élargissement aux codes `E` Étudiant et `M` Agent public passe par
  -- les flags MCP `include_etudiants` / `include_agents_publics`, qui
  -- construisent l'array côté handler TS via `buildCategorieCodes()`.
  --
  -- `OR p_code IS NULL` dans les 2 branches : un code catégorie absent
  -- (~0 row en base au 2026-05-10 mais possible si l'ANS introduit un
  -- nouveau code) reste visible — on préfère sur-inclure plutôt que
  -- d'exclure silencieusement.
  SELECT
    CASE
      WHEN cardinality(p_codes) = 0 THEN p_code = 'C' OR p_code IS NULL
      ELSE p_code = ANY(p_codes) OR p_code IS NULL
    END;
$$;

GRANT EXECUTE ON FUNCTION rpps_categorie_match TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- (2) RPC rpps_par_specialite_dept — aligne le default interne (cf. V0.5.4
--     `EXECUTE format`) sur `[C]`. Cette RPC garde son propre default car
--     elle reçoit les params via `EXECUTE format(...) USING ...` et ne
--     délègue PAS au helper `rpps_categorie_match` (raison historique :
--     V0.5.4 inline le predicate `r.categorie_code = ANY($4) OR IS NULL`
--     dans le format string pour permettre au planner de pousser le filtre
--     index avec le bon estimate de sélectivité).
-- ──────────────────────────────────────────────────────────────────────────

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
  -- Default V0.5.5 = `[C]` Civil seulement si NULL ou tableau vide.
  -- Cohérent avec le caller TS (`rpps-db.ts CATEGORIE_CODES_DEFAUT`) et la
  -- sémantique des flags MCP `include_etudiants` / `include_agents_publics`.
  -- Un caller PostgREST direct passant `[]` reçoit donc les Civils par
  -- défaut au lieu de 0 row silent (ANY([]) = false).
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C']);
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
