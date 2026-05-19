# ban_join — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use `- [ ]` for tracking.
> Spec : `docs/plans/2026-05-19-ban-join-design.md`. Contexte :
> `docs/plans/2026-05-19-HANDOFF-etat-et-suite.md` + `CLAUDE.md` (gotchas DB).

**Goal:** Remplacer le step BAN cassé du cron RPPS (build index lourd + géocodage
API, structurellement timeouté à 60 s) par `ban_join` : un UPDATE batché
`rpps_staging ⟕ geocoded_addresses` piloté par curseur keyset, jumeau de
`finess_join`.

**Architecture:** Une RPC SQL `ingest_apply_rpps_ban_join_batch(p_after,p_limit)`
(prédicat/expression byte-identiques à la parité existante, `statement_timeout`
fonction < 60 s) pilotée par un helper keyset générique côté TS. Suppression du
câblage des steps 5c/5d/5e et de `runBanGeocodeStep`. Backfill (`ban-backfill.mjs`)
inchangé (hors scope, décidé PO).

**Tech Stack:** TypeScript strict, Vercel/Supabase PostGIS, pnpm, vitest, biome.
Migration appliquée par canal psql manuel (naming `YYYYMMDDThhmmss` — la CLI
Supabase la saute, cf. convention projet).

---

## File Structure

- **Create** `supabase/migrations/20260519T180000_ingest_apply_rpps_ban_join_batch.sql`
  — la RPC `ban_join` (responsabilité : pose ensembliste cache→staging, 1 lot).
- **Modify** `scripts/ingest/shared.ts` — ajoute `runKeysetRpc` (boucle keyset
  générique, à côté de `runBatchedRpc`).
- **Modify** `scripts/ingest/rpps.ts` — remplace blocs 5c/5d/5e (≈514-591) par
  l'appel `ban_join` ; supprime `runBanGeocodeStep` (≈997-1444) + `__TESTING__`
  associé ; nettoie constantes/imports orphelins.
- **Modify** `scripts/ingest/shared.test.ts` — tests unitaires `runKeysetRpc`.
- **Modify** `scripts/ingest/rpps.test.ts` — retire `describe runBanGeocodeStep`,
  ajoute tests boucle `ban_join`.
- **Modify** `scripts/ingest/enrichment-statement-timeout.test.ts` — invariant
  `statement_timeout ≤ 55s` étendu à `ingest_apply_rpps_ban_join_batch`.
- **Modify** `scripts/ingest/ban-eligibility-predicate-parity.test.ts` &
  `ban-eligibility-index-expr-parity.test.ts` — la nouvelle RPC entre dans le
  périmètre de parité prédicat/expression.
- **Create** `scripts/ingest/ban-join.integration.test.ts` — intégration DB locale.
- **Modify** `CLAUDE.md`, `CHANGELOG.md`, mémoires, HANDOFF.

---

## Task 1: Migration SQL `ingest_apply_rpps_ban_join_batch`

**Files:**
- Create: `supabase/migrations/20260519T180000_ingest_apply_rpps_ban_join_batch.sql`

- [ ] **Step 1: Écrire la migration**

