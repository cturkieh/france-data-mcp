-- 2026-09-05 — `rpps_geocoded_cache_lookup` expose les champs du GATE d'acceptation
-- (result_score, result_type, ban_last_status) en plus de {address_key, accepted,
-- ban_attempt_count}.
--
-- POURQUOI. Le backfill (scripts/ban-backfill.mjs) doit reconnaître un REJET
-- PÉRIMÉ : une clé rejetée sous une règle d'acceptation PLUS STRICTE que l'actuelle
-- (gate score ≥ 0,7 du 2026-05-18, assoupli à 0,5 le 2026-05-19) puis FIGÉE par le
-- cap de tentatives (`BAN_MAX_ATTEMPTS`). Prouvé prod 2026-09-05 : 9 305 clés
-- `rejected_low_score` à result_score ≥ 0,5 et result_type ∈ {housenumber, street,
-- locality}, TOUTES à ban_attempt_count = 3 et geocoded_at = 2026-05-18, portant
-- 15 903 lignes `rpps` restées au centroïde commune (22 % des 71 211 centroïdes) ;
-- échantillon de 248 re-géocodées → 247 acceptées. Sans ces champs, le backfill ne
-- voit que {accepted, attempts} et ne peut pas distinguer « durablement irrésolue »
-- de « rejetée par une règle qui n'existe plus ».
--
-- LIMITE CONNUE (revue altitude 2026-09-05) : les RPC de jauge
-- `rpps_measure_ban_to_geocode` (20260520T000000) et `ameli_measure_ban_to_geocode`
-- (20260521T102000) comptent une clé comme « faite » dès `accepted OR
-- ban_attempt_count >= 3` : elles SOUS-COMPTENT la population « rejet périmé » entre
-- un assouplissement de règle et le drain suivant (déclenché sans condition après
-- chaque cron, donc fenêtre courte et auto-fermante). Trou d'observabilité, pas
-- d'exécution — tracé `docs/backlog.md` (fonction SQL partagée si la règle change
-- à nouveau).
--
-- ADDITIF et rétro-compatible : le code en prod ignore les champs supplémentaires.
-- Format T (prod-only via MCP apply_migration ; la CLI Supabase saute ce format).
CREATE OR REPLACE FUNCTION rpps_geocoded_cache_lookup(p_keys TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'address_key',       g.address_key,
        'accepted',          g.accepted,
        'ban_attempt_count', g.ban_attempt_count,
        'result_score',      g.result_score,
        'result_type',       g.result_type,
        'ban_last_status',   g.ban_last_status
      )
    ),
    '[]'::jsonb
  )
  FROM geocoded_addresses g
  WHERE g.address_key = ANY(p_keys)
$$;
REVOKE EXECUTE ON FUNCTION rpps_geocoded_cache_lookup(TEXT[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpps_geocoded_cache_lookup(TEXT[]) TO service_role;

COMMENT ON FUNCTION rpps_geocoded_cache_lookup(TEXT[]) IS
  'Lit le cache geocoded_addresses pour un lot de cles passees en BODY POST (p_keys TEXT[]) au lieu de .in() en URL GET. RETURNS jsonb : UN tableau agrege (1 ligne scalaire, immunise au plafond de LIGNES PostgREST max_rows) des objets {address_key, accepted, ban_attempt_count, result_score, result_type, ban_last_status} pour les seules cles presentes (= ANY($1), servi par l''index d''unicite address_key) ; [] si aucune. Les 3 champs de gate (2026-09-05) permettent au backfill de re-soumettre un REJET PERIME (rejete sous une regle plus stricte que l''actuelle, fige par le cap d''attempts). READ-ONLY, STABLE, SECURITY DEFINER, EXECUTE service_role only. Incident GATE G5bis : cf. en-tete de la migration 20260518T120000.';
