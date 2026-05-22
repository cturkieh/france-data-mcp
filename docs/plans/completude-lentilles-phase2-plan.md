# Plan d'implémentation Phase 2 — Couche d'activités hébergées (juxtaposition)

> **Pour les workers agentiques :** SOUS-SKILL REQUIS — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour exécuter ce plan tâche par tâche. Les
> étapes utilisent la syntaxe checkbox (`- [ ]`).

**Goal :** Exposer dans la sortie des tools de comptage filtrés par famille
(labo / pharmacie / imagerie) un **second compte juxtaposé** des sites
hébergeant l'activité correspondante sous une autre catégorie FINESS, sans
jamais mélanger les deux comptes. Doctrine : le MCP juxtapose, le LLM décide.

**Architecture :** Une matview `finess_hosted_activities` (`num_finess → activités[]`)
est calculée par jointure RPPS×FINESS au cron RPPS ET au cron FINESS (rebuild
post-swap façon OID, jamais REFRESH). 2 RPCs de lookup (radius / zone admin)
exposent des comptes par activité dans une zone. Côté tools, un champ
**additionnel** `activite_hebergee` est ajouté aux 5 tools de comptage FINESS
quand la famille filtrée est mappable (labo/pharmacie/imagerie) — pas de
`UNION`, pas de flag binaire, pas de modification de `count` principal.

**Tech Stack :** PostgreSQL/PostGIS (matview + RPC), Supabase migrations,
TypeScript strict (lib `src/sante/` + endpoint `api/tools.ts`), Vitest, Biome.

**Réf :**
- Cadrage : `docs/plans/completude-lentilles-sources.md` §6.1 (Route A)
- Mesure : `docs/plans/completude-lentilles-phase2-mesure.md` (seuils + faux positifs validés prod)
- Phase 1 : `docs/plans/completude-lentilles-plan.md` (le `perimetre` jumeau)

---

## Prérequis

- **V0.17.0 (Phase 1) doit être releasée et mergée sur `main` AVANT exécution.**
  Phase 2 démarre sur une nouvelle branche `feat/completude-lentilles-phase2`
  partant de `main` post-release. Le champ `activite_hebergee` complète le
  champ `perimetre` de Phase 1 — il en dépend en cohérence (la `completeness_note`
  du `perimetre` mentionne implicitement la couche dérivée).

## Décisions produit figées

| Famille filtrée | Activité hébergée exposée | Filtre RPPS (activité) | Filtre FINESS (excluse de la couche) |
|---|---|---|---|
| `labo` | « biologie médicale » | `savoir_faire ILIKE 'Biologie médicale%'` OR `ILIKE 'Anatomie et cytologie%'` OR `profession = 'Technicien de Laboratoire'` | `610`/`611`/`612` (les labos eux-mêmes) |
| `pharmacie` | « pharmacie à usage intérieur » | `profession = 'Pharmacien'` | `620`/`627`/`628`/`629` (officines) + `300`/`330` (écoles, faux positifs prouvés) + `610`/`611`/`612`/`132` (labos & EFS = pharmaciens biologistes) |
| `imagerie` | « imagerie médicale » | `profession = 'Manipulateur ERM'` OR `savoir_faire ILIKE 'Radio-diagnostic%'` OR `ILIKE 'Radiologie et imagerie%'` | `619` (cabinets imagerie, vide en pratique) |

**Seuil N = 3** pour les 3 activités (calibré par la mesure §3 du rapport, FP ≤ 8 %).

EFS (catégorie `132`) est inclus dans **biologie** (validé Cyril) — la
qualification biologique du don est une activité biologique légitime.

Phrases (`note`) lues par le LLM caller — finalisées dans la conversation de
cadrage, **interdire l'addition sans précision** :

- **biologie** : « Plateaux techniques de biologie hébergés dans des hôpitaux, CLCC ou centres de transfusion sanguine (EFS) — activité analytique sans accès patient ambulatoire (distincte des laboratoires autonomes du compte principal). Ne pas additionner les deux comptes sans préciser leur nature. »
- **pharmacie** : « Pharmacies hospitalières (PUI) desservant les patients hospitalisés en interne — pas d'accès grand public (distinctes des officines du compte principal). Ne pas additionner les deux comptes sans préciser leur nature. »
- **imagerie** : « Sites d'imagerie (radiologie, scanner, IRM) en cliniques ou hôpitaux, accessibles au public en ambulatoire. La catégorie FINESS « cabinet d'imagerie » étant peu peuplée en pratique, ce compte représente l'essentiel de l'offre territoriale d'imagerie. »

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `supabase/migrations/YYYYMMDDTHHMMSS_finess_hosted_activities.sql` | Matview + RPCs + rebuild | **Créer** |
| `scripts/ingest/rpps.ts` | Hook rebuild post-swap RPPS | Modifier (~ligne 556) |
| `scripts/ingest/finess.ts` | Hook rebuild post-swap FINESS | Modifier |
| `src/sante/hosted-activities.ts` | Module lib (types + fetchers + notes) | **Créer** |
| `src/sante/hosted-activities.test.ts` | Tests unitaires lib | **Créer** |
| `api/tools.ts` | Wire `activite_hebergee` dans 5 handlers + output schema | Modifier |
| `api/tools.test.ts` | Tests handler-level (vi.spyOn pattern) | Modifier |
| `CHANGELOG.md` · `CLAUDE.md` | Docs convention | Modifier |
| `package.json` · `server.json` · `src/core/version.ts` | Version bump 0.17.0 → 0.18.0 | Modifier |

**Note infra** : la matview joint `rpps` (swap mensuel) ET `finess` (swap bimestriel).
Elle DOIT donc être REBUILT (jamais REFRESH) post-swap de chacune des deux
sources — pattern OID rebuild de `CLAUDE.md` (cf. `ingest_rebuild_rpps_matviews`).

---

## Task 1 : Migration SQL — matview + RPCs + rebuild

**Files:**
- Create: `supabase/migrations/YYYYMMDDTHHMMSS_finess_hosted_activities.sql` (timestamp = `date +%Y%m%dT%H%M%S` au moment de la migration)
- Test: `scripts/ingest/finess-hosted-activities-rebuild.test.ts` (garde-fou OID rebuild)

Pattern de rebuild post-swap : voir `supabase/migrations/20260518T150000_rebuild_rpps_matviews_postswap.sql` (jumeau exact à reproduire pour cette nouvelle matview). Pattern de SQL pour mesurer : voir `docs/plans/completude-lentilles-phase2-mesure.md` annexe A.

- [ ] **Step 1 : Écrire la migration SQL**

