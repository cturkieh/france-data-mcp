# Backfill BAN Ameli — cadrage

> **État** : code livré sur la branche `feat/ameli-ban-backfill` (migration + CLI +
> tests de parité, gate vert). **Non appliqué en prod, non mergé** (override
> CLAUDE.md : validation Cyril requise). Voir le runbook ops en fin de doc.

## 1. Problème (en simple)

Deux annuaires partagent un **même répertoire de coordonnées GPS** : le cache
`geocoded_addresses` (clé = adresse normalisée). Ce répertoire n'était rempli
que par `ban-backfill.mjs` **côté RPPS**. Les adresses **propres à Ameli** —
celles qu'aucun professionnel RPPS ne partage — n'avaient donc **aucun chemin de
géocodage** : le `ban_join` Ameli *consomme* le cache mais ne le *remplit* pas.

Conséquence mesurée en prod (run Ameli 2026-05-25, `ingest_log.ban_to_geocode_distinct`) :
**61 380 adresses distinctes Ameli** restaient au centroïde commune (~précision
ville), faute d'outil. C'est la dette « re-géocodage récurrent manuel » du CLAUDE.md.

## 2. Solution (en simple)

On apprend à l'outil de remplissage à lire **aussi** l'annuaire Ameli :
`node scripts/ban-backfill.mjs --source ameli`. Le cœur du script acceptait déjà
une `sourceTable` ; il manquait (a) les fonctions SQL côté Ameli, (b) le flag CLI,
(c) les garde-fous de parité. Le géocodage des ~61 k adresses se fait alors
exactement comme côté RPPS (idempotent, cache-only, ~77 % d'acceptation attendue).

## 3. Solution technique

### 3.1 Migration `20260601T000000_ameli_ban_backfill.sql` (3 objets SQL)

Réplication **1:1** du dispositif RPPS (durci par 3 post-mortems prod), transposée
à `annuaire_ameli` :

| Objet | Jumeau RPPS | Rôle |
|---|---|---|
| `ameli_count_ban_eligible_rows(text)` | `rpps_count_ban_eligible_rows` | backstop S-1 (count ≥ clés distinctes) |
| `ameli_distinct_eligible_keys(text,text,int)` | `rpps_distinct_eligible_keys` | énumération **skip-scan O(clés)** keyset |
| `ingest_build_ameli_staging_ban_indexes()` | `ingest_build_rpps_staging_ban_indexes` | pose les 2 index partiels post-chargement |

**Invariants load-bearing :**

- **Prédicat d'éligibilité Ameli = `geom_source = 'commune_centroid' AND adresse IS NOT NULL`**
  — *différent* du RPPS (`... OR (geom IS NULL AND adresse IS NOT NULL)`) : Ameli
  n'a pas de FINESS-join, son seul état non précis est le centroïde commune.
  Byte-identique à `ingest_apply_ameli_ban_join_batch` + `ameli_measure_ban_to_geocode`
  (sinon le count diverge du set posé → classe S-1). **C'est pourquoi des
  fonctions dédiées**, et non un arm du whitelist de `rpps_distinct_eligible_keys`
  (qui porte le prédicat RPPS).
- **Clé d'adresse via le wrapper `rpps_address_key_for_index(adresse,code_postal,code_insee)`**
  (générique 3-arg, IMMUTABLE avec `search_path` → non inliné → indexable),
  **byte-identique** à `rpps_normalize_address_key` qu'utilisent le ban_join + la
  mesure Ameli — **parité prouvée prod : 0 divergence / 5 000 adresses Ameli réelles**.
  Donc les clés énumérées+soumises matchent exactement celles que le ban_join
  cherche dans le cache partagé.
- **Index posés sur `annuaire_ameli_staging`, jamais dans la staging-create** :
  les y maintenir pendant les ~462 k INSERT de `streamCsvToStaging` = pénalité
  (analogue à l'AGGRAVANT 57014 RPPS). Ils voyagent vers `annuaire_ameli` via le
  RENAME du swap → ils n'apparaissent jamais comme `CREATE INDEX ON annuaire_ameli`
  → contournent le garde-fou `staging-parity.test.ts` (exactement comme le patron RPPS).

### 3.2 CLI `scripts/ban-backfill.mjs`

- Descripteur `SOURCES = { rpps, ameli }` (table LIVE + 2 RPC jumelles). La lecture
  cache (`rpps_geocoded_cache_lookup`) reste **partagée**.
- `runBanBackfill(supabase, { source })` résout les noms de RPC ; `source` inconnue → throw.
- Flag `--source rpps|ameli` (défaut `rpps`, back-compat total) ; valeur invalide → throw.

### 3.3 Tests (gate vert)

- `ban-backfill.test.ts` : +2 cas (routage Ameli prouvé par RPC names + cache-only ;
  source inconnue → throw). 19 tests verts.
- `ban-eligibility-ameli-parity.test.ts` (nouveau) : garde la parité **prédicat**
  (5 sites) + **expression de clé wrapper** (enum + 2 index), avec preuves
  positive/négative (suffix-narrow, forme RPPS copiée, jumeau nu, immunité prose).

## 4. Durabilité inter-swap — FOLLOW-UP tracé (non livré cette nuit)

Les index posés par `ingest_build_ameli_staging_ban_indexes()` ne survivent aux
swaps hebdo **que si le cron `ameli.ts` appelle cette RPC post-ban_join / pré-swap**
(jumeau du step 5c RPPS). Ce câblage **modifie le cron Ameli hebdo (sensible)** →
laissé en follow-up scruté (commit séparé / validation dédiée). Tant qu'il n'est
pas câblé, les index doivent être (re)créés sur la table LIVE avant chaque
drainage (runbook §5). Recommandation : step **best-effort warn** (le cron ne
*consomme* pas ces index — seul le backfill manuel le fait, et il échoue *loud*
si absents ; cohérent avec la philosophie warn-only du ban_join Ameli existant).

## 5. Runbook OPS (session validée — matin)

1. **Revue** : `git diff main...feat/ameli-ban-backfill` (+ ce doc).
2. **Appliquer la migration** : MCP `apply_migration({name:'ameli_ban_backfill', query:<SQL>})`.
3. **Amorcer les index sur la table LIVE** (one-time, car le cron n'a pas encore
   le step de build — CONCURRENTLY pour ne pas locker les lectures prod) :
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS ameli_staging_ban_eligible_normkey_idx
     ON annuaire_ameli (rpps_address_key_for_index(adresse, code_postal, code_insee))
     WHERE geom_source = 'commune_centroid' AND adresse IS NOT NULL;
   CREATE INDEX CONCURRENTLY IF NOT EXISTS ameli_staging_ban_eligible_normkey_id_idx
     ON annuaire_ameli (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
     WHERE geom_source = 'commune_centroid' AND adresse IS NOT NULL;
   ```
   *(noms `ameli_staging_*` même sur la table LIVE : ce sont les noms cibles
   post-swap ; côté LIVE on les crée à l'identique pour l'amorçage.)*
   ⚠️ vérifier le budget `statement_timeout` (CONCURRENTLY hors transaction).
4. **Canary** : `node scripts/ban-backfill.mjs --source ameli --max 1000` →
   vérifier le résumé DONE (~77 % accepted attendu, 0 api_failures anormal).
5. **Drainage complet** : `node scripts/ban-backfill.mjs --source ameli`
   (idempotent : un re-run reprend via le cache). Vérifier en prod :
   `SELECT count(*) FROM annuaire_ameli WHERE geom_source='commune_centroid' AND adresse IS NOT NULL;`
   décroît au prochain `ban_join` (cron hebdo), ET le cache `geocoded_addresses`
   gagne ~47 k entrées acceptées (61 380 × ~0,77).
6. **Décider** du follow-up §4 (câblage cron pour durabilité inter-swap).

## 6. Pourquoi cette approche (pistes écartées)

- *Arm du whitelist `rpps_distinct_eligible_keys`* → écarté : appliquerait le
  prédicat RPPS (`OR geom IS NULL`) à Ameli, divergeant du ban_join Ameli.
- *Index dans `ingest_create_annuaire_ameli_staging`* → écarté : maintenus pendant
  les 462 k INSERT (pénalité), et tripperait `staging-parity` ; le STEP de build
  dédié est le patron prouvé RPPS.
- *Géocodage SQL-side / autre seuil* → hors scope : on réutilise tel quel le client
  BAN + les seuils prouvés (`BAN_ACCEPT_SCORE=0.5`, types `housenumber/street/locality`).
