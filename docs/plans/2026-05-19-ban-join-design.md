# Spec — `ban_join` (refonte du dépôt BAN dans `rpps`)

> **Document de design autoportant.** Validé par Cyril (PO) le 2026-05-19.
> Préalable : `docs/plans/2026-05-19-HANDOFF-etat-et-suite.md` (état git/prod, dead-ends).
> Discipline : **prouver par la prod avant de coder** — ce spec est étayé par des
> mesures prod réelles (§3), pas des inférences.

## 1. But métier

Donner une géoloc **précise** (numéro/rue) aux PS du RPPS qui n'en ont pas.
Le cache `geocoded_addresses` (266 049 adresses acceptées) est **déjà rempli** —
le seul blocage des 4 derniers jours = **poser ces coordonnées dans `rpps`**.
`ban_join` fait ça en répliquant le pattern `finess_join` qui marche déjà en prod.

## 2. État prouvé (2026-05-19)

- Branche `feat/rpps-ban-rearm`, 4 commits devant `main` (cf. HANDOFF §2).
- Prod (mesuré cette session, canal psql autorisé par le PO) :
  | Métrique | Valeur |
  |---|---|
  | `rpps` total | 2 239 631 |
  | Éligibles BAN | **1 294 421** (centroïde 1 268 852 + geom NULL/adresse 25 569) |
  | Cache `accepted=true` | **266 049** |
  | `rpps.geom_source='ban_address'` | **0** (jamais posé) |
  | `geom` | `geometry(Point,4326)` |
- Préconditions §5 du HANDOFF **prouvées** :
  1. `rpps_address_key_for_index(adresse,code_postal,code_insee)` → `Volatility = immutable` ;
     délègue strictement à `rpps_normalize_address_key` (source de vérité unique) ;
     **même expression dans l'index ET dans `rpps_distinct_eligible_keys`**.
  2. `geocoded_addresses` : colonne `address_key text NOT NULL`, **PK B-tree
     `geocoded_addresses_pkey (address_key)`** → jointure sur index, pas de full-scan.
  3. Parité clé/prédicat : 22 tests verts (`ban-eligibility-index-expr-parity`,
     `ban-eligibility-predicate-parity`).

## 3. Décision de design — PROUVÉE par la prod + la doc

### 3.1 Pattern retenu : jumeau `finess_join` + **curseur keyset sur `id`**

`finess_join` (prod, fonctionne) :
```
ingest_apply_rpps_finess_enrichment_batch(p_limit) :
  CTE batch  : SELECT id FROM rpps_staging WHERE <pas traité> ORDER BY id LIMIT p_limit
  UPDATE ... LEFT JOIN finess ON num_finess
  sentinelle geom_source NULL→'finess_join'/'finess_unmatched' → row sort du lot suivant
  RETURNS row_count ; statement_timeout=55s ; piloté par runBatchedRpc
```

`ban_join` reproduit la mécanique **mais remplace la sentinelle par un curseur
keyset `id`** (différence load-bearing, cf. §3.2).

### 3.2 Pourquoi keyset et NON sentinelle — preuve prod

`EXPLAIN (ANALYZE,BUFFERS)` réels sur `rpps` (transaction ROLLBACK / read-only) :

| Approche | Position | Mesure 10 000 lignes |
|---|---|---|
| Keyset `id > 0` | début | **4,6 s** |
| Keyset `id > 2 014 889` (p90) | fin de parcours | **4,8 s** (constant) |
| Sentinelle pure (proxy `OFFSET 1.2M`) | fin de parcours | **`ERROR: canceling statement due to statement timeout`** (>120 s) |

- Jointure cache : `Index Scan using geocoded_addresses_pkey` à **0,18 ms × 10 000**
  — nested-loop indexé optimal (conforme doc CYBERTEC/Postgres Pro :
  *« Nested Loop Join is optimal when one table is small and has an index on the
  join key »*). **Aucun index fonctionnel lourd sur `rpps_staging` requis.**
- Scan du lot : `Index Scan using rpps_pkey` (ordre id, jamais seq scan).
- **Sentinelle pure (style FINESS) = re-scan quadratique du préfixe déjà traité
  → timeout 57014 en fin de parcours. RÉFUTÉ par la prod.**
- **Keyset = coût constant ~4,8 s/lot → ~130 lots ≈ ~10-11 min linéaires.
  PROUVÉ par la prod.**
