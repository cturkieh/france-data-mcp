# Banc : recherche RPPS par nom via un index de noms distincts

**Date :** 2026-11-06. **Statut :** concluant sur une copie locale des données réelles, avec une conception différente de la piste de départ (2 listes et 1 index). Migration appliquée en prod le 2026-11-06 et mesurée, résultats en fin de série ; code en PR.

## Question

Un index trigramme sur les noms distincts supprime-t-il les timeouts de `rpps_search_by_name` (HTTP 500 PostgREST, SQLSTATE 57014, coupure à 10 s), sans perdre de résultats ?

## Protocole

En prod, dans une seule transaction, sur des tables temporaires `ON COMMIT DROP` :

1. Construire la liste des noms distincts avec leurs identifiants, et un index trigramme.
2. Pour chaque terme : trouver les noms proches (`%`, seuil 0,3), les trier par similarité, garder 2 000 lignes au plus.
3. Lire ces lignes dans `rpps` par clé primaire, à la place du futur index sur `lower(nom)`.

La référence est l'`EXPLAIN ANALYZE` de la requête de candidats actuelle, à plafond et filtre de catégorie identiques.

## Coût

Première série : 21 s de lecture sur la base de prod. Deuxième série et seuil : moins de 4 minutes de lecture. Copie locale : téléchargement du fichier public (829 Mo) et environ 40 minutes de machine locale ; en prod, seulement des lectures de catalogue et de réglages, et un échantillon de 1 % pour la taille des lignes. Puis plusieurs passages locaux de 7 à 8 minutes, et une construction des 2 listes en prod sur des tables temporaires (22 s). Aucune écriture permanente, aucun service payant.

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

**Construction de la liste.** 9,4 s pour la liste et 2,1 s pour son index, sur une table temporaire qui porte aussi les identifiants. La mesure des 2 listes finales figure plus bas.

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

### Troisième série : copie locale des données réelles

**Protocole.** Postgres 17.10 jetable, avec les réglages de planification et de mémoire de la prod (`shared_buffers`, `work_mem`, `effective_cache_size`, `random_page_cost`, parallélisme). Données : le fichier RPPS public qui alimente la prod, version du 2026-11-06, 2 315 657 lignes (prod au 2026-11-05 : 2 315 279). Sans PostGIS, `geom` et `geog` sont remplacés par des `bytea` de même largeur. Les index de la prod sont repris, hors GiST.

**Calibrage.** Sur les 12 mesures de la prod, le rapport des blocs local/prod va de 0,63 à 1,32 et vaut le plus souvent 0,85. La table locale est plus compacte (84 000 pages contre 110 000 : pas de lignes mortes). Sur les 8 recherches filtrées, 7 rendent le même nombre de lignes et la dernière 3 de plus ; sans filtre, l'écart atteint 4 %.

**Conversion en durée.** Les lectures à froid sont comptées après vidage du cache Postgres (`pg_buffercache_evict`). Les mesures en prod donnent environ 3 000 lectures par seconde (68 648 en 22,9 s, 57 753 en 18,3 s, 44 626 en 15,8 s). Avec le rapport de 0,85, 25 000 lectures locales valent environ 10 s en prod. Cette durée est une estimation.

**Variantes écartées**, chacune sur un cas mesuré :