```sql
-- ban_join — refonte 2026-05-19. Cf. docs/plans/2026-05-19-ban-join-design.md.
--
-- Remplace le step BAN cron cassé (build index lourd via RPC PostgREST,
-- timeouté structurellement au cap passerelle 60 s — réfuté prod run
-- #26087010166) par un UPDATE ensembliste rpps_staging ⟕ geocoded_addresses,
-- jumeau de ingest_apply_rpps_finess_enrichment_batch, PILOTÉ PAR CURSEUR
-- KEYSET (p_after) — PAS par sentinelle (l'approche sentinelle re-scanne le
-- préfixe traité → quadratique → 57014 en fin de parcours, RÉFUTÉ prod :
-- proxy OFFSET 1.2M > 120 s ; keyset = ~4,8 s/lot constant, prouvé prod).
--
-- PARITÉ BYTE-À-BYTE (garde-fou dur) : l'expression
-- rpps_address_key_for_index(adresse,code_postal,code_insee) ET le prédicat
-- geom_source='commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL)
-- sont byte-identiques à rpps_distinct_eligible_keys / rpps_count_ban_eligible_rows
-- / ingest_build_rpps_staging_ban_indexes (gardés par
-- ban-eligibility-{index-expr,predicate}-parity.test.ts). statement_timeout
-- fonction = '55s' (< cap passerelle PostgREST 60 s — gotcha CLAUDE.md ;
-- gardé par enrichment-statement-timeout.test.ts).
--
-- APPLICATION : naming YYYYMMDDThhmmss → la CLI Supabase saute ce fichier
-- (db reset ne l'applique pas) ; appliquée MANUELLEMENT en prod via le canal
-- psql pooler. CREATE OR REPLACE, signature stable, idempotente, rejouable.

CREATE OR REPLACE FUNCTION ingest_apply_rpps_ban_join_batch(
  p_after BIGINT, p_limit INT)
RETURNS TABLE(last_id BIGINT, applied INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT id,
           rpps_address_key_for_index(adresse, code_postal, code_insee) AS akey
    FROM rpps_staging
    WHERE id > p_after
      AND (geom_source = 'commune_centroid'
           OR (geom IS NULL AND adresse IS NOT NULL))
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
    RETURNING 1
  )
  SELECT max(b.id)::BIGINT AS last_id,
         (SELECT count(*)::INT FROM upd) AS applied
  FROM batch b;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_ban_join_batch(BIGINT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_rpps_ban_join_batch(BIGINT, INT) TO service_role;

COMMENT ON FUNCTION ingest_apply_rpps_ban_join_batch(BIGINT, INT) IS
  'ban_join (refonte 2026-05-19, cf. docs/plans/2026-05-19-ban-join-design.md) — pose ensembliste cache geocoded_addresses → rpps_staging pour UN lot keyset (p_after BIGINT curseur, p_limit INT). Jumeau de ingest_apply_rpps_finess_enrichment_batch mais piloté CURSEUR KEYSET (p_after), pas sentinelle (sentinelle = re-scan quadratique → 57014 fin de parcours, réfuté prod ; keyset ~4,8s/lot constant, prouvé prod). RETURNS (last_id = max(id) du lot VU matché ou non = curseur ; NULL ⇒ page vide ⇒ fin ; applied = nb réellement posés). JOIN (pas LEFT JOIN) + zéro sentinelle : une ligne non cachée garde commune_centroid (repli ~3km). Expression rpps_address_key_for_index + prédicat geom_source=commune_centroid OR (geom NULL AND adresse NOT NULL) byte-identiques à rpps_distinct_eligible_keys / rpps_count_ban_eligible_rows / ingest_build_rpps_staging_ban_indexes (gardes ban-eligibility-*-parity). SECURITY DEFINER, SET statement_timeout=55s (< cap passerelle 60s, garde enrichment-statement-timeout), EXECUTE service_role only. Idempotente, rejouable. Naming T-format : CLI Supabase la saute, appliquée manuellement via canal psql.';
```

- [ ] **Step 2: Appliquer en local (DB de test) pour les tests d'intégration**

Run: `pnpm db:start` puis appliquer la migration via psql local :
```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d '"')" -f supabase/migrations/20260519T180000_ingest_apply_rpps_ban_join_batch.sql
```
Expected: `CREATE FUNCTION` / `REVOKE` / `GRANT` / `COMMENT` sans erreur.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260519T180000_ingest_apply_rpps_ban_join_batch.sql
git commit -m "feat(ingest): RPC ingest_apply_rpps_ban_join_batch (keyset, jumeau finess)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Helper keyset générique `runKeysetRpc`