```sql
-- supabase/migrations/YYYYMMDDTHHMMSS_finess_hosted_activities.sql
--
-- Couche d'activités hébergées (Phase 2 chantier Complétude & lentilles).
-- Mappe num_finess → activités[] pour les sites hébergeant une activité
-- secondaire (biologie / pharmacie / imagerie) sous une catégorie FINESS
-- d'une autre famille. Calculée par jointure RPPS×FINESS, seuil N≥3.
--
-- ⚠️ La matview joint deux tables swappées (rpps mensuel, finess bimestriel).
-- Pattern OID rebuild OBLIGATOIRE post-swap des deux côtés (cf. gotcha
-- CLAUDE.md). NE JAMAIS utiliser REFRESH ici — la matview suit l'OID de
-- ses sources, un swap suffit à la désynchroniser silencieusement.
--
-- Réf : docs/plans/completude-lentilles-{sources,phase2-mesure}.md

CREATE MATERIALIZED VIEW IF NOT EXISTS finess_hosted_activities AS
WITH bio AS (
  SELECT r.num_finess
  FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
  WHERE f.categorie_code NOT IN ('610','611','612')
    AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
          OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
          OR r.profession_libelle = 'Technicien de Laboratoire' )
  GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
),
pharma AS (
  SELECT r.num_finess
  FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
  WHERE f.categorie_code NOT IN ('620','627','628','629','610','611','612','300','330','132')
    AND r.profession_libelle = 'Pharmacien'
  GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
),
img AS (
  SELECT r.num_finess
  FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
  WHERE f.categorie_code IS DISTINCT FROM '619'
    AND ( r.profession_libelle = 'Manipulateur ERM'
          OR r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'
          OR r.savoir_faire_libelle ILIKE 'Radiologie et imagerie%' )
  GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
),
unioned AS (
  SELECT num_finess, 'biologie'::text AS activite FROM bio
  UNION ALL
  SELECT num_finess, 'pharmacie'::text FROM pharma
  UNION ALL
  SELECT num_finess, 'imagerie'::text FROM img
),
grouped AS (
  SELECT num_finess, array_agg(activite ORDER BY activite)::text[] AS activites
  FROM unioned GROUP BY num_finess
)
SELECT
  g.num_finess,
  g.activites,
  f.raison_sociale,
  f.categorie_code,
  f.categorie_libelle,
  f.code_departement,
  f.code_insee,
  f.geom,
  f.geog
FROM grouped g
JOIN finess f ON f.num_finess = g.num_finess;

CREATE UNIQUE INDEX finess_hosted_activities_pkey ON finess_hosted_activities (num_finess);
CREATE INDEX finess_hosted_activities_activites_gin ON finess_hosted_activities USING GIN (activites);
CREATE INDEX finess_hosted_activities_geog_gist ON finess_hosted_activities USING GIST (geog);
CREATE INDEX finess_hosted_activities_code_dept ON finess_hosted_activities (code_departement);
CREATE INDEX finess_hosted_activities_code_insee ON finess_hosted_activities (code_insee);

GRANT SELECT ON finess_hosted_activities TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC 1 — lookup in_radius (PostGIS)
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION finess_hosted_activities_in_radius(
  p_activite text,
  p_lat double precision,
  p_lon double precision,
  p_radius_meters integer,
  p_sample_limit integer DEFAULT 5
)
RETURNS TABLE (
  total_count bigint,
  num_finess char(9),
  raison_sociale text,
  categorie_code varchar,
  categorie_libelle text
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '55s'
AS $$
DECLARE
  v_point geography := ST_MakePoint(p_lon, p_lat)::geography;
BEGIN
  RETURN QUERY
  WITH matched AS (
    SELECT num_finess, raison_sociale, categorie_code, categorie_libelle
    FROM finess_hosted_activities
    WHERE p_activite = ANY(activites)
      AND ST_DWithin(geog, v_point, p_radius_meters)
  ),
  counted AS ( SELECT count(*)::bigint AS n FROM matched )
  SELECT counted.n,
         matched.num_finess, matched.raison_sociale,
         matched.categorie_code, matched.categorie_libelle
  FROM counted
  LEFT JOIN matched ON true
  ORDER BY matched.raison_sociale
  LIMIT GREATEST(p_sample_limit, 1) + 1;  -- +1 sentinel pour signaler la troncature côté caller
END;
$$;

REVOKE EXECUTE ON FUNCTION finess_hosted_activities_in_radius FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION finess_hosted_activities_in_radius TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC 2 — lookup in_zone (départment OU commune)
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION finess_hosted_activities_in_zone(
  p_activite text,
  p_departement text DEFAULT NULL,
  p_code_insee text DEFAULT NULL,
  p_sample_limit integer DEFAULT 5
)
RETURNS TABLE (
  total_count bigint,
  num_finess char(9),
  raison_sociale text,
  categorie_code varchar,
  categorie_libelle text
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '55s'
AS $$
BEGIN
  IF p_departement IS NULL AND p_code_insee IS NULL THEN
    RAISE EXCEPTION 'finess_hosted_activities_in_zone: p_departement OR p_code_insee required';
  END IF;
  RETURN QUERY
  WITH matched AS (
    SELECT num_finess, raison_sociale, categorie_code, categorie_libelle
    FROM finess_hosted_activities
    WHERE p_activite = ANY(activites)
      AND ( p_departement IS NULL OR code_departement = p_departement )
      AND ( p_code_insee  IS NULL OR code_insee       = p_code_insee )
  ),
  counted AS ( SELECT count(*)::bigint AS n FROM matched )
  SELECT counted.n,
         matched.num_finess, matched.raison_sociale,
         matched.categorie_code, matched.categorie_libelle
  FROM counted
  LEFT JOIN matched ON true
  ORDER BY matched.raison_sociale
  LIMIT GREATEST(p_sample_limit, 1) + 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION finess_hosted_activities_in_zone FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION finess_hosted_activities_in_zone TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Rebuild post-swap (pattern OID — JAMAIS REFRESH, cf. gotcha CLAUDE.md)
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ingest_rebuild_finess_hosted_activities()
RETURNS void
LANGUAGE plpgsql
SET statement_timeout = '10min'
AS $$
BEGIN
  -- DROP la matview obsolète (collée à l'ancien OID des tables swappées)
  DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities_rebuild;

  -- CREATE la nouvelle (résolue PAR NOM, donc liée aux OIDs actuels)
  CREATE MATERIALIZED VIEW finess_hosted_activities_rebuild AS
  WITH bio AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code NOT IN ('610','611','612')
      AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
            OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
            OR r.profession_libelle = 'Technicien de Laboratoire' )
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  pharma AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code NOT IN ('620','627','628','629','610','611','612','300','330','132')
      AND r.profession_libelle = 'Pharmacien'
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  img AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code IS DISTINCT FROM '619'
      AND ( r.profession_libelle = 'Manipulateur ERM'
            OR r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'
            OR r.savoir_faire_libelle ILIKE 'Radiologie et imagerie%' )
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  unioned AS (
    SELECT num_finess, 'biologie'::text AS activite FROM bio
    UNION ALL SELECT num_finess, 'pharmacie'::text FROM pharma
    UNION ALL SELECT num_finess, 'imagerie'::text FROM img
  ),
  grouped AS (
    SELECT num_finess, array_agg(activite ORDER BY activite)::text[] AS activites
    FROM unioned GROUP BY num_finess
  )
  SELECT g.num_finess, g.activites, f.raison_sociale, f.categorie_code,
         f.categorie_libelle, f.code_departement, f.code_insee, f.geom, f.geog
  FROM grouped g JOIN finess f ON f.num_finess = g.num_finess;

  -- Indexes sur la _rebuild (avant le rename atomique)
  CREATE UNIQUE INDEX finess_hosted_activities_rebuild_pkey
    ON finess_hosted_activities_rebuild (num_finess);
  CREATE INDEX finess_hosted_activities_rebuild_activites_gin
    ON finess_hosted_activities_rebuild USING GIN (activites);
  CREATE INDEX finess_hosted_activities_rebuild_geog_gist
    ON finess_hosted_activities_rebuild USING GIST (geog);
  CREATE INDEX finess_hosted_activities_rebuild_code_dept
    ON finess_hosted_activities_rebuild (code_departement);
  CREATE INDEX finess_hosted_activities_rebuild_code_insee
    ON finess_hosted_activities_rebuild (code_insee);

  GRANT SELECT ON finess_hosted_activities_rebuild TO anon, authenticated, service_role;

  -- RENAME atomique (1 transaction PL/pgSQL)
  DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities;
  ALTER MATERIALIZED VIEW finess_hosted_activities_rebuild
    RENAME TO finess_hosted_activities;
  ALTER INDEX finess_hosted_activities_rebuild_pkey
    RENAME TO finess_hosted_activities_pkey;
  ALTER INDEX finess_hosted_activities_rebuild_activites_gin
    RENAME TO finess_hosted_activities_activites_gin;
  ALTER INDEX finess_hosted_activities_rebuild_geog_gist
    RENAME TO finess_hosted_activities_geog_gist;
  ALTER INDEX finess_hosted_activities_rebuild_code_dept
    RENAME TO finess_hosted_activities_code_dept;
  ALTER INDEX finess_hosted_activities_rebuild_code_insee
    RENAME TO finess_hosted_activities_code_insee;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities TO service_role;

COMMENT ON FUNCTION ingest_rebuild_finess_hosted_activities IS
  'Rebuild post-swap (RPPS ou FINESS) de la matview finess_hosted_activities. Pattern OID — JAMAIS REFRESH. Hooké dans scripts/ingest/{rpps,finess}.ts post-swap.';

COMMENT ON MATERIALIZED VIEW finess_hosted_activities IS
  'Couche d''activités hébergées (biologie/pharmacie/imagerie) calculée par jointure RPPS×FINESS, seuil N≥3 professionnels. Phase 2 chantier Complétude & lentilles. Voir docs/plans/completude-lentilles-{sources,phase2-mesure,phase2-plan}.md.';
```