| Variante | Pire cas | Problème |
|---|---:|---|
| Liste + index sur `lower(nom)` | `le` + département : 26 633 blocs | Lit toutes les fiches des noms proches |
| Index composite, parcours nom par nom | `le` + département rare : 22 435 lectures (151 aujourd'hui) | Le parcours touche tout l'index quand le filtre est rare |
| Liste des noms, index trigramme gardé sur le prénom | `le` + `ab` : 84 095 lectures | Un prénom court fausse l'estimation : 129 lignes prévues, 289 942 candidats |
| 2 listes, parcours pour toute catégorie | `le` + catégorie `M` : 22 111 lectures (1 032 aujourd'hui) | Le parcours lit la table pour écarter les autres catégories |

**Conception retenue** (SQL en annexe) : deux vues matérialisées de valeurs distinctes, noms et prénoms, chacune avec son index trigramme ; un index `(nom, prenom, id)` sur `rpps` ; l'index département existant. Sans filtre, les noms sont parcourus du plus proche au plus lointain, avec arrêt à la limite. Avec un filtre, une seule requête prend les noms et prénoms proches. Les index trigrammes de `rpps` ne servent plus : seules `rpps_search_by_name` et la création du staging y font référence.

**Échantillon.** 278 personnes tirées au hasard (200 lignes, donc pondérées par la fréquence des noms, et 78 noms distincts) × 8 formes de recherche = 2 224 recherches, à limite 101. La référence est la même recherche sans aucun plafond.

Lectures à froid, version finale :

| Forme | Actuelle : médiane | Actuelle : maximum | Actuelle : au-delà de 10 s | Finale : médiane | Finale : maximum | Finale : au-delà de 10 s |
|---|---:|---:|---:|---:|---:|---:|
| Nom | 7 042 | 60 181 | 17 | 833 | 2 703 | 0 |
| Nom + département | 453 | 59 788 | 10 | 880 | 3 452 | 0 |
| Nom + prénom | 6 836 | 77 474 | 34 | 1 060 | 3 251 | 0 |
| Nom + prénom + département | 535 | 77 474 | 20 | 1 248 | 3 314 | 0 |
| Nom avec une faute | 4 556 | 59 713 | 23 | 515 | 2 568 | 0 |
| Nom avec une faute + prénom | 5 319 | 77 474 | 31 | 648 | 2 894 | 0 |
| 3 premières lettres | 11 201 | 59 555 | 45 | 1 553 | 2 938 | 0 |
| 2 premières lettres + département | 5 714 | 80 813 | 93 | 2 857 | 5 027 | 0 |
| **Total** | **5 291** | **80 813** | **273 (12 %)** | **1 087** | **5 027** | **0** |

Selon le passage, la version actuelle compte 198, 203, 273 ou 397 recherches au-delà de 10 s (9 à 18 %), car son plan varie ; le tableau montre le passage à 273. Le dernier passage, sur la migration de la PR, donne pour la version finale les mêmes totaux que le tableau : médiane 1 087, 95e centile 2 930, maximum 5 027, aucune au-delà de 10 s.

**Justesse.** La version finale rend les mêmes lignes que la référence dans 2 224 cas sur 2 224. La version actuelle : 1 915, soit 86 %. 29 cas limites ont aussi été comparés à la référence, tous identiques : limite 501, catégories rares, `---`, apostrophe, tiret, accents, 200 caractères. Une limite absente ou de 9 999 rend 501 lignes au plus, comme le plafond de l'endpoint.

**Contrepartie.** Selon le plan de la version actuelle, 456 à 947 recherches sur 2 224 lisent plus qu'aujourd'hui, dont 3 au plus de plus de 2 500 lectures (environ 1 s de plus à froid). Au total, le dernier passage lit 2,9 M de blocs, contre 18,8 M pour la version actuelle. Exemples : `martin` + département passe de 2 360 à 3 605 lectures, `martin` + `jean` de 1 921 à 3 576, `le` + département rare de 303 à 2 837. Au second passage, les pages sont déjà en mémoire et ces recherches ne lisent plus rien sur disque.

**Ingestion, test de bout en bout avec la fonction de swap de la prod :**

- **Nom nouveau :** introuvable avant reconstruction, trouvé après. Aucune fiche rendue n'est fausse ni absente de la nouvelle table, car les listes ne portent que des valeurs.
- **Une panne de reconstruction :** la recherche continue, seuls les noms nouveaux manquent. Le run passe en `partial`, et son message donne le délai et la commande de réparation.
- **Sans réparation :** testé avec le swap suivant, dont le `DROP ... CASCADE` détruit les listes. La recherche rend 42P01, et une reconstruction rétablit tout. D'après le code, non exécuté, le nettoyage du dimanche a le même effet dès la semaine de la panne : `ingest_drop_stale_previous` ne compte pas un run `partial` comme réussi.
- **Reconstruction des 2 listes :** 2 à 3,5 s en local, 22,2 s en prod sur des tables temporaires (14,6 s pour 444 943 noms, 7,6 s pour 83 820 prénoms, index et `ANALYZE` compris). Ajoutée aux 21,5 s de `ingest_rebuild_rpps_matviews`, elle approcherait la coupure de 60 s de la passerelle : elle a son propre appel, avec une limite de 55 s.
- **Recherches pendant une reconstruction :** 100 recherches en local, médiane 19 ms, maximum 33 ms, avec la bascule en fin de fonction. Avec une bascule après chaque liste, le maximum montait à 397 ms.
- **Insertion de 2,3 M de lignes, tous index en place :** 99 et 106 s avec les index actuels, 74 et 78 s avec la conception retenue.
- **Disque :** index `(nom, prenom, id)` de 128 Mo et listes de 42 Mo, contre 176 Mo pour les 2 index trigrammes retirés en prod.

### Mesure en prod après application

`20261106T120000` appliquée depuis l'éditeur SQL. `EXPLAIN (ANALYZE, BUFFERS)` sur la vraie RPC, à limite 101. Le cache était chaud, car la construction venait de relire la table : ces durées ne sont pas des mesures à froid.

| Recherche | Lignes | Durée | Lectures disque |
|---|---:|---:|---:|
| `ab` | 101 | 171 ms | 88 |
| `test` | 101 | 63 ms | 77 |
| nom rare | 101 | 107 ms | 86 |
| `martin` | 101 | 102 ms | 97 |
| `le` | 101 | 173 ms | 94 |
| `de la` | 101 | 190 ms | 93 |
| `ab` + département | 51 | 187 ms | 214 |
| nom rare + département | 101 | 101 ms | 283 |
| `test` + département | 51 | 32 ms | 54 |
| `martin` + département | 101 | 1 008 ms | 1 377 |
| `ab` + prénom | 11 | 75 ms | 5 |
| nom rare + prénom | 54 | 74 ms | 24 |
| `test` + prénom | 25 | 32 ms | 17 |
| `martin` + prénom | 101 | 763 ms | 1 097 |
| `le` + `ab` | 0 | 218 ms | 273 |
| `le` + `marie` + département | 16 | 764 ms | 825 |

- **Justesse :** les 6 personnes du nom rare sont rendues, contre 3 avant. Les 5 recherches sans troncature de la deuxième série rendent le même nombre de lignes.
- **Limite :** absente ou de 9 999, elle rend 501 lignes.
- **Service en ligne, code encore ancien :** 12 recherches via `/mcp` en HTTP 200, en 0,5 s au plus, coordonnées présentes. 2 entrées invalides rendent bien `-32602`. Le smoke post-déploiement passe, `professionnels_rpps_in_radius` aussi. Aucune issue Sentry sur l'heure écoulée.
- **Droits :** en rôle `anon`, la RPC répond avec `geom` en GeoJSON ; la reconstruction reste réservée à `service_role`.
- **Disque :** listes de 46 et 8 Mo, index de 98 Mo, soit 152 Mo contre 176 Mo pour les 2 index trigrammes, encore en place jusqu'au prochain swap.

## Limites

- Les durées à froid sont estimées depuis une copie locale : la mesure en prod s'est faite à chaud. Seuls le suivi des 57014 et la première ingestion trancheront. Le disque local est bien plus rapide, seuls les nombres de lectures sont comparables.
- Le plan de la version actuelle varie entre les passages (198 à 397 cas au-delà de 10 s). Cette version sert de comparaison, pas de mesure exacte de la prod.
- Non mesurés : la durée de reconstruction lors d'une vraie ingestion, le verrou de la bascule sous le trafic de prod, le coût de `ST_AsGeoJSON` dans la sortie (PostGIS est simulé en local ; les lignes sont déjà lues, il ne change pas leur nombre).
- Non testé : la piste « nom exact d'abord », qui laisserait les fautes de frappe sur le chemin lent. Un serveur plus puissant non plus : il ne corrige pas le plafond qui perd des résultats.

## Décision

Retenir la conception de la migration en annexe. Écartés, chiffres ci-dessus : la liste seule, le seuil relevé (il casse la tolérance aux fautes sans supprimer la lenteur), et `work_mem` à 64 Mo (il supprime les blocs lossy sans changer la durée, 23,8 s sur `ab`).

Les listes sont des vues matérialisées, comme les 3 autres listes dérivées de `rpps`. Des tables ordinaires survivraient au nettoyage et au swap suivant, mais elles ajoutent des droits d'écriture et une RLS à maintenir. Priorité à la maintenance simple. Risque accepté, le même que pour ces 3 listes : une panne de reconstruction laisse au plus 7 jours pour lancer une commande. Passé ce délai, la recherche rend une erreur visible jusqu'à la reconstruction.

Les critères fixés avant cette série sont tenus, sauf un : `martin` filtré n'est pas strictement « non dégradé » (environ 0,5 s de plus à froid). Ce coût est accepté au regard des 198 à 397 recherches sur 2 224 qui dépassent 10 s aujourd'hui.

Preuve attendue en prod : `EXPLAIN` sur les termes de cette page, `SET` portés par la RPC, appel réel en tant qu'`anon` avec `ST_AsGeoJSON`, parité des index prod et staging, durée réelle de reconstruction à la première ingestion.

## Annexe : SQL

Le SQL final vit dans `supabase/migrations/20261106T120000_rpps_search_by_name_listes.sql`, appliquée telle quelle sur la copie locale, et `20261106T130000_rpps_retrait_index_trigrammes.sql` pour le retrait des index trigrammes. La migration fait foi.
