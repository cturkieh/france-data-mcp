# Banc : recherche RPPS par nom via un index de noms distincts

**Date :** 2026-11-06. **Statut :** la liste seule est insuffisante, car elle dégrade les noms courants filtrés. Variante avec index classique à prouver sur une copie locale.

## Question

Un index trigramme sur les noms distincts supprime-t-il les timeouts de `rpps_search_by_name` (HTTP 500 PostgREST, SQLSTATE 57014, coupure à 10 s), sans perdre de résultats ?

## Protocole

En prod, dans une seule transaction, sur des tables temporaires `ON COMMIT DROP` :

1. Construire la liste des noms distincts avec leurs identifiants, et un index trigramme.
2. Pour chaque terme : trouver les noms proches (`%`, seuil 0,3), les trier par similarité, garder 2 000 lignes au plus.
3. Lire ces lignes dans `rpps` par clé primaire, à la place du futur index sur `lower(nom)`.

La référence est l'`EXPLAIN ANALYZE` de la requête de candidats actuelle, à plafond et filtre de catégorie identiques.

## Coût

Première série : 21 s de lecture sur la base de prod. Séries suivantes : moins de 4 minutes de lecture. Aucune écriture permanente, aucun service payant.

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

### Deuxième série : recherches filtrées

Même protocole, sans plafond avant filtre, au seuil de 0,3. Le prénom testé est `jean`, le département `75`. Les nombres de lignes sont identiques des deux côtés dans les 8 cas.

| Terme + filtre | Lignes | Blocs, actuel | Blocs, liste | Durée, actuelle | Durée, liste |
|---|---:|---:|---:|---:|---:|
| `ab` + département | 51 | 72 457 | 3 228 | 22,9 s | 0,7 s |
| nom rare + département | 282 | 58 532 | 14 930 | 18,3 s | 4,0 s |
| `test` + département | 51 | 13 727 | 5 456 | 3,5 s | 1,3 s |
| `martin` + département | 772 | 2 762 | **85 737** | 0,6 s | **14,3 s** |
| `ab` + prénom | 11 | 72 457 | 3 230 | 22,9 s | 0,09 s (cache chaud) |
| nom rare + prénom | 54 | 58 532 | 14 932 | 19,3 s | 0,10 s (cache chaud) |
| `test` + prénom | 25 | 13 727 | 5 456 | 3,5 s | 0,03 s (cache chaud) |
| `martin` + prénom | 386 | 2 720 | **48 188** | 0,6 s | **15,8 s** |

**Deux constats.** Avec un filtre, le plafond ne coupe plus la lecture : un nom court dépasse donc les 10 s à froid (18 à 23 s pour le nom rare et `ab`). Et la liste seule ferait dépasser ces 10 s à `martin` filtré, qui répond aujourd'hui en 0,6 s.

**Construction de la liste.** 9,4 s pour la liste et 2,1 s pour son index, sur une table temporaire qui porte aussi les identifiants. La reconstruction réelle après swap reste non mesurée.

### Piste plus simple : relever le seuil de similarité

Sans filtre, avec un plafond de 2 000 :

| Terme | Lignes, seuil 0,4 | Blocs, seuil 0,4 | Lignes, seuil 0,5 | Blocs, seuil 0,5 |
|---|---:|---:|---:|---:|
| nom rare, 5 lettres | 363 | 15 567 | 88 | 15 567 |
| `test` | 454 | 13 727 | 308 | 2 139 |
| `ab` | 71 | 9 761 | 8 | 9 761 |
| `martin` | 2 000 | 5 751 | 2 000 | 3 578 |

Le nom rare prend encore 10,5 s à froid au seuil de 0,5. La tolérance aux fautes s'effondre sur les noms courts, d'après un échantillon de 3 549 noms sans accent ni espace, avec une lettre modifiée au milieu du nom :

| Longueur | Noms | Lettre remplacée : retrouvés à 0,3 / 0,4 / 0,5 | Lettre oubliée : retrouvés à 0,3 / 0,4 / 0,5 |
|---|---:|---|---|
| 4-5 lettres | 752 | 74 % / 0 % / 0 % | 75 % / 7 % / 7 % |
| 6-7 lettres | 1 674 | 100 % / 100 % / 0 % | 100 % / 100 % / 58 % |
| 8-9 lettres | 880 | 100 % / 100 % / 100 % | 100 % / 100 % / 100 % |
| 10 lettres ou plus | 243 | 100 % / 100 % / 100 % | 100 % / 100 % / 100 % |

## Limites

- Les durées sont indicatives : elles dépendent du cache, chauffé par les mesures précédentes. Le nombre de blocs est la mesure robuste.
- Le côté « liste » lit chaque ligne par clé primaire, faute d'index sur `lower(nom)` en prod. C'est un majorant : un vrai index peut se combiner avec ceux du département et du prénom, ce qui n'a pas été mesuré.
- Non testés : le filtre de catégorie avant plafond, la reconstruction après swap, le coût du futur index sur `lower(nom)`, et la piste « nom exact d'abord » (elle laisserait les fautes de frappe sur le chemin lent).

## Décision

La liste seule est écartée. Le seuil relevé aussi : il ne supprime pas la lenteur et casse la tolérance aux fautes. `work_mem` à 64 Mo est écarté : il supprime les blocs lossy, sans changer la durée (23,8 s sur `ab`).

Piste à prouver : liste des noms plus index classique sur `lower(nom)`, combinable avec les filtres, sur une copie locale des données réelles. Critères : aucun cas de cette page au-delà de 10 s à froid, comparaison perdu/gagné/identique des résultats, `martin` filtré non dégradé, parité des index prod et staging, reconstruction réelle mesurée après swap. En cas d'échec sur `martin` : garder le chemin actuel pour les noms qui ont beaucoup de lignes.
