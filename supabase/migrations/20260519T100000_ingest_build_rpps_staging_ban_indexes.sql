-- Refonte 2026-05-18 — STEP d'index BAN post-enrichment / pre-swap.
-- Cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md.
--
-- ┌─ POURQUOI (decision d'architecture — doc PostgreSQL « Populating a DB ») ───┐
-- │ Les 2 index fonctionnels BAN Unicode-lourds                                │
-- │   rpps_staging_ban_eligible_normkey_idx     (cle-seule, sauts skip-scan)   │
-- │   rpps_staging_ban_eligible_normkey_id_idx  (composite (keyexpr, id),      │
-- │                                              representant MIN(id))         │
-- │ NE doivent etre crees NI dans `ingest_create_rpps_staging` NI post-swap    │
-- │ sur la table SERVIE `rpps`. Les creer dans la staging-create les ferait    │
-- │ maintenir PAR ROW pendant l'INSERT 2,24 M + l'UPDATE de masse de           │
-- │ l'enrichment FINESS (recalcul de la normalisation Unicode                  │
-- │ `rpps_address_key_for_index` par ligne updatee × centaines de milliers)    │
-- │ → depasse `statement_timeout` → SQLSTATE 57014 en phase `validate`         │
-- │ (l'AGGRAVANT prouve, runs #26029698016 / #26046475566 ; cf. plan §0/§1    │
-- │ + migration 20260518T140000). Doctrine PostgreSQL : construire les index  │
-- │ APRES le chargement de masse, jamais les maintenir pendant.               │
-- │                                                                            │
-- │ Cette RPC construit les 2 index UNE FOIS, sur `rpps_staging`, APRES        │
-- │ l'enrichment FINESS et AVANT le swap atomique, en `CREATE INDEX`           │
-- │ BLOQUANT classique (PAS `CONCURRENTLY` : `rpps_staging` ne sert AUCUNE     │
-- │ lecture prod — c'est `rpps` qui sert — donc le lock de build est sans      │
-- │ impact externe ; de plus `CREATE INDEX CONCURRENTLY` est interdit dans     │
-- │ une fonction PL/pgSQL transactionnelle). Les 2 index voyagent ensuite      │
-- │ dans `rpps` via le RENAME du swap. Au cron suivant, `rpps_staging` est     │
-- │ recree propre (sans index BAN, def canonique 20260518T140000) → zero       │
-- │ penalite INSERT/enrichment ; cette RPC les reconstruit une fois sur        │
-- │ donnees stabilisees. La table SERVIE `rpps` a TOUJOURS les 2 index         │
-- │ (arrives par le dernier swap) : le 57014 est structurellement hors         │
-- │ d'atteinte + fix C en defense de profondeur.                               │
-- │                                                                            │
-- │ PARITE BYTE-A-BYTE (garde-fou dur) : l'expression d'index                  │
-- │ `rpps_address_key_for_index(adresse, code_postal, code_insee)` ET le      │
-- │ predicat partiel `geom_source = 'commune_centroid' OR (geom IS NULL AND   │
-- │ adresse IS NOT NULL)` sont byte-identiques a ceux de                       │
-- │ `rpps_distinct_eligible_keys` (skip-scan saut + representant),             │
-- │ `rpps_count_ban_eligible_rows` et `ingest_apply_rpps_ban_geocoding_batch` │
-- │ (sinon le planner juge les index inapplicables → full-scan + timeout       │
-- │ 60 s au cron, regression silencieuse). Gardes par                          │
-- │ scripts/ingest/ban-eligibility-index-expr-parity.test.ts +                 │
-- │ ban-eligibility-predicate-parity.test.ts (NE doivent jamais rougir). Le   │
-- │ wrapper `rpps_address_key_for_index` (defini 20260517T120000 section 0)    │
-- │ delegue STRICTEMENT au jumeau `rpps_normalize_address_key` (UNIQUE source │
-- │ de verite, parite octet JS↔SQL couverte PAR TRANSITIVITE par le HARD       │
-- │ GATE ban-geocode-parity.integration.test.ts — aucune re-implementation).  │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- APPLICATION. Naming `YYYYMMDDThhmmss` → la CLI Supabase saute ce fichier
-- (`db reset` ne l'applique pas) : appliquee MANUELLEMENT en prod via le canal
-- psql pooler (jamais le SQL Editor pour du DDL lourd). `CREATE OR REPLACE`
-- (signature `RETURNS VOID` stable → pas de `DROP FUNCTION` requis),
-- IDEMPOTENTE (`CREATE INDEX IF NOT EXISTS`), REJOUABLE sans effet de bord.
-- Postérieure a 20260518T160000 (fix C) : ordre d'application coherent.

CREATE OR REPLACE FUNCTION ingest_build_rpps_staging_ban_indexes()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10min'
AS $$
BEGIN
  -- (1) Index fonctionnel PARTIEL cle-seule — sert les DESCENTES de saut du
  --     skip-scan de `rpps_distinct_eligible_keys` (keyexpr > prev ORDER BY
  --     keyexpr LIMIT 1). MEME expression `rpps_address_key_for_index(...)` +
  --     MEME predicat byte-identiques a la RPC skip-scan / au count / a
  --     ingest_apply_rpps_ban_geocoding_batch (sinon planner inapplicable).
  --     CREATE INDEX bloquant classique (rpps_staging non servie) ; jamais
  --     CONCURRENTLY (interdit en fonction plpgsql + inutile ici).
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee))
    WHERE geom_source = 'commune_centroid'
          OR (geom IS NULL AND adresse IS NOT NULL);

  -- (2) Index fonctionnel PARTIEL COMPOSITE (keyexpr, id) — sert le SEEK
  --     CORRELE du representant MIN(id) du skip-scan (keyexpr = $1 ORDER BY
  --     keyexpr, id LIMIT 1) en O(1) par cle. MEME expression + MEME predicat
  --     byte-identiques a l'index cle-seule ci-dessus et a la RPC skip-scan
  --     (sinon le representant viendrait d'un sous-ensemble different → cles
  --     perdues OU re-scan O(taille du groupe geant) = re-regression G5).
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_id_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid'
          OR (geom IS NULL AND adresse IS NOT NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_build_rpps_staging_ban_indexes() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_build_rpps_staging_ban_indexes() TO service_role;

COMMENT ON FUNCTION ingest_build_rpps_staging_ban_indexes() IS
  'Refonte 2026-05-18 (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md) — construit les 2 index fonctionnels BAN (rpps_staging_ban_eligible_normkey_idx cle-seule + rpps_staging_ban_eligible_normkey_id_idx composite (keyexpr, id)) sur rpps_staging, APPELEE par scripts/ingest/rpps.ts APRES l enrichment FINESS et AVANT le swap atomique (step 5c), puis re-ANALYZE (5d) AVANT l enumeration BAN (5e). CREATE INDEX bloquant classique, jamais CONCURRENTLY (rpps_staging ne sert aucune lecture prod ; CIC interdit en fonction plpgsql). Les 2 index voyagent dans rpps via le RENAME du swap. JAMAIS crees dans ingest_create_rpps_staging ni post-swap sur la table servie : les y maintenir pendant l INSERT 2,24 M + l UPDATE d enrichment = l AGGRAVANT prouve du timeout 57014 (doctrine PostgreSQL « Populating a Database » : index APRES chargement de masse). Expression rpps_address_key_for_index(adresse, code_postal, code_insee) + predicat geom_source=commune_centroid OR (geom NULL AND adresse NOT NULL) byte-identiques a rpps_distinct_eligible_keys / rpps_count_ban_eligible_rows / ingest_apply_rpps_ban_geocoding_batch (gardes par ban-eligibility-index-expr-parity + ban-eligibility-predicate-parity). SECURITY DEFINER, SET statement_timeout=10min (parite RPC lourdes projet), EXECUTE service_role only. Idempotente (CREATE INDEX IF NOT EXISTS), rejouable. Naming T-format : CLI Supabase la saute, appliquee manuellement via canal psql pooler.';