- [ ] **Step 2 : Appliquer la migration (dashboard SQL editor)**

Per `CLAUDE.md` : les migrations format `YYYYMMDDTHHMMSS_*.sql` sont **rejetées par `supabase db push`**. **Canal d'apply** : coller le SQL ci-dessus dans le dashboard Supabase SQL editor (`https://supabase.com/dashboard/project/_/sql/new`), exécuter. Vérifier visuellement la création de la matview + des 3 fonctions.

- [ ] **Step 3 : Sanity-check prod**

Via Supabase MCP `execute_sql` :

```sql
-- 1. Counts par activité — doivent matcher le rapport de mesure §3
SELECT 'biologie' AS activite, count(*) FROM finess_hosted_activities WHERE 'biologie' = ANY(activites)
UNION ALL SELECT 'pharmacie', count(*) FROM finess_hosted_activities WHERE 'pharmacie' = ANY(activites)
UNION ALL SELECT 'imagerie', count(*) FROM finess_hosted_activities WHERE 'imagerie' = ANY(activites);
```
Expected: biologie ≈ 662, pharmacie ≈ 650-700 (après gate 300/330/132), imagerie ≈ 1553.

```sql
-- 2. Sanity-check Lille (cf. démo de cadrage)
SELECT raison_sociale, categorie_libelle, activites
FROM finess_hosted_activities
WHERE code_insee = '59350' AND 'biologie' = ANY(activites)
ORDER BY raison_sociale;
```
Expected: ≈ 13 sites (cf. démo Lille du cadrage).

- [ ] **Step 4 : Écrire le test garde-fou de l'OID rebuild**