- Coût d'écriture mesuré (~13 s/lot sur `rpps` servie) dû à la maintenance des
  index GiST de la table **servie** ; le cron écrit dans `rpps_staging`
  quasi-sans-index pendant l'enrichment (doctrine PostgreSQL « indexer après
  chargement », déjà appliquée par FINESS qui tient le budget 55 s). Coût
  différentiel `ban_join` vs `finess_join` à l'écriture sur staging = nul.

Sources doc : PostgreSQL « Populating a Database » / `sql-update` ; CYBERTEC
« Join strategies and performance » ; Supabase « Timeouts » & discussions
#21015/#21133 (cap passerelle 60 s — motive `statement_timeout` fonction < 60 s).

## 4. Périmètre exact (ce que la feature touche)

Cron RPPS (`scripts/ingest/rpps.ts`) :

| Step | Action |
|---|---|
| 5a ANALYZE staging | inchangé (fail-loud) |
| 5b enrichment FINESS | inchangé |
| **5c `ingest_build_rpps_staging_ban_indexes`** | **SUPPRIMÉ** (cause du blocage) |
| **5d re-ANALYZE** | **SUPPRIMÉ** (ne servait qu'aux index lourds) |
| **5e `runBanGeocodeStep` (géocodage API + apply)** | **REMPLACÉ** par `ban_join` |
| **5\* `ban_join` (nouveau)** | boucle keyset sur la nouvelle RPC |
| 6 swap / 6b rebuild matviews | inchangé |

Nouvelle migration SQL (canal psql manuel, naming `YYYYMMDDThhmmss` que la CLI
Supabase saute — cf. convention projet) :

```sql
CREATE OR REPLACE FUNCTION ingest_apply_rpps_ban_join_batch(
  p_after BIGINT, p_limit INT)
RETURNS BIGINT                       -- dernier id traité (curseur), NULL si page vide
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'        -- < 60 s cap passerelle (gotcha projet)
AS $$
DECLARE v_last_id BIGINT;
BEGIN
  WITH batch AS (
    SELECT id,
           rpps_address_key_for_index(adresse, code_postal, code_insee) AS akey
    FROM rpps_staging
    WHERE id > p_after
      AND (geom_source = 'commune_centroid'
           OR (geom IS NULL AND adresse IS NOT NULL))   -- BYTE-IDENTIQUE parité
    ORDER BY id
    LIMIT p_limit
  ),
  upd AS (
    UPDATE rpps_staging r
    SET geom = ST_SetSRID(ST_MakePoint(g.lon, g.lat), 4326),
        geom_source = 'ban_address'
    FROM batch b
    JOIN geocoded_addresses g
      ON g.address_key = b.akey AND g.accepted = true
    WHERE r.id = b.id
    RETURNING 1                       -- data-modifying wCTE : exécuté
  )                                   -- INCONDITIONNELLEMENT par PostgreSQL
  SELECT max(id), (SELECT count(*) FROM upd)   -- curseur + nb réellement posés
    INTO v_last_id, v_applied
  FROM batch;                         -- curseur = dernier id VU (matché ou non)
  RETURN v_last_id;                   -- NULL ⇒ page vide ⇒ fin de boucle
END;
$$;
```
> Forme de retour à trancher au plan : `RETURNS BIGINT` (curseur seul) +
> compteur de posés via log applicatif, **ou** `RETURNS TABLE(last_id BIGINT,
> applied INT)` (curseur + observabilité en un appel). `v_applied` ci-dessus
> matérialise le besoin du compteur §5 ; le wCTE `upd` est exécuté même
> non-référencé (règle PostgreSQL data-modifying CTE).

Notes load-bearing :
- **`JOIN` (pas `LEFT JOIN`) + pas de sentinelle** : une ligne non trouvée
  garde son `geom_source='commune_centroid'` (repli ~3 km conservé, filtré par
  le GiST partiel `rpps_in_radius`). La progression vient **uniquement du
  curseur `id`** → chaque ligne vue exactement 1 fois → linéaire.
- `v_last_id = max(id) du BATCH` (pas des seules lignes matchées) : sinon le
  curseur stagnerait sur une page sans aucun match → non-convergence.
- Prédicat d'éligibilité **byte-identique** à `ban-eligibility-predicate-parity`
  (garde-fou de parité — ne doit pas rougir).
- Expression `rpps_address_key_for_index(...)` évaluée uniquement sur les
  `p_limit` lignes retenues (au-dessus du `LIMIT`), jamais sur tout le scan.

Pilote TS (`scripts/ingest/rpps.ts`) : boucle keyset `p_after=0` → appeler →
`p_after = retour` → jusqu'à retour `NULL` (page vide). Borne anti-hang
`withTimeout` + `retryTransient` + garde de non-progression (si le retour
n'augmente pas → `IngestError`). Réutiliser le pattern keyset existant
(`rpps_distinct_eligible_keys` / `ban-backfill.mjs`) ; étendre `runBatchedRpc`
en variante keyset OU petite boucle dédiée (tranché au plan).

## 5. Robustesse / gestion d'erreurs

- Fail-loud : erreur SQL réelle → `IngestError("validate", …)` (jamais avalée),
  `rpps` + cache intacts (échec avant swap). Distinguer transitoire (retry) vs
  structurel (throw).
- Classe d'échec « 4 jours » supprimée structurellement : plus d'index lourd ni
  d'API dans le cron.
- Garde de convergence : curseur non croissant après N lots → `IngestError`
  (jamais de boucle infinie ; pas de hang silencieux — `withTimeout`).
- Sentinelles de cohérence (style FINESS) : 0 ligne posée alors que cache
  contient 266 k éligibles plausibles → suspicion dérive de clé → throw loud.
- Observabilité : log JSON 1 ligne (compteurs vus / posés / non-cachés /
  iterations), audit `ingest_log`.

## 6. Tests

- Parité (existants, ne doivent pas rougir) : `ban-eligibility-index-expr-parity`,
  `ban-eligibility-predicate-parity`, `staging-parity` (l'expression + le
  prédicat de la nouvelle RPC entrent dans le périmètre de parité).
- Unitaires : boucle keyset (page pleine / partielle / vide, curseur croissant,
  garde de non-progression, mapping erreurs transitoire vs structurel).
- Intégration (DB locale) : `ingest_apply_rpps_ban_join_batch` — cache hit pose
  `ban_address`+geom ; miss conserve `commune_centroid` ; convergence sur
  l'intégralité d'un jeu ; idempotence (2ᵉ passe = 0 nouvelle pose).
- Garde-fou : suppression de 5c/5d/5e ne casse aucun test de parité staging
  (adapter `staging-parity` si la RPC supprimée y était référencée).

## 7. Hors scope (explicite — décidé par le PO)

- `ban-backfill.mjs` : **inchangé**, manuel, hors scope.
- Automatisation du backfill : feature ultérieure dédiée.

## 8. Dette tracée (transparence, pas du scope)

- `ban-backfill.mjs` + `rpps_distinct_eligible_keys` + `rpps_count_ban_eligible_rows`
  s'appuient sur les **index BAN présents sur `rpps`**. Aujourd'hui `rpps` ne les
  a pas (le swap n'a jamais réussi avec). `ban_join` n'en dépend **pas** (c'est
  l'intérêt). Mais la future « automatisation backfill » devra résoudre la
  présence/reconstruction de ces index sur `rpps` (post-swap bloquant = dead-end
  connu, cf. HANDOFF §6). À documenter dans CLAUDE.md à la livraison.
- `ingest_build_rpps_staging_ban_indexes` devient orpheline (plus appelée par le
  cron). La conserver en base (le backfill futur pourra la réutiliser) mais
  retirer son câblage `rpps.ts` + adapter `staging-parity`/
  `enrichment-statement-timeout` tests.

## 9. Anti-thrash (dead-ends prouvés — NE PAS refaire)

- ❌ Re-builder les index BAN via RPC PostgREST dans le cron (réfuté prod, cap 60 s).
- ❌ Sentinelle pure style FINESS pour `ban_join` (réfuté prod §3.2, timeout 57014).
- ❌ `LEFT JOIN` + sentinelle `ban_unmatched` : la branche `geom IS NULL AND
  adresse IS NOT NULL` du prédicat ne dépend pas de `geom_source` → ne sortirait
  pas du périmètre → non-convergence. Le curseur keyset règle ça proprement.
- ❌ Toucher au cache `geocoded_addresses` (266 k, NE PAS TOUCHER).
- ❌ Coder un ajustement perf non prouvé par la prod (règle des 4 jours).