**Files:**
- Modify: `scripts/ingest/shared.ts` (à côté de `runBatchedRpc`, ≈ ligne 640)
- Test: `scripts/ingest/shared.test.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter dans `scripts/ingest/shared.test.ts` :

```typescript
describe("runKeysetRpc", () => {
  it("avance le curseur p_after et s'arrête sur last_id NULL (page vide)", async () => {
    const calls: number[] = [];
    const supabase = {
      rpc: (_n: string, p: { p_after: number; p_limit: number }) => {
        calls.push(p.p_after);
        if (p.p_after === 0) return Promise.resolve({ data: [{ last_id: 100, applied: 7 }], error: null });
        if (p.p_after === 100) return Promise.resolve({ data: [{ last_id: 250, applied: 3 }], error: null });
        return Promise.resolve({ data: [{ last_id: null, applied: 0 }], error: null });
      },
    } as unknown as Parameters<typeof runKeysetRpc>[0];
    const res = await runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 2000);
    expect(calls).toEqual([0, 100, 250]);
    expect(res).toEqual({ totalApplied: 10, iterations: 3 });
  });

  it("throw IngestError si le curseur ne progresse pas (régression contrat)", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: [{ last_id: 50, applied: 0 }], error: null }),
    } as unknown as Parameters<typeof runKeysetRpc>[0];
    // p_after part de 0 → 50 → 50 (stagne) → garde de non-progression
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(
      /did not progress|non-progress/i,
    );
  });

  it("throw IngestError sur erreur RPC", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    } as unknown as Parameters<typeof runKeysetRpc>[0];
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(/boom/);
  });

  it("throw IngestError si la forme de retour est inattendue (contrat)", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: 42, error: null }),
    } as unknown as Parameters<typeof runKeysetRpc>[0];
    await expect(runKeysetRpc(supabase, "rpc_x", { p_limit: 100 }, 10)).rejects.toThrow(
      /contract regression/i,
    );
  });
});
```

Ajouter l'import : dans `shared.test.ts`, étendre l'import existant depuis
`./shared.js` avec `runKeysetRpc`.

- [ ] **Step 2: Lancer les tests — vérifier l'échec**

Run: `pnpm vitest run scripts/ingest/shared.test.ts -t runKeysetRpc`
Expected: FAIL — `runKeysetRpc is not exported` / not a function.

- [ ] **Step 3: Implémenter `runKeysetRpc`**

Dans `scripts/ingest/shared.ts`, après `runBatchedRpc` (après sa `}` ≈ ligne 640) :

```typescript
/**
 * Pilote keyset générique pour une RPC d'application batchée par CURSEUR
 * (≠ runBatchedRpc qui s'appuie sur un prédicat auto-rétrécissant / sentinelle).
 * La RPC DOIT accepter `p_after` (curseur) + les `params` fixes, et renvoyer
 * UNE ligne `{ last_id: bigint|null, applied: int }` : `last_id` = dernière clé
 * VUE (matchée ou non) du lot ; `null` ⇒ page vide ⇒ fin. Garde de
 * NON-PROGRESSION : si `last_id` n'augmente pas strictement → IngestError
 * (régression de contrat : rows updated mais curseur figé = boucle infinie).
 * Pourquoi keyset et non sentinelle : prouvé prod (cf.
 * docs/plans/2026-05-19-ban-join-design.md §3.2) — la sentinelle re-scanne le
 * préfixe déjà traité (quadratique → 57014 en fin de parcours) ; le keyset
 * démarre où le lot précédent s'est arrêté (linéaire, ~constant/lot).
 * Borne anti-hang `withTimeout` par appel (cron non surveillé).
 */
