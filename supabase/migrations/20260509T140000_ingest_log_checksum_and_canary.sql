-- V0.4.4 — Observabilité ingestion (audit Charleville 2026-05-09).
--
-- B2. csv_sha256 + skip_reason
--   Trace la version exacte du CSV ingéré et permet le short-circuit
--   "fichier byte-identique au dernier success → skip COPY/VALIDATE/SWAP".
--   skip_reason distingue ce cas (`same_checksum`) d'un futur no-op
--   (`upstream_unchanged`, etc.) sans réinventer une nouvelle colonne.
--
-- B3. canary_failures + ingest_canary_targets + check_ingest_canary RPC
--   5 cibles hardcodées par source (FINESS num_finess, Ameli PS) que la
--   prod doit retourner après chaque swap. Disparition d'une cible →
--   `canary_failures[]` rempli + warning logué. Non-bloquant : la swap
--   est déjà committée, on alerte sans rollback (la swap rollback se fait
--   par swap inverse staging ↔ previous, hors scope de ce check).

-- ============================================================
-- B2 — Checksum SHA-256 du CSV ingéré + skip_reason
-- ============================================================
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS csv_sha256 CHAR(64);
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS skip_reason TEXT;

-- ============================================================
-- B3 — Canary post-swap
-- ============================================================
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS canary_failures TEXT[];

-- Cibles canary par source. Clé composite (source, key_type, key_value)
-- pour permettre 2-5 cibles par source et plusieurs `key_type` (num_finess
-- côté FINESS, nom+CP côté Ameli).
CREATE TABLE IF NOT EXISTS ingest_canary_targets (
  source       TEXT NOT NULL,   -- 'finess' | 'ameli_ps'
  key_type     TEXT NOT NULL,   -- 'num_finess' | 'siren' | 'siret' | 'commune+nom' | placeholder
  key_value    TEXT NOT NULL,   -- la valeur attendue (ex: '080010085')
  description  TEXT NOT NULL,   -- contexte humain (ex: "BIO ARD'AISNE Charleville")
  created_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (source, key_type, key_value)
);

GRANT SELECT ON ingest_canary_targets TO anon, authenticated, service_role;

-- Seed FINESS — 3 num_finess BIO ARD'AISNE déjà identifiés dans l'audit
-- Charleville 2026-05-09 (parmi les 4 sites du LBM, 080010234 exclu car
-- c'est précisément la ligne polluée par le double-espace fixé en B1 —
-- on ne veut pas que le canary pète sur la cible qu'on vient de nettoyer).
-- On ajoute aussi 2 cibles génériques notoires (CHU stables sur le long
-- terme) pour avoir 5 cibles au total comme demandé dans le brief.
INSERT INTO ingest_canary_targets (source, key_type, key_value, description) VALUES
  ('finess', 'num_finess', '080010085', 'LBM BIO ARD''AISNE — site Charleville-Mézières'),
  ('finess', 'num_finess', '080010093', 'LBM BIO ARD''AISNE — site Sedan'),
  ('finess', 'num_finess', '080010101', 'LBM BIO ARD''AISNE — autre site Charleville'),
  ('finess', 'num_finess', '750100166', 'AP-HP — Hôpital Pitié-Salpêtrière (cible nationale stable)'),
  ('finess', 'num_finess', '130786049', 'AP-HM — Hôpital de la Timone (cible nationale stable)')
ON CONFLICT DO NOTHING;

-- Seed Ameli : aucun ici. Le canary Ameli reste désactivé (table empty pour
-- cette source) jusqu'à identification de cibles stables (ex: MG 75 + IDE 13
-- avec nom+CP traçables sur le long terme). Une 2e migration corrective les
-- ajoutera via INSERT classique. Comportement actuel : le RPC retourne `[]`
-- pour `ameli_ps` → aucun warning, canary inactif sans bruit dans ingest_log.
-- TODO future : ajouter 2 cibles Ameli réelles via une migration `_canary_ameli_seed`.

-- ============================================================
-- RPC check_ingest_canary
-- ============================================================
-- Retourne les `key_value` attendus pour `p_source` mais introuvables
-- dans la table prod correspondante. Vide = canary OK.
--
-- STABLE car ne modifie rien (lectures only) — autorise le caching
-- PostgREST sur les retries proches dans le temps.
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
    -- Pas de cibles seedées pour Ameli en V0.4.4 (cf. commentaire seed). Le
    -- jour où elles le seront avec key_type 'nom+cp' (ou autre clé stable),
    -- ajouter ici un LEFT JOIN annuaire_ameli ON la(es) colonne(s) appropriée(s).
    -- En attendant, le canary Ameli est inactif : on retourne `[]`.
    missing := NULL;

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

GRANT EXECUTE ON FUNCTION check_ingest_canary(TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
