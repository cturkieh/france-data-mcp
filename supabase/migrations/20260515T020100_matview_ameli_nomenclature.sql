-- V0.10.1 — Materialized view pré-agrégée pour `ameli_lister_specialites`
-- et `ameli_lister_types_ps`.
--
-- Root cause (PROUVÉE en prod via EXPLAIN ANALYZE, 2026-05-15) : les deux
-- RPC font un `Seq Scan on annuaire_ameli` de 462 466 lignes / 154 MB
-- (19 717 buffers) suivi d'un HashAggregate à CHAQUE appel — le GROUP BY
-- sur (specialite_code, specialite_libelle, type_ps_code, type_ps_libelle)
-- n'est couvert par aucun index donc full scan obligatoire. Mesuré : ~330 ms
-- à chaud → plusieurs secondes / `57014` à froid (post-ingest hebdo, ou
-- éviction du cache par les requêtes RPPS 2.23M). La sous-requête corrélée
-- O(N²) de `ameli_lister_specialites` est NÉGLIGEABLE (65 boucles × 65
-- lignes) — ce n'était pas la cause, le full scan l'est.
--
-- Solution (même pattern que `rpps_savoir_faire_stats` V0.8.2) : pré-agréger
-- dans une matview (~65 lignes). Les RPC lisent la matview = lookup trivial,
-- immune au cache froid. Résultat quasi-statique entre 2 ingests hebdo.
--
-- REFRESH : appelé post-swap atomique par scripts/ingest/ameli.ts via
-- `ingest_refresh_matview` (whitelist étendue plus bas). CONCURRENTLY exige
-- un UNIQUE INDEX → index sur les 4 colonnes de grain, NULLS NOT DISTINCT
-- (PG17) pour que d'éventuels libellés NULL ne cassent pas l'unicité requise
-- par REFRESH CONCURRENTLY. La matview ne filtre AUCUN NULL : chaque RPC
-- applique son propre `IS NOT NULL` (sémantique V0.4 préservée à
-- l'identique, sans risque de drop silencieux si un futur dump Ameli
-- introduit un code partiel).

-- Pas de `DROP ... CASCADE` (≠ pattern RPPS 20260514T040000) : CASCADE
-- droperait les 2 RPC LANGUAGE sql qui référencent la matview. Elles sont
-- recréées plus bas via CREATE OR REPLACE (signature inchangée), donc le DROP
-- est inutile et son blast radius (un futur consommateur externe dans une
-- autre migration serait silencieusement dropé) est à proscrire. On mirroir
-- exactement `rpps_savoir_faire_stats` : CREATE ... IF NOT EXISTS.
CREATE MATERIALIZED VIEW IF NOT EXISTS ameli_nomenclature_stats AS
SELECT
  a.specialite_code,
  a.specialite_libelle,
  a.type_ps_code,
  a.type_ps_libelle,
  COUNT(*)::BIGINT AS cnt
FROM annuaire_ameli a
GROUP BY a.specialite_code, a.specialite_libelle, a.type_ps_code, a.type_ps_libelle;

CREATE UNIQUE INDEX IF NOT EXISTS ameli_nomenclature_stats_pk
  ON ameli_nomenclature_stats (specialite_code, specialite_libelle, type_ps_code, type_ps_libelle)
  NULLS NOT DISTINCT;

GRANT SELECT ON ameli_nomenclature_stats TO anon;

COMMENT ON MATERIALIZED VIEW ameli_nomenclature_stats IS
  'V0.10.1 — pré-agrégation nomenclature Ameli (~65 lignes). REFRESH post-ingest Ameli (hebdo). Sert ameli_lister_specialites + ameli_lister_types_ps (perf <5ms vs ~330ms / 57014 à froid en V0.x).';

