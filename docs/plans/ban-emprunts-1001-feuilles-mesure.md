# BAN bulk — quatre emprunts à 1001 feuilles, mesurés sur le cache prod avant tout filtre

> Mesure du 2026-09-05, lecture seule, échantillon aléatoire rejouable (seed
> `20260905`, script scratch `mesure-ban.mts`). Décision Cyril : **pas de module
> partagé** avec 1001 feuilles ; chaque emprunt se mesure d'abord sur notre cache.
> Complète `ban-join.md` (acceptation par précision) et la mémoire
> `ban-acceptance-precision-tier`.

## Méthode

- **Échantillon** : 260 sondes `id` aléatoires × 40 lignes sur `rpps`, deux strates
  par `geom_source` — `ban_address` (10 400 lignes → 8 237 clés) et
  `commune_centroid` (10 393 lignes → 5 228 clés), clés recalculées par
  `normalizeAddressKey3` (parité SQL garantie par le HARD GATE) et jointes au cache
  `geocoded_addresses` par lots de 60.
- **Re-géocodage** : POST bulk CSV avec la requête EXACTE de la lib
  (`normalizeAddressForBan` + `postcode` + `citycode`), lecture des colonnes
  `result_housenumber` / `result_name` / `result_street` / `result_label`.
- **Juge du libellé** : tokens signifiants de la voie demandée vs rendue (accents
  pliés, abréviations RPPS `R`/`AV`/`BD`/`CHE`/`RTE`… développées, types de voie et
  mots vides retirés) ; « rue » = aucun token commun, « numéro » = `housenumber`
  rendu ≠ numéro demandé.

État du périmètre le jour de la mesure (`rpps`, post 5c-bis) :

| geom_source        | lignes    |
|--------------------|-----------|
| `ban_address`      | 1 180 823 |
| `finess_join`      |   439 567 |
| `commune_centroid` |    71 211 |

Cache : 424 488 clés acceptées (65 911 à score < 0,7), 57 487 rejetées ou
irrésolues.

## Emprunt 3 — repli d'hôte Géoplateforme IGN ↔ api-adresse : **RETENU (urgent)**

- Doc officielle (`adresse.data.gouv.fr/outils/api-doc/adresse`) : « L'API Adresse
  BAN est dépréciée et intégrée dans le nouveau Service de géocodage de la
  Géoplateforme. L'url api-adresse.data.gouv.fr sera décommissionnée fin Janvier
  2026. » L'hôte répond encore le 2026-09-05, mais notre client de masse n'avait
  QUE lui.
- **Parité prouvée** : 1 000 adresses RPPS réelles POSTées sur les deux endpoints
  `…/search/csv/` → **1 000 résultats identiques** (`result_id`, coordonnées,
  score, type), en-tête CSV identique colonne pour colonne.
