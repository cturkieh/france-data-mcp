-- Sit@del en base — permis de construire (logements) agrégés commune × année.
-- Cf. docs/plans/sitadel-ingestion.md (mesures 2026-09-21).
--
-- POURQUOI : `permitsForCommune` appelait l'API DiDo SDES en direct, ~37 s par
-- commune MÊME filtrée (mesuré Villejuif 37,2 s, Bordeaux 35,0 s) = 42 des ~45 s
-- de `dynamique_immobiliere`. La donnée est mensuelle → on la recopie une fois
-- par mois (cron `ingest-sitadel.yml`) et on lit ici en quelques ms.
--
-- GRAIN : 1 ligne par (commune, année), type « Tous Logements » UNIQUEMENT
-- (les sous-types « Individuel pur », « Collectif »… double-compteraient).
-- ~35 K communes × 6 années ≈ 210 K lignes. Les lignes à ZÉRO sont CONSERVÉES :
-- « commune connue, 0 logement » (couverture ok) ≠ « commune absente »
-- (indisponible:no_data) — contrat `PermitsResult` inchangé.
--
-- `code_insee TEXT` (pas CHAR(5)) à dessein : évite le piège « colonne CHAR(n)
-- filtrée par param TEXT → index inutilisable » et le pad d'espaces PostgREST.
-- `INTEGER` (pas NUMERIC/BIGINT) : PostgREST sérialise en number, pas en string.
-- Maille COMMUNE ENTIÈRE côté DiDo (75056, 69123, 13055 — jamais les
-- arrondissements) : le repli arrondissement → commune vit côté lecture.
-- PAS de matview → pas de bombe OID au swap.

CREATE TABLE IF NOT EXISTS sitadel_logements (
  code_insee  TEXT     NOT NULL CHECK (code_insee ~ '^[0-9][0-9AB][0-9]{3}$'),
  annee       SMALLINT NOT NULL CHECK (annee BETWEEN 2000 AND 2100),
  log_aut     INTEGER  NOT NULL CHECK (log_aut >= 0),  -- logements autorisés (Σ des mois)
  log_com     INTEGER  NOT NULL CHECK (log_com >= 0),  -- logements commencés (Σ des mois)
  mois_couverts SMALLINT NOT NULL CHECK (mois_couverts BETWEEN 1 AND 12),
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (code_insee, annee)
);
ALTER TABLE sitadel_logements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read sitadel_logements" ON sitadel_logements;
CREATE POLICY "anon read sitadel_logements" ON sitadel_logements FOR SELECT TO anon USING (true);

-- Staging : recopie VERBATIM du DDL ci-dessus (PostgreSQL n'a pas d'héritage de
-- corps de fonction). Les contraintes nommées par défaut suivent le RENAME.
CREATE OR REPLACE FUNCTION ingest_create_sitadel_logements_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS sitadel_logements_staging CASCADE;
  CREATE TABLE sitadel_logements_staging (
    code_insee  TEXT     NOT NULL CHECK (code_insee ~ '^[0-9][0-9AB][0-9]{3}$'),
    annee       SMALLINT NOT NULL CHECK (annee BETWEEN 2000 AND 2100),
    log_aut     INTEGER  NOT NULL CHECK (log_aut >= 0),
    log_com     INTEGER  NOT NULL CHECK (log_com >= 0),
    mois_couverts SMALLINT NOT NULL CHECK (mois_couverts BETWEEN 1 AND 12),
    created_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (code_insee, annee)
  );
  ALTER TABLE sitadel_logements_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read sitadel_logements" ON sitadel_logements_staging FOR SELECT TO anon USING (true);
  NOTIFY pgrst, 'reload schema';
END;
$$;
REVOKE EXECUTE ON FUNCTION ingest_create_sitadel_logements_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_sitadel_logements_staging TO service_role;

-- Canary : 3 communes RÉELLES vérifiées présentes dans le flux DiDo le
-- 2026-09-21 (métropole dense, grande ville, Corse — code alphanumérique).
INSERT INTO ingest_canary_targets (source, key_type, key_value, description) VALUES
  ('sitadel', 'code_insee', '94076', 'Villejuif — métropole dense, parité live prouvée 2026-09-21'),
  ('sitadel', 'code_insee', '33063', 'Bordeaux — grande ville, parité live prouvée 2026-09-21'),
  ('sitadel', 'code_insee', '2A004', 'Ajaccio — code INSEE alphanumérique (Corse)')
ON CONFLICT DO NOTHING;

-- check_ingest_canary : def COMPLÈTE recopiée VERBATIM de la prod
-- (pg_get_functiondef 2026-09-21 : finess, ameli_ps, cds, rpps, iris) + la
-- branche `sitadel`. Leçon 20260528T180000 : un CREATE OR REPLACE qui ne
-- recopie pas toutes les branches tue un canary en silence.
CREATE OR REPLACE FUNCTION check_ingest_canary(p_source TEXT) RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  missing TEXT[];
BEGIN
  IF p_source = 'finess' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN finess f
      ON t.key_type = 'num_finess'
     AND f.num_finess = t.key_value
    WHERE t.source = 'finess'
      AND t.key_type = 'num_finess'
      AND f.num_finess IS NULL;

  ELSIF p_source = 'ameli_ps' THEN
    missing := NULL;

  ELSIF p_source = 'cds' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN centres_sante c
      ON t.key_type = 'etab_finess'
     AND c.etab_finess = t.key_value
    WHERE t.source = 'cds'
      AND t.key_type = 'etab_finess'
      AND c.etab_finess IS NULL;

  ELSIF p_source = 'rpps' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN rpps r
      ON t.key_type = 'rpps_id'
     AND r.rpps_id = t.key_value
    WHERE t.source = 'rpps'
      AND t.key_type = 'rpps_id'
      AND r.rpps_id IS NULL;

  ELSIF p_source = 'iris' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN iris i
      ON t.key_type = 'code_iris'
     AND i.code_iris = t.key_value
    WHERE t.source = 'iris'
      AND t.key_type = 'code_iris'
      AND i.code_iris IS NULL;

  ELSIF p_source = 'sitadel' THEN
    -- Pivot key_type 'code_insee' : la commune doit avoir ≥ 1 ligne.
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    WHERE t.source = 'sitadel'
      AND t.key_type = 'code_insee'
      AND NOT EXISTS (
        SELECT 1 FROM sitadel_logements s WHERE s.code_insee = t.key_value
      );

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

NOTIFY pgrst, 'reload schema';
