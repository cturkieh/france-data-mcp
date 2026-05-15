-- V0.10.1 — `ameli_by_specialite_dept` réécrite en `LANGUAGE plpgsql STABLE`
-- + `EXECUTE format(... %L::CHAR(3) ...)` pour interpoler `p_departement`
-- comme literal SQL typé CHAR(3) et forcer un custom plan exploitable.
--
-- Root cause (PROUVÉE en prod via EXPLAIN ANALYZE, 2026-05-15) : la V0.4.1
-- comparait `WHERE a.code_departement = p_departement` avec `p_departement`
-- typé TEXT. Postgres résout ce mismatch en castant la COLONNE indexée
-- `code_departement CHAR(3)` en text → `(code_departement)::text = $1`. Ce
-- cast rend `annuaire_ameli_dept_sort_covering_idx` (sur la colonne CHAR(3))
-- INUTILISABLE → le planner tombe sur `annuaire_ameli_insee_idx` et
-- scanne/filtre ~460 000 lignes. Mesuré : 254 ms / 265 786 buffers (~2 GB
-- touchés) à chaud → plusieurs secondes / `57014` à froid (post-ingest
-- hebdo ou éviction cache par les requêtes RPPS 2.23M).
--
-- Preuve du fix (même session, EXPLAIN ANALYZE) : avec le littéral
-- `code_departement = '75'::char(3)`, le planner choisit le covering index
-- → Index Cond direct, 86 lignes filtrées, 90 buffers, 5,5 ms. Soit 45×
-- plus rapide et ~3000× moins d'I/O — c'est cette chute d'I/O qui supprime
-- l'exposition au timeout à cache froid.
--
-- Ce n'est PAS un problème generic-vs-custom plan : les deux plans (custom
-- ET generic forcés) choisissaient `insee_idx` et étaient également lents
-- (254 ms vs 210 ms). Le levier décisif est la SUPPRESSION du cast `::text`
-- sur la colonne indexée, obtenue en interpolant `p_departement` comme
-- literal `%L::CHAR(3)` (le param devient '75'::CHAR(3), pas $1 opaque).
-- Même correctif que `rpps_par_specialite_dept` (V0.5.4, migration
-- 20260510T030000) — jamais porté à Ameli jusqu'ici (dette CHANGELOG V0.9.4).
--
-- Trade-off identique à RPPS : `LANGUAGE plpgsql` → fonction non-inlinable
-- (Function Scan dans le plan parent), coût planning ~0,1 ms/call. C'est le
-- but : `EXECUTE format` force un custom plan voyant la vraie valeur dept.

DROP FUNCTION IF EXISTS ameli_by_specialite_dept(TEXT, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS ameli_by_specialite_dept(TEXT, TEXT, TEXT, INT, INT);

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
  distance_meters               DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  -- Garde stricte alignée sur `rpps_par_specialite_dept` : un caller
  -- PostgREST direct ne distingue pas "dept inexistant" de "aucun PS".
  -- Couvre 2 chiffres métropole (01-95), 3 chiffres DOM/COM (971-988),
  -- Corse 2A/2B. Défense en profondeur — le wrapper TS valide déjà via
  -- assertValidDept, mais format(%L) ne doit jamais recevoir d'input non
  -- contraint même si %L échappe déjà les quotes.
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
      NULL::DOUBLE PRECISION       AS distance_meters
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

GRANT EXECUTE ON FUNCTION ameli_by_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
