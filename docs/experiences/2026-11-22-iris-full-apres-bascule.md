# Vue `iris_full` : elle reste liée aux anciennes tables après une bascule IRIS (2026-11-22)

## Question

Les 5 RPC IRIS (`iris_profil_by_code`, `iris_at_point`, `iris_in_radius`,
`iris_in_radius_of_code`, `iris_by_commune`) lisent la vue `iris_full`, jointure de `iris`,
`iris_population`, `iris_familles` et `iris_revenu`. `iris.ts` bascule ces 4 tables par RENAME
(`ingest_atomic_swap`). Que lit la vue après une bascule, et que lui arrive-t-il à la suivante ?
Une fonction qui redéfinit la vue suffit-elle, sans casser une lecture en cours ?

Le défaut avait été vu en revue de la PR #106 (une vue suit ses tables par OID). Il restait à le
rejouer de bout en bout, puis à prouver le correctif.

## Protocole

Base jetable Postgres 17.10 (Homebrew, `initdb` dans le dossier temporaire de la session, écoute
`127.0.0.1` seulement). Aucune écriture en prod. Rôles `anon`, `authenticated`, `service_role` avec
les mêmes privilèges par défaut que Supabase.

État de départ, remis à zéro avant chaque cas :

- les 4 tables IRIS avec les colonnes que la vue lit, clé primaire, index, RLS et policy `anon`
  (200 îlots, 60 lignes de revenu pour reproduire la couverture partielle). PostGIS n'est pas
  installé en local : `geog` et `centroid_geog` sont des colonnes `TEXT`, la vue ne fait que les
  exposer ;
- la vue créée par le texte exact de `20260528T220000` (lignes 23 à 44) ;
- `iris_profil_by_code` et `ingest_atomic_swap`, extraites telles quelles des migrations.

Une « ingestion » = 4 tables `_staging` dont le libellé porte le numéro du millésime, puis les 4
appels à `ingest_atomic_swap`. Lecture de la prod le même jour en lecture seule (`pg_depend`,
`pg_class`, `pg_proc`) pour caler l'état de départ : vue liée aux 4 tables servies, option
`security_invoker=true`, mêmes droits que sur le banc, aucun objet ne dépend de la vue, les 5 RPC
sont en `LANGUAGE sql` à corps texte.

## Coût

0 €. Une heure environ.

## Résultats

Phase A, sans correctif :

| Étape | Table `iris` | La RPC (vue) sert | Vue |
|---|---|---|---|
| Après la 1re bascule | millésime 2 | **millésime 1** | liée aux 4 tables `_previous` |
| `DROP TABLE iris_previous` (nettoyage) | | | refus 2BP01, « view iris_full depends on table iris_previous » |
| Après la 2e bascule | millésime 3 | erreur `relation "iris_full" does not exist` | **détruite** (`NOTICE: drop cascades to view iris_full`) |

Phase B, avec `20261122T230000` :

