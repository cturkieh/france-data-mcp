# Chantier C — Géocodage Ameli (centroïde commune → adresse précise)

> Plan d'implémentation rédigé AVANT code (discipline « prouver par la prod »,
> cf. mémoire `prove-rootcause-by-prod`). Mesures prod du 2026-05-21 ci-dessous,
> reproductibles via `node dist/cadrage/measure.mjs` (script jetable).

## But métier

Les 4 tools Ameli (`professionnels_in_radius`, `professionnels_par_specialite_dept`,
`centres_sante_in_radius`, `centres_sante_by_finess`) servent aujourd'hui des
coordonnées au **centroïde commune** (~3 km de précision). À Paris ou en zone
dense, le tri par distance et la recherche par rayon court sont inutilisables —
même piège que côté RPPS pré-`ban_join` (V0.12).

Solution : géocoder à l'adresse précise via le cache BAN partagé avec RPPS,
pattern `ban_join` keyset déjà prouvé prod (1 065 291 RPPS posés run #13).
Le centroïde reste en repli quand l'adresse n'a pas de hit cache accepté.

## Mesures prod (2026-05-21)

| Mesure | Valeur |
|---|---|
| Total `annuaire_ameli` | **462 668 PS** |
| Géocodables (adresse + CP + INSEE non NULL) | **462 603 (100 %)** |
| Cache `geocoded_addresses` total | 331 546 entries |
| Cache accepted | 295 660 (89,2 %) |
| **Hit rate cache partagé sur échantillon Ameli (n=500)** | **32,6 % accepted direct** |
| Reste à backfiller via BAN | ~67 % = **~313 K adresses distinctes** |
| Backfill BAN à 100 req/s | ~52 min |

Plafond input : 100 % des PS Ameli ont les 3 segments de clé (adresse + CP + INSEE) →
zéro cas dégradé à gérer côté input ; le repli centroïde reste néanmoins
nécessaire pour les adresses non résolues par BAN.

Format adresse : Ameli et RPPS convergent largement après uppercase (top types
de voie partagés `RUE`/`AVENUE`/`BOULEVARD`/`ROUTE`/`CHEMIN`). Divergences
mineures sur `PL`/`PLACE` et abréviations historiques RPPS — le hit rate 33 %
est cohérent avec ce diagnostic (les ~67 % manquants sont les adresses
qu'aucun cycle RPPS n'a encore touché, pas une divergence de format
systémique).

## Décision — Option A (cache partagé)

| Critère | Option A (cache partagé) | Option B (cache dédié) |
|---|---|---|
| Migration | aucune (réutilise `geocoded_addresses`) | nouvelle table + index |
| Duplication données | 0 | min 295 K rows dupliquées |
| Hit gratuit J1 | **~150 K PS** | 0 |
| Croissance organique | oui (chaque cycle Ameli rempli renforce RPPS et vice-versa) | non (cache stagne) |
| Complexité code | faible (clone `ban_join` RPPS) | élevée (2 pipelines BAN parallèles) |

**Option A retenue, sans hésitation.**

Le nom `rpps_normalize_address_key` est historique mais la fonction est
**générique** : pure, prend `(adresse TEXT, code_postal TEXT, code_insee TEXT)`,
ne dépend de rien de RPPS. Le cache `geocoded_addresses` est aussi agnostique
de source par design (PK = `address_key`). Aucune raison de fragmenter.

> Renommage `rpps_normalize_address_key` → `address_normalize_key` : **HORS
> SCOPE**. C'est du code sous HARD GATE de parité octet-à-octet JS↔SQL
> (`scripts/ingest/ban-geocode-parity.integration.test.ts`). Tenter le
> renommage dans ce chantier = risque de panne totale silencieuse (1 octet
> de divergence ⇒ 0 ligne géocodée en rapportant succès). Le nom sera traité
> en dette P2 dédiée si jamais — pour l'instant les commentaires de migration
> Ameli documenteront « historiquement RPPS, sémantiquement générique ».

## Architecture cron Ameli (post-fix)

Séquence dans `scripts/ingest/ameli.ts` :

```
1. download CSV + lookup last checksum  (parallèle, comme aujourd'hui)
2. short-circuit si checksum identique
3. pre-validate (headers, taille, delimiter)
4. fetchAllCommunes + commune index    (comme aujourd'hui)
5. create staging + stream COPY → INSERT, geom_source='commune_centroid' posé d'office
6. validate coherence (MIN_ROWS / MAX_ROWS / structural / unmatched-locality)
7. ANALYZE staging                                                     ← NOUVEAU
8. ameli_measure_ban_to_geocode (best-effort)                          ← NOUVEAU
9. ban_join keyset cache → annuaire_ameli_staging                       ← NOUVEAU
10. atomic swap
11. rebuildAmeliMatviews
12. canary + ingest_log
```

Aucun appel BAN API dans le cron (cf. dead-end RPPS prouvé : `CREATE INDEX`
ou géocodage synchrone via PostgREST = cap 60 s structurel). Le cron
**applique seulement** le cache existant. Le re-remplissage du cache reste
manuel (`ban-backfill.mjs` adapté Ameli, hors cron) — même dette que RPPS,
même future feature « automatisation backfill ».

## Migrations (DDL)

### 1. Ajout colonnes geom_source + geog partiel sur `annuaire_ameli`

`supabase/migrations/YYYYMMDDTHHMMSS_ameli_geom_source.sql` :

```sql
ALTER TABLE annuaire_ameli
  ADD COLUMN IF NOT EXISTS geom_source TEXT
    CHECK (geom_source IN ('commune_centroid', 'ban_address'))
    DEFAULT 'commune_centroid';

-- Initialiser les rows existantes — toutes au centroïde aujourd'hui.
UPDATE annuaire_ameli
  SET geom_source = 'commune_centroid'
  WHERE geom_source IS NULL;

ALTER TABLE annuaire_ameli ALTER COLUMN geom_source SET NOT NULL;

-- GiST PARTIEL pour la branche "precise" des tools de radius
-- (jumeau exact de rpps_geog_precise_gist, gotcha CLAUDE.md prouvé prod)
CREATE INDEX IF NOT EXISTS annuaire_ameli_geog_precise_gist
  ON annuaire_ameli USING GIST (geog)
  WHERE geom_source = 'ban_address';
```

**Gotcha critique** : la migration doit aussi mettre à jour
`ingest_create_annuaire_ameli_staging` pour créer le même GiST partiel sur
`annuaire_ameli_staging` (sinon le swap reverte l'index — cf. gotcha CLAUDE.md
« staging-create doit mirrorer prod, partiel-à-partiel »).

### 2. RPC `ingest_apply_ameli_ban_join_batch(p_after, p_limit)`

Jumeau exact de `ingest_apply_rpps_ban_join_batch` (migration `20260519T180000`),
adapté à `annuaire_ameli_staging` :

```sql
CREATE OR REPLACE FUNCTION ingest_apply_ameli_ban_join_batch(
  p_after BIGINT,
  p_limit INT
) RETURNS TABLE(last_id BIGINT, applied INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_max_id BIGINT;
  v_applied INT;
BEGIN
  WITH eligible AS (
    SELECT s.id, g.lat, g.lon
    FROM annuaire_ameli_staging s
    JOIN geocoded_addresses g
      ON g.address_key = rpps_normalize_address_key(
           s.adresse, s.code_postal, s.code_insee)
    WHERE s.id > p_after
      AND g.accepted = true
      AND g.lat IS NOT NULL
      AND g.lon IS NOT NULL
      AND s.geom_source IS DISTINCT FROM 'ban_address'
    ORDER BY s.id
    LIMIT p_limit
  )
  UPDATE annuaire_ameli_staging s
  SET geom        = ST_SetSRID(ST_MakePoint(e.lon, e.lat), 4326),
      geom_source = 'ban_address'
  FROM eligible e
  WHERE s.id = e.id
  RETURNING s.id INTO v_max_id;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN QUERY SELECT v_max_id, v_applied;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_ameli_ban_join_batch(BIGINT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_apply_ameli_ban_join_batch(BIGINT, INT) TO service_role;
```

Différence avec RPPS : Ameli n'a **pas** d'éligibilité multi-source
(`finess_join`/`commune_centroid`) — il n'y a qu'un seul état non-précis
(`commune_centroid`). La clause WHERE est donc plus simple :
`s.geom_source IS DISTINCT FROM 'ban_address'` suffit (toutes les rows
non-géocodées sont au centroïde).

### 3. RPC `ameli_measure_ban_to_geocode` (mesure best-effort)

Jumeau de `rpps_measure_ban_to_geocode` (migration `20260520T000000`) :
compte adresses Ameli distinctes éligibles et celles non encore dans
`geocoded_addresses`. Logge le delta dans `ingest_log` pour décider Phase 2
(automatisation backfill) après 1-2 cycles.

### 4. Mise à jour `ingest_create_annuaire_ameli_staging`

Recopier **VERBATIM** la def actuelle (`20260508000018`) + ajouter :
- `geom_source TEXT NOT NULL DEFAULT 'commune_centroid' CHECK (...)`
- Index GiST partiel `WHERE geom_source = 'ban_address'`

Aligner sur le pattern « staging-create mirrore prod » garde-fou par
`staging-parity.test.ts` (étendre à `annuaire_ameli_staging` si pas déjà
couvert).

## Code TS (`scripts/ingest/ameli.ts`)

Ajouts après le step `5. VALIDATE COHERENCE` (avant l'atomic swap) :

```typescript
// 5b. ANALYZE staging (alimente le planner avant la jointure cache)
const { error: analyzeErr } = await supabase.rpc("ingest_analyze_ameli_staging");
if (analyzeErr) {
  throw new IngestError("validate", `ANALYZE failed: ${analyzeErr.message}`);
}

// 5c. Mesure best-effort delta cache (Phase 1 — sera lue après 1-2 cycles)
const { data: measure } = await supabase.rpc("ameli_measure_ban_to_geocode");
if (measure) {
  log.ban_eligible_distinct = measure.eligible_distinct;
  log.ban_to_geocode_distinct = measure.to_geocode_distinct;
}

// 5d. ban_join keyset cache → staging
const banResult = await runKeysetRpc({
  supabase,
  rpcName: "ingest_apply_ameli_ban_join_batch",
  pageSize: 50_000,
  logPrefix: "ameli ban_join",
  withTimeout: 90_000,
});
log.ban_join_applied = banResult.totalApplied;
console.log(`[ameli] ban_join: ${banResult.totalApplied} rows passed to ban_address`);
```

`runKeysetRpc` existe déjà dans `scripts/ingest/shared.ts` — clone direct
du chemin RPPS.

## Backfill initial (hors cron, manuel)

Une fois après merge :
1. Adapter `ban-backfill.mjs` pour énumérer aussi les adresses Ameli
   distinctes manquantes (ou écrire `ban-backfill-ameli.mjs` clone).
2. Lancer en local avec `BAN_API_KEY` (cap 100 req/s) — ~52 min pour 313 K
   adresses, possiblement moins avec hits partiels.
3. Le cache se remplit ; le prochain cron Ameli pose à 80-90 % au lieu de 33 %.

À ne PAS faire dans ce chantier : automatiser le backfill au cron
(dead-end connu, `ban-backfill.mjs` dépend des index BAN sur table prod,
post-swap bloquant). Cohérent avec la dette RPPS tracée.

## Acceptance prod

Critères de succès post-déploiement (mesures sur prod après cron #1) :

1. `SELECT count(*) FROM annuaire_ameli WHERE geom_source = 'ban_address'`
   → **≥ 100 K** (hit rate ≥ 30 % avant backfill, ≥ 80 % après backfill)
2. `professionnels_in_radius` à Paris 500 m, profession=`10` (médecin) :
   - distances variées, pas toutes au centroïde ~3 km
   - `geo_precision='adresse'` dominant (à exposer dans le résultat tool)
3. EXPLAIN ANALYZE BUFFERS `professionnels_in_radius` Neuilly 2 km :
   - branche precise utilise `annuaire_ameli_geog_precise_gist`
   - temps total < 200 ms (pattern V0.13.3 RPPS post-KNN GiST)
4. Cron complet < 65 min (vs ~55 min RPPS aujourd'hui sur ~2,23 M rows)
5. `ingest_log` montre `forced=false`, `status='success'`, `ban_join_applied`
   non NULL et cohérent avec `ban_eligible_distinct - ban_to_geocode_distinct`

## Risques identifiés

| Risque | Mitigation |
|---|---|
| Format adresse Ameli ≠ RPPS (abréviations, complément type `MAISON SANTE`) | Mesuré : hit rate 33 % cohérent ; backfill BAN sur le reste résout |
| Index `annuaire_ameli_geog_precise_gist` jamais créé sur staging-create | Garde-fou `staging-parity.test.ts` étendu |
| Régression staging.geom_source (commit/ALTER perdu au swap) | Test `ameli-staging-parity` (clone RPPS) |
| Cap PostgREST 60 s sur `ingest_apply_ameli_ban_join_batch` | `SET statement_timeout='55s'` au niveau RPC + cap loop côté JS 90 s |
| Pipeline Ameli hebdo (vs mensuel RPPS) → maintenance index plus fréquente | Mesurer cron #1 et #2, ajuster si > 65 min ; le GiST partiel est petit (~150 K rows post-backfill) |
| Faux match cache : une clé byte-identique RPPS↔Ameli mais l'adresse réelle diffère | Impossible par construction : clé = `normalize(adresse|CP|INSEE)` ; une collision exigerait que 2 PS aient EXACTEMENT la même adresse texte + CP + INSEE après normalisation, ce qui signifie qu'ils sont au même endroit — la coord cache est correcte |

## Garde-fous tests (à écrire)

- `scripts/ingest/ameli-ban-join.integration.test.ts` (jumeau du test RPPS,
  HIT/MISS/non-éligible/idempotence sur DB locale)
- Étendre `scripts/ingest/staging-parity.test.ts` à `annuaire_ameli_staging`
  (GiST partiel, geom_source CHECK, NOT NULL)
- `ameli-statement-timeout.test.ts` : assert que `ingest_apply_ameli_ban_join_batch`
  porte `SET statement_timeout='55s'`
- Garde de parité expression entre `ingest_apply_ameli_ban_join_batch` et
  l'index `annuaire_ameli_geog_precise_gist` (forme partielle byte-identique)

## Ordre de PR proposé

Une seule PR cohérente, branche `feat/ameli-ban-join`, livrable en 1-2 sessions :

1. Migration `ameli_geom_source` (colonne + GiST partiel)
2. Migration `ingest_apply_ameli_ban_join_batch` + `ameli_measure_ban_to_geocode`
3. Migration `ingest_create_annuaire_ameli_staging` (recopie + ajout colonne/index)
4. Modif `scripts/ingest/ameli.ts` (steps 5b-5d)
5. Tests intégration + parity
6. Modif tools MCP pour exposer `geo_precision` ('adresse' vs 'commune')
   sur les 4 tools Ameli

Le backfill manuel sera fait après merge, avant le 1er cron hebdo, pour
viser un hit rate immédiat > 80 % au lieu de 33 %.

## Dette tracée

- Automatisation backfill BAN pour cycles Ameli/RPPS futurs : même future
  feature que RPPS, conditionnée chiffre prod via les RPC `*_measure_ban_to_geocode`.
- Renommage `rpps_normalize_address_key` → `address_normalize_key` :
  dette cosmétique, à traiter avec un PR dédié hors feature (HARD GATE
  parité à préserver).
