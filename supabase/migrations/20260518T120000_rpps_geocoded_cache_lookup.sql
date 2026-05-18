-- Phase 2 (RPPS BAN-geocoding) — CORRECTIVE G5bis : lecture du cache
-- `geocoded_addresses` via RPC server-side (clés en BODY POST) au lieu de
-- `.from().select().in("address_key", slice)` (clés en URL GET).
--
-- ┌─ POURQUOI (incident GATE G5, 4 hypothèses réfutées par preuve prod) ───────┐
-- │ Le backfill (et le cron) lisaient le cache par chunks `.in()` de 500 clés  │
-- │ ⇒ ~670 requêtes GET SÉQUENTIELLES (335k clés / 500) pour le seul cache.    │
-- │ 3 runs prod morts `TypeError: fetch failed` sur cette phase ; diag isolé   │
-- │ (1 seule requête `.in()`) toujours OK ⇒ le défaut tient au VOLUME de       │
-- │ requêtes séquentielles (≥670 occasions d'échec transport), pas à une       │
-- │ requête donnée. L'énumération, elle, ne tombe JAMAIS — parce qu'elle       │
-- │ passe par une RPC server-side (POST, body JSON). On applique le MÊME       │
-- │ pattern au cache : `p_keys TEXT[]` en body POST, batch large (10k) ⇒       │
-- │ ~670 requêtes → ~34. Immunisé URL-length + réduit massivement la surface   │
-- │ d'échec réseau ; le retry transitoire reste en place pour les vrais blips. │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- READ-ONLY. `geocoded_addresses` vit HORS du swap atomique mensuel (jamais
-- droppée/renommée) : aucune parité staging, aucun index à mirrorer (cette
-- table n'est pas concernée par `staging-parity`). `address_key` est la clé
-- d'unicité (cf. `upsert onConflict:"address_key"`) donc `= ANY($1)` est
-- servi par l'index d'unicité. STABLE (lecture), SECURITY DEFINER + search_path
-- fixé (pattern `rpps_count_ban_eligible_rows`), EXECUTE service_role only.
--
-- Migration idempotente (`CREATE OR REPLACE`, GRANT/REVOKE idempotents).
-- Appliquée en PROD par le mainteneur via Supabase SQL Editor (la CLI supabase
-- SKIPPE les migrations `YYYYMMDDThhmmss_` — contrainte projet connue ; CI
-- via la boucle psql R5.3).

-- DROP préalable OBLIGATOIRE : `CREATE OR REPLACE FUNCTION` ne peut PAS
-- changer le type de retour (ERROR 42P13). Idempotent (IF EXISTS) ; sûr même
-- si une version antérieure `RETURNS TABLE` a été appliquée (local/CI).
DROP FUNCTION IF EXISTS rpps_geocoded_cache_lookup(TEXT[]);

-- ⚠️ RETURNS jsonb (PAS RETURNS TABLE) — LOAD-BEARING anti-S-1 :
-- PostgREST `max_rows` (config.toml = 1000) PLAFONNE SILENCIEUSEMENT le nombre
-- de LIGNES de TOUTE réponse, y compris une fonction `RETURNS TABLE` (cf.
-- gotcha CLAUDE.md « PostgREST max_rows »). Avec un batch de 10 000 clés
-- quasi-toutes en cache (run idempotent), une `RETURNS TABLE` renverrait
-- ≤1000 lignes ⇒ les clés tronquées seraient traitées « jamais vues » ⇒
-- RE-SOUMISES à BAN (viole « accepted=true FIGÉES », ré-introduit le volume
-- que ce correctif supprime) — panne SILENCIEUSE. Une fonction SCALAIRE
-- `RETURNS jsonb` retourne EXACTEMENT 1 ligne (le tableau agrégé) : `max_rows`
-- (cap de LIGNES) ne peut PAS la tronquer, quel que soit le nb d'entrées.
-- `COALESCE(..., '[]')` ⇒ jamais NULL (lot sans aucune clé en cache → `[]`,
-- pas NULL → caller `data ?? []` cohérent). Le caller itère le tableau.
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
        'address_key', g.address_key,
        'accepted', g.accepted,
        'ban_attempt_count', g.ban_attempt_count
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
  'Lit le cache geocoded_addresses pour un lot de cles passees en BODY POST (p_keys TEXT[]) au lieu de .in() en URL GET. RETURNS jsonb : UN tableau agrege (1 ligne scalaire, immunise au plafond de LIGNES PostgREST max_rows) des objets {address_key, accepted, ban_attempt_count} pour les seules cles presentes (= ANY($1), servi par l''index d''unicite address_key) ; [] si aucune. READ-ONLY, STABLE, SECURITY DEFINER, EXECUTE service_role only. Pourquoi / incident GATE G5bis : cf. en-tete de la migration 20260518T120000.';