| Cas | Résultat |
|---|---|
| Apply de la migration sur la vue existante | rend `{iris,iris_familles,iris_population,iris_revenu}`, OID de la vue inchangé, option et droits inchangés |
| Cycle complet (reconstruction, 4 bascules, reconstruction) | entre la dernière bascule et la reconstruction la RPC sert le millésime 1 ; après, le millésime 2, population, ménages et revenu compris (200 lignes, 60 avec revenu) |
| Nettoyage des 4 copies sans `CASCADE` | passe, la vue reste |
| Deux cycles de plus, copies gardées | la vue survit à chaque bascule, même OID sur les 3 cycles, millésimes 3 puis 4 servis |
| Droits | `anon` lit la vue (RLS des tables) ; `anon` et `authenticated` ne peuvent pas appeler la fonction ; `service_role` oui ; vue possédée par `postgres` |
| Run tué après 2 bascules sur 4 | vue liée à 2 tables servies et 2 `_previous` ; un appel la rattache aux 4 tables en place |
| Run tué après les 4 bascules, puis run suivant sans reconstruction d'avant-bascule | vue détruite par le `CASCADE` de la bascule |
| Même cas, avec reconstruction d'avant-bascule | vue conservée, la RPC répond pendant tout le run |
| Lecture qui tient la vue 8 s | la fonction abandonne à 5 s (`lock timeout`), vue intacte, l'appel suivant passe |
| Lecture de 3 s en cours, reconstruction en attente, 2e lecture arrivée derrière | les trois aboutissent, aucune erreur |
| Vue portant une colonne que la fonction ne connaît pas | erreur « cannot drop columns from view », vue inchangée |
| Variante `DROP VIEW` + `CREATE VIEW` dans une transaction, mêmes lectures concurrentes | les lectures aboutissent aussi ; l'OID de la vue change, les droits reviennent par les privilèges par défaut |
| Vue absente | créée, avec `security_invoker` et les droits ; `anon` la lit |
| Une table servie manque | erreur `relation "iris_revenu" does not exist`, vue inchangée |
| 20 appels de suite | même OID, mêmes tables |
| Table temporaire nommée `iris` dans la session appelante | la vue reste liée aux tables du schéma `public` (`pg_temp` en fin de `search_path`) |

## Limites

- Colonnes géographiques en `TEXT` sur le banc : `ST_Covers` et `ST_DWithin` n'ont pas été
  rejoués. La fonction ne change pas le SELECT de la vue (parité testée), seulement les tables
  qu'il désigne.
- L'appel par PostgREST n'a pas été rejoué : le `statement_timeout` de la fonction (30 s) n'est
  vérifié que par sa présence dans `pg_proc`.
- Aucune ingestion IRIS réelle n'a tourné : le câblage dans `iris.ts` est couvert par des tests
  unitaires et un garde-fou sur le source, pas par un run. La prochaine bascule réelle est celle
  du 2027-01-20.
- Entre la dernière bascule et la reconstruction (quelques secondes), la vue sert encore l'ancien
  millésime. Elle passe au nouveau d'un coup, pour les 4 tables.
- Un run tué entre une bascule et la reconstruction laisse la vue sur des tables `_previous`
  jusqu'au run suivant ou à un appel manuel. Le nettoyage échoue alors en 2BP01 et alerte.
- Un run qui s'arrête sur des fichiers identiques au dernier succès (court-circuit) ne rattache
  rien : après un run forcé tué, la vue resterait sur des copies au contenu identique jusqu'à
  l'alerte 2BP01 du nettoyage.
- Une bascule validée en base alors que le client a reçu une erreur (réponse perdue) : le chemin
  d'échec tente le rattachement, mais si la bascule s'applique après lui, la vue repasse sur une
  `_previous`. Le message d'`ingest_log` le signale, rien ne le détecte tout seul.
- `ingest_atomic_swap` garde son `DROP <prod>_previous_OLD CASCADE` : la reconstruction
  d'avant-bascule retire ce qui en dépendait, elle ne retire pas le `CASCADE`.

## Décision

Migration `20261122T230000_iris_full_reconstruite_apres_bascule.sql` : `ingest_rebuild_iris_full()`
redéfinit la vue par `CREATE OR REPLACE VIEW` (OID et droits conservés), vérifie dans le catalogue
qu'elle est liée aux 4 tables servies et rend leur liste. `iris.ts` l'appelle avant la première
bascule et après la dernière, et la tente encore si le run échoue entre les deux (dès que
l'appel d'avant bascule a réussi, qu'une table ait basculé ou non).
`DROP VIEW` + `CREATE VIEW` marche aussi sur le banc, mais il est écarté : si la vue reçoit un
jour une colonne que la fonction ne connaît pas, il la ramènerait à l'ancienne forme sans erreur,
là où `CREATE OR REPLACE` refuse. À appliquer en prod avant le merge ; la migration appelle la
fonction une fois, sans effet sur une base saine.