Créer `scripts/ingest/finess-hosted-activities-rebuild.test.ts` sur le modèle EXACT de `scripts/ingest/rpps-matview-rebuild.test.ts` (lire ce fichier d'abord — il définit le pattern de garde anti-drift contre `REFRESH`). Adapter le nom : la fonction sous test est `ingest_rebuild_finess_hosted_activities`.

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("ingest_rebuild_finess_hosted_activities — garde-fou OID", () => {
  const migrationPath = "supabase/migrations/<YYYYMMDDTHHMMSS>_finess_hosted_activities.sql";
  const sql = readFileSync(join(process.cwd(), migrationPath), "utf-8");

  it("rebuild function performs DROP + CREATE + RENAME, never REFRESH", () => {
    const rebuildBody = extractFunctionBody(sql, "ingest_rebuild_finess_hosted_activities");
    expect(rebuildBody).toMatch(/DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities/i);
    expect(rebuildBody).toMatch(/CREATE MATERIALIZED VIEW finess_hosted_activities_rebuild/i);
    expect(rebuildBody).toMatch(/ALTER MATERIALIZED VIEW finess_hosted_activities_rebuild\s+RENAME TO finess_hosted_activities/i);
    expect(rebuildBody).not.toMatch(/REFRESH MATERIALIZED VIEW/i);
  });

  it("rebuild body is byte-identical to the initial CREATE (anti-drift)", () => {
    const initial = extractCreateMatviewBody(sql, "finess_hosted_activities");
    const rebuild = extractCreateMatviewBody(sql, "finess_hosted_activities_rebuild");
    expect(rebuild).toBe(initial); // CTEs + SELECT identiques, sinon drift silencieux
  });
});

// helpers extractFunctionBody / extractCreateMatviewBody : reprendre la même
// logique que rpps-matview-rebuild.test.ts (tag-aware, strip comments).
```

- [ ] **Step 5 : Vérifier**

Run: `pnpm vitest run scripts/ingest/finess-hosted-activities-rebuild.test.ts`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add supabase/migrations/*_finess_hosted_activities.sql \
        scripts/ingest/finess-hosted-activities-rebuild.test.ts
git commit -m "feat(phase2): matview finess_hosted_activities + RPCs + rebuild

Couche d'activités hébergées (biologie/pharmacie/imagerie) par jointure
RPPS x FINESS, seuil N>=3 (mesure prod 2026-05-22). 2 RPCs lookup
(radius / zone). Rebuild post-swap pattern OID (jamais REFRESH).
Migration appliquée manuellement via dashboard SQL editor. Sanity-check
prod : biologie 662 / pharmacie ~650 / imagerie 1553. Garde-fou OID test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 : Hook rebuild dans le cron RPPS

**Files:**
- Modify: `scripts/ingest/rpps.ts` (~ligne 556, après `rebuildRppsMatviews`)

- [ ] **Step 1 : Lire le contexte**

Lire `scripts/ingest/rpps.ts` autour de la ligne 556 — bloc d'appel à `rebuildRppsMatviews(supabase, log)`. La nouvelle matview se rebuild **après** les matviews RPPS existantes (séquentiel — la jointure dépend de la donnée RPPS swappée).

- [ ] **Step 2 : Étendre `rebuildRppsMatviews`**

Dans `scripts/ingest/rpps.ts`, fonction `rebuildRppsMatviews` (~ligne 883) : après l'appel à `ingest_rebuild_rpps_matviews`, ajouter un second appel à `ingest_rebuild_finess_hosted_activities`. Pattern :

```typescript
export async function rebuildRppsMatviews(
  supabase: SupabaseClient,
  log: IngestLogEntry,
): Promise<void> {
  // ... appel existant à ingest_rebuild_rpps_matviews ...
  const { error } = await supabase.rpc("ingest_rebuild_rpps_matviews");
  if (error) {
    // gestion existante — laisser inchangée
  }

  // Phase 2 — couche d'activités hébergées dépend AUSSI de RPPS.
  // Rebuild après les matviews RPPS (séquentiel).
  const start2 = Date.now();
  const { error: err2 } = await supabase.rpc("ingest_rebuild_finess_hosted_activities");
  const elapsed2 = Date.now() - start2;
  if (err2) {
    const message = err2.message ?? String(err2);
    const code = err2.code ?? null;
    const detail = `post-swap finess_hosted_activities rebuild failed [code=${code}] after ${elapsed2}ms: ${message}`;
    console.warn(`[rpps] ${detail}`);
    log.partialFailures = log.partialFailures ?? [];
    log.partialFailures.push({ step: "rebuild_finess_hosted_activities", detail });
    // NE PAS throw : échec transitoire = matview légèrement périmée, pas catastrophe.
    // Pattern aligné sur le rebuild des autres matviews (échec partiel, log warn).
    return;
  }
  console.log(`[rpps] ingest_rebuild_finess_hosted_activities OK in ${elapsed2}ms`);
}
```

(Vérifier le typage exact de `log.partialFailures` dans le projet — adapter si la forme diffère.)

- [ ] **Step 3 : Test d'intégration (mock)**

Dans `scripts/ingest/rpps.test.ts` (ou un nouveau `scripts/ingest/rpps-hosted-rebuild.test.ts`), ajouter un test qui mocke `supabase.rpc` et vérifie que les deux RPCs (`ingest_rebuild_rpps_matviews` puis `ingest_rebuild_finess_hosted_activities`) sont appelées dans cet ordre.

```typescript
import { describe, expect, it, vi } from "vitest";
import { rebuildRppsMatviews } from "./rpps";

describe("rebuildRppsMatviews chains finess_hosted_activities", () => {
  it("appelle d'abord ingest_rebuild_rpps_matviews, puis ingest_rebuild_finess_hosted_activities", async () => {
    const calls: string[] = [];
    const rpc = vi.fn(async (name: string) => {
      calls.push(name);
      return { data: null, error: null };
    });
    const supabase = { rpc } as any;
    const log = {} as any;
    await rebuildRppsMatviews(supabase, log);
    expect(calls).toEqual([
      "ingest_rebuild_rpps_matviews",
      "ingest_rebuild_finess_hosted_activities",
    ]);
  });

  it("ne throw pas si le rebuild hosted_activities échoue, log warn + partialFailure", async () => {
    const rpc = vi.fn(async (name: string) =>
      name === "ingest_rebuild_finess_hosted_activities"
        ? { data: null, error: { message: "transient", code: "XX000" } }
        : { data: null, error: null },
    );
    const supabase = { rpc } as any;
    const log: any = {};
    await expect(rebuildRppsMatviews(supabase, log)).resolves.not.toThrow();
    expect(log.partialFailures).toContainEqual(
      expect.objectContaining({ step: "rebuild_finess_hosted_activities" }),
    );
  });
});
```

- [ ] **Step 4 : Vérifier**

Run: `pnpm typecheck && pnpm vitest run scripts/ingest/rpps.test.ts scripts/ingest/rpps-hosted-rebuild.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add scripts/ingest/rpps.ts scripts/ingest/*.test.ts
git commit -m "feat(phase2): rebuild finess_hosted_activities post-swap RPPS

Chaîné après ingest_rebuild_rpps_matviews dans le cron RPPS. Échec
transitoire = warn + partialFailure (pas throw — matview légèrement
périmée acceptable, le prochain cron rattrape).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 : Hook rebuild dans le cron FINESS

**Files:**
- Modify: `scripts/ingest/finess.ts`

Identique à Task 2 mais côté FINESS. La matview joint AUSSI `finess` → un swap finess sans rebuild la désynchroniserait (CLAUDE.md gotcha OID).

- [ ] **Step 1 : Lire le contexte**

Lire `scripts/ingest/finess.ts`, repérer le post-swap (chercher `swap` ou `rebuild`). Le cron FINESS swap `finess_staging` → `finess`. Après ce swap, ajouter l'appel à `ingest_rebuild_finess_hosted_activities`.

- [ ] **Step 2 : Ajouter l'appel post-swap**

Reproduire le pattern de Task 2 Step 2 (capture du temps + gestion d'erreur warn-not-throw + log + partialFailure). NE PAS dupliquer la logique — extraire une fonction utilitaire `rebuildFinessHostedActivities(supabase, log)` dans `scripts/ingest/shared.ts` si la duplication entre rpps.ts et finess.ts devient trop verbatim. Décision à prendre à la lecture des deux call-sites : si <15 lignes dupliquées, ne pas factoriser ; sinon, extraire.

- [ ] **Step 3 : Test**

Ajouter un test miroir du Task 2 Step 3 pour le call-site FINESS (`scripts/ingest/finess.test.ts`).

- [ ] **Step 4 : Vérifier**

Run: `pnpm typecheck && pnpm vitest run scripts/ingest/finess.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add scripts/ingest/finess.ts scripts/ingest/*.test.ts
git commit -m "feat(phase2): rebuild finess_hosted_activities post-swap FINESS

Chaîné après le swap finess_staging->finess. Couvre l'autre côté de la
dépendance matview (RPPS=mensuel, FINESS=bimestriel, l'un OU l'autre
swap suffit à désynchroniser sans rebuild).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 : Module lib `hosted-activities.ts`

**Files:**
- Create: `src/sante/hosted-activities.ts`
- Test: `src/sante/hosted-activities.test.ts`

Module lib pur (`src/`) — OSS-publishable, pas de Sentry, pas de catch silencieux. Expose les types, le mapper famille→activité, les notes par activité, et les 2 fetchers.

- [ ] **Step 1 : Écrire les tests (échec attendu)**

Créer `src/sante/hosted-activities.test.ts` :

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  type HostedActivity,
  HOSTED_ACTIVITY_NOTES,
  familleToHostedActivity,
} from "./hosted-activities";

describe("familleToHostedActivity", () => {
  it("mappe labo → biologie", () => {
    expect(familleToHostedActivity("labo")).toBe("biologie");
  });
  it("mappe pharmacie → pharmacie", () => {
    expect(familleToHostedActivity("pharmacie")).toBe("pharmacie");
  });
  it("mappe imagerie → imagerie", () => {
    expect(familleToHostedActivity("imagerie")).toBe("imagerie");
  });
  it("retourne null pour les familles sans activité hébergée pertinente", () => {
    expect(familleToHostedActivity("ehpad")).toBeNull();
    expect(familleToHostedActivity("mco")).toBeNull();
    expect(familleToHostedActivity("ssr")).toBeNull();
  });
});

describe("HOSTED_ACTIVITY_NOTES", () => {
  it("expose un libellé d'activité + une note pour chaque activité", () => {
    const activites: HostedActivity[] = ["biologie", "pharmacie", "imagerie"];
    for (const a of activites) {
      const entry = HOSTED_ACTIVITY_NOTES[a];
      expect(entry.activite_libelle.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(50);
      expect(entry.note).toMatch(/[Nn]e pas additionner|distinct/i); // garde anti-mélange
    }
  });
  it("biologie mentionne EFS et l'absence d'accès ambulatoire", () => {
    expect(HOSTED_ACTIVITY_NOTES.biologie.note).toMatch(/EFS|transfusion/);
    expect(HOSTED_ACTIVITY_NOTES.biologie.note).toMatch(/ambulatoire/);
  });
  it("pharmacie mentionne PUI et l'absence d'accès grand public", () => {
    expect(HOSTED_ACTIVITY_NOTES.pharmacie.note).toMatch(/PUI/);
    expect(HOSTED_ACTIVITY_NOTES.pharmacie.note).toMatch(/grand public/);
  });
  it("imagerie mentionne l'accès ambulatoire et la catégorie 619 peu peuplée", () => {
    expect(HOSTED_ACTIVITY_NOTES.imagerie.note).toMatch(/ambulatoire/);
    expect(HOSTED_ACTIVITY_NOTES.imagerie.note).toMatch(/peu peuplée|cabinet d.imagerie/);
  });
});
```

- [ ] **Step 2 : Lancer — vérifier échec**

Run: `pnpm vitest run src/sante/hosted-activities.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Créer le module**

```typescript
// src/sante/hosted-activities.ts
/**
 * Couche d'activités hébergées (Phase 2 chantier Complétude & lentilles).
 *
 * Expose pour chaque tool de comptage filtré par famille (labo/pharmacie/
 * imagerie) un SECOND compte juxtaposé des sites hébergeant l'activité
 * correspondante sous une autre catégorie FINESS. Doctrine : MCP juxtapose,
 * jamais d'addition silencieuse, le LLM décide.
 *
 * Source : matview `finess_hosted_activities` (jointure RPPS×FINESS, seuil
 * N≥3, calibré par mesure prod — cf. docs/plans/completude-lentilles-phase2-mesure.md).
 *
 * Les notes ci-dessous sont LUES PAR LE LLM CALLER et restituées au lecteur
 * final — elles doivent rester courtes, précises, et interdire explicitement
 * l'addition sans préciser la nature des deux comptes.
 */
import { getAnonClient } from "../storage/supabase.js";
import { assertValidDept } from "../territoire/dept-codes.js";
import { formatRpcError, validateCoords, validateRadiusKm } from "./db-helpers.js";
import type { FinessFamilleQuery } from "./finess-categories.js";

/** Activités hébergées exposables par la couche. */
export type HostedActivity = "biologie" | "pharmacie" | "imagerie";

/**
 * Mapping famille FINESS → activité hébergée pertinente. Les familles non
 * mappées (EHPAD, MCO, etc.) n'ont pas d'activité-secondaire à signaler →
 * `null`, et le champ `activite_hebergee` est absent de la réponse du tool.
 */
export function familleToHostedActivity(
  famille: FinessFamilleQuery,
): HostedActivity | null {
  switch (famille) {
    case "labo":      return "biologie";
    case "pharmacie": return "pharmacie";
    case "imagerie":  return "imagerie";
    default:          return null;
  }
}

/** Libellé public + note à restituer au lecteur final via le LLM. */
export const HOSTED_ACTIVITY_NOTES: Record<
  HostedActivity,
  { activite_libelle: string; note: string }
> = {
  biologie: {
    activite_libelle: "biologie médicale",
    note:
      "Plateaux techniques de biologie hébergés dans des hôpitaux, CLCC ou " +
      "centres de transfusion sanguine (EFS) — activité analytique sans accès " +
      "patient ambulatoire (distincte des laboratoires autonomes du compte " +
      "principal). Ne pas additionner les deux comptes sans préciser leur nature.",
  },
  pharmacie: {
    activite_libelle: "pharmacie à usage intérieur",
    note:
      "Pharmacies hospitalières (PUI) desservant les patients hospitalisés en " +
      "interne — pas d'accès grand public (distinctes des officines du compte " +
      "principal). Ne pas additionner les deux comptes sans préciser leur nature.",
  },
  imagerie: {
    activite_libelle: "imagerie médicale",
    note:
      "Sites d'imagerie (radiologie, scanner, IRM) en cliniques ou hôpitaux, " +
      "accessibles au public en ambulatoire. La catégorie FINESS « cabinet " +
      "d'imagerie » étant peu peuplée en pratique, ce compte représente " +
      "l'essentiel de l'offre territoriale d'imagerie.",
  },
};

/** Aperçu d'un site (sample borné). */
export interface HostedSiteSample {
  num_finess: string;
  raison_sociale: string;
  categorie_code: string | null;
  categorie_libelle: string | null;
}

/** Résultat juxtaposé — voyage dans la sortie des tools. */
export interface HostedActivityResult {
  activite: string;          // libellé public, ex. "biologie médicale"
  count: number;             // nombre total dans la zone
  note: string;              // phrase à restituer
  sites_apercu: HostedSiteSample[]; // ≤ 5 exemples
  truncated: boolean;        // true si `count > sites_apercu.length`
}

const DEFAULT_SAMPLE_LIMIT = 5;

interface RawRpcRow {
  total_count: number | string; // bigint → string ou number selon driver
  num_finess: string | null;
  raison_sociale: string | null;
  categorie_code: string | null;
  categorie_libelle: string | null;
}

function buildResult(activite: HostedActivity, rows: RawRpcRow[]): HostedActivityResult {
  const { activite_libelle, note } = HOSTED_ACTIVITY_NOTES[activite];
  const total =
    rows.length === 0
      ? 0
      : typeof rows[0]!.total_count === "string"
        ? Number(rows[0]!.total_count)
        : (rows[0]!.total_count ?? 0);
  const samples: HostedSiteSample[] = rows
    .filter((r) => r.num_finess !== null) // ligne sentinelle si count=0 → num_finess null
    .slice(0, DEFAULT_SAMPLE_LIMIT)
    .map((r) => ({
      num_finess: r.num_finess!,
      raison_sociale: r.raison_sociale ?? "",
      categorie_code: r.categorie_code,
      categorie_libelle: r.categorie_libelle,
    }));
  return {
    activite: activite_libelle,
    count: total,
    note,
    sites_apercu: samples,
    truncated: total > samples.length,
  };
}

export interface InRadiusInput {
  activite: HostedActivity;
  center: { lat: number; lon: number };
  radiusKm: number;
  sampleLimit?: number;
}

/**
 * Compte les sites hébergeant `activite` dans un rayon. Retourne un
 * `HostedActivityResult` avec count + sample borné.
 */
export async function getHostedActivitiesInRadius(
  input: InRadiusInput,
): Promise<HostedActivityResult> {
  validateCoords(input.center.lat, input.center.lon);
  validateRadiusKm(input.radiusKm);
  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;

  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_hosted_activities_in_radius", {
    p_activite: input.activite,
    p_lat: input.center.lat,
    p_lon: input.center.lon,
    p_radius_meters: input.radiusKm * 1000,
    p_sample_limit: sampleLimit,
  });
  if (error) {
    throw new Error(formatRpcError("finess_hosted_activities_in_radius", error));
  }
  return buildResult(input.activite, (data as RawRpcRow[]) ?? []);
}

