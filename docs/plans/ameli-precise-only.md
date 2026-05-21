# `precise_only` Ameli — handoff d'application

> Branche `feat/ameli-precise-only`. Préparé 2026-05-22. Câble le paramètre
> `precise_only` sur `professionnels_in_radius` (Ameli), jumeau du
> `precise_only` de `professionnels_rpps_in_radius` (V0.12.0).

## TL;DR

`professionnels_in_radius` (Ameli) gagne `precise_only` (boolean, défaut
false). À `true` : exclut les PS au centroïde commune, ne renvoie que les
~77 % géocodés à l'adresse BAN (`distance_km` exacte au m près). Tout le code
est prêt sur la branche ; il reste **une seule action manuelle** : appliquer
la migration SQL en prod (après un check EXPLAIN).

## Ce qui est déjà fait sur la branche

| Fichier | Changement |
|---|---|
| `supabase/migrations/20260522T003000_ameli_in_radius_precise_only.sql` | RPC `ameli_in_radius` + `p_precise_only BOOLEAN DEFAULT FALSE` |
| `src/sante/ameli-db.ts` | `AmeliInRadiusInput.preciseOnly`, `getAmeliInRadius` propage le param |
| `api/tools.ts` | schéma `precise_only` + handler + description du tool |
| `api/tools.test.ts`, `src/sante/ameli-db.test.ts` | tests (propagation, garde, note 0-résultat, schéma, boundary) |
| `CHANGELOG.md` | entrée `### Added` sous `[Unreleased]` |

Vérifié : `tsc` + `lint` clean, 1313 tests unit verts, 10/10 tests
d'intégration Ameli verts, SQL de la migration exécuté en transaction
`ROLLBACK` sur Supabase local (DROP/CREATE/GRANT/COMMENT OK, signature 7
params correcte).

## Pourquoi une requête plate et pas le split CTE de RPPS

`rpps_in_radius` a dû éclater en CTE `precise` + CTE `centroid` + matview
`rpps_commune_centroids` parce que RPPS pré-V0.12 avait 2,2 M lignes TOUTES au
centroïde commune (cluster Paris ~77 K lignes co-localisées → timeout 57014).
`annuaire_ameli` est à une autre échelle : ~462 K lignes, ~77 % déjà en
adresse BAN précise depuis le Chantier C, les ~23 % résiduels au centroïde
répartis sur ~35 K communes (pire cluster ≈ quelques milliers de lignes). La
requête plate `ameli_in_radius` actuelle absorbe déjà ces clusters en prod.
`precise_only=true` n'ajoute qu'un filtre `geom_source` qui RÉDUIT le travail.

## ⚠️ GATE — check EXPLAIN AVANT d'appliquer la migration

`annuaire_ameli` porte à la fois un GiST global (`annuaire_ameli_geog_gist`)
et le GiST partiel (`annuaire_ameli_geog_precise_gist`). C'est la config qui a
causé les 57014 RPPS (le planner peut préférer le global et reléguer
`geom_source` en Filter post-index). Le risque est faible à l'échelle Ameli
mais **non prouvé** — discipline projet : prouver par la prod avant
d'appliquer.

**Étape 1 — exécuter ce EXPLAIN dans le SQL editor Supabase** (zone Paris
centre dense, rayon 1 km, branche précise) :

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT a.id,
       ST_Distance(a.geog, ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography) AS d
FROM annuaire_ameli a
WHERE a.geog IS NOT NULL
  AND ST_DWithin(a.geog, ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography, 1000)
  AND a.geom_source = 'ban_address'
ORDER BY a.geog <-> ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography
LIMIT 100;
```

**Critères GO (les trois doivent être vrais)** :
- `Execution Time` < ~500 ms (le rôle `anon` a un `statement_timeout` de 3 s) ;
- un `Index Scan` GiST (`annuaire_ameli_geog_precise_gist` OU
  `annuaire_ameli_geog_gist`), PAS un `Seq Scan` ;
- pas de `Rows Removed by Filter` à 6 chiffres.

**Si GO** → étape 2. **Si NO-GO** (seq scan, ou temps qui explose, ou filtre
qui jette des centaines de milliers de lignes) → NE PAS appliquer, voir
« Plan B » plus bas.

**Étape 2 — appliquer la migration** : coller le contenu de
`supabase/migrations/20260522T003000_ameli_in_radius_precise_only.sql` dans le
SQL editor Supabase et exécuter.

**Étape 3 — smoke test prod** :

```sql
-- hybride (défaut) : doit renvoyer un mélange ban_address / commune_centroid
SELECT geom_source, count(*) FROM ameli_in_radius(48.8566, 2.3522, 2000, '{}', '{}', 50) GROUP BY 1;
-- precise_only=true : doit renvoyer UNIQUEMENT ban_address
SELECT geom_source, count(*) FROM ameli_in_radius(48.8566, 2.3522, 2000, '{}', '{}', 50, true) GROUP BY 1;
```

## Après la migration — déployer le code

```
git checkout main
git merge feat/ameli-precise-only
git push            # déclenche CI + déploiement Vercel
```

Le code est sûr à déployer UNIQUEMENT après la migration : `getAmeliInRadius`
n'envoie `p_precise_only` que quand un caller passe `precise_only=true` (un
appel hybride reste à 6 args, compatible avec ou sans la migration). Donc même
si le déploiement précédait l'application SQL, le mode hybride continuerait de
fonctionner — seul `precise_only=true` échouerait tant que la migration n'est
pas là. Ordre recommandé quand même : migration d'abord, déploiement ensuite.

Avant le `git push` : lancer `/simplify` puis `/review` (P1 + P2) sur le diff
de la branche — discipline projet pour un `feat` (non faite côté préparation,
à faire dans la session « demain matin »).

## Plan B (si le GATE EXPLAIN est NO-GO)

Cloner le pattern RPPS complet : matview `ameli_commune_centroids` (1 ligne /
commune) + `ameli_in_radius` restructurée en `precise` (GiST partiel) UNION
ALL `centroid` (matview + CROSS JOIN LATERAL) + DROP du GiST global +
`ingest_create_annuaire_ameli_staging` mis à jour + parité staging. C'est le
chantier lourd documenté pour RPPS dans les gotchas de `CLAUDE.md`
(`20260516T050000`, `20260520T100000`). À ne faire que si la requête plate ne
tient pas — improbable à l'échelle Ameli, mais tracé ici par sécurité.
