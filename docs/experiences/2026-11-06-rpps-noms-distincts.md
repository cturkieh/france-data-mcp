# Banc : recherche RPPS par nom via un index de noms distincts

**Date :** 2026-11-06. **Statut :** banc concluant, implémentation en attente de validation.

## Question

Un index trigramme sur les noms distincts supprime-t-il les timeouts de `rpps_search_by_name` (HTTP 500 PostgREST, SQLSTATE 57014, coupure à 10 s), sans perdre de résultats ?

## Protocole

En prod, dans une seule transaction, sur des tables temporaires `ON COMMIT DROP` :

1. Construire la liste des noms distincts avec leurs identifiants, et un index trigramme.
2. Pour chaque terme : trouver les noms proches (`%`, seuil 0,3), les trier par similarité, garder 2 000 lignes au plus.
3. Lire ces lignes dans `rpps` par clé primaire, à la place du futur index sur `lower(nom)`.

La référence est l'`EXPLAIN ANALYZE` de la requête de candidats actuelle, à plafond et filtre de catégorie identiques.

## Coût

21 s de lecture sur la base de prod, aucune écriture permanente, aucun service payant.

## Résultats

434 590 noms distincts. Index de 12 Mo, contre 99 Mo pour l'index trigramme actuel.

| Terme | Correspondances (actuel = banc) | Blocs, actuel | Blocs, banc | Durée, actuelle | Durée, banc |
|---|---:|---:|---:|---:|---:|
| `ab` | 805 | 70 547 | 782 | 22,6 s | 1,0 s |
| nom rare, 5 lettres | 3 718 | 21 654 | 1 949 | 6,8 s | 2,2 s |
| `test` | 1 359 | non mesuré | 1 328 | 10 s (coupée, prod) | 1,3 s |
| `martin` | 21 364 | 3 342 | 1 916 | 0,9 s | 1,9 s |
| `le` | 24 542 | non mesuré | 1 929 | non mesurée | 1,8 s |
| `de la` | 2 693 | non mesuré | 1 950 | non mesurée | 1,7 s |

**Perte de résultats actuelle.** Pour le nom rare, 6 personnes portent exactement ce nom ; la RPC en renvoie 3, même quand elle aboutit. Le plafond de 2 000 candidats s'applique avant le tri, sur des lignes arbitraires. En triant d'abord par similarité, le banc lit les 6.

## Limites

- Les durées sont indicatives : le cache était déjà chauffé par les mesures précédentes. Le nombre de blocs est la mesure robuste.
- `martin` ne gagne rien (1,9 s contre 0,9 s). Lire seulement les lignes renvoyées à l'appelant pourrait l'améliorer ; non mesuré.
- Non testés : les filtres `prenom` et `departement`, le filtre de catégorie avant plafond, la reconstruction après swap, le coût du futur index sur `lower(nom)`.

## Décision

Retenir cette piste. `work_mem` à 64 Mo est écarté : il supprime les blocs lossy, sans changer la durée (23,8 s sur `ab`). Preuve attendue après implémentation : `EXPLAIN` sur ces termes, comparaison perdu/gagné/identique des résultats, parité des index prod et staging.
