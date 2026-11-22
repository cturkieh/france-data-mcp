# Sit@del : l'export CSV DiDo perd sa dernière tranche (2026-11-22)

## Question

Le cron `ingest-sitadel.yml` du 10/11/2026 a échoué en `download` (3 tentatives
`terminated`, issue #103). Panne passagère du SDES, ou défaut durable à contourner ?

## Protocole

Téléchargements `curl` depuis un poste local, le 22/11/2026 au soir, sur le datafile
`577a8a66-4157-4787-b00a-031b61afea61` (millésime `2026-10`, publié le 28/10/2026),
filtre `TYPE_LGT=eq:Tous Logements`. Un appel à la fois (DiDo répond 429 dès deux appels
concurrents). Référence de complétude : le champ `total` de l'endpoint paginé `/rows`
avec les mêmes filtres.

## Coût

0 €. Environ 25 minutes de téléchargements, une quinzaine d'appels.

## Résultats

Sans tri explicite, l'export CSV est coupé à chaque fois (connexion fermée sans fin de
flux, `curl` exit 18 en HTTP/1.1, 92 en HTTP/2) :

| Requête | Lignes reçues | Lignes attendues | Durée |
|---|---|---|---|
| `ANNEE=gte:2020` (celle du cron) | 2 820 000 | 2 832 117 | 111 s |
| `ANNEE=eq:2020` à `eq:2026`, une par une | 310 000 à 410 000, toujours un multiple de 10 000 | non mesuré | 70 à 74 s |
| `ANNEE=eq:2026&MOIS=eq:09` | 30 000 | 34 945 | 63 s |

- Le nombre de lignes reçues est toujours un multiple de 10 000 : l'export sert des
  tranches de 10 000 lignes et perd la dernière, incomplète.
- Les données arrivent vite, puis le flux se fige environ 60 s avant la coupure (avec
  `--speed-time 15`, l'année 2026 est abandonnée à 40 s, ses 310 000 lignes déjà reçues).
- Le fichier étant servi par commune croissante, la partie perdue est toujours la fin :
  0 ligne `97xxx` (DOM) dans les 9 fichiers coupés. Le fichier du cron s'arrête à la
  commune 95607, celui du seul mois de septembre à la commune 77041.
- La donnée existe côté source : `/rows` rend `total = 34 945` pour septembre 2026 et sa
  page 349 (taille 100) finit sur la commune 97357.

Avec `orderBy`, l'export arrive entier :

| Requête | Lignes reçues | `total` de `/rows` | Durée | Fin de flux |
|---|---|---|---|---|
| `ANNEE=eq:2026&MOIS=eq:09&orderBy=-CODE_INSEE` | 34 945 | 34 945 | 27 s | propre |
| `ANNEE=gte:2020&orderBy=CODE_INSEE` | 2 832 117 | 2 832 117 | 122 s | propre |

Contrôles sur le fichier complet trié : 10 449 lignes DOM, 34 969 communes, 636 clés
(année, mois, commune) en double. Ces 636 doublons sont ceux de la source, déjà mesurés
le 22/09/2026 : ils sont présents aux mêmes numéros de ligne dans le fichier non trié, et
chaque paire est identique au caractère près. Toutes les lignes du fichier non trié se
retrouvent dans le fichier trié.

Chemin réel du cron rejoué en local, sans écriture en base (`downloadCsv` de Node sur
l'URL de `buildSitadelUrl`, puis `preValidateFile`, `aggregateSitadelRecords` et
`validateSitadelAggregate`) : 129 046 147 octets en 69 s, 2 832 117 lignes brutes,
209 725 lignes commune × année, 34 969 communes, 774 lignes DOM, 0 ligne invalide,
dernier mois 2026-09, toutes les gardes passées. La table de prod porte aujourd'hui
209 725 lignes et 774 lignes DOM, avec 8 mois couverts sur 2026 : le prochain run
ajoute septembre sans changer le volume.

Pistes écartées :

- Découper par année ou par mois : chaque morceau perd aussi sa dernière tranche.
- Passer par `/rows` : 100 lignes par page au maximum et environ 25 s par appel.
- Filtrer la fin manquante (`CODE_INSEE=gte:97000`) : opérateur refusé (HTTP 400).

## Limites

- Cause côté SDES non identifiée. Le cron du 10/10/2026 avait réussi avec la requête sans
  tri, sur le millésime précédent : régression de l'API ou effet du millésime `2026-10`,
  non départagé.
- `orderBy` validé sur deux requêtes seulement, le même soir. Le contournement repose sur
  un comportement non documenté de DiDo.
- Mesuré depuis un poste local, pas depuis un runner GitHub.

## Décision

`buildSitadelUrl` ajoute `orderBy=CODE_INSEE` (test de non-régression sur l'URL). Les
garde-fous existants restent le filet : une coupure fait échouer `downloadCsv`, et la
bande `[33 000, 37 000]` communes refuse un fichier amputé d'une région. Après merge,
relancer `ingest-sitadel.yml` à la main : succès attendu, dernier mois = septembre 2026.
