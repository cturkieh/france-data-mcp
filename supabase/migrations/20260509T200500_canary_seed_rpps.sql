-- V0.5 — extension du canary `check_ingest_canary` pour la source `rpps`
-- + seed initial de cibles placeholder.
--
-- Étape 1 — étendre `check_ingest_canary` avec une branche `rpps`. Sans ça,
-- `runAndRecordCanary` lèverait `unknown source rpps` au 1er run.
-- Étape 2 — seeder quelques cibles placeholder (à remplacer par de vrais
-- IDNPS référents stables après le 1er run prod, via une migration corrective).

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
    -- Pas de cibles seedées pour Ameli en V0.4.4. Le jour où elles le seront
    -- avec key_type 'nom+cp' (ou autre clé stable), ajouter le LEFT JOIN ici.
    missing := NULL;

  ELSIF p_source = 'rpps' THEN
    -- key_type 'rpps_id' = IDNPS national (11 chars).  Sentinel placeholder
    -- du seed initial : si tous les IDNPS seedés sont des placeholders, le
    -- canary remontera 100% missing au 1er run — c'est attendu jusqu'à ce
    -- qu'une migration corrective remplace les seeds par des IDNPS réels.
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN rpps r
      ON t.key_type = 'rpps_id'
     AND r.rpps_id = t.key_value
    WHERE t.source = 'rpps'
      AND t.key_type = 'rpps_id'
      AND r.rpps_id IS NULL;

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

GRANT EXECUTE ON FUNCTION check_ingest_canary(TEXT) TO anon, authenticated, service_role;

-- Seed placeholder — IDNPS = 11 chiffres exactement (sinon le LEFT JOIN
-- `r.rpps_id = t.key_value` ne matche jamais et le canary remonte 100%
-- missing à chaque run, polluant durablement les warnings).
-- À remplacer par 2-3 IDNPS référents stables (Pr AP-HP, IDE Marseille…)
-- via migration corrective après le 1er run prod et vérification
-- annuaire.sante.fr.
INSERT INTO ingest_canary_targets (source, key_type, key_value, description)
VALUES
  ('rpps', 'rpps_id', '81000964799', 'PS placeholder — à valider post 1er run'),
  ('rpps', 'rpps_id', '00000000001', 'PS placeholder bas de spectre — à valider post 1er run'),
  ('rpps', 'rpps_id', '99999999999', 'PS placeholder haut de spectre — à valider post 1er run')
ON CONFLICT (source, key_type, key_value) DO NOTHING;
