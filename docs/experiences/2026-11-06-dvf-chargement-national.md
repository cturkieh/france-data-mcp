# DVF : passer du cache par commune au chargement national

**Date :** 2026-11-06 et 2026-11-07. **Statut :** chargement à blanc fait en prod, bascule à faire.

## Question

Les fichiers DVF par commune sont annoncés supprimés au 31/11/2026, et Paris, Lyon et Marseille rendent 0 vente. Peut-on charger les fichiers nationaux, et à quel coût sur le disque et en temps de réponse, sans changer ce que disent les tools ?

## Protocole

- **Fichiers :** lecture en flux des 6 livraisons `full-*.csv.gz` de data.gouv, sans rien stocker ; puis un fichier de travail local de 342 Mo, supprimé après usage.
- **Règles :** celles de `parseDvfCsv` : coordonnées et date obligatoires, prix au m² seulement pour Maison et Appartement. Une ligne est « utile » si `aggregatePrix` la lit : prix au m² ou `surface_terrain > 0`.
- **Taille :** coût par ligne lu sur la table de prod (255 481 lignes). PostGIS n'est pas installé sur le Mac et il n'y a pas été ajouté.
- **Temps de lecture :** `EXPLAIN (ANALYZE, BUFFERS)` en lecture seule sur la prod.
- **Plafond de 500 lignes :** simulation sur le fichier de travail. Les égalités de date suivent l'ordre des communes, soit le futur rangement de la table ; SQL ne garantit pas cet ordre, donc le biais exact peut varier.

## Coût

Environ 950 Mo téléchargés en flux, quelques requêtes de lecture seule en prod. Le chargement à blanc écrit 338 Mo dans une table temporaire, sans effet sur les utilisateurs.

## Résultats

### Volume

| Périmètre | Lignes | Taille estimée |
|---|---|---|
| Fichiers bruts, 5 ans | 20 065 182 | sans objet |
| Une ligne par clé, avec coordonnées, 5 ans | 10 965 315 | ~4 Go |
| Utiles, 24 derniers mois | 3 185 285 | ~710 Mo |
| **Utiles, 12 derniers mois (retenu)** | **1 609 828** | **~360 Mo** |

Coût par ligne mesuré en prod : table 176 octets dont ~36 pour `geom`, index `geog` 74, clé primaire 63, index `geom` 43, index `code_commune` 8. L'estimation retenue compte 140 + 74 + 8 = 222 octets par ligne.

Sur 12 mois : 875 291 lignes avec prix, 1 217 931 avec terrain, 32 635 communes, les 45 arrondissements de Paris, Lyon et Marseille, 3 406 lignes pour Paris 15e, aucune ligne sur les codes ville. Plus petit mois : 58 % du plus fourni.

La source ne couvre pas la Moselle, le Bas-Rhin, le Haut-Rhin ni Mayotte : aucune ligne pour 57, 67, 68 et 976.

Les fichiers ne sont pas triés par commune (1,1 million de retours en arrière sur le fichier 2024) : sans tri au chargement, une recherche par rayon lirait des blocs dispersés sur toute la table.

### Le plafond de 500 lignes fausse le prix sur une table nationale

Médiane en €/m², fenêtre de 24 mois.

| Point | Rayon | Lignes dans le rayon | Médiane exacte | 500 plus récentes | Écart |
|---|---|---|---|---|---|
| Paris 15e | 2 km | 10 503 | 9 711 | 9 787 | +1 % |
| Paris 15e | 5 km | 43 432 | 9 808 | 10 588 | +8 % |
| Paris 15e | 10 km | 119 548 | 8 261 | 9 206 | +11 % |
| Paris 15e | 20 km | 209 914 | 6 325 | 8 793 | +39 % |
| Paris 15e | 50 km | 324 422 | 4 833 | 8 370 | +73 % |
| Lyon 3e | 50 km | 102 096 | 3 283 | 3 206 | -2 % |
| Nantes | 5 km | 15 168 | 3 392 | 3 262 | -4 % |

Le compteur `n_ventes` était lui aussi faux : il restait sous 500 quel que soit le volume réel (Paris 15e, 50 km : 417 affichées pour 264 282).

### Temps de lecture en prod

26 680 lignes candidates lues en 259 ms, dont 146 ms pour 232 blocs d'index lus sur disque. Avant le chargement, le pire cas à 12 mois était estimé à environ 160 000 lignes à 50 km de Paris. Mesure réelle ci-dessous.

### Chargement à blanc en prod (2026-11-07, sans bascule)