export async function runKeysetRpc(
  supabase: SupabaseClient,
  rpcName: string,
  params: Record<string, unknown>,
  expectedTotal: number,
  perCallTimeoutMs: number = RPC_BATCH_TIMEOUT_MS,
): Promise<{ totalApplied: number; iterations: number }> {
  const batchSize = Number(params.p_limit) || 1;
  const maxIterations = Math.ceil(Math.max(expectedTotal, 1) / batchSize) + 5;
  let after = 0;
  let totalApplied = 0;
  let iter = 0;
  while (true) {
    if (++iter > maxIterations) {
      throw new IngestError(
        "validate",
        `${rpcName} did not converge after ${maxIterations} batches — likely RPC contract regression (cursor not advancing)`,
      );
    }
    const call = supabase.rpc(rpcName, { ...params, p_after: after });
    let result: Awaited<typeof call>;
    try {
      result = await withTimeout(call, perCallTimeoutMs, `${rpcName} (batch ${iter})`);
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        console.error(
          `[france-data-mcp][ingest] ${rpcName} timed out after ${perCallTimeoutMs}ms (batch ${iter}) — anti-silent-hang bound tripped, failing loud`,
        );
        throw new IngestError(
          "validate",
          `${rpcName} timed out after ${perCallTimeoutMs}ms (batch ${iter}) — possible hung apply RPC (anti-silent-hang bound)`,
        );
      }
      console.error(
        `[france-data-mcp][ingest] ${rpcName} (batch ${iter}) threw a non-timeout error, re-raising`,
      );
      throw e;
    }
    const { data, error } = result;
    if (error) {
      throw new IngestError("validate", `${rpcName} failed: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (
      row == null ||
      typeof row !== "object" ||
      !("last_id" in row) ||
      !("applied" in row) ||
      typeof (row as { applied: unknown }).applied !== "number"
    ) {
      throw new IngestError(
        "validate",
        `${rpcName} returned an unexpected shape instead of { last_id, applied } — RPC contract regression`,
      );
    }
    const lastId = (row as { last_id: number | null }).last_id;
    const applied = (row as { applied: number }).applied;
    totalApplied += applied;
    if (lastId == null) return { totalApplied, iterations: iter };
    if (lastId <= after) {
      throw new IngestError(
        "validate",
        `${rpcName} cursor did not progress (after=${after} last_id=${lastId}) — RPC contract regression (rows seen but cursor frozen)`,
      );
    }
    after = lastId;
  }
}
```

- [ ] **Step 4: Lancer les tests — vérifier le succès**

Run: `pnpm vitest run scripts/ingest/shared.test.ts -t runKeysetRpc`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest/shared.ts scripts/ingest/shared.test.ts
git commit -m "feat(ingest): runKeysetRpc — pilote keyset générique (anti re-scan quadratique)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Brancher `ban_join` dans le cron (remplace 5c/5d/5e)

**Files:**
- Modify: `scripts/ingest/rpps.ts:514-591` (blocs 5c, 5d, 5e)

- [ ] **Step 1: Remplacer les blocs 5c+5d+5e**

Supprimer intégralement les lignes 514 à 591 (commentaire `// 5c. BUILD INDEX
BAN …` jusqu'à `await runBanGeocodeStep(supabase, log, "rpps_staging");`
inclus) et insérer à la place :

```typescript
    // 5c. BAN_JOIN — pose ensembliste du cache geocoded_addresses (déjà rempli
    // par ban-backfill.mjs, hors cron) dans rpps_staging, jumeau de
    // l'enrichment FINESS (5b) mais piloté CURSEUR KEYSET. Remplace l'ancien
    // build d'index lourd + géocodage API (timeouté structurellement au cap
    // passerelle 60 s — réfuté prod #26087010166). Cf.
    // docs/plans/2026-05-19-ban-join-design.md. fail-loud : une erreur SQL
    // réelle → IngestError → run échoué visible, rpps + cache intacts (avant
    // swap). Le géocodage des NOUVELLES adresses reste ban-backfill.mjs (manuel,
    // hors scope). expectedTotal = nb de lignes éligibles (count RPC dédié,
    // borne maxIterations de la garde de convergence).
    const { data: banEligibleData, error: banEligibleErr } = await withTimeout(
      supabase.rpc("rpps_count_ban_eligible_rows", { p_source_table: "rpps_staging" }),
      RPC_READ_TIMEOUT_MS,
      "rpps_count_ban_eligible_rows",
    );
    if (banEligibleErr) {
      throw new IngestError(
        "validate",
        `Failed to count BAN-eligible rows: ${banEligibleErr.message}${missingRpcHint(banEligibleErr.message)}`,
      );
    }
    const banEligible = parseRpcCount(banEligibleData, "rpps_count_ban_eligible_rows");
    if (banEligible > 0) {
      const { totalApplied: banApplied, iterations: banIterations } = await runKeysetRpc(
        supabase,
        "ingest_apply_rpps_ban_join_batch",
        { p_limit: BAN_JOIN_BATCH_SIZE },
        banEligible,
        RPC_BATCH_TIMEOUT_MS,
      );
      console.log(
        `[rpps] ban_join: ${banApplied} posed / ${banEligible} eligible in ${banIterations} batches`,
      );
      // Sentinelle de cohérence (style FINESS 5b) : 0 posé alors que le cache
      // contient des adresses acceptées plausibles ⇒ suspicion de dérive de
      // clé (parité RPC↔cache cassée) → throw loud (jamais un succès muet
      // sur une régression silencieuse de normalisation).
      if (banApplied === 0) {
        const { count: cacheAccepted, error: cacheErr } = await supabase
          .from("geocoded_addresses")
          .select("*", { count: "exact", head: true })
          .eq("accepted", true);
        if (cacheErr) {
          throw new IngestError(
            "validate",
            `ban_join posed 0 rows; cache sanity check failed: ${cacheErr.message}`,
          );
        }
        if ((cacheAccepted ?? 0) > 0) {
          throw new IngestError(
            "validate",
            `ban_join posed 0 rows over ${banEligible} eligible while geocoded_addresses has ${cacheAccepted} accepted — suspected address-key parity drift (RPC vs cache)`,
          );
        }
      }
    } else {
      console.log("[rpps] ban_join: 0 eligible rows, skipped");
    }
```

- [ ] **Step 2: Ajouter la constante `BAN_JOIN_BATCH_SIZE`**

Dans `scripts/ingest/rpps.ts`, près de `const ENRICH_BATCH_SIZE = 10_000;`
(ligne 89), ajouter :

```typescript
// Taille de lot ban_join. 10k = même ordre que l'enrichment FINESS ; prouvé
// prod ~4,8 s/lot scan keyset constant (cf. design §3.2), large sous le
// budget statement_timeout 55s de la RPC.
const BAN_JOIN_BATCH_SIZE = 10_000;
```

- [ ] **Step 3: Mettre à jour l'import depuis `./shared.js`**

Dans le bloc d'import lignes 25-43, ajouter `runKeysetRpc,` (ordre alpha,
après `runIfMain,` → en réalité après `runBatchedRpc,`).

- [ ] **Step 4: Vérifier la compilation**

Run: `pnpm typecheck`
Expected: peut signaler des imports/constantes BAN désormais inutilisés
(`geocodeAddressesBatch`, `banLastStatus`, `BanGeocodeResult`,
`runBanGeocodeStep` encore présent) → traités Task 4. Aucune erreur sur le
nouveau bloc 5c.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest/rpps.ts
git commit -m "feat(ingest): branche ban_join keyset dans le cron (remplace 5c/5d/5e)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Supprimer `runBanGeocodeStep` + nettoyer constantes/imports orphelins

**Files:**
- Modify: `scripts/ingest/rpps.ts` (≈997-1444 fonction + `__TESTING__` + jsdoc
  pipeline 950-996 + constantes BAN 125-187)

- [ ] **Step 1: Supprimer la fonction `runBanGeocodeStep`**

Supprimer le bloc JSDoc de `runBanGeocodeStep` + la fonction entière
(de `export async function runBanGeocodeStep(` ligne 997 à sa `}` fermante
ligne 1444 incluse). Supprimer aussi le JSDoc pipeline qui la décrit
(≈ lignes 950-996, le commentaire numéroté `0..8` du step BAN) s'il ne décrit
QUE `runBanGeocodeStep`.

- [ ] **Step 2: Retirer `runBanGeocodeStep` de `__TESTING__`**

Dans l'export `__TESTING__` (≈1446) retirer la ligne `runBanGeocodeStep,`.
Retirer aussi `BAN_MAX_NEW_PER_RUN,` du même export (constante supprimée
Step 3).

- [ ] **Step 3: Supprimer les constantes BAN orphelines**

Supprimer de `scripts/ingest/rpps.ts` les constantes désormais sans
consommateur (vérifiées par `grep -n` avant suppression — ne supprimer que
celles à 1 seul usage = leur déclaration) : `BAN_GEOCODE_BATCH_SIZE`,
`BAN_BULK_CHUNK`, `BAN_ACCEPT_SCORE`, `BAN_API_FAILURE_CEILING`,
`BAN_MAX_ATTEMPTS`, `BAN_MAX_NEW_PER_RUN`, `BAN_REQUEST_TIMEOUT_MS`,
`RPC_BUILD_INDEX_TIMEOUT_MS` + leurs commentaires.
**Garder** `RPC_READ_TIMEOUT_MS`, `RPC_BATCH_TIMEOUT_MS`,
`RPC_ANALYZE_TIMEOUT_MS`, `ENRICH_BATCH_SIZE`, `BAN_JOIN_BATCH_SIZE`
(consommés ailleurs).

Run de contrôle avant chaque suppression :
`grep -n "BAN_GEOCODE_BATCH_SIZE" scripts/ingest/rpps.ts` → si 1 seule ligne
(la déclaration), supprimer ; sinon investiguer le consommateur restant.

- [ ] **Step 4: Nettoyer les imports orphelins**

Dans l'import `../../src/core/index.js` (lignes 5-11), retirer
`type BanGeocodeResult,`, `banLastStatus,`, `geocodeAddressesBatch,` s'ils ne
sont plus référencés. Garder `parseRpcCount,` (utilisé par le nouveau bloc 5c)
et `withTimeout,`. Dans `./retry-transient.js` garder `retryTransient` si
encore utilisé ailleurs (vérifier `grep -n retryTransient scripts/ingest/rpps.ts`),
sinon retirer.

- [ ] **Step 5: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS, zéro import/constante inutilisé, zéro `any`.

- [ ] **Step 6: Commit**

```bash
git add scripts/ingest/rpps.ts
git commit -m "refactor(ingest): supprime runBanGeocodeStep + constantes/imports BAN orphelins

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Adapter les tests existants (parité, timeout, rpps.test)

**Files:**
- Modify: `scripts/ingest/rpps.test.ts` (describe runBanGeocodeStep ≈367-620)
- Modify: `scripts/ingest/enrichment-statement-timeout.test.ts`
- Modify: `scripts/ingest/ban-eligibility-predicate-parity.test.ts`
- Modify: `scripts/ingest/ban-eligibility-index-expr-parity.test.ts`

- [ ] **Step 1: rpps.test.ts — retirer le describe `runBanGeocodeStep`**

Supprimer le bloc `describe("runBanGeocodeStep", …)` entier (≈596+) et le stub
chaînable associé + l'import `runBanGeocodeStep` du `__TESTING__`. Ajouter à la
place un `describe("ban_join cron wiring", …)` minimal vérifiant que `main`
appelle bien `runKeysetRpc` sur `ingest_apply_rpps_ban_join_batch` (mock
supabase chaînable : `rpc("rpps_count_ban_eligible_rows")` → count, puis
`rpc("ingest_apply_rpps_ban_join_batch")` → `{last_id:null,applied:0}`). Si le
test de `main` est trop lourd à monter, couvrir plutôt par le test
d'intégration Task 6 et garder ici uniquement la suppression.

- [ ] **Step 2: enrichment-statement-timeout.test.ts — étendre l'invariant**

Après le `describe("fix C …")`, ajouter :

```typescript
describe("ban_join — statement_timeout fonction ≤ 55s (parité fix C)", () => {
  const BANJOIN = "ingest_apply_rpps_ban_join_batch";
  it("a un SET statement_timeout fonction", () => {
    const def = latestFunctionDef(BANJOIN);
    expect(
      def,
      `${BANJOIN} sans SET statement_timeout → hérite du budget 8s service_role→authenticator → 57014 déterministe (cron RPPS cassé)`,
    ).toMatch(/set\s+statement_timeout/i);
  });
  it("valeur ≤ 55s (sous le cap passerelle PostgREST ~60s)", () => {
    const secs = timeoutSeconds(latestFunctionDef(BANJOIN));
    expect(secs, `SET statement_timeout absent/illisible dans ${BANJOIN}`).not.toBeNull();
    expect(secs! > 0 && secs! <= 55, `statement_timeout=${secs}s : doit être >0 et ≤55s`).toBe(true);
  });
});
```

- [ ] **Step 3: ban-eligibility-*-parity.test.ts — ajouter ban_join au périmètre**

Dans chacun des 2 fichiers, repérer la liste des fonctions/RPC dont le
prédicat (resp. l'expression d'index) doit être byte-identique et y AJOUTER
`ingest_apply_rpps_ban_join_batch`. (Ouvrir le fichier, localiser le tableau de
noms RPC comparés — ex. `const RPCS = [...]` ou les `it(...)` par RPC — et
étendre.) Le prédicat attendu : `geom_source = 'commune_centroid' OR (geom IS
NULL AND adresse IS NOT NULL)` ; l'expression : `rpps_address_key_for_index(
adresse, code_postal, code_insee)`.

- [ ] **Step 4: Lancer toute la suite parité/timeout**

Run: `pnpm vitest run scripts/ingest/enrichment-statement-timeout.test.ts scripts/ingest/ban-eligibility-predicate-parity.test.ts scripts/ingest/ban-eligibility-index-expr-parity.test.ts scripts/ingest/staging-parity.test.ts scripts/ingest/rpps.test.ts`
Expected: PASS. Si `staging-parity` rougit (référence à
`ingest_build_rpps_staging_ban_indexes` devenue non câblée), adapter le test :
la RPC reste en base (réutilisable par le futur backfill) mais n'est plus dans
le périmètre « câblé par le cron » — ajuster l'assertion en conséquence, ne PAS
masquer un vrai garde-fou.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest/*.test.ts
git commit -m "test(ingest): parité+timeout étendus à ban_join, retrait tests runBanGeocodeStep

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Test d'intégration `ban_join` (DB locale)

**Files:**
- Create: `scripts/ingest/ban-join.integration.test.ts`

- [ ] **Step 1: Écrire le test d'intégration**

Calquer la structure sur `scripts/ingest/rpps-geocoded-cache-lookup.integration.test.ts`
(même bootstrap client service-role local + skip si pas de DB). Cas couverts :

```typescript
// Pseudocode des assertions (adapter au harness d'intégration existant) :
// Setup : insérer dans rpps_staging 4 lignes :
//   A geom_source='commune_centroid', adresse présente en cache accepted=true
//   B geom IS NULL, adresse présente en cache accepted=true
//   C geom_source='commune_centroid', adresse ABSENTE du cache
//   D geom_source='finess_join' (NON éligible)
// + insérer les clés A,B dans geocoded_addresses (accepted=true, lat/lon).
//
// Boucle keyset jusqu'à last_id NULL :
//   - A & B : geom_source='ban_address', geom = point attendu (lon/lat)
//   - C : reste 'commune_centroid', geom inchangé
//   - D : intact (jamais visité — hors prédicat)
//   - applied cumulé == 2 ; convergence atteinte (pas d'IngestError)
// Idempotence : 2e passe complète → applied == 0, dataset inchangé.
```

- [ ] **Step 2: Lancer le test d'intégration**

Run: `pnpm db:start && pnpm vitest run scripts/ingest/ban-join.integration.test.ts`
Expected: PASS (cache hit pose ban_address+geom ; miss conserve centroïde ;
non-éligible intact ; idempotence).

- [ ] **Step 3: Commit**

```bash
git add scripts/ingest/ban-join.integration.test.ts
git commit -m "test(ingest): intégration ban_join (hit/miss/non-éligible/idempotence)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Documentation (AVANT la chaîne discipline finale)

**Files:**
- Modify: `CLAUDE.md` (section « Top gotchas DB » + « Ingestion »)
- Modify: `CHANGELOG.md`
- Modify: `docs/plans/2026-05-19-HANDOFF-etat-et-suite.md`
- Modify: mémoire `~/.claude/projects/.../memory/` + `MEMORY.md`

- [ ] **Step 1: CLAUDE.md — nouveau gotcha**

Ajouter un gotcha : « ban_join = jumeau finess MAIS curseur keyset OBLIGATOIRE
(sentinelle pure re-scanne le préfixe → quadratique → 57014 fin de parcours,
réfuté prod proxy OFFSET 1.2M > 120 s ; keyset ~4,8 s/lot constant prouvé prod).
Steps 5c/5d/5e supprimés du cron ; `runBanGeocodeStep` supprimé ;
`ingest_build_rpps_staging_ban_indexes` conservée en base mais non câblée
(réutilisable backfill futur). Dette : `ban-backfill.mjs` dépend des index BAN
sur `rpps` — à traiter dans la feature automatisation backfill. »

- [ ] **Step 2: CHANGELOG.md — section en haut** (bump version mineure si la
  convention projet le veut pour une refonte pipeline ; sinon section
  `Unreleased`). Décrire : refonte BAN → ban_join keyset, suppression step
  cassé, hors scope backfill.

- [ ] **Step 3: HANDOFF — marquer §5 résolu**, pointer vers le spec + ce plan,
  acter que le blocage 4 jours est levé.

- [ ] **Step 4: Mémoire projet** — créer un fichier mémoire
  `ban-join-keyset-resolution.md` (fait durable : pourquoi keyset, preuves
  prod chiffrées, dette backfill) + 1 ligne dans `MEMORY.md`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md docs/plans/2026-05-19-HANDOFF-etat-et-suite.md
git commit -m "docs: ban_join — gotcha keyset, changelog, handoff résolu

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Chaîne discipline post-fix + livraison prod

- [ ] **Step 1: `/simplify`** (3 agents reuse/quality/efficiency) sur tout le
  diff de la branche → appliquer toutes les corrections.

- [ ] **Step 2: `/review` Passe 1** (code-reviewer + silent-failure-hunter +
  code-simplifier) → corriger TOUT, y compris hors scope, zéro TODO laissé.

- [ ] **Step 3: `/review` Passe 2** (code-reviewer + silent-failure-hunter) →
  corriger.

- [ ] **Step 4: Validation finale**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: tout vert. Puis `pnpm test` (DB locale) vert.

- [ ] **Step 5: Appliquer la migration en PROD** (canal psql autorisé) :

```bash
PGPASSWORD="$(cat ~/fdm-pass.txt)" docker exec -i -e PGPASSWORD supabase_db_france-data-public psql "$(cat ~/fdm-conn.txt)" -f - < supabase/migrations/20260519T180000_ingest_apply_rpps_ban_join_batch.sql
```
Vérifier : `\df+ ingest_apply_rpps_ban_join_batch` (présente, statement_timeout
55s, EXECUTE service_role).

- [ ] **Step 6: Run armé prod** (force, sans changement de source) :

```bash
gh workflow run ingest-rpps.yml --ref feat/rpps-ban-rearm -f force=true
gh run watch --exit-status
```
Expected : run vert, log `[rpps] ban_join: <N> posed / <M> eligible …`,
`rpps.geom_source='ban_address'` > 0 en prod après swap (vérifier via psql).

- [ ] **Step 7: Vérif prod post-swap**

```bash
PGPASSWORD="$(cat ~/fdm-pass.txt)" docker exec -i -e PGPASSWORD supabase_db_france-data-public psql "$(cat ~/fdm-conn.txt)" -P pager=off -c "SELECT geom_source, count(*) FROM rpps GROUP BY geom_source ORDER BY 2 DESC;"
```
Expected : `ban_address` ≈ 266 k (les adresses cachées posées), pas de
régression `finess_join`, `rpps_in_radius` fonctionnel (canary).

- [ ] **Step 8: `finishing-a-development-branch`** — PR vers `main` ou merge
  selon la décision PO (le HANDOFF interdit de merger le BAN cassé `6a2bbf3` ;
  cette branche le résout — PR avec récap des preuves prod).

---

## Self-Review (rempli par l'auteur du plan)

- **Spec coverage** : §3 design → Task 1+3 ; §4 périmètre → Task 3+4 ; §5
  robustesse → Task 2 (garde non-progression) + Task 3 (sentinelle cohérence) ;
  §6 tests → Task 2,5,6 ; §7 hors scope → respecté (backfill non touché) ; §8
  dette → Task 7 doc. ✅ Couvert.
- **Placeholders** : aucun « TBD/TODO » ; code complet pour RPC, helper, bloc
  cron, tests unitaires. Task 5 Step 3 / Task 6 décrivent l'adaptation au
  harness existant (lecture du fichier requise à l'exécution) — assumé, pas un
  placeholder de logique.
- **Type consistency** : `runKeysetRpc(supabase, rpcName, params, expectedTotal,
  perCallTimeoutMs)` cohérent Task 2 ↔ Task 3 ; RPC retourne
  `{last_id, applied}` cohérent SQL (Task 1) ↔ helper (Task 2) ↔ test (Task 6) ;
  `BAN_JOIN_BATCH_SIZE` défini Task 3 Step 2, utilisé Task 3 Step 1.
