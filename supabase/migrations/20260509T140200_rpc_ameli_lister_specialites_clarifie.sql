-- V0.4.4 — `ameli_lister_specialites` enrichi avec `libelle_clarifie` data-driven.
--
-- Audit Claude.ai 2026-05-09 a révélé 4 libellés dupliqués qui rendaient la
-- nomenclature ambiguë côté caller MCP :
--   • "Médecin généraliste"        (codes 01 ≈ 55K, 22 ≈ 5.8K, 23 ≈ 502)
--   • "Chirurgien-dentiste"        (codes 19 ≈ 41K, 53 ≈ 244, 54 ≈ 23)
--   • "Psychiatre"                 (codes 33 ≈ 7K,  75 ≈ 127)
--   • "Gynécologue / Obstétricien" (codes 07 ≈ 4.6K, 70 ≈ 896, 77 ≈ 5, 79 ≈ 401)
--
-- `libelle_clarifie` est calculé en SQL via window function — purement
-- data-driven, donc robuste à un nouveau code dupliqué qu'Ameli introduirait
-- dans une MAJ future. Pas de dictionnaire codé en dur.
--
-- Format : "{libelle} (code {code}, {count_compact})" si le libellé est
-- partagé par ≥ 2 codes, sinon `libelle` inchangé. Le `count_compact` est
-- formaté par `format_count_human` (cf. infra) : "55K", "5.8K", "502", "2.3M".
--
-- ⚠️ Types Supabase à régénérer manuellement post-merge :
--    `pnpm supabase gen types typescript ...` (non automatisé pour ce projet).

-- Helper SQL : format compact lisible humain (K / M / brut).
--
-- Décision portabilité : `to_char(...)` retourne un séparateur décimal
-- localisé (virgule en lc_numeric français). On force le point via `replace`
-- pour garantir un output stable indépendant de la session PostgreSQL.
CREATE OR REPLACE FUNCTION format_count_human(n BIGINT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  -- Branches aplaties (seuils croissants). Contract : `n` est un compteur
  -- (>= 0 attendu). Pour `n < 0`, on retourne le brut signé pour que tout
  -- caller futur qui passerait une différence par accident voie un signal
  -- clair plutôt qu'un "12M" parasité.
  SELECT CASE
    WHEN n IS NULL    THEN ''
    WHEN n < 0        THEN n::TEXT
    WHEN n >= 10000000 THEN trunc(n / 1000000.0)::TEXT || 'M'
    WHEN n >= 1000000  THEN replace(trim(to_char(n / 1000000.0, 'FM999D9')), ',', '.') || 'M'
    WHEN n >= 10000    THEN trunc(n / 1000.0)::TEXT || 'K'
    WHEN n >= 1000     THEN replace(trim(to_char(n / 1000.0, 'FM999D9')), ',', '.') || 'K'
    ELSE n::TEXT
  END;
$$;

GRANT EXECUTE ON FUNCTION format_count_human(BIGINT) TO anon, authenticated, service_role;

-- Remplace `ameli_lister_specialites` avec deux nouvelles colonnes :
--   • `libelle_clarifie`     : libellé désambiguïsé via window count
--   • `is_libelle_partage`   : true ssi ≥ 2 codes partagent le même `libelle`
--
-- Les colonnes existantes (code, libelle, type_ps_code, type_ps_libelle,
-- count) et l'ordre de tri (count DESC, code ASC) sont préservés — la
-- migration est strictement additive côté shape.
CREATE OR REPLACE FUNCTION ameli_lister_specialites()
RETURNS TABLE (
  code TEXT,
  libelle TEXT,
  libelle_clarifie TEXT,
  type_ps_code TEXT,
  type_ps_libelle TEXT,
  count BIGINT,
  is_libelle_partage BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT
      a.specialite_code AS code,
      a.specialite_libelle AS libelle,
      a.type_ps_code,
      a.type_ps_libelle,
      COUNT(*)::BIGINT AS cnt
    FROM annuaire_ameli a
    WHERE a.specialite_code IS NOT NULL
    GROUP BY a.specialite_code, a.specialite_libelle, a.type_ps_code, a.type_ps_libelle
  ),
  enriched AS (
    SELECT
      code,
      libelle,
      type_ps_code,
      type_ps_libelle,
      cnt,
      -- COUNT(DISTINCT code) OVER pas supporté en PG → sous-requête scalaire.
      -- Contrat : `is_libelle_partage` = true SSI ≥ 2 codes spécialité distincts
      -- partagent ce libellé. Sans le DISTINCT, un même code éclaté en 2 lignes
      -- base (variantes type_ps) déclencherait un faux positif libelle_partage.
      (
        SELECT COUNT(DISTINCT b2.code)
        FROM base b2
        WHERE b2.libelle IS NOT DISTINCT FROM base.libelle
      ) AS libelle_dup_count
    FROM base
  )
  SELECT
    code,
    libelle,
    CASE
      WHEN libelle_dup_count > 1 THEN
        libelle || ' (code ' || code || ', ' || format_count_human(cnt) || ')'
      ELSE libelle
    END AS libelle_clarifie,
    type_ps_code,
    type_ps_libelle,
    cnt AS count,
    libelle_dup_count > 1 AS is_libelle_partage
  FROM enriched
  ORDER BY cnt DESC, code ASC;
$$;

GRANT EXECUTE ON FUNCTION ameli_lister_specialites() TO anon, authenticated, service_role;
