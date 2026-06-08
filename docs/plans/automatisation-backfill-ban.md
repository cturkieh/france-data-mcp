# Automatisation backfill BAN (RPPS + Ameli) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supprimer la corvée manuelle hebdomadaire du backfill BAN Ameli en lui donnant le même « bouton GitHub » qu'RPPS (étape 1), puis rendre les deux entièrement automatiques après chaque ingestion (étape 2).

**Architecture:** Le backfill Ameli échoue aujourd'hui sans une recréation d'index manuelle parce qu'il énumère les adresses à géocoder **par la clé d'adresse** (exige un index BAN sur la table live, orphéliné à chaque swap). RPPS a résolu exactement ce problème en énumérant **par la PK `id`** (toujours indexée, aucun index BAN requis) via `rpps_eligible_rows_after_id`. L'étape 1 réplique ce pattern prouvé pour Ameli ; l'étape 2 bascule le déclencheur de manuel (`workflow_dispatch`) à automatique (`workflow_run` après l'ingestion).

**Tech Stack:** PostgreSQL/PostGIS (Supabase), plpgsql `SECURITY DEFINER`, RPC PostgREST keyset, Node/tsx (`scripts/ban-backfill.mjs`), GitHub Actions, vitest (garde-fous SQL sans DB).

---

## Contexte (cause-racine prouvée)

- **RPPS** (mensuel) : bouton manuel `ban-backfill-rpps.yml` → `scripts/ban-backfill.mjs --source rpps`. Énumère via `rpps_eligible_rows_after_id` (keyset `id`). **Aucun index BAN requis.** ✅
- **Ameli** (hebdo) : 100 % manuel. Énumère via `ameli_distinct_eligible_keys` (keyset sur `address_key`) → **exige `ameli_staging_ban_eligible_normkey*` sur la table live**. Or le swap atomique du cron renomme `annuaire_ameli` → `_previous` : **l'index est orphéliné à chaque ingestion** (vécu prod 2026-06-01 ET 2026-06-08). Sans recréation manuelle (DROP orphelins + CREATE sur la live), `ameli_distinct_eligible_keys` seq-scanne → timeout 50 s.
- 2 dead-ends déjà prouvés prod (cf. `20260605T150000_rpps_eligible_rows_after_id_keyset.sql`) : (a) construire l'index via RPC PostgREST = cap passerelle 60 s ; (b) passe unique DISTINCT sur la clé Unicode = ~880 µs × N lignes > 55 s. **Le keyset `id` est la seule solution validée.**
- `annuaire_ameli` a une PK `annuaire_ameli_pkey` sur `id bigint` (vérifié prod) → le keyset `id` est applicable tel quel.

## File structure

| Fichier | Action | Responsabilité |
|---|---|---|
| `supabase/migrations/<ts>_ameli_eligible_rows_after_id_keyset.sql` | Create | RPC `ameli_eligible_rows_after_id` (keyset `id`, prédicat Ameli) |
| `scripts/ingest/ameli-eligible-rows-after-id.test.ts` | Create | Garde-fou parité prédicat/clé/keyset de la nouvelle RPC (jumeau du test RPPS) |
| `scripts/ban-backfill.mjs:135-146` | Modify | `SOURCES.ameli` → énumère par `id` (nouvelle RPC) |
| `.github/workflows/ban-backfill-ameli.yml` | Create | Bouton manuel drain Ameli (jumeau de `ban-backfill-rpps.yml`) |
| `CHANGELOG.md` | Modify | Trace du changement |

**Hors scope étape 1 (dette tolérée, documentée)** : `ameli_distinct_eligible_keys`, `ingest_build_ameli_staging_ban_indexes` et les 2 index live restent en base mais ne sont **plus sur le chemin critique** du backfill. Leur retrait = nettoyage séparé (risque sur `ban-eligibility-ameli-parity.test.ts`), traité en étape 1bis si souhaité.

---

## ÉTAPE 1 — Bouton GitHub Ameli (réplique RPPS)

### Task 1 : RPC `ameli_eligible_rows_after_id` (keyset id)

**Files:**
- Create: `supabase/migrations/<ts>_ameli_eligible_rows_after_id_keyset.sql`

- [ ] **Step 1 : Écrire la migration** (jumeau exact de `rpps_eligible_rows_after_id`, avec whitelist + prédicat **Ameli**)

```sql
-- Énumération KEYSET SUR id (PK) des lignes éligibles BAN d'Ameli — jumeau de
-- rpps_eligible_rows_after_id. AUCUN index BAN requis (la PK suffit). Remplace
-- ameli_distinct_eligible_keys (keyset sur la clé → exigeait un index live
-- orphéliné au swap) comme énumération du bouton drain Ameli.
-- Prédicat Ameli = `geom_source='commune_centroid' AND adresse IS NOT NULL`
-- (PAS la branche `OR (geom IS NULL ...)` de RPPS — Ameli n'a pas de FINESS-join).
CREATE OR REPLACE FUNCTION ameli_eligible_rows_after_id(
  p_source_table TEXT DEFAULT 'annuaire_ameli',
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
    WHEN 'annuaire_ameli'         THEN 'annuaire_ameli'
    WHEN 'annuaire_ameli_staging' THEN 'annuaire_ameli_staging'
    ELSE NULL
  END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'ameli_eligible_rows_after_id: invalid source_table %, expected ''annuaire_ameli'' | ''annuaire_ameli_staging''',
      p_source_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'ameli_eligible_rows_after_id: p_limit must be >= 1 (got %)', p_limit
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT t.id,
           rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) AS address_key,
           t.adresse::text, t.code_postal::text, t.code_insee::text
    FROM %I t
    WHERE (t.geom_source = 'commune_centroid' AND t.adresse IS NOT NULL)
      AND t.id > $1
    ORDER BY t.id
    LIMIT $2
  $q$, v_source) USING p_after_id, p_limit;
END;
$$;

COMMENT ON FUNCTION ameli_eligible_rows_after_id(TEXT, BIGINT, INT) IS
  'Énumération KEYSET SUR id (PK) des lignes éligibles BAN Ameli (annuaire_ameli | annuaire_ameli_staging) — jumeau de rpps_eligible_rows_after_id. Prédicat Ameli geom_source=commune_centroid AND adresse IS NOT NULL. Aucun index BAN requis (PK). Consommée par ban-backfill.mjs --source ameli (bouton drain). Gardé par ameli-eligible-rows-after-id.test.ts.';

REVOKE EXECUTE ON FUNCTION ameli_eligible_rows_after_id(TEXT, BIGINT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ameli_eligible_rows_after_id(TEXT, BIGINT, INT) TO service_role;
```

- [ ] **Step 2 : Appliquer en prod via MCP** `mcp__supabase_france_data__apply_migration({name:'ameli_eligible_rows_after_id_keyset', query:<SQL ci-dessus>})` (canal validé V0.20). Le fichier dans `supabase/migrations/` reste requis pour que les garde-fous SQL (`allMigrationsSql()`) le voient.

- [ ] **Step 3 : Tester la RPC en prod via MCP** `execute_sql` :

```sql
-- a) signature + 1ère page rapide (doit être < quelques secondes, pas 50 s)
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM ameli_eligible_rows_after_id('annuaire_ameli', 0, 1000);
-- b) cohérence keyset : la 2e page reprend après le dernier id de la 1ère
-- c) edge: p_limit=0 → EXCEPTION 22023 ; source hors whitelist → EXCEPTION 22023
SELECT * FROM ameli_eligible_rows_after_id('annuaire_ameli', 0, 0);          -- attendu: erreur
SELECT * FROM ameli_eligible_rows_after_id('pg_class', 0, 10);               -- attendu: erreur
```
Expected : (a) `Index Scan using annuaire_ameli_pkey`, pas de seq-scan ; (b)/(c) conformes.

### Task 2 : Garde-fou SQL `ameli-eligible-rows-after-id.test.ts`

**Files:**
- Create: `scripts/ingest/ameli-eligible-rows-after-id.test.ts`
- Test: `pnpm vitest run scripts/ingest/ameli-eligible-rows-after-id.test.ts`

- [ ] **Step 1 : Écrire le test** (jumeau de `rpps-eligible-rows-after-id.test.ts`, prédicat **Ameli**)

```ts
import { describe, expect, it } from "vitest";
import { allMigrationsSql, latestFunctionBodyLoose } from "./migration-sql.js";

// Garde-fou de la RPC d'énumération KEYSET SUR id `ameli_eligible_rows_after_id`
// (consommée par ban-backfill.mjs --source ameli). Jumeau du guard RPPS, prédicat
// AMELI (`geom_source='commune_centroid' AND adresse IS NOT NULL`, sans branche geom NULL).
describe("ameli_eligible_rows_after_id : RPC keyset id (bouton drain Ameli)", () => {
  const body = latestFunctionBodyLoose("ameli_eligible_rows_after_id");
  const norm = body.toLowerCase().replace(/\s+/g, " ");

  it("présente dans les migrations", () => {
    expect(body.length, "ameli_eligible_rows_after_id introuvable").toBeGreaterThan(0);
  });

  it("calcule la clé via le wrapper rpps_address_key_for_index", () => {
    expect(norm, "n'utilise PAS le wrapper → clés divergentes du cache").toContain(
      "rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)",
    );
  });

  it("prédicat d'éligibilité AMELI byte-identique au canonique (sans branche geom NULL)", () => {
    expect(
      norm,
      "prédicat divergent du canonique Ameli → énumère un set != du count (backstop S-1 faussé)",
    ).toContain("where (t.geom_source = 'commune_centroid' and t.adresse is not null)");
    expect(norm, "ne doit PAS contenir la branche RPPS geom IS NULL").not.toContain("geom is null");
  });

  it("keyset SUR id : id > $1 ... ORDER BY id LIMIT (curseur PK)", () => {
    expect(norm, "pas de borne keyset `id > $1`").toContain("t.id > $1");
    expect(norm, "pas d'ORDER BY id").toContain("order by t.id");
    expect(norm, "pas de LIMIT $2").toContain("limit $2");
    expect(
      norm,
      "ORDER BY sur la clé Unicode → réévaluation = 57014 (dead-end)",
    ).not.toMatch(/order by[^;]*rpps_address_key_for_index/);
  });

  it("whitelist source explicite (annuaire_ameli | annuaire_ameli_staging)", () => {
    expect(norm).toContain("when 'annuaire_ameli' then 'annuaire_ameli'");
    expect(norm).toContain("when 'annuaire_ameli_staging' then 'annuaire_ameli_staging'");
    expect(norm, "pas d'EXCEPTION sur source hors whitelist").toContain("raise exception");
  });

  it("le drift guard reste ancré sur les migrations réelles", () => {
    expect(allMigrationsSql()).toContain("ameli_eligible_rows_after_id");
  });
});
```

- [ ] **Step 2 : Run** `pnpm vitest run scripts/ingest/ameli-eligible-rows-after-id.test.ts` → Expected : PASS (la migration Task 1 est dans le repo).

### Task 3 : Basculer `SOURCES.ameli` vers le keyset id

**Files:**
- Modify: `scripts/ban-backfill.mjs:135-146`

- [ ] **Step 1 : Remplacer le descripteur** `SOURCES.ameli`

```js
  ameli: {
    table: "annuaire_ameli",
    // Énumération KEYSET SUR id (PK) — jumeau RPPS, AUCUN index BAN requis sur la
    // table live (résout la corvée de recréation d'index orphéliné au swap, cf.
    // docs/plans/automatisation-backfill-ban.md). Curseur = `id`.
    enumRpc: "ameli_eligible_rows_after_id",
    cursorParam: "p_after_id",
    cursorField: "id",
    cursorInit: 0,
    countRpc: "ameli_count_ban_eligible_rows",
  },
```

- [ ] **Step 2 : Vérifier les garde-fous structurels du module** (la boucle de validation `SOURCES` au chargement exige `cursorInit ∈ {0, null}` — `0` est conforme). Run : `pnpm vitest run scripts/ban-backfill.test.ts` (si présent) → Expected : PASS.

- [ ] **Step 3 : `pnpm typecheck && pnpm lint`** → Expected : 0 erreur.

### Task 4 : Workflow `ban-backfill-ameli.yml`

**Files:**
- Create: `.github/workflows/ban-backfill-ameli.yml`

- [ ] **Step 1 : Écrire le workflow** (jumeau de `ban-backfill-rpps.yml` — différences : titre, `--source ameli`, `concurrency.group: ingest-ameli`)

```yaml
# Bouton MANUEL « drain BAN Ameli » — géocode le résidu d'adresses éligibles non
# encore en cache (geocoded_addresses) et REMPLIT le cache. Les coords sont POSÉES
# dans annuaire_ameli au prochain cron Ameli via ban_join.
#
# Énumération ROBUSTE : keyset SUR id (PK) via ameli_eligible_rows_after_id —
# AUCUN index BAN à construire (cf. docs/plans/automatisation-backfill-ban.md).
name: Backfill BAN Ameli (manuel)

on:
  workflow_dispatch:
    inputs:
      max:
        description: "Nb max de NOUVELLES adresses géocodées ce run (canari, ex. 1000). Vide = drainage complet."
        type: string
        required: false
        default: ""

permissions:
  contents: read

# JAMAIS concurrent du cron Ameli : son swap atomique renommerait annuaire_ameli
# en pleine énumération keyset. Même groupe que ingest-ameli.yml → sérialisés.
concurrency:
  group: ingest-ameli
  cancel-in-progress: false

jobs:
  backfill:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Validate required secrets present
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: |
          missing=()
          [ -z "$SUPABASE_URL" ] && missing+=("SUPABASE_URL")
          [ -z "$SUPABASE_SERVICE_ROLE_KEY" ] && missing+=("SUPABASE_SERVICE_ROLE_KEY")
          if [ ${#missing[@]} -gt 0 ]; then
            echo "::error::Secrets manquants: ${missing[*]}"
            exit 1
          fi

      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 9.12.0
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Drain BAN Ameli (géocode le résidu → remplit le cache)
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          MAX: ${{ inputs.max }}
        run: |
          if [ -n "$MAX" ]; then
            echo "Canari : $MAX adresses max"
            pnpm exec tsx scripts/ban-backfill.mjs --source ameli --max "$MAX"
          else
            echo "Drainage complet"
            pnpm exec tsx scripts/ban-backfill.mjs --source ameli
          fi
```

### Task 5 : Validation prod (via le bouton) + commit

- [ ] **Step 1 : Canari via le bouton** — Actions → « Backfill BAN Ameli (manuel) » → Run avec `max=1000`. Vérifier le log : énumération qui ne timeoute pas, `DONE` avec ~80 % accepted, 0 api_failure anormal. **Preuve que le bouton fonctionne SANS recréation d'index manuelle préalable.**
- [ ] **Step 2 : Drain complet via le bouton** (`max` vide). Vérifier `not_in_cache = 0` côté DB (query de vérif du runbook).
- [ ] **Step 3 : Commit** (`feat(ameli): bouton drain BAN keyset id — supprime la corvée d'index orphéliné`) + CHANGELOG. PR pour validation Cyril (override santé : pas de merge auto).

---

## ÉTAPE 2 — Zéro-clic (déclenchement automatique) — ✅ LIVRÉE

**Objectif :** plus de bouton à presser ; le drain part tout seul après chaque ingestion (RPPS **et** Ameli).

**Design retenu (préféré) : `workflow_run` chaîné.** Chaque cron d'ingestion (`ingest-ameli.yml`, `ingest-rpps.yml`) déclenche, à sa **complétion réussie**, le workflow de backfill correspondant via `on: workflow_run: { workflows: ["Ingestion Ameli"], types: [completed] }` + garde `if: github.event.workflow_run.conclusion == 'success'`. Le `concurrency.group` partagé (`ingest-ameli` / `ingest-rpps`) garantit déjà la sérialisation post-swap.

**Pourquoi pas un step chaîné dans le workflow d'ingestion lui-même :** garderait l'ingestion (sensible) couplée au géocodage (best-effort) dans un seul run → un échec BAN ferait rougir le cron d'ingestion. `workflow_run` découple : l'ingestion reste verte, le backfill a son propre statut.

**Rappel important du décalage (déjà acté) :** remplir le cache juste après l'ingestion N **n'applique pas** les coords à la table courante ; elles sont posées à l'ingestion N+1 via `ban_join`. L'automatisation supprime le clic, **pas** le décalage d'une passe. Réduire le décalage à zéro = sujet distinct (forcer une ré-application post-backfill), volontairement hors scope.

**Tasks (esquisse, à étoffer en plan dédié) :** (1) ajouter le bloc `workflow_run` aux 2 workflows de backfill ; (2) retirer/garder `workflow_dispatch` en parallèle (garder = bouton de secours) ; (3) vérifier les noms exacts des workflows déclencheurs ; (4) observer 1 cycle réel de chaque source.

---

## Risques & garde-fous

| Risque | Mitigation |
|---|---|
| Divergence prédicat Ameli vs canonique (backstop S-1 faussé) | Garde-fou Task 2 + `ban-eligibility-ameli-parity.test.ts` existant |
| Migration appliquée en prod mais fichier absent du repo → tests SQL aveugles | Step 2 Task 1 : fichier `supabase/migrations/` **obligatoire** en plus de l'apply MCP |
| Drain concurrent du cron (swap en plein keyset) | `concurrency.group: ingest-ameli` (Task 4) |
| Régression silencieuse sur pipeline santé | Override CLAUDE.md : PR validée par Cyril, jamais de merge auto |

## Méthodologie d'évaluation (preuve que ça marche)

1. **Garde-fou vert** : `pnpm vitest run scripts/ingest/ameli-eligible-rows-after-id.test.ts` + suite parité existante.
2. **Prod, sans index manuel** : lancer le bouton Ameli `max=1000` **sans avoir recréé d'index au préalable** → si le canari draine sans timeout, la cause-racine est éliminée (c'est LE critère de succès de l'étape 1).
3. **Cohérence cache** : `not_in_cache = 0` après drain complet (query runbook).
4. **Non-régression** : `pnpm test:unit` + CI verte (2 tsconfigs + biome + Supabase local).

## Self-review (effectuée)

- **Couverture spec** : étape 1 (bouton Ameli) entièrement décomposée ; étape 2 (zéro-clic) cadrée en design + esquisse de tasks (volontairement non détaillée — « plus tard » côté Cyril). ✅
- **Placeholders** : aucun — code SQL/TS/YAML complet à chaque step. ✅
- **Cohérence des noms** : `ameli_eligible_rows_after_id` (RPC), `p_after_id`/`id` (curseur), `ameli-eligible-rows-after-id.test.ts` (test) cohérents entre Task 1/2/3. ✅
