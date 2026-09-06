# FINESS : migration du CSV DREES vers le flux ANS « nouvelle génération »

> Post-mortem + inventaire du flux + décisions. Source de vérité pour
> `scripts/ingest/finess.ts`, `finess-ans-parse.ts` et la migration
> `20260905T210000_finess_ans_geom_previous_diff_canary.sql`.
> Découvert le 2026-09-05 en publiant la réutilisation data.gouv.fr.

## 1. Ce qui s'est passé

La DREES a déployé une nouvelle version de FINESS le **20 juillet 2026** et a
**arrêté la génération des flux CSV**. Le dataset data.gouv
`finess-extraction-du-fichier-des-etablissements` n'a plus qu'une extraction
« au 04/05/2026 », publiée le 12 mai. Personne ne nous l'a dit ; la fiche
data.gouv le mentionne en une phrase.

Côté cron (`ingest-finess.yml`, le 1ᵉʳ et le 15) : le fichier n'ayant pas
changé d'un octet depuis le 15 mai, **sept runs consécutifs** (1ᵉʳ juin → 1ᵉʳ
septembre) ont court-circuité en `skip_reason = same_checksum`, **statut
`success`**. `getDataFreshness` prenait le dernier `success` → un LLM demandant
`include_freshness` recevait `staleness_days ≈ 4` pour une donnée vieille de
113 jours. Le pipeline a fait exactement ce pour quoi il était conçu ; c'est la
sémantique de « succès » qui ne distinguait pas « rien de neuf en amont » de
« source morte ».

Deux corrections, indépendantes :

- **Fraîcheur honnête** (`src/storage/ingest-log.ts`) : `last_data_change_at` /
  `data_age_days` = dernier run `success`/`partial` **sans** `skip_reason`.
  `last_success_at`/`staleness_days` conservés (ils ne sont pas faux, ils
  répondent à une autre question). Test rejouant la séquence réelle.
- **Migration de la source** vers l'ANS (ce document).

## 2. Le flux ANS

