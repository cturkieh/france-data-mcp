# `ban_join` — design durable + post-mortem (RÉSOLU, prouvé prod 2026-05-19)

> Doc de référence consolidé. Remplace les 4 docs de travail
> (design / implementation-plan / HANDOFF / ban-rearm-postenrichment-index-step)
> dont la matière durable est ici. Gotcha synthétique : `CLAUDE.md` § "Top gotchas DB".

## But métier

Le fichier RPPS de l'ANS ne contient **aucune coordonnée**. 3 voies de géoloc :
`finess_join` (JOIN `rpps.num_finess = finess.num_finess`, ~377 k PS, marche),
`commune_centroid` (repli ~3 km), `ban_address` (géocodage BAN de l'adresse texte).
Seul `ban_address` n'était jamais arrivé en prod — c'était le blocage des 4 jours.
Le cache `geocoded_addresses` (266 049 adresses acceptées) était **déjà rempli** ;
le seul problème = **poser ces coords dans `rpps`**.

## Décision finale — `ban_join` (jumeau `finess_join`, curseur KEYSET)

`ingest_apply_rpps_ban_join_batch(p_after, p_limit)` (migration `20260519T180000`,
`SET statement_timeout='55s'`, `RETURNS TABLE(last_id, applied)`) :
`UPDATE rpps_staging ⟕ geocoded_addresses ON g.address_key = rpps_address_key_for_index(...)`,
lot borné **`WHERE id > p_after ORDER BY id LIMIT p_limit`** (jamais sentinelle/OFFSET).
Helper générique `runKeysetRpc` (`shared.ts`, garde de non-progression + `withTimeout`).
Le cache rempli hors cron devient "une table à joindre" comme FINESS — plus aucun
build d'index lourd ni géocodage API dans le cron.

### Pourquoi KEYSET et NON sentinelle (prouvé prod, EXPLAIN ANALYZE en txn ROLLBACK)

- Sentinelle façon FINESS (proxy `OFFSET 1.2M`) re-scanne le préfixe déjà traité
  → quadratique → **57014 en fin de parcours** (>120 s). Réfuté en prod.
- Keyset `id > p_after` démarre où le lot précédent s'est arrêté →
  **~4,8 s/lot CONSTANT** début↔fin. ~1,29 M éligibles ≈ ~11 min linéaire.
- Jointure sur `geocoded_addresses_pkey` = nested-loop indexé 0,18 ms/ligne →
  **aucun index fonctionnel lourd sur `rpps_staging` requis**.

## Résultat prouvé prod

Run **#13** (`ce56dcb`, `success`, ~54 min) : `rpps.geom_source='ban_address'`
= **1 065 291** (0 avant) ; `finess_join` non régressé (392 056) ;
`commune_centroid` 1,27 M → 208 k ; canary `rpps_in_radius` Paris 1 km = 147 ms
(anti-57014 tient le nouveau volume). **PR #21 mergée sur `main`** → le cron
mensuel embarque le fix automatiquement.

## Dead-ends prouvés — NE PAS REFAIRE

- ❌ `CREATE INDEX` multi-minutes via RPC PostgREST (ancien step 5c
  `ingest_build_rpps_staging_ban_indexes`) — **cap passerelle Supabase 60 s en
  dur**, structurel, réfuté run #26087010166. Indexer après chargement de masse
  reste juste, mais via canal direct, jamais via RPC PostgREST synchrone du cron.
- ❌ Sentinelle/OFFSET pour itérer un gros UPDATE joint (cf. ci-dessus).
- ❌ Cherry-pick des fixes intriqués sur `main` (conflits prouvés — reconstruire).
- ❌ Coder un fix sans l'avoir prouvé en prod / validé doc officielle + forums.
  Une inférence passée /review reste une inférence (4 jours perdus là-dessus).

## Dette tracée (hors scope, décidé PO)

`ban-backfill.mjs` reste manuel (hors cron) et dépend encore des index BAN
présents sur `rpps` (aujourd'hui absents — swap jamais réussi avec). À résoudre
dans une future feature « automatisation backfill » (post-swap bloquant =
dead-end connu). Le cache `geocoded_addresses` (266 k) ne se touche pas.

## Garde-fous

`ban-eligibility-predicate-parity` (6 sites), `ban-eligibility-index-expr-parity`
(ban_join via WRAPPER), `enrichment-statement-timeout` (ban_join ≤55 s),
test d'intégration DB locale (HIT/MISS/non-éligible/idempotence).
