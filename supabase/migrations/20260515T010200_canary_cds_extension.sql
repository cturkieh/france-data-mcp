-- V0.10 — Étend `check_ingest_canary` à la source `cds`.
--
-- Ajoute la branche `cds` au RPC existant (V0.4.4). Le RPC reste générique :
-- 1 SELECT par source, retour TEXT[] (vide = OK, non-vide = `key_value`
-- attendus mais absents post-swap). Sentinelle `['__rpc_error__']` réservée
-- aux pannes RPC (cf. shared.ts).
--
-- PAS DE SEED de cibles CDS pour l'instant — DÉLIBÉRÉ. On NE connaît pas
-- encore les vrais `etab_finess` notoires/stables (ils n'apparaîtront que
-- dans le 1er CSV CNAM ingéré). Seeder des placeholders inexistants
-- déclencherait un canary TOUJOURS rouge à chaque cron hebdo → cry-wolf
-- qui désensibilise l'ops (quand un vrai CDS disparaîtra plus tard, le
-- warning aura la même forme que le bruit permanent et sera ignoré).
--
-- Comportement actuel : `ingest_canary_targets` n'a aucune ligne `source =
-- 'cds'` → la branche `cds` du RPC retourne `[]` (canary INACTIF sans
-- bruit, exactement comme `ameli_ps`). Une fois la 1ère ingestion réelle
-- faite et 3-5 CDS notoires stables identifiés dans la base, une migration
-- corrective `_canary_cds_real_seeds` fera l'INSERT (cf. docs/backlog.md).

-- Étend le RPC pour gérer p_source = 'cds'. Pattern aligné sur 'finess' :
-- LEFT JOIN sur etab_finess (clé naturelle). Si la cible attendue n'a pas
-- de ligne dans `centres_sante`, elle apparaît dans le retour.
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
    -- Pas de cibles seedées pour Ameli en V0.4.4 (cf. commentaire seed
    -- migration originale). Le jour où elles le seront avec key_type
    -- 'nom+cp' (ou autre clé stable), ajouter ici un LEFT JOIN
    -- annuaire_ameli ON la(es) colonne(s) appropriée(s).
    -- En attendant, le canary Ameli est inactif : on retourne `[]`.
    missing := NULL;

  ELSIF p_source = 'cds' THEN
    -- V0.10 : pivot via etab_finess (PK de la table centres_sante).
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN centres_sante c
      ON t.key_type = 'etab_finess'
     AND c.etab_finess = t.key_value
    WHERE t.source = 'cds'
      AND t.key_type = 'etab_finess'
      AND c.etab_finess IS NULL;

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

GRANT EXECUTE ON FUNCTION check_ingest_canary(TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