Dataset data.gouv `finess-structures-1` (Agence du Numérique en Santé), mis à
jour **quotidiennement**, JSON.gz. Complété par `finess-activites-1`
(non consommé pour l'instant).

| | Valeur |
|---|---|
| Ressource journalière | id **stable** `cd493959-fb03-41e5-9347-0edd14dfbc22` (créé 2026-05-06), l'URL `data.gouv.fr/fr/datasets/r/<id>` redirige vers le fichier du jour |
| Taille | ~50 Mo gz, **715 Mo** décompressés |
| Structure | `{ generatedAt, schemaVersion, pmej[], gco[], gcc[] }` ; les établissements sont les **EGE**, imbriqués dans `pmej[].ege[]` |
| Volumes (2026-09-05) | 98 208 PMEJ · **174 681 EGE** dont **104 734 en service** (`etatObjet = "A"` ET `dateFermeture` nulle) |
| Schéma officiel | github.com/ansforge/finess `schema-structures-v1.json` |
| Nomenclature catégories | **identique** au CSV DREES (620 pharmacie, 611 LBM, 124 centre de santé…) → `finessFamille` inchangé. Libellés : le flux ne donne que le code ; nomenclature TRE_R397 (428 concepts) figée dans `src/sante/finess-categories-labels.ts` (source unique lib + ingestion depuis le 2026-09-06) par `refresh-finess-categories.ts` |

### 2.1 Pièges du flux (tous mesurés, tous testés)

1. **`adresse[]` est un tableau, l'adresse géographique est `usageAdresse = "03"`**
   (TRE_R377 « Adresse géographique du lieu d'exercice »). Présente exactement
   une fois par EGE actif ; mais sur **2 294** EGE actifs elle n'est **pas en
   première position** (accueil `06` devant). `adresse[0]` les aurait
   géolocalisés au mauvais endroit, en silence. Fixture réelle `010008894`.
2. **Deux paires de coordonnées, système variable.** `(coordonneeX, coordonneeY)`
   et `(directionLongitude, directionLatitude)` : l'une est WGS84, l'autre
   Lambert 93 — **laquelle change d'un enregistrement à l'autre** (57 930 EGE
   actifs avec `coordonneeX` en WGS84, 20 499 avec `coordonneeX` en Lambert).
   Détection par plage de valeurs (`resolveCoordinates`), les emprises étant
   disjointes de plusieurs ordres de grandeur. Fixture réelle `080010093`
   (canary) qui aurait donné `geom = NULL` sans crier.
3. **Seulement 74,9 % des EGE en service ont des coordonnées** (78 429/104 734)
   contre 100 % dans la table issue du CSV DREES géocodé. Le trou est uniforme
   par catégorie (pharmacies 16,7 %, LBM 20,7 %, EHPAD 25 %). Voir § 3.
4. `etatObjet` est une chaîne sur tout le flux, mais le schéma le déclare
   avec un `coding` ailleurs → `readEtat` accepte chaîne et tableau.
5. **715 Mo > limite de chaîne V8 (~512 Mo)** : `JSON.parse` est impossible,
   parsing en flux obligatoire (`stream-json` v3, `pick("pmej")` →
   `streamArray`, chaîné par `stream.pipeline` pour propager les erreurs).
6. Le contenu change chaque jour (`generatedAt`) → le court-circuit par
   checksum ne s'applique qu'à un re-jeu le même jour ; deux crons à quinze
   jours d'écart avec le même SHA = **publication ANS gelée** (loguée comme
   telle, `ingest_log.error_message` + warn).
7. **La clé BAN dit la précision, pas le score** : `cleInInteropBAN` =
   `01053_1950_00062` (numéro) / `01053_1950` (rue) / `01053` (**commune** =
   centroïde) — 186 EGE en prod le 2026-09-05 avec une clé commune et un
   `scoreBAN` ≈ 0,94. Refusés dans `finess.geom` (le cron RPPS recopie ce
   point en `finess_join`, tier précis) ; le repli `previous_ingest` les
   couvre s'ils sont connus.

### 2.2 Ce qu'on gagne

- Source vivante, quotidienne (le cron reste à 2×/mois).
- **DOM** : 2 814 établissements (Réunion 909, Guadeloupe 733, Martinique 595,
  Guyane 330, Mayotte 227…) — **totalement absents** jusqu'ici. Le parseur CSV
  les skippait explicitement (`dom_unsupported`, « V0.3 widens code_insee »),
  dette jamais levée alors que `code_departement CHAR(3)` / `code_insee CHAR(5)`
  les acceptent depuis longtemps.
- +8 517 établissements en métropole (4 mois de retard rattrapés + périmètre).
- `cogCommune` = code INSEE 5 caractères direct, **0 manquant** (le CSV perdait
  ~2,5 % en `bad_dept`).
- Nouveaux champs dans `raw` (jsonb, sans migration) : **`siret`** (139 287 EGE
  tous états), **`cle_ban`** + **`score_ban`** (clé d'interopérabilité BAN,
  78 429), `geom_source`. Matière pour la phase 2.

## 3. Géolocalisation : la cascade et ce qu'on a refusé

Migrer tel quel = **26 305 établissements** sans `geom` → invisibles dans
toutes les recherches par rayon (`ST_DWithin` ignore les NULL). Le garde-fou
`MIN_GEOM_COVERAGE` (0,8) de l'ancien script aurait refusé le swap — sans dire
pourquoi.

Cascade retenue, dans l'ordre :

1. **Coordonnées ANS** (WGS84 natif, quelle que soit la paire qui le portait)
   → `raw.geom_source = ans`. La disposition des paires (`wgs84_first` /
   `lambert_first`) n'est qu'un compteur de diagnostic dans les logs du run,
   pas une provenance.
2. **Point de la prod actuelle** pour un `num_finess` déjà connu
   (`ingest_apply_finess_geom_previous`, un UPDATE PK↔PK avant swap) →
   `geom_source = previous_ingest`. Mesuré sur 600 manquants : **86,3 %**
   récupérables → couverture projetée **≈ 96,6 %**. Le seuil passe de 0,8 à
   **0,95** (relevé, pas abaissé).
3. **Rien** — `geom NULL`, tracé.

**Refusé : le centroïde commune dans `finess.geom`.** Le cron RPPS copie
`finess.geom` vers le RPPS sous l'étiquette `finess_join`, classée *précise*
et indexée dans le GiST partiel `rpps_geog_precise_gist`. Un centroïde dans
`finess.geom` contaminerait la précision RPPS sous une étiquette « précis ».
Le résiduel (~3,4 %) relève d'un géocodage BAN (phase 2), pas d'un centroïde.

## 4. Garde-fous (`finess-validate.ts`, fonctions pures testées sur les chiffres mesurés ; `finess.ts` n'orchestre)

| Étape | Seuil | Effet |
|---|---|---|
| Pré-validation | taille ≥ 30 Mo **et** octets magiques gzip | throw (page HTML de maintenance servie en 200) |
| Lignes | 50 000 ≤ n ≤ 200 000 | throw |
| Anomalies structurelles (`no_finess_id`, `bad_finess_id`, `no_adresse_geographique`, `no_commune`, `bad_commune` — validateurs partagés `isValidCodeInsee`/`deptFromCodeInsee`) | > 1 % | throw ; `ferme`/`inactif` = périmètre attendu, pas des anomalies |
| Contraintes de colonnes (`COLUMN_RULES`, parité DDL testée) | valeur hors contrainte → `null` compté ; > 1 % sur un champ | throw (changement de format) |
| Coordonnées présentes mais aucune paire WGS84 plausible | > 2 % warn, > 5 % throw | dérive de format |
| Couverture géo après repli (comptée en base) | < 95 % | throw |
| **Diff staging ↔ prod** (`ingest_finess_staging_diff`) | `removed` > 10 % de la prod | throw — un fichier ANS partiel mais > 50 000 lignes passerait sinon |
| `lost_geom` (géolocalisés prod sans point APRÈS repli) | > 0,5 % | throw — garde le repli lui-même (tautologique pour la non-régression, cf. § 3) |
| **`moved_gt_500m` / établissements communs** | > 20 % | throw — inversion lat/lon, datum, signe : invisibles ligne à ligne depuis le domaine WGS84 complet |
| Anomalies de contenu sur lignes insérées (`categorie_code` nul, `raison_sociale` vide) | > 1 % | throw — 32 sans catégorie en prod (0,03 %), signalés ; une encapsulation du code par l'ANS mettrait 100 % des tools par famille à 0 en `success` |
| Nomenclature | codes en famille « autre » > 15 % ; codes sans libellé | warn (relancer `refresh-finess-categories.mjs`) ; **fatal** si « autre » > 50 % ou lignes sans libellé > 1 % (catalogue TS ou JSON figé désynchronisés) |
| Canary post-swap (`runAndRecordCanary`, toutes sources) | cible manquante | run marqué **`partial`** (avant : `success`, invisible 4 mois) |
| `FINESS_DRY_RUN=1` | — | tout le pipeline, **arrêt avant swap**, staging conservée, aucune ligne `ingest_log` |

## 5. Canary

`130786049` (« Timone ») **n'a jamais existé dans FINESS** — ni dans la table
prod, ni dans le flux ANS ; `canary_failures` le loguait à chaque run depuis
le 2026-05-15. Le vrai numéro de l'hôpital de la Timone est `130783293`.
Corrigé dans la migration. `750100166` est le site Cochin (description
corrigée). `080010085` (Rethel) n'a pas de coordonnées ANS et existe en prod
avec un point : il est le canary naturel du repli `previous_ingest`.

## 6. Preuve (dry-runs du 2026-09-05, `FINESS_DRY_RUN=1` en local contre la prod)

Trois dry-runs, chacun ayant appris quelque chose :

1. **Échec en `copy`, 22001** : UN téléphone à deux numéros
   (`0690291988/0590895757`, 21 caractères) pour une colonne `VARCHAR(20)`.
   Postgres ne tronque pas → règle « débordement = null compté, jamais
   tronqué » + normalisation du téléphone (premier numéro, sans séparateurs).
2. **Pipeline complet en 71 s, arrêt sur `MIN_GEOM_COVERAGE`** : 94,97 %
   (99 463 / 104 734) pour un seuil de 0,95 posé sur une extrapolation
   (96,6 % estimés sur 600 manquants ; le repli réel reprend 21 036 points,
   soit 80 % des 26 307 manquants). Qualification SQL sur la staging conservée :

   | Mesure | Valeur | Lecture |
   |---|---|---|
   | `lost_geom` | **0** | aucun établissement géolocalisé en prod ne perd son point |
   | sans point | 5 271 | **100 % nouveaux** (3 797 métropole + 1 474 DOM), jamais en prod |
   | `added` / `removed` | +17 450 / −6 119 (6,6 %) | sous le seuil de 10 % |
   | retirés (échantillon 400) | **400/400 dans le flux ANS, tous `fermé`**, 387 avant mai 2026, certains depuis 2010 | le CSV DREES servait des établissements fermés depuis des années |
   | `moved_gt_500m` | 5 395 — médiane 1,1–1,5 km, p99 ~35 km, max 98 km, 28 > 50 km | géocodage DREES grossier remplacé par des points BAN ; **aucun aberrant à des centaines de km** (pas de mauvaise détection Lambert/WGS84) |
   | geom à l'insert | 57 930 WGS84 · 20 497 Lambert · 0 inexploitable | conforme à l'inventaire |
   | anomalies structurelles | 0 / 0 / 0 / 0 | |
   | écartés | 69 799 fermés · 148 inactifs | périmètre attendu |

   Conséquence : le seuil global passe à **0,93** (baseline mesurée − 2 pts,
   documenté dans `finess-validate.ts`). **Correction de la revue
   (silent-failure-hunter)** : `lost_geom = 0` n'est PAS une preuve de
   non-régression — le repli `previous_ingest` remplit exactement l'ensemble
   que `lost_geom` compte, juste avant la diff ; un 0 prouve que l'UPDATE a
   tourné. Ce garde surveille le repli (RPC muette) ; la non-régression
   réelle de la géolocalisation est portée par **`moved_gt_500m` ≤ 20 % des
   établissements communs** (6,18 % le jour de migration, 0 ensuite) : depuis
   que la détection WGS84 couvre le domaine complet, une inversion lat/lon ou
   un changement de datum upstream produirait des points « valides » avec
   couverture 100 % et `lost_geom = 0` — seul le déplacement massif le trahit.
   La preuve de non-régression du jour de migration est donc la **distribution
   des déplacements** (médiane 1,3 km, max 98 km, aucun aberrant) et le fait
   que chaque point prod est soit conservé (`previous_ingest`), soit remplacé
   par un point ANS.
3. **Dry-run n°3** : tous les garde-fous passent.

4. **Dry-run n°4 (après la revue `/simplify`, forcé par `FORCE_REINGEST=1`)** :
   staging strictement identique à la prod fraîchement swappée —
   `added 0 / removed 0 / lost_geom 0 / moved 0` — en **52 s** au lieu de 91,8
   (`streamValues: false`, lots de 1 000, tampons 1 Mo). Au passage : le
   forçage était inopérant sur FINESS (flag jamais transmis, ni par le script
   ni par le workflow) — corrigé.
5. **Dry-run n°5 (politique de validation extraite en `finess-validate.ts`,
   bornes WGS84 élargies au domaine complet)** : toujours identique à la prod,
   **47 s**, et 2 établissements de plus géolocalisés (99 465) — leur WGS84
   sortait de l'emprise « France » qui ne servait à rien dans la détection.

**Run réel n°2 (2026-09-05 22:25 UTC, code final après revue `/review-fix`)** :
`success` en **69 s**, forcé (`FORCE_REINGEST=1`, marqué `forced`), staging
identique à la prod du run n°1 sauf les **186 centroïdes commune refusés**
(tous repris par `previous_ingest` : 21 222), `geom_source` aligné sur le code
(`ans` / `previous_ingest`), canary 5/5, matview reconstruite en 20 s.

**Run réel n°1 (2026-09-05 21:24 UTC, local contre la prod)** : `success` en
91,8 s — swap atomique, **canary 5/5** (`canary_failures = null`, Timone
`130783293` incluse), `ingest_rebuild_finess_hosted_activities` en 19,9 s
(2 115 lignes). Prod après swap : 104 734 établissements, 99 463 géolocalisés,
2 816 DOM, `020010229` (fermé en 2010) disparu, `080010085` (Rethel) en
`previous_ingest`, 91 542 SIRET dans `raw`, `finess_previous` = 93 403 lignes
(rollback par rename). Vérification E2E via l'endpoint MCP de production :
`etablissements_finess_in_radius` autour de Saint-Denis de La Réunion renvoie
des pharmacies — territoire absent de l'outil jusqu'à ce jour.

Bilan géolocalisation : **99 463 établissements géolocalisés contre 93 401
aujourd'hui (+6 062)**, dont les DOM ; 5 271 nouveaux sans point, à géocoder
en phase 2.

## 7. Phase 2 (backlog)

- Géocodage BAN du résiduel sans point (adresse structurée complète +
  `cle_ban` fournie par l'ANS pour une partie) via le cache `geocoded_addresses`.
- Colonnes dédiées `siret`, `cle_ban`, `score_ban`, `geom_source` (aujourd'hui
  dans `raw`) + parité `ingest_create_finess_staging`.
- Consommer `finess-activites-1` (autorisations d'activité).
- Ajouter le dataset `FINESS - Structures` (ANS) aux jeux de données de la
  réutilisation data.gouv.fr publiée le 2026-09-05.
- Alerte Sentry `warning` quand des `same_checksum` s'enchaînent au-delà de la
  cadence attendue d'une source (Ameli, RPPS, CDS restent exposés au même
  angle mort).