export interface InZoneInput {
  activite: HostedActivity;
  departement?: string;
  codeInsee?: string;
  sampleLimit?: number;
}

/**
 * Compte les sites hébergeant `activite` dans une zone administrative
 * (département OU commune — au moins l'un des deux requis).
 */
export async function getHostedActivitiesInZone(
  input: InZoneInput,
): Promise<HostedActivityResult> {
  if (input.departement === undefined && input.codeInsee === undefined) {
    throw new RangeError(
      "getHostedActivitiesInZone: `departement` OR `codeInsee` requis (au moins un).",
    );
  }
  if (input.departement !== undefined) assertValidDept(input.departement);

  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const supabase = getAnonClient();
  const { data, error } = await supabase.rpc("finess_hosted_activities_in_zone", {
    p_activite: input.activite,
    p_departement: input.departement ?? null,
    p_code_insee: input.codeInsee ?? null,
    p_sample_limit: sampleLimit,
  });
  if (error) {
    throw new Error(formatRpcError("finess_hosted_activities_in_zone", error));
  }
  return buildResult(input.activite, (data as RawRpcRow[]) ?? []);
}
```

- [ ] **Step 4 : Étendre le test pour couvrir les fetchers (mocks)**

Ajouter à `hosted-activities.test.ts` des tests mockant `supabase.rpc` :

```typescript
import * as supabaseModule from "../storage/supabase";
import {
  getHostedActivitiesInRadius,
  getHostedActivitiesInZone,
} from "./hosted-activities";