| Mesure | Attendu | Réel |
|---|---|---|
| Lignes en base | 1 609 828 | 1 609 828 |
| Taille totale | ~360 Mo | 338 Mo : table 219, index `geog` 107, index `code_commune` 12 |
| Durée du run | 90 min au plus | 7 min, dont 5 min 25 d'insertion pour 805 lots |
| Pic mémoire du script | 1,5 Go | sans incident, non relevé sur le runner |
| Pire lecture : Paris 15e, 50 km, 165 447 lignes | 15 s au plus | 324 ms, 5 810 blocs dont 169 lus sur disque |
| Dernière date de la table | 8 s au plus sans budget propre | 392 ms, 28 074 blocs dont 6 282 lus sur disque |

Ces temps ne sont pas à froid : la table venait d'être écrite. Au coût mesuré plus haut (146 ms pour 232 blocs d'index), la pire lecture entièrement sur disque prendrait environ 3,7 s, sous la limite de 15 s : c'est un calcul, pas une mesure.

Comparaison entre le SQL sur le serveur et une mesure indépendante en Python sur le fichier de travail, 13 points. L'écart de médiane est au plus de 0,13 % ; Python calcule sur une sphère et PostGIS sur l'ellipsoïde, d'où quelques lignes de différence en bordure de rayon.

| Point | Lignes SQL | Lignes Python | Médiane SQL | Médiane Python |
|---|---|---|---|---|
| Paris 15e, 2 km | 4 916 | 4 938 | 9 750 | 9 750 |
| Paris 15e, 50 km | 165 447 | 165 520 | 4 871 | 4 870 |
| Lyon 3e, 2 km | 3 419 | 3 421 | 4 826 | 4 825 |
| Lyon 3e, 50 km | 51 672 | 51 821 | 3 289 | 3 285 |
| Marseille 6e, 2 km | 4 866 | 4 859 | 3 766 | 3 771 |
| Nantes, 5 km | 7 786 | 7 789 | 3 356 | 3 356 |
| Creuse, 5 km | 138 | 138 | 819 | 819 |
| Strasbourg, 5 km | 0 | 0 | aucune | aucune |

### Ventes à plusieurs lots, fichier 2025

La règle actuelle divise le prix total par la surface d'un seul lot. Médiane en €/m².

| Zone | Actuelle | Ventes à un seul lot | Écart |
|---|---|---|---|
| France | 2 627 | 2 658 | -1,2 % |
| Paris | 9 787 | 9 667 | +1,2 % |
| Lyon | 4 512 | 4 483 | +0,7 % |
| Marseille | 3 385 | 3 296 | +2,7 % |
| Toulouse | 3 380 | 3 322 | +1,8 % |
| Creuse | 883 | 800 | +10,4 % |

## Décision

Retenu :

- 12 derniers mois publiés, lignes utiles seulement, sur les 2 dernières livraisons. Fenêtre ancrée sur le dernier mois publié.
- Médiane, quartiles et compteurs calculés dans la base (`dvf_stats_in_radius`), sur toutes les lignes du rayon.
- Tri par commune au chargement. Ni clé primaire ni `geom` : aucune lecture ne s'en sert. Le contrôle des doublons se fait à la lecture du fichier et par comptage avant la bascule.
- Cron mensuel : la signature des livraisons, calculée sur les sommes de contrôle de data.gouv, évite tout téléchargement quand rien n'a changé.
- Un fichier annuel remplace ses semestres : une même vente change d'identifiant d'une livraison à l'autre (Paris 15e : `2025-1293021` en avril, `2025-1361587` en octobre), donc le dédoublonnage ne verrait pas le chevauchement.
- Contrôles avant bascule, calibrés sur ces mesures : volumes (lignes, prix, terrains, communes), 97 départements, 45 arrondissements, 95 % des lignes en métropole, 12 mois présents, médiane nationale, cohérence du dernier mois, livraison qui ne recule pas. Sur les vrais fichiers, les 1 609 828 lignes passent toutes les gardes (celle du recul lit la prod, elle sera exercée au premier run).
- Premier chargement à blanc (`dry_run`) pour lire la taille réelle et les temps avant toute bascule.

Écarté :

- 24 mois : deux fois plus de disque, pour des prix moins récents.
- Garder le plafond avec un indicateur « tronqué » : la médiane resterait fausse à grand rayon.
- Corriger maintenant la règle des lots et le libellé « terrains » : ces changements modifieraient les chiffres publiés, ils restent au backlog avec cette mesure. Le premier pèse surtout en zone rurale.
