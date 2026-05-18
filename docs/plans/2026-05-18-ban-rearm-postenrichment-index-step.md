# Refonte BAN — ré-armement via STEP d'index post-enrichment / pré-swap

> Date : 2026-05-18. Remplace le plan « post-swap + connexion directe »
> (sur-conçu : sa prémisse « index BAN = cause structurelle du 57014 » a été
> RÉFUTÉE en prod, run #26046475566).
> Branche cible : base `main` (fix A+B+C déjà en prod), ré-injection BAN.

## 0. Vérité prouvée en prod (ne pas re-débattre)

- Le cron RPPS 57014 est **déjà résolu** par le **fix C** (`a3efcab`,
  migration `20260518T160000`), trouvé via la doc Supabase :
  1. `service_role` rolconfig=NULL → hérite `authenticator` `statement_timeout`
     = 8 s ; l'enrichment était la seule RPC longue sans `SET statement_timeout`.
  2. Aucun `ANALYZE rpps_staging` post-COPY → plan dégradé → 1er batch > 8 s.
  - Fix : `SET statement_timeout='55s'` sur la fonction enrichment (C1) +
    RPC `ingest_analyze_rpps_staging` post-COPY/pré-enrichment (C2).
- Le retrait des index BAN (« fix A », `20260518T140000`) a été **prouvé
  insuffisant** (cron re-échoué à l'identique sans les index). Les index BAN
  étaient un **aggravant** (maintenance par row pendant INSERT 2,24 M /
  UPDATE enrichment), PAS la cause.
- Cron prod = VERT (A+B+C). Cache `geocoded_addresses` = 266 049 acceptées,
  survit à tout, **NE PAS TOUCHER**.

## 1. Décision d'architecture (doc PostgreSQL officielle)

« Populating a Database » + « Create indexes after bulk loading » (CYBERTEC) :
construire les index **après** le chargement, jamais les maintenir pendant.

→ Les 2 index BAN ne sont créés NI dans `ingest_create_rpps_staging` (sinon
maintenus pendant l'INSERT 2,24 M + l'UPDATE enrichment = l'aggravant) NI
post-swap sur la table servie (inutilement complexe : CONCURRENTLY +
connexion directe + rebuild mensuel + gestion INVALID). Ils sont construits
**une fois, sur `rpps_staging`, APRÈS l'enrichment et AVANT le swap**, en
`CREATE INDEX` bloquant classique : `rpps_staging` ne sert AUCUNE lecture
prod (c'est `rpps` qui sert), donc le lock de build est sans impact externe.
Les index voyagent ensuite dans `rpps` via le RENAME du swap.

## 2. Nouvelle séquence cron (`scripts/ingest/rpps.ts`, base = main)

```
4.  ingest_create_rpps_staging (SANS index BAN — def main 20260518T140000) + COPY 2,24M
5a. ingest_analyze_rpps_staging               (fix C2, fail-loud — inchangé main)
5b. enrichment FINESS runBatchedRpc           (fix C1, 55s, AUCUN index BAN à maintenir)
5c. NOUVEAU — ingest_build_rpps_staging_ban_indexes()
       = CREATE INDEX (bloquant, non concurrent) des 2 index BAN sur rpps_staging,
         sur données stabilisées (post-enrichment), RPC SECURITY DEFINER
         SET statement_timeout='10min' (parité RPC lourdes projet) ; idempotent
         (IF NOT EXISTS) ; fail-loud (IngestError) — sans ces index l'énumération
         BAN full-scanne.
5d. NOUVEAU — ingest_analyze_rpps_staging (re-ANALYZE : le planner doit voir les
       index fonctionnels neufs sinon skip-scan ignoré)
5e. NOUVEAU — runBanGeocodeStep(supabase, log, sourceTable='rpps_staging')
       énumération keyset skip-scan + cache lookup + filtrage 3-cas + cap
       BAN_MAX_NEW_PER_RUN + appels BAN (chunk 2000) + upsert cache +
       ingest_apply_rpps_ban_geocoding_batch → pose geom/geom_source='ban_address'
       sur rpps_staging. BEST-EFFORT (catch→partial, jamais throw, finess_join
       jamais touché, backstop S-1 count>0 && keys==0 → throw→catch→partial).
6.  atomicSwapTables('rpps')   — rpps_staging→rpps : coords précises + 2 index voyagent
6b. rebuildRppsMatviews (RPC ingest_rebuild_rpps_matviews — def main B, PAS refresh-only)
6c. canary
```

Au cron suivant : `rpps_staging` recréé propre (sans index BAN, étape 4) →
zéro pénalité INSERT/enrichment ; 5c les reconstruit une fois sur données
stabilisées. Invariant : la table SERVIE `rpps` a toujours les 2 index
(arrivés par le dernier swap), le 57014 est structurellement hors d'atteinte
(aucun index BAN présent pendant l'INSERT massif ni l'UPDATE enrichment) +
fix C en défense de profondeur.

## 3. Stratégie git

Nouvelle branche `feat/rpps-ban-rearm` depuis `main` (base fix A+B+C). Re-port
chirurgical de la logique BAN de `feat/rpps-ban-geocoding` (fichiers BAN purs
inchangés : `src/core` client BAN + `retry-transient`, migrations
`20260516T060000`/`20260517T120000`/`20260517T130000`/`20260518T120000`,
`scripts/ban-backfill.mjs`, tests d'intégration BAN). PAS de merge/rebase
(58 commits, conflits récurrents `rpps.ts`/`migration-sql.ts`). `migration-sql.ts`
résolu en module union (renommer `latestFunctionBody` de main →
`latestFunctionBodyLoose`, garder les 2 contrats — distincts VOLONTAIREMENT).
Les 4 commits G5/G6 (`d7e5dab`..`e7a1cea`, non passés /simplify+/review) :
le re-port les fait entrer dans la chaîne discipline (non exemptables).

## 4. Changements migrations

- `20260517T120000` / `20260517T130000` : `ingest_create_rpps_staging` NE
  DOIT PLUS créer les 2 index BAN (rester la def main `20260518T140000`).
  Garder le wrapper `rpps_address_key_for_index`, la RPC skip-scan
  `rpps_distinct_eligible_keys`, `rpps_count_ban_eligible_rows`,
  `rpps_geocoded_cache_lookup`, `ingest_apply_rpps_ban_geocoding_batch`.
- Nouvelle migration `2026MMDDThhmmss_ingest_build_rpps_staging_ban_indexes.sql` :
  RPC `ingest_build_rpps_staging_ban_indexes()` SECURITY DEFINER
  `SET search_path=public,extensions` `SET statement_timeout='10min'`,
  corps = 2 `CREATE INDEX IF NOT EXISTS` (clé-seule + composite) sur
  `rpps_staging`, expression `rpps_address_key_for_index(adresse,
  code_postal, code_insee)` + prédicat byte-identiques aux migrations BAN /
  RPC / count (parité gardée). Jamais `CONCURRENTLY` (rpps_staging non servie).
- Parité jumeau SQL↔JS (`rpps_normalize_address_key`↔`normalizeAddressKey`,
  HARD GATE) : NON modifiée. Wrapper non modifié. Parité par transitivité.

## 5. Tests (TDD, RED d'abord)

- `rpps.test.ts` : ordre strict 5b→5c→5d→5e→6 (assertion séquence) ;
  `runBanGeocodeStep` `sourceTable='rpps_staging'` ; 3-cas cache, cap,
  backstop S-1, R4, best-effort `partial` (ré-injectés de feat).
- `ban-eligibility-index-expr-parity.test.ts` étendu : expression+prédicat
  émis par la RPC `ingest_build_rpps_staging_ban_indexes` == migrations/RPC.
- `staging-parity.test.ts` : les 2 index BAN NE doivent PAS être dans
  `ingest_create_rpps_staging` (commentaire pointant ce plan + 140000(c)).
- `enrichment-statement-timeout.test.ts`, `rpps-matview-rebuild.test.ts` :
  verts après renommage `latestFunctionBody`→`latestFunctionBodyLoose`.
- Intégration (`--no-file-parallelism` LOAD-BEARING) : nouveau
  `rpps-staging-ban-index-step.integration.test.ts` (applique migrations via
  psql, seed mini-rpps_staging, exécute la RPC, vérifie 2 index valides +
  EXPLAIN skip-scan) ; `ban-geocode-parity` (HARD GATE) inchangé.

## 6. GATE prod (réécrit, remplace phase2-prod-gate §130000)

Canal : `PGPASSWORD="$(cat ~/fdm-pass.txt)" docker exec -i -e PGPASSWORD
supabase_db_france-data-public psql "$(cat ~/fdm-conn.txt)"` (autorisé).

1. Pré-req : `ingest_create_rpps_staging` = def main (SANS index BAN, fix A) ;
   fix C1/C2 présents ; wrapper + RPC BAN + `ingest_build_rpps_staging_ban_indexes`
   appliqués (canal psql, jamais SQL Editor pour DDL lourd).
2. HARD GATE parité JS↔SQL (`ban-geocode-parity.integration.test.ts`) — 1 octet
   de divergence ⇒ STOP.
3. Cache : `count FILTER (WHERE accepted)` ≈ 266 049 (réutilisé, pas de
   re-géocodage de masse).
4. **Critère bloquant** : 1 run cron complet → `ingest_log` :
   `status`∈{success,partial}, `error_phase`≠validate, AUCUN 57014,
   enrichment convergé, step 5c a buildé 2 index valides, 5e a posé N>0
   `geom_source='ban_address'`, matviews OK, durée mesurée < seuil de
   référence (runs verts 2026-05-18). `partial` (BAN a hoqueté, cache
   préservé) ≠ échec. `failed`/57014/`error_phase=validate` = échec → STOP.
5. **Durabilité** : 2e cron consécutif → pas de 57014, 2 index reconstruits,
   matviews servies OK, PS en `ban_address` croît/stable. Preuve vs feat qui
   n'a jamais passé 1 cron armé.
6. Cas fonctionnels : RPPS connus centroïde→`ban_address` ; pas de régression
   `rpps_search_by_name`/`data_freshness`.
7. Verdict commité.

## 7. Discipline post-fix (CLAUDE.md)

Avant commit : tests MAJ → `/simplify` (3) → `/review` P1 (3, corriger TOUT)
→ `/review` P2 (2) → docs (`CHANGELOG`, `CLAUDE.md` gotcha NOUVEAU « index
BAN = STEP post-enrichment/pré-swap sur rpps_staging, JAMAIS dans
staging-create, JAMAIS post-swap sur table servie ; non concurrent OK car
staging non servie »), `docs/ingestion.md`, ce plan, GATE réécrit →
`pnpm typecheck && lint && test:unit` verts. Dette G5/G6 intégrée au périmètre.

## 8. Critères PASS / STOP

PASS : 2 crons consécutifs verts (jamais failed/57014/validate), 2 index
reconstruits chaque mois, N>0 PS `ban_address` dans `rpps` servie, matviews
OK, cache intact, parité JS↔SQL verte, suite verte, chaîne discipline faite.
STOP : tout 57014/`error_phase=validate`, divergence HARD GATE parité, index
BAN ré-introduit dans `ingest_create_rpps_staging`, régression fix A/B/C.