-- RPC réécrite : interroge la matview au lieu de scanner annuaire_ameli.
-- Sémantique de sortie STRICTEMENT identique à V0.9 (20260509T140200) :
-- mêmes colonnes, même libelle_clarifie, même is_libelle_partage, même tri.
-- La sous-requête corrélée libelle_dup_count est conservée volontairement :
-- sur ~65 lignes de matview elle est négligeable, et la réécrire risquerait
-- un écart sémantique (COUNT(DISTINCT) en window non supporté par PG).
CREATE OR REPLACE FUNCTION ameli_lister_specialites()
RETURNS TABLE (
  code               TEXT,
  libelle            TEXT,
  libelle_clarifie   TEXT,
  type_ps_code       TEXT,
  type_ps_libelle    TEXT,
  count              BIGINT,
  is_libelle_partage BOOLEAN
)
LANGUAGE sql STABLE
AS $$
  WITH base AS (
    SELECT
      s.specialite_code   AS code,
      s.specialite_libelle AS libelle,
      s.type_ps_code,
      s.type_ps_libelle,
      s.cnt
    FROM ameli_nomenclature_stats s
    WHERE s.specialite_code IS NOT NULL
  ),
  enriched AS (
    SELECT
      code,
      libelle,
      type_ps_code,
      type_ps_libelle,
      cnt,
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

GRANT EXECUTE ON FUNCTION ameli_lister_specialites TO anon;

COMMENT ON FUNCTION ameli_lister_specialites IS
  'V0.10.1 — interroge la matview ameli_nomenclature_stats (perf <5ms vs ~330ms / 57014 à froid). Sémantique identique à V0.9.';

-- RPC réécrite : interroge la matview. Sémantique identique à V0.5
-- (20260509000002) : mêmes colonnes, même jsonb_agg trié, même tri final.
CREATE OR REPLACE FUNCTION ameli_lister_types_ps()
RETURNS TABLE (
  code                  TEXT,
  libelle_source        TEXT,
  count                 BIGINT,
  specialites_presentes JSONB
)
LANGUAGE sql STABLE
AS $$
  WITH spec_per_type AS (
    SELECT
      s.type_ps_code,
      s.type_ps_libelle,
      s.specialite_code,
      s.specialite_libelle,
      s.cnt AS spec_count
    FROM ameli_nomenclature_stats s
    WHERE s.type_ps_code IS NOT NULL
  ),
  spec_agg AS (
    SELECT
      sp.type_ps_code,
      sp.type_ps_libelle,
      jsonb_agg(
        jsonb_build_object(
          'code', sp.specialite_code,
          'libelle', sp.specialite_libelle,
          'count', sp.spec_count
        )
        ORDER BY sp.spec_count DESC, sp.specialite_code ASC
      ) AS specialites_presentes,
      SUM(sp.spec_count)::BIGINT AS total_count
    FROM spec_per_type sp
    GROUP BY sp.type_ps_code, sp.type_ps_libelle
  )
  SELECT
    sa.type_ps_code AS code,
    sa.type_ps_libelle AS libelle_source,
    sa.total_count AS count,
    sa.specialites_presentes
  FROM spec_agg sa
  ORDER BY sa.total_count DESC, sa.type_ps_code ASC;
$$;

GRANT EXECUTE ON FUNCTION ameli_lister_types_ps TO anon;

COMMENT ON FUNCTION ameli_lister_types_ps IS
  'V0.10.1 — interroge la matview ameli_nomenclature_stats (perf <5ms vs ~330ms / 57014 à froid). Sémantique identique à V0.5.';

-- Étend la whitelist de `ingest_refresh_matview` (V0.9, 20260514T060000)
-- pour autoriser le refresh de la matview Ameli post-swap. Re-déclaration
-- complète (whitelist hardcodée — discipline : étendre cette liste à chaque
-- nouvelle matview refresh post-ingest).
CREATE OR REPLACE FUNCTION ingest_refresh_matview(p_matview TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10min'
AS $$
BEGIN
  IF p_matview NOT IN ('rpps_savoir_faire_stats', 'rpps_count_stats', 'ameli_nomenclature_stats') THEN
    RAISE EXCEPTION 'ingest_refresh_matview: matview % not in whitelist', p_matview
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', p_matview);
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_refresh_matview(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_refresh_matview(TEXT) TO service_role;

COMMENT ON FUNCTION ingest_refresh_matview IS
  'V0.10.1 — REFRESH MATERIALIZED VIEW CONCURRENTLY avec whitelist (rpps_savoir_faire_stats, rpps_count_stats, ameli_nomenclature_stats). Appelé par scripts/ingest/{rpps,ameli}.ts post-swap.';

-- REFRESH initial (non-concurrent : la matview vient d'être créée).
REFRESH MATERIALIZED VIEW ameli_nomenclature_stats;

NOTIFY pgrst, 'reload schema';
