-- Bouton GitHub « drain BAN Ameli » — énumération ROBUSTE en KEYSET SUR `id` (PK).
-- JUMEAU EXACT de rpps_eligible_rows_after_id (migration 20260605T150000), à UNE
-- différence load-bearing près : le prédicat d'éligibilité AMELI est
-- `geom_source='commune_centroid' AND adresse IS NOT NULL` — SANS la branche RPPS
-- `OR (geom IS NULL AND adresse IS NOT NULL)` (Ameli n'a pas de FINESS-join → son
-- seul état non géocodé est le centroïde commune).
--
-- POURQUOI (cause-racine, cf. docs/plans/automatisation-backfill-ban.md) :
-- l'énumération par CLÉ `ameli_distinct_eligible_keys` exige un index BAN sur la
-- table LIVE `annuaire_ameli`, ORPHÉLINÉ à chaque swap atomique du cron Ameli
-- hebdo (le RENAME emporte l'index sur `annuaire_ameli_previous`) → seq-scan 50 s
-- → timeout, d'où une recréation MANUELLE d'index avant CHAQUE drain. Le keyset
-- sur la PK `id` (toujours indexée → AUCUN index BAN requis) borne le nb d'évals
-- de la clé Unicode coûteuse par page (côté RPPS ~4,4 s / 5000 lignes au défaut RPC,
-- MESURÉ ; le client backfill pagine par KEYSET_PAGE=1000 → pages plus petites, coût
-- CONSTANT par page, pas d'OFFSET quadratique). La clé est calculée par
-- PROJECTION (1 éval/ligne retournée, pas de tri sur la clé → pas de réévaluation).
-- Le client (ban-backfill.mjs) déduplique par `address_key`.
--
-- Expression `rpps_address_key_for_index` + prédicat BYTE-IDENTIQUES au canonique
-- Ameli — garde-fou DÉDIÉ ameli-eligible-rows-after-id.test.ts (la parité du
-- prédicat sur les 5 AUTRES sites BAN Ameli est gardée séparément par
-- ban-eligibility-ameli-parity.test.ts, qui n'énumère PAS cette RPC). SECURITY
-- DEFINER + REVOKE PUBLIC + GRANT service_role + STABLE + statement_timeout 55 s
-- (< cap passerelle PostgREST 60 s) = pattern aligné RPPS.

CREATE OR REPLACE FUNCTION ameli_eligible_rows_after_id(
  p_source_table TEXT DEFAULT 'annuaire_ameli',
  p_after_id     BIGINT DEFAULT 0,
  p_limit        INT DEFAULT 5000
)
RETURNS TABLE (
  id          BIGINT,
  address_key TEXT,
  adresse     TEXT,
  code_postal TEXT,
  code_insee  TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '55s'
SET search_path = public, extensions
AS $$
DECLARE
  v_source TEXT;
BEGIN
  v_source := CASE p_source_table
    WHEN 'annuaire_ameli'         THEN 'annuaire_ameli'
    WHEN 'annuaire_ameli_staging' THEN 'annuaire_ameli_staging'
    ELSE NULL
  END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'ameli_eligible_rows_after_id: invalid source_table %, expected ''annuaire_ameli'' | ''annuaire_ameli_staging''',
      p_source_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'ameli_eligible_rows_after_id: p_limit must be >= 1 (got %)', p_limit
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT t.id,
           rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) AS address_key,
           t.adresse::text, t.code_postal::text, t.code_insee::text
    FROM %I t
    WHERE (t.geom_source = 'commune_centroid' AND t.adresse IS NOT NULL)
      AND t.id > $1
    ORDER BY t.id
    LIMIT $2
  $q$, v_source) USING p_after_id, p_limit;
END;
$$;

COMMENT ON FUNCTION ameli_eligible_rows_after_id(TEXT, BIGINT, INT) IS
  'Énumération KEYSET SUR id (PK) des lignes éligibles BAN Ameli (annuaire_ameli | annuaire_ameli_staging) — jumeau de rpps_eligible_rows_after_id. Prédicat Ameli geom_source=commune_centroid AND adresse IS NOT NULL (PAS la branche RPPS geom IS NULL). Aucun index BAN requis (PK suffit) ; borne le nb d''évals de la clé Unicode coûteuse par page. Consommée par ban-backfill.mjs --source ameli (bouton drain Ameli), dédup par address_key côté client. Prédicat byte-identique aux sites BAN Ameli (garde-fou ameli-eligible-rows-after-id.test.ts).';

REVOKE EXECUTE ON FUNCTION ameli_eligible_rows_after_id(TEXT, BIGINT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ameli_eligible_rows_after_id(TEXT, BIGINT, INT) TO service_role;
