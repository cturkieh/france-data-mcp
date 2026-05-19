# PASSATION — état réel & suite (2026-05-19)

> ## ✅ RÉSOLU (2026-05-19, même jour) — `ban_join` implémenté
> Le blocage des 4 jours (§3, §5) est **levé**. Solution `ban_join` (jumeau
> FINESS + curseur keyset) conçue, prouvée prod, implémentée en 6 tâches TDD,
> garde-fous parité étendus, test d'intégration vert. Voir :
> `docs/plans/2026-05-19-ban-join-design.md` (spec + preuves prod) et
> `docs/plans/2026-05-19-ban-join-implementation-plan.md` (plan exécuté).
> §5 ci-dessous = contexte historique de la décision ; §3 (cause du blocage)
> = post-mortem. Reste : application migration prod + run armé `force` +
> vérif post-swap (Task 8 du plan d'implémentation). Backfill = hors scope
> (décidé PO), automatisation = feature ultérieure (dette tracée CLAUDE.md).

> **Document de reprise autoportant.** Une nouvelle session Claude Code n'a PAS
> besoin de relire la conversation précédente. Tout l'essentiel est ici.
> Lis-le EN ENTIER avant toute action. Discipline projet : **prouver par la
> prod avant de coder** (4 jours perdus en inférences passées /review puis
> réfutées par la prod — ne pas répéter).

## 0. START HERE (ordre d'action conseillé)

1. Lire ce doc en entier + `CLAUDE.md` section « Top gotchas DB ».
2. **Ne rien merger sur `main` dans la précipitation.** Rien ne l'exige (cf. §2).
3. Prochaine vraie tâche = écrire le plan **`ban_join`** (§5), le faire valider
   par Cyril (PO, non-dev — expliquer simple), puis coder sous chaîne discipline.
4. Tâche secondaire non urgente = port propre des fixes qui marchent vers `main`
   (§4) — **reconstruction manuelle**, PAS un cherry-pick (prouvé impossible).

## 1. Le but métier (rappel)

Donner une géoloc **précise** (numéro/rue) aux professionnels de santé du RPPS
qui n'en ont pas. Le fichier RPPS de l'ANS **ne contient AUCUNE coordonnée**.
3 voies de géoloc, toutes calculées par le pipeline :
- `finess_join` : JOIN SQL `rpps.num_finess = finess.num_finess` → copie le geom
  précis de l'établissement FINESS. **Marche, ~377 k PS uniques.**
- `commune_centroid` : repli ~3 km (CP/INSEE).
- `ban_address` : géocodage BAN de l'adresse texte. **C'est ÇA qui n'est jamais
  arrivé en prod** — l'objectif des 4 derniers jours.

Dimensionnement prouvé prod : 1,87 M PS uniques ; 377 k précis via FINESS ;
**~1,01 M éligibles BAN** ; ~484 k inlocalisables (donnée source trop pauvre).
Côté adresses distinctes : ~332 k à géocoder, dont **266 049 déjà géocodées et
acceptées** dans le cache `geocoded_addresses` (65 497 rejetées par la BAN =
adresses dégradées). **Le géocodage est fait. Ce qui bloque = le poser dans
`rpps`.**

## 2. État réel — PROUVÉ (ne pas re-supposer)

### Git
- Branche courante : **`feat/rpps-ban-rearm`**, poussée, tree propre.
- Tag de revert : **`wip/rpps-ban-rearm-2026-05-19`** (poussé) = point de
  restauration complet.
- 3 commits devant `main` :
  | Commit | Quoi | Statut |
  |---|---|---|
  | `6a2bbf3` | Refonte BAN 0.11.0 (base de branche) — step 5c `ingest_build_rpps_staging_ban_indexes` | ❌ **CASSÉ** (timeout passerelle, cf. §3) |
  | `8b578f2` | Durabilité GiST partiel `rpps_in_radius` (migration `20260519T160000` + guard `staging-parity` + gotcha CLAUDE.md) | ✅ **BON, déjà appliqué en prod** |
  | `393b107` | Levier `force` (input `workflow_dispatch` `force` → `FORCE_REINGEST` → `isForceReingestEnv` → bypass court-circuit SHA256) | ✅ **BON, validé par le run armé** |
- `main` = baseline A+B+C (cron vert, **sans** BAN).
- Branche locale parasite `chore/secure-prod-fixes` (jamais poussée, pointe sur
  main, 0 commit, inerte) : `git branch -D chore/secure-prod-fixes` quand
  possible (permission a bloqué cette session — sans conséquence).

### Prod (appliqué DIRECTEMENT en base via canal psql, PAS via main)
Canal autorisé :
`PGPASSWORD="$(cat ~/fdm-pass.txt)" docker exec -i -e PGPASSWORD supabase_db_france-data-public psql "$(cat ~/fdm-conn.txt)" -c "<SQL>"`
- **Hotfix `rpps_in_radius` LIVE** : `DROP INDEX rpps_geog_gist` +
  `CREATE INDEX rpps_geog_precise_gist ON rpps USING GIST (geog) WHERE
  geom_source IN ('finess_join','ban_address')`. Vérifié : Paris 1 km / 10 km
  OK (l'outil était cassé en 57014 pour TOUS les users sur commune dense ;
  réparé).
- **Migration `20260519T160000` appliquée en prod** (`CREATE OR REPLACE
  FUNCTION ingest_create_rpps_staging` crée désormais le GiST PARTIEL, plus le
  global → le fix survit au prochain swap). Vérifié en prod.
- **Cache `geocoded_addresses`** : 266 049 `accepted=t` + 65 497 `accepted=f`.
  Intact, NE PAS TOUCHER. `rpps.geom_source='ban_address'` = **0** (jamais posé).
- `rpps` servie intacte : `commune_centroid` 1 268 852 / NULL 571 607 /
  `finess_join` 392 056 / `finess_unmatched` 7 116.

> **Divergence source↔runtime à connaître** : la prod (DB) a le fix
> `rpps_in_radius` ; `main` (repo) ne l'a PAS. Le cron lit la def de fonction
> EN BASE (migration appliquée), donc le runtime prod est sain quelle que soit
> la branche. C'est un écart de reproductibilité, pas un outage.

### Le run armé (#26087010166) — ce qu'il a prouvé
`gh workflow run ingest-rpps.yml --ref feat/rpps-ban-rearm -f force=true`.
- ✅ Le flag `force` **marche** : pas de skip `same_checksum`, run complet
  (2 239 631 lignes, enrichment FINESS OK, fix C anti-57014 OK).
- ❌ **Échec au step 5c** : `Failed to build rpps_staging BAN indexes:
  upstream request timeout`, `error_phase=validate`, **AVANT le swap** → `rpps`
  + cache intacts, `rpps_in_radius` non régressé. Le garde-fou fail-loud a
  fonctionné.

## 3. Cause-racine CASSURE — prouvée (prod + doc officielle)

Le step 5c `ingest_build_rpps_staging_ban_indexes` construit 2 index
fonctionnels Unicode-lourds sur `rpps_staging` (~2,24 M) via un **appel RPC
PostgREST synchrone (supabase-js)**. Or **Supabase plafonne tout appel Client
API / PostgREST à 60 s en dur** (doc officielle confirmée +
[GitHub discussions #21133](https://github.com/orgs/supabase/discussions/21133),
[#21015](https://github.com/orgs/supabase/discussions/21015),
[Timeouts doc](https://supabase.com/docs/guides/database/postgres/timeouts)),
**indépendamment** du `SET statement_timeout='10min'` de la fonction et du
`withTimeout` 15 min client. → `upstream request timeout`. Un `CREATE INDEX`
multi-minutes via supabase-js est **structurellement impossible**. Reco
officielle Supabase pour DDL longue : **connexion directe / Supavisor session,
JAMAIS le Client API**. La prémisse du plan
`docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md` (« step RPC
dédié post-enrichment suffit ») est **réfutée par la prod**.

## 4. Ce qui MARCHE — à sécuriser sur main (NON urgent)

`8b578f2` + `393b107` sont bons mais **développés par-dessus `6a2bbf3`** :
cherry-pick vers `main` **prouvé impossible** (conflits 5 fichiers ; dépend du
`latestFunctionBody` STRICT de `migration-sql.ts` qui n'existe QUE sur la
branche ; `main` n'a que la version lâche `latestFunctionBody(fnName)`).
→ Port = **reconstruction manuelle délibérée** sur une branche depuis `main` :
1. Migration `20260519T160000` (recopie verbatim — `20260518T140000` est sur
   main, lignée OK) + gotcha CLAUDE.md.
2. Levier `force` (`isForceReingestEnv` + param `force` de
   `shortCircuitIfSameChecksum` + input workflow + tests).
3. Test `staging-parity` ré-écrit P2 : soit l'adapter au `latestFunctionBody`
   lâche de main, soit porter aussi le STRICT (générique, sans logique BAN —
   le plus propre, à trancher dans l'analyse).
4. Chaîne discipline complète + `pnpm typecheck && lint && test:unit` verts →
   commits atomiques `git revert`-ables → PR.
**Non urgent** : prod runtime déjà sain (§2). Ne PAS bâcler sur main.

## 5. Ce qui NE marche PAS — la VRAIE solution `ban_join` (validée)

**Idée (validée doc Supabase + pattern prouvé en prod) :** une fois le cache
rempli (fait, 266 k), il devient **exactement comme FINESS : une table à
joindre**. Remplacer les steps 5c (build index lourd) + 5e (apply RPC) par
**un UPDATE ensembliste côté serveur** `rpps_staging` ⟕ `geocoded_addresses`
sur la clé d'adresse normalisée, **dans le pattern batched-RPC d'enrichment
qui marche déjà** (le même que `finess_join`, dans le budget 55 s/chunk du
fix C). L'unique index Unicode lourd vit alors **une seule fois** sur le petit
cache stable (`geocoded_addresses` ~332 k), construit par **migration via
canal direct** (= la reco officielle Supabase, payée 1× et non 12×/an).
→ Supprime la classe d'échec (plus de DDL lourde gateway-bound dans le cron),
reproduit un pattern déjà prouvé en prod (`finess_join`).

**Précondition à PROUVER en prod AVANT de designer** (ne pas inférer) :
- `rpps_address_key_for_index(adresse,code_postal,code_insee)` doit être
  `IMMUTABLE`.
- `geocoded_addresses` doit être indexé sur **exactement cette clé normalisée**
  (sinon la jointure full-scanne).
Vérifier : `\df+ rpps_address_key_for_index` (volatilité) + `\d
geocoded_addresses` (index sur la clé) + parité de la clé RPC↔cache↔jumeau
SQL/JS (gardée par `ban-eligibility-*-parity.test.ts`).

Périmètre éligible (prédicat source de vérité, byte-identique pipeline) :
`geom_source='commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL)`.
Couvre sans-FINESS ET FINESS-inexploitable (766 k + 528 k lignes). FINESS-
agnostique : se base sur l'état de géoloc, pas sur le FINESS.

## 6. À NE PAS FAIRE (anti-thrash, dead-ends prouvés)

- ❌ Re-builder les index BAN via RPC PostgREST (step 5c) — réfuté par la prod.
- ❌ Cherry-pick `8b578f2`/`393b107` sur main — conflits prouvés, intriqué.
- ❌ Merger `feat/rpps-ban-rearm` sur main (embarque le BAN cassé `6a2bbf3`).
- ❌ Toucher au cache `geocoded_addresses` (266 k, survit, NE PAS TOUCHER).
- ❌ Coder un fix sans l'avoir prouvé en prod / validé doc+forums (§GATE
  CLAUDE.md / skills-routing §6). Une inférence /review-validée reste une
  inférence.

## 7. Revert / restauration

- État complet récupérable : `git checkout wip/rpps-ban-rearm-2026-05-19` ou
  `origin/feat/rpps-ban-rearm` @ `393b107`.
- Annuler le hotfix prod `rpps_in_radius` (si jamais nécessaire) = inverse SQL :
  recréer `rpps_geog_gist` global + drop `rpps_geog_precise_gist` — mais NE PAS
  le faire (le hotfix est correct et prouvé).
- Migration `20260519T160000` : idempotente (`CREATE OR REPLACE`), rejouable.