- Implémentation (`src/core/ban-bulk-client.ts`, `BAN_BULK_HOSTS`) : **Géoplateforme
  en tête** (successeur officiel, déjà l'hôte de `territoire/geocode.ts`),
  api-adresse en repli tant qu'il répond. 5xx / erreur réseau / timeout → tentative
  suivante sur l'autre hôte ; l'hôte qui répond devient l'hôte de départ des chunks
  suivants (sticky, leçon de la panne du 26/08/2026 chez 1001 feuilles : bloc
  `37.59.183.x` refusant la connexion, `data.geopf.fr` debout). Un 429 ne bascule
  pas (quota de l'hôte).

## Emprunt 4 — `Retry-After` sur 429, barème 2/4/8 s : **RETENU**

Le client ignorait le header et re-tapait à 0,5 / 1 / 2 s. Désormais : header
présent → il prime (secondes ou HTTP-date, plafonné 60 s par
`parseRetryAfterSeconds`, source unique dans `core/http.ts`) ; absent → 2 s, 4 s,
8 s. Aucun 429 observé pendant la mesure (≈ 6 000 lignes en 7 POST).

## Emprunt 1 — vérifier le libellé rendu avant d'accepter : **MESURÉ, NON RETENU**

| strate acceptée (cache)      | n   | « rue » (juge strict) | dont vraies mauvaises rues à la relecture | illisible |
|------------------------------|-----|-----------------------|-------------------------------------------|-----------|
| score < 0,7                  | 548 | 23 (4,2 %)            | **8 (1,5 %)**                              | 8         |
| score ≥ 0,7                  | 600 |  4 (0,7 %)            | **1 (0,2 %)**                              | 8         |

- 1001 feuilles mesurait 17 % de mauvaise rue à score ≥ 0,5 sur son corpus greffe
  (portes exigées en `housenumber`). Chez nous, sur la requête réelle de la lib
  avec `citycode` épinglé : **~1,5 %** sous 0,7 et **~0,2 %** au-dessus ≈ 1 600
  clés sur 424 000 acceptées.
- Le juge strict (tokens exacts) produit **deux faux positifs sur trois** : pluriels
  (`FONDERIE` / `Fonderies`), graphies (`RIBEIRA` / `Ribera`, `GARREAU` / `Charles
  Garrau`, `COMBENEUVE` / `Combe Neuve`) et une **corruption systématique du RPPS
  `TH` → `E`** (`EENARD` = Thénard, `EALASSA` = Thalassa, `BREEEL` = Brethel,
  `MENEONNEX` = Menthonnex, `PENEIEVRE` = Penthièvre) que la BAN résout pourtant
  sur la bonne voie. Un filtre strict jetterait ~2 800 clés dont ~1 800 justes au
  centroïde (3 km) pour en corriger ~1 000 : bilan négatif. Un juge flou
  (distance d'édition + pluriels + `TH`↔`E`) serait nécessaire pour ~1 600 clés
  (0,4 %) : coût non justifié aujourd'hui. Réévaluer si le corpus change
  (Ameli sans `citycode`, nouvelle source).
- Exemples de vraies mauvaises rues (même commune) : `17 Rue DE L'ARMOR` → Rue de
  l'Abbaye (Guingamp), `112 Avenue DE LA MARNE` → Avenue de la Roudet (Libourne),
  `Route DE CAEN` → Route de Rouen (Troarn), `12 AVENUE DE LA LIBERTE` → Avenue de
  l'Allier (Pérignat-sur-Allier).

## Emprunt 2 — nettoyer la requête (BP, CS, TSA, cedex, parenthèses) : **MESURÉ, NON RETENU**

- Sur les 71 211 lignes `commune_centroid` restantes, **96** contiennent
  `BP|CS|TSA|CEDEX|(`. Le step 5c-bis (repli FINESS, 2026-09-05) a déjà sorti les
  adresses d'établissement du périmètre BAN : le bruit visé par 1001 feuilles n'est
  plus là.
- 900 clés rejetées re-géocodées en 3 variantes : requête actuelle **291 acceptées**
  (voir ci-dessous) ; sans bruit BP/CS/TSA/cedex/parenthèses **292** (+1, 7 requêtes
  modifiées) ; extraction « dernière porte numéro + type de voie » façon 1001 feuilles
  **294** (+3, 164 requêtes modifiées, et deux des trois gains choisissent une adresse
  parmi deux — `22 Cours VITTON - 46 RUE TETE D'OR`). Gain ≤ 0,3 %, pas de filtre.

## Découverte annexe — 9 305 rejets PÉRIMÉS figés par le cap de tentatives : **CORRIGÉ**

En re-géocodant les 900 rejetées avec la requête actuelle, **291 (32 %) sont
acceptées aujourd'hui**. Ventilation :

| statut cache                              | n   | ré-acceptées |
|-------------------------------------------|-----|--------------|
| `rejected_low_score`, score ≥ 0,5, type précis | 248 | **247 (99,6 %)** |
| `rejected_low_score`, score < 0,5         | 379 | 21 (5,5 %)   |
| `unresolved`                              | 264 | 23 (8,7 %)   |

La première ligne = clés rejetées le **2026-05-18** sous le gate `score ≥ 0,7`,
assoupli à 0,5 le 2026-05-19, et **jamais re-soumises** parce que
`ban_attempt_count = 3` (cap `BAN_MAX_ATTEMPTS`). En prod : **9 305 clés**, toutes
à `attempts = 3`, `geocoded_at` 2026-05-18, portant **15 903 lignes `rpps`**
(22 % des 71 211 centroïdes) — et des lignes Ameli (cache partagé, non comptées).

Fix : `scripts/ban-backfill.mjs` re-soumet un rejet `rejected_low_score` dont le
cache porte encore un résultat que la règle courante accepterait
(`isStaleRejection`, règle lue via `meetsBanAcceptanceGate` — prédicat partagé avec
le client, source unique du gate), malgré le cap ; plafond `BAN_STALE_RESUBMIT_CAP`
= une seule tentative supplémentaire par clé (convergence par construction, testée).
Limite connue : les jauges SQL `*_measure_ban_to_geocode` comptent encore « cap
atteint = fait » (backlog P3, fenêtre courte et auto-fermante). La RPC
`rpps_geocoded_cache_lookup` expose `result_score` / `result_type` /
`ban_last_status` (migration `20260905T180000`, appliquée prod 2026-09-05 via MCP,
additive). Compteur `staleResubmitted` dans le résumé du run.

**Runbook** (après merge) : `Actions → Backfill BAN RPPS (auto + manuel) → Run
workflow` **sans `max`** (un canari `--max N` sert d'abord les clés jamais vues et
diffère tous les périmés — la ligne `DONE:` affiche alors `deferred by --max`), puis
`Backfill BAN Ameli`. Attendu : `≈ 9 300 stale_rejections_resubmitted` (5 POST de
2 000), `≈ 9 250 accepted`, `re-rejected` proche de 0, `ban_hosts` majoritairement
`data.geopf.fr`. Les coordonnées seront POSÉES
dans `rpps` au prochain cron mensuel (`ban_join`), par design.

## Non retenu, à ne pas ré-enquêter sans nouveau corpus

- Juge flou du libellé (emprunt 1) — ~1 600 clés (0,4 %) en jeu.
- Nettoyage BP/CS/TSA/cedex (emprunt 2) — 96 lignes RPPS en jeu.
- Module BAN partagé avec 1001 feuilles — décision Cyril 2026-09-05 : non.
