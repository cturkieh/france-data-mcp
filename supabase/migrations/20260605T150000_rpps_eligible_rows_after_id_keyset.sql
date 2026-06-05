-- Bouton GitHub « drain BAN RPPS » — énumération ROBUSTE en KEYSET SUR `id` (PK).
--
-- CONTEXTE (2 dead-ends prouvés prod 2026-06-05, discipline « prouver par la prod ») :
--  1. Keyset sur la CLÉ d'adresse (rpps_distinct_eligible_keys) → exige un index BAN
--     sur la table. Sur `rpps` LIVE il n'existe pas (orphelin au swap) ; le construire
--     via RPC PostgREST = cap passerelle 60 s (dead-end CLAUDE.md « BAN re-arm »).
--  2. Passe unique (DISTINCT / DISTINCT ON, même MATERIALIZED) → calcule
--     `rpps_address_key_for_index` (normalisation Unicode, ~880 µs/appel, MESURÉ) sur
--     les ~147k lignes éligibles en UNE requête ≈ 129 s → 57014.
--
-- LA SOLUTION : keyset sur `id` (la PK, TOUJOURS indexée → aucun index BAN requis).
-- Chaque page borne le nombre de lignes → borne le nb d'évals de la clé coûteuse :
-- MESURÉ 5000 lignes/page = 4,4 s (Index Scan rpps_pkey, filtre éligibilité), coût
-- CONSTANT par page (keyset, pas d'OFFSET quadratique). 147k éligibles ≈ 30 pages
-- × 4,4 s, chacune TRÈS en-dessous du budget 55 s. La clé est calculée par
-- PROJECTION (1 éval/ligne retournée, pas de tri sur la clé → pas de réévaluation).
-- Le client (ban-backfill.mjs) déduplique par `address_key`.
--
-- POURQUOI RETOURNER LES LIGNES (pas les clés distinctes) : dédupliquer côté SQL
-- exigerait un GROUP BY/DISTINCT sur la clé = retour au calcul-en-masse + tri. Le
-- résidu live est petit ; la dédup côté client (Map) est triviale. Représentant par
-- clé = 1ère ligne rencontrée en ordre d'`id` (équivalent géocodage : même clé =
-- même adresse normalisée).
--
-- Expression `rpps_address_key_for_index` + prédicat BYTE-IDENTIQUES aux sites BAN
-- (garde-fou dédié rpps-eligible-rows-after-id.test.ts). SECURITY DEFINER +
-- REVOKE PUBLIC + GRANT service_role = pattern aligné. statement_timeout 55 s
-- (< cap passerelle 60 s ; une page déborde JAMAIS, mais filet propre 57014).

CREATE OR REPLACE FUNCTION rpps_eligible_rows_after_id(
  p_source_table TEXT DEFAULT 'rpps',
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
    WHEN 'rpps'         THEN 'rpps'
    WHEN 'rpps_staging' THEN 'rpps_staging'
    ELSE NULL
  END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'rpps_eligible_rows_after_id: invalid source_table %, expected ''rpps'' | ''rpps_staging''',
      p_source_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'rpps_eligible_rows_after_id: p_limit must be >= 1 (got %)', p_limit
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT t.id,
           rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) AS address_key,
           t.adresse::text, t.code_postal::text, t.code_insee::text
    FROM %I t
    WHERE (t.geom_source = 'commune_centroid'
           OR (t.geom IS NULL AND t.adresse IS NOT NULL))
      AND t.id > $1
    ORDER BY t.id
    LIMIT $2
  $q$, v_source) USING p_after_id, p_limit;
END;
$$;

COMMENT ON FUNCTION rpps_eligible_rows_after_id(TEXT, BIGINT, INT) IS
  'Énumération KEYSET SUR id (PK) des lignes éligibles BAN de la table whitelistée (rpps | rpps_staging) — retourne (id, address_key, adresse, code_postal, code_insee) pour id > p_after_id, ORDER BY id LIMIT p_limit. Aucun index BAN requis (PK suffit) ; borne le nb d''évals de la clé Unicode coûteuse par page (~4,4 s / 5000 lignes, MESURÉ). Consommée par ban-backfill.mjs (bouton drain RPPS), dédup par address_key côté client. Prédicat byte-identique aux sites BAN (garde-fou rpps-eligible-rows-after-id.test.ts).';

REVOKE EXECUTE ON FUNCTION rpps_eligible_rows_after_id(TEXT, BIGINT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpps_eligible_rows_after_id(TEXT, BIGINT, INT) TO service_role;