describe("getHostedActivitiesInRadius", () => {
  it("retourne count + sample borné + truncated true quand sample < count", async () => {
    vi.spyOn(supabaseModule, "getAnonClient").mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: [
          { total_count: 12, num_finess: "590048468", raison_sociale: "CENTRE DE BIOLOGIE PATHOLOGIE", categorie_code: "101", categorie_libelle: "C.H.R." },
          { total_count: 12, num_finess: "590000105", raison_sociale: "CHR LILLE", categorie_code: "101", categorie_libelle: "C.H.R." },
          // ... jusqu'à 5
        ],
        error: null,
      }),
    } as any);
    const r = await getHostedActivitiesInRadius({
      activite: "biologie",
      center: { lat: 50.63, lon: 3.06 },
      radiusKm: 5,
    });
    expect(r.activite).toBe("biologie médicale");
    expect(r.count).toBe(12);
    expect(r.truncated).toBe(true);
    expect(r.sites_apercu.length).toBeLessThanOrEqual(5);
    expect(r.note).toMatch(/Plateaux techniques/);
  });

  it("count=0 → sites_apercu vide, truncated false", async () => {
    vi.spyOn(supabaseModule, "getAnonClient").mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as any);
    const r = await getHostedActivitiesInRadius({
      activite: "biologie",
      center: { lat: 48.85, lon: 2.35 },
      radiusKm: 5,
    });
    expect(r.count).toBe(0);
    expect(r.sites_apercu).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});

describe("getHostedActivitiesInZone", () => {
  it("throw si ni departement ni codeInsee", async () => {
    await expect(getHostedActivitiesInZone({ activite: "biologie" })).rejects.toThrow(/requis/);
  });
});
```

- [ ] **Step 5 : Vérifier**

Run: `pnpm vitest run src/sante/hosted-activities.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add src/sante/hosted-activities.ts src/sante/hosted-activities.test.ts
git commit -m "feat(phase2): lib hosted-activities — types + fetchers + notes

