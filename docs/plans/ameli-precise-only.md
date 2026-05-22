# `precise_only` Ameli — handoff d'application

> Branche `feat/ameli-precise-only`. Préparé 2026-05-22. Câble le paramètre
> `precise_only` sur `professionnels_in_radius` (Ameli), jumeau du
> `precise_only` de `professionnels_rpps_in_radius` (V0.12.0).

## TL;DR

`professionnels_in_radius` (Ameli) gagne `precise_only` (boolean, défaut
false). À `true` : exclut les PS au centroïde commune, ne renvoie que les
~77 % géocodés à l'adresse BAN (`distance_km` exacte au m près). Tout le code
est prêt et revu sur la branche, le GATE EXPLAIN est passé. Il reste **une
seule action manuelle** : appliquer la migration SQL en prod, puis merger.

## Ce qui est déjà fait sur la branche

| Fichier | Changement |
|---|---|
| `supabase/migrations/20260522T003000_ameli_in_radius_precise_only.sql` | RPC `ameli_in_radius` + `p_precise_only BOOLEAN DEFAULT FALSE` |
| `src/sante/ameli-db.ts` | `AmeliInRadiusInput.preciseOnly`, `getAmeliInRadius` propage le param |
| `src/sante/db-helpers.ts` | helper `validatePreciseOnly` (partagé avec `getRppsInRadius`) |
| `api/tools.ts` | schéma `precise_only` + handler + description du tool |
| `api/tools.test.ts`, `src/sante/ameli-db.test.ts` | tests (propagation, garde, note 0-résultat, schéma, boundary) |
| `CHANGELOG.md` | entrée `### Added` sous `[Unreleased]` |

Vérifié : `tsc` + `lint` clean, 1313 tests unit verts, 10/10 tests
d'intégration Ameli verts. Migration exécutée en transaction `ROLLBACK` sur
Supabase local — fonction appelée dans les 2 modes (hybride + precise), SQL
dynamique parsé/planifié/exécuté, conformité `RETURNS TABLE` OK. Discipline
`/simplify` (3 agents) + `/review` P1 (3 agents) + P2 (2 agents) passée —
verdict **clean**.

## Pourquoi `RETURN QUERY EXECUTE format(...)` et pas une requête statique

Le filtre `geom_source = 'ban_address'` doit être un **littéral** dans le SQL
pour que le planner puisse élire le GiST PARTIEL
`annuaire_ameli_geog_precise_gist`. Deux pièges écartés :

1. **Condition paramétrée** (`NOT p_precise_only OR geom_source = ...`) : sous
   un generic plan plpgsql, le placeholder rend le partiel inéligible.
2. **`RETURN QUERY` statique** : met le plan en cache, peut basculer en generic
   plan après ~5 appels.

Dans les deux cas → repli sur le GiST GLOBAL `annuaire_ameli_geog_gist` +
Filter post-index → en zone dense le bbox ramène le cluster co-localisé
`commune_centroid` → timeout 57014 (piège prouvé prod RPPS, gotchas CLAUDE.md).

La parade : `RETURN QUERY EXECUTE format(...)` — chaque appel re-planifié en
custom plan (jamais de generic plan), et le fragment `%s` injecte le littéral
`AND geom_source = 'ban_address'` quand `precise_only`. Même pattern que la
fonction voisine `ameli_by_specialite_dept`.

Pas besoin du chantier lourd RPPS (split CTE + matview `ameli_commune_centroids`
+ DROP du GiST global) : `annuaire_ameli` ~462 K lignes dont ~77 % en adresse
BAN, clusters centroïde résiduels ~25-75× plus petits que RPPS.

## GATE EXPLAIN — ✅ PASSÉ le 2026-05-22

Exécuté en prod (Paris centre, rayon 1 km). Résultats :

| Chemin | Index élu | Execution Time | Verdict |
|---|---|---|---|
| precise (`geom_source = 'ban_address'`) | `annuaire_ameli_geog_precise_gist` (partiel) | 149 ms (cache froid) | **GO** |
| hybride (sans filtre) | `annuaire_ameli_geog_gist` (global) | 52 ms | référence OK |

Les 3 critères GO remplis : temps < 500 ms (20× sous le budget `anon` 3 s),
Index Scan GiST (le PARTIEL pour le chemin précis — le 57014 ne se déclenche
pas), aucun `Rows Removed by Filter`. Le 149 ms est du cache froid (le GiST
partiel n'avait jamais été interrogé) — plus rapide à chaud.

## Application — ce qu'il reste à faire

**Étape 1 — appliquer la migration** : coller le contenu de
`supabase/migrations/20260522T003000_ameli_in_radius_precise_only.sql` dans le
SQL editor Supabase (projet france-data) et exécuter.

**Étape 2 — smoke test prod** :

```sql
-- hybride (défaut) : doit renvoyer un mélange ban_address / commune_centroid
SELECT geom_source, count(*) FROM ameli_in_radius(48.8566, 2.3522, 2000, '{}', '{}', 50) GROUP BY 1;
-- precise_only=true : doit renvoyer UNIQUEMENT ban_address
SELECT geom_source, count(*) FROM ameli_in_radius(48.8566, 2.3522, 2000, '{}', '{}', 50, true) GROUP BY 1;
```

**Étape 3 — déployer le code** :

```
git checkout main
git merge feat/ameli-precise-only
git push            # déclenche CI + déploiement Vercel
```

Ordre : migration d'abord, déploiement ensuite. Le code reste de toute façon
sûr — `getAmeliInRadius` n'envoie `p_precise_only` que quand un caller passe
`precise_only=true` ; un appel hybride reste à 6 args, compatible avec ou sans
la migration.

`/simplify` + `/review` (P1 + P2) déjà passés — rien à relancer avant le merge.

## Si un jour le chemin précis régresse (Plan B)

Cloner le pattern RPPS complet : matview `ameli_commune_centroids` (1 ligne /
commune) + `ameli_in_radius` restructurée en `precise` (GiST partiel) UNION
ALL `centroid` (matview + CROSS JOIN LATERAL) + DROP du GiST global +
`ingest_create_annuaire_ameli_staging` mis à jour + parité staging. Chantier
lourd documenté pour RPPS dans `CLAUDE.md` (`20260516T050000`,
`20260520T100000`). Non nécessaire au vu du GATE — tracé par sécurité.