Module lib pur. Mapper famille->activité, notes par activité (lues par
le LLM, interdisent l'addition), 2 fetchers (in_radius / in_zone) sur
les RPCs Task 1. Pas encore câblé aux tools (Task 5+).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 : Wire `activite_hebergee` dans les 2 tools `etablissements_finess_*`

**Files:**
- Modify: `api/tools.ts` (handlers + output schema)
- Test: `api/tools.test.ts`

Pattern : après le `withFreshness(...)` + `withPerimetre(...)` existant, calculer en parallèle (`Promise.all`) le `HostedActivityResult` si la famille filtrée est mappable, et l'attacher à la réponse via un nouveau wrapper `withHostedActivity(result, hosted)` (jumeau de `withPerimetre`).

- [ ] **Step 1 : Importer le module + définir le wrapper**

En tête de `api/tools.ts`, ajouter à la liste d'imports `src/sante/` :

```typescript
import {
  type HostedActivityResult,
  familleToHostedActivity,
  getHostedActivitiesInRadius,
  getHostedActivitiesInZone,
} from "../src/sante/hosted-activities.js";
```

Près de `withPerimetre`, ajouter :

```typescript
/**
 * Injecte un descripteur d'activité hébergée juxtaposée dans la sortie d'un
 * tool de comptage filtré par famille. Le compte est SÉPARÉ du `count`
 * principal — la note interdit l'addition sans précision (cf.
 * src/sante/hosted-activities.ts). Champ omis si la famille n'a pas
 * d'activité hébergée pertinente (`hosted === null`).
 */
function withHostedActivity<T extends object & { then?: never }>(
  result: T,
  hosted: HostedActivityResult | null,
): T & { activite_hebergee?: HostedActivityResult } {
  if (hosted === null) return result;
  return { ...result, activite_hebergee: hosted };
}
```

- [ ] **Step 2 : Étendre le schéma de sortie**

Près de `PERIMETRE_OUTPUT_SCHEMA`, ajouter :

```typescript
const HOSTED_ACTIVITY_OUTPUT_SCHEMA = {
  type: "object",
  description:
    "Compte juxtaposé des sites hébergeant l'activité correspondant à la " +
    "famille filtrée, sous une autre catégorie FINESS. Distinct du `count` " +
    "principal — lire `note` pour comprendre la sémantique et ne JAMAIS " +
    "additionner les deux comptes sans préciser leur nature.",
  properties: {
    activite: { type: "string" },
    count: { type: "integer" },
    note: { type: "string" },
    sites_apercu: {
      type: "array",
      items: {
        type: "object",
        properties: {
          num_finess: { type: "string" },
          raison_sociale: { type: "string" },
          categorie_code: { type: "string" },
          categorie_libelle: { type: "string" },
        },
      },
    },
    truncated: { type: "boolean" },
  },
} as const;
```

Ajouter `activite_hebergee: HOSTED_ACTIVITY_OUTPUT_SCHEMA` dans les `properties` de `QUERY_RESULT_OUTPUT_SCHEMA` (optionnel, pas dans `required`).

- [ ] **Step 3 : Câbler `etablissements_finess_in_radius`**

Handler ~ligne 1290. Repérer la zone `const result = await withFreshness(...)` puis `return withPerimetre(result, ...)`. Étendre pour calculer le hosted en parallèle :

```typescript
      // ... unchanged: input building, withFreshness, withPerimetre ...
      const hostedActivity = familles?.length === 1
        ? familleToHostedActivity(familles[0]!)
        : null; // multi-familles : pas d'activite_hebergee (sémantique ambiguë)
      const [withPerim, hosted] = await Promise.all([
        (async () => withPerimetre(
          await withFreshness(await getFinessInRadius(input), args.include_freshness, ["finess"]),
          finessFamillePerimetre(familles),
        ))(),
        hostedActivity
          ? getHostedActivitiesInRadius({
              activite: hostedActivity,
              center: { lat, lon },
              radiusKm,
            })
          : Promise.resolve(null),
      ]);
      return withHostedActivity(withPerim, hosted);
```

**Sémantique décidée** : `activite_hebergee` est ajouté **uniquement quand `familles` contient EXACTEMENT 1 famille mappable**. Multi-familles → champ omis (le caller voit le `perimetre` et peut requêter par famille s'il veut le hosted).

- [ ] **Step 4 : Câbler `etablissements_finess_by_categorie`**

Handler ~ligne 1346. `categorie` est une famille unique (paramètre obligatoire). Le hosted est donc toujours calculable si mappable. Même pattern :

```typescript
      const hostedActivity = familleToHostedActivity(famille);
      const [withPerim, hosted] = await Promise.all([
        (async () => withPerimetre(
          await withFreshness(await getFinessByCategorie(input), args.include_freshness, ["finess"]),
          finessFamillePerimetre([famille]),
        ))(),
        hostedActivity
          ? getHostedActivitiesInZone({
              activite: hostedActivity,
              departement: departement ?? undefined,
              codeInsee: codeInsee ?? undefined,
            })
          : Promise.resolve(null),
      ]);
      return withHostedActivity(withPerim, hosted);
```

⚠️ `getHostedActivitiesInZone` exige département OU code_insee. Si les deux sont absents (recherche France entière), passer le compte hosted en `Promise.resolve(null)` — on ne peut pas calculer hosted sur France entière sans une RPC séparée (hors scope v1, le tool a déjà `count = nombre national`).

```typescript
      const canFetchHosted = hostedActivity && (departement || codeInsee);
      // ... else: Promise.resolve(null)
```

- [ ] **Step 5 : Tests de câblage**

Dans `api/tools.test.ts`, nouveau `describe("activite_hebergee wiring — etablissements_finess_*")` :

```typescript
describe("activite_hebergee wiring — etablissements_finess_*", () => {
  afterEach(() => vi.restoreAllMocks());

  it("etablissements_finess_in_radius famille=labo expose activite_hebergee biologie", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 12, truncated: false, results: [],
    } as any);
    vi.spyOn(hostedActivitiesDb, "getHostedActivitiesInRadius").mockResolvedValueOnce({
      activite: "biologie médicale", count: 5, note: "Plateaux ...",
      sites_apercu: [], truncated: false,
    });
    const tool = findTool("etablissements_finess_in_radius");
    expect(tool).toBeDefined();
    const out = (await tool!.handler({ lat: 50.63, lon: 3.06, familles: ["labo"], radius_km: 5 })) as any;
    expect(out.count).toBe(12);                   // compte principal intact
    expect(out.activite_hebergee.count).toBe(5);  // compte juxtaposé
    expect(out.activite_hebergee.activite).toBe("biologie médicale");
    expect(out.activite_hebergee.note).toMatch(/[Nn]e pas additionner/);
  });

  it("multi-familles → activite_hebergee absent", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 0, truncated: false, results: [],
    } as any);
    const tool = findTool("etablissements_finess_in_radius");
    const out = (await tool!.handler({ lat: 50.63, lon: 3.06, familles: ["labo", "pharmacie"], radius_km: 5 })) as any;
    expect(out.activite_hebergee).toBeUndefined();
  });

  it("famille sans hosted (ex. ehpad) → activite_hebergee absent", async () => {
    vi.spyOn(finessDb, "getFinessInRadius").mockResolvedValueOnce({
      count: 0, truncated: false, results: [],
    } as any);
    const tool = findTool("etablissements_finess_in_radius");
    const out = (await tool!.handler({ lat: 50.63, lon: 3.06, familles: ["ehpad"], radius_km: 5 })) as any;
    expect(out.activite_hebergee).toBeUndefined();
  });

  it("etablissements_finess_by_categorie sans dept ni commune → activite_hebergee absent (pas de scope zone)", async () => {
    vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({
      count: 4112, truncated: false, results: [],
    } as any);
    const tool = findTool("etablissements_finess_by_categorie");
    const out = (await tool!.handler({ categorie: "labo" })) as any;
    expect(out.count).toBe(4112);
    expect(out.activite_hebergee).toBeUndefined(); // pas de scope géographique
  });
});
```

- [ ] **Step 6 : Vérifier**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run api/tools.test.ts`
Expected: PASS (≥ 145 tests, +4 nouveaux).

- [ ] **Step 7 : Commit**

```bash
git add api/tools.ts api/tools.test.ts
git commit -m "feat(phase2): activite_hebergee sur etablissements_finess_{in_radius,by_categorie}

withHostedActivity (jumeau de withPerimetre) ajoute le compte juxtaposé
pour les familles mappables (labo->biologie, pharmacie->PUI,
imagerie->imagerie). Multi-familles ou famille non-mappable -> champ omis.
by_categorie sans scope zone -> champ omis (limitation v1 acceptée).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 : Wire dans `densite_etablissements_sante`

**Files:**
- Modify: `api/tools.ts` (handler `densite_etablissements_sante` ~ligne 2019)
- Test: `api/tools.test.ts`

Densité : count / population × 100k. Le hosted ajoute son propre compte → densité hosted = `hosted.count / population × 100k`. Calcul partagé avec la population déjà fetchée pour le compte principal.

- [ ] **Step 1 : Étendre le type `HostedActivityResult` avec densité (optionnel)**

Plutôt qu'allonger le type lib, le handler calcule la densité juste avant de l'attacher au résultat. Étendre le champ injecté côté tool uniquement :

```typescript
// dans le handler densite_etablissements_sante
const hostedActivity = familleToHostedActivity(famille);
const [result, hosted] = await Promise.all([
  densiteEtablissementsSante(input),
  hostedActivity
    ? getHostedActivitiesInZone({ activite: hostedActivity, departement: codeDept })
    : Promise.resolve(null),
]);
const withPerim = withPerimetre(result, finessFamillePerimetre([famille]));
const hostedWithDensite = hosted && result.zone.population_municipale
  ? {
      ...hosted,
      densite_pour_100k_hab:
        Math.round((hosted.count / result.zone.population_municipale) * 100_000 * 100) / 100,
    }
  : hosted;
return withHostedActivity(withPerim, hostedWithDensite);
```

(Vérifier le nom exact du champ population dans `DensiteEtablissementsSanteResult` : `result.zone.population_municipale` ou similaire — adapter.)

- [ ] **Step 2 : Test**

Ajouter un test handler-level qui mocke `densiteEtablissementsSante` et `getHostedActivitiesInZone`, asserte la présence de `activite_hebergee.count` et `activite_hebergee.densite_pour_100k_hab`.

- [ ] **Step 3 : Vérifier**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run api/tools.test.ts`
Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add api/tools.ts api/tools.test.ts
git commit -m "feat(phase2): activite_hebergee sur densite_etablissements_sante

Densité hosted calculée sur la même population que le compte principal
(densite_pour_100k_hab attachée au champ activite_hebergee).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 : Wire dans `panorama_sante_territoire`

**Files:**
- Modify: `api/tools.ts` (handler ~ligne 2062)
- Test: `api/tools.test.ts`

Panorama agrège plusieurs familles. Pour la couche hosted : pour CHAQUE famille mappable présente dans `finess_familles` (effectives, post-DEFAULT_FAMILLES), exposer un hosted. Le champ devient un **dictionnaire** `activites_hebergees_par_famille: Record<famille, HostedActivityResult>` (pluriel, structure dédiée).

- [ ] **Step 1 : Calcul parallèle**

```typescript
// Phase 1 (déjà en place) : effective familles
const famillesEffectives = familles ?? DEFAULT_FAMILLES;
// Phase 2 : pour chaque famille mappable, fetch hosted (parallèle)
const hostedTasks: Record<string, Promise<HostedActivityResult>> = {};
for (const f of famillesEffectives) {
  const a = familleToHostedActivity(f);
  if (a !== null) hostedTasks[f] = getHostedActivitiesInZone({ activite: a, codeInsee });
}
const hostedEntries = await Promise.all(
  Object.entries(hostedTasks).map(async ([f, p]) => [f, await p] as const),
);
const activitesHebergeesParFamille = Object.fromEntries(hostedEntries);
// ... existing perimetre logic ...
return {
  ...withPerimetre(result, perimetre),
  ...(Object.keys(activitesHebergeesParFamille).length > 0
    ? { activites_hebergees_par_famille: activitesHebergeesParFamille }
    : {}),
};
```

(Si `[]` désactive le volet FINESS, comme géré en Phase 1, le hosted est également omis.)

- [ ] **Step 2 : Test**

Ajouter un test qui : passe `finess_familles: ["labo","ehpad"]`, mocke `panoramaSanteTerritoire` + `getHostedActivitiesInZone`, asserte que `activites_hebergees_par_famille.labo` existe et `.ehpad` n'existe pas.

- [ ] **Step 3 : Vérifier + Commit**

```bash
git add api/tools.ts api/tools.test.ts
git commit -m "feat(phase2): activites_hebergees_par_famille sur panorama_sante_territoire

Dictionnaire par famille mappable des familles effectives. Familles non
mappables (ehpad, mco...) absentes du dict. Volet FINESS désactivé
([]) -> dict absent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 : Wire dans `finess_sirene_coverage_in_radius`

**Files:**
- Modify: `api/tools.ts` (handler ~ligne 2316)
- Test: `api/tools.test.ts`

Coverage filtre par famille (optionnel). Si une seule famille mappable est passée, ajouter `activite_hebergee`. Sinon (multi ou non-mappable) → champ omis.

- [ ] **Step 1 : Câblage**

```typescript
const hostedActivity = familles?.length === 1
  ? familleToHostedActivity(familles[0]!)
  : null;
const [result, hosted] = await Promise.all([
  getCoverageFinessVsSireneInRadius(input),
  hostedActivity
    ? getHostedActivitiesInRadius({ activite: hostedActivity, center: { lat, lon }, radiusKm })
    : Promise.resolve(null),
]);
return withHostedActivity(
  withPerimetre(result, finessFamillePerimetre(familles)),
  hosted,
);
```

- [ ] **Step 2-4 : Test, vérifier, commit** (pattern identique aux tâches précédentes)

```bash
git commit -m "feat(phase2): activite_hebergee sur finess_sirene_coverage_in_radius

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 : Documentation + bump V0.18.0

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `package.json`, `server.json`, `src/core/version.ts`

- [ ] **Step 1 : CHANGELOG.md — section `[0.18.0]`**

Ajouter en tête :

```markdown
## [0.18.0] — 2026-XX-XX (Phase 2 — couche d'activités hébergées)

### Added

- **Champ `activite_hebergee`** sur les tools de comptage FINESS filtrés par
  famille mappable (`labo`/`pharmacie`/`imagerie`) — compte **juxtaposé** des
  sites hébergeant l'activité correspondante sous une autre catégorie FINESS.
  Distinct du `count` principal, la `note` interdit l'addition. Doctrine : le
  MCP juxtapose, le LLM décide.
- Mapping : `labo` → biologie médicale (plateaux hospitaliers + EFS),
  `pharmacie` → pharmacies à usage intérieur (PUI), `imagerie` → sites
  d'imagerie en cliniques/hôpitaux (essentiel de l'offre ambulatoire car la
  catégorie FINESS `619` est vide en pratique).
- Tools concernés : `etablissements_finess_in_radius`,
  `etablissements_finess_by_categorie`, `densite_etablissements_sante`,
  `panorama_sante_territoire`, `finess_sirene_coverage_in_radius`.
- Infrastructure : matview `finess_hosted_activities` (jointure RPPS×FINESS,
  seuil N≥3), rebuild post-swap pattern OID (cron RPPS + cron FINESS).

Réf : `docs/plans/completude-lentilles-phase2-{plan,mesure}.md`.
```

- [ ] **Step 2 : CLAUDE.md — convention**

Sous-section Endpoint (`api/`), ajouter :

```markdown
- **Champ `activite_hebergee`** : tout tool de comptage FINESS filtré par
  famille mappable (`labo`/`pharmacie`/`imagerie`) DOIT exposer un compte
  juxtaposé via `withHostedActivity` (jumeau de `withPerimetre`). Source =
  matview `finess_hosted_activities`. JAMAIS d'addition entre `count` et
  `activite_hebergee.count` côté tool — la `note` interdit l'addition au
  caller LLM. Cf. `src/sante/hosted-activities.ts` et le rebuild post-swap
  pattern OID chaîné dans les crons RPPS ET FINESS.
```

- [ ] **Step 3 : Bump version 0.17.0 → 0.18.0** sur les 4 emplacements
(`package.json:3`, `server.json:9`, `server.json:14`, `src/core/version.ts:10`).

- [ ] **Step 4 : Vérifier**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add CHANGELOG.md CLAUDE.md package.json server.json src/core/version.ts
git commit -m "docs: CHANGELOG + CLAUDE.md + bump 0.18.0 (Phase 2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 : Discipline post-fix + release V0.18.0

Identique au Task 7 du plan Phase 1 (`completude-lentilles-plan.md`) — adapter à V0.18.0.

- [ ] **Step 1** : Self-review du diff (`git diff main...HEAD`).
- [ ] **Step 2** : `/simplify` (3 agents reuse/quality/efficiency).
- [ ] **Step 3** : `/review` Passe 1 (3 agents) — corriger tout.
- [ ] **Step 4** : `/review` Passe 2 (2 agents).
- [ ] **Step 5** : validation finale (`pnpm typecheck && pnpm lint && pnpm test`).
- [ ] **Step 6** : Validation prod du comportement — appeler les 5 tools avec une famille mappable et vérifier la présence + cohérence d'`activite_hebergee`. Cas concret : Charleville-Mézières (`code_insee=08105`) famille=labo → confirmer le hosted count + sample comprenant un site hospitalier.
- [ ] **Step 7** : Release V0.18.0 (maintainer — `scripts/release.sh`).
- [ ] **Step 8** : Mémoire `~/.claude/projects/.../memory/v018-phase2-hosted-activities.md`.

---

## Self-Review du plan

- **Couverture spec** : juxtaposition `activite_hebergee` (T5-T8) · matview + rebuild (T1-T3) · lib (T4) · docs (T9) · discipline (T10). Pas de gap.
- **Placeholders** : `<YYYYMMDDTHHMMSS>` dans Task 1/4 = timestamp à générer au moment de la migration (instruction explicite, pas un TODO). Reste du code = exact.
- **Cohérence des types** : `HostedActivity`, `HostedActivityResult`, `HostedSiteSample`, `familleToHostedActivity`, `getHostedActivitiesInRadius`, `getHostedActivitiesInZone`, `withHostedActivity`, `HOSTED_ACTIVITY_NOTES`, `HOSTED_ACTIVITY_OUTPUT_SCHEMA` — noms identiques de leur définition (T4) à leurs usages (T5-T8). ✅
- **Scope** : Phase 2 = un sous-système shippable cohérent (matview + lib + câblage + docs). Pas de mélange avec Phase 2-bis (médecins) qui n'est pas nécessaire (cf. fin de la conversation de cadrage : RPPS est complet par construction, le routage Phase 1 suffit).
- **Dépendance prod** : la matview doit exister AVANT que les tools soient câblés (sinon les RPCs lib échouent). Ordre Task 1 → Task 4 → Task 5+ respecté. La migration s'applique manuellement via dashboard (Task 1 Step 2) avant le commit de Task 1.

---

## Décisions techniques figées (récap)

- **Pattern de wrapper** : `withHostedActivity<T extends object & { then?: never }>` (jumeau de `withPerimetre`, type durci anti-Promise-spread — gotcha Phase 1).
- **Champ omis quand non pertinent** : multi-familles / famille non mappable / scope zone absent (`by_categorie` sans dept ni commune). Pas de champ vide bruyant.
- **EFS (cat. 132)** : dans **biologie** (validé Cyril).
- **Gate pharmacie matview** : exclure écoles `300`/`330` + officines `620`/`627`/`628`/`629` + labos `610`/`611`/`612` + EFS `132`. GCS `696` INCLUS (PUI mutualisées légitimes, le sample montre les borderline).
- **Multi-familles** dans `etablissements_finess_in_radius` / `coverage` → `activite_hebergee` omis (sémantique non univoque).
- **Pas de Phase 2-bis « médecins »** : RPPS est complet, la Phase 1 a installé le routage Ameli→RPPS qui suffit.
