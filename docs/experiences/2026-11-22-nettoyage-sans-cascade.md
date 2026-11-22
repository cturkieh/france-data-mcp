# Nettoyage des copies de secours : `DROP … CASCADE` détruit une matview encore liée (2026-11-22)

## Question

`ingest_drop_stale_previous` supprime `<prod>_previous` en `DROP TABLE … CASCADE`. Si un run
d'ingestion s'arrête entre la bascule et la reconstruction des matviews, celles-ci sont-elles
vraiment emportées avec la copie ? Et retirer `CASCADE` suffit-il, sans bloquer le nettoyage normal ?

Le risque était jusque-là déduit du code (revue de la PR #96, backlog P2). Le run RPPS du
2026-09-05 a bien été tué 5 s après sa bascule, mais la destruction elle-même n'avait jamais été
rejouée.

## Protocole

Base jetable Postgres 17.10 (Homebrew, `initdb` dans le dossier temporaire de la session, écoute
`127.0.0.1` seulement). Aucune commande sur la prod. Rôles `anon`, `authenticated`, `service_role`
créés, avec le même défaut que Supabase (`ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS`),
et une table `ingest_log` réduite aux colonnes lues par la fonction.

Cas d'école, remis à zéro avant chaque phase :

1. table `demo` avec ce qu'une table servie possède en prod (clé primaire, séquence de son `id`,
   index, valeur par défaut, contrainte `CHECK`, RLS et policy `anon`) ;
2. matview `demo_stats` construite sur `demo` ;
3. nouvelle version `demo_staging`, puis bascule par les mêmes `RENAME` qu'`ingest_atomic_swap`
   (`demo` → `demo_previous`, `demo_staging` → `demo`), sans reconstruire la matview ;
4. un seul `success` dans `ingest_log`, vieux de 30 jours (le run de la bascule n'a rien écrit).

Après l'étape 3, `pg_depend` confirme que `demo_stats` est liée à `demo_previous`, pas à `demo`.

Phase A : fonction d'origine (`20260514T080000`), puis `ingest_drop_stale_previous('demo','demo',4)`.
Phase B : fonction corrigée (`20261122T210000`), même appel, puis réparation (matview reconstruite
sur `demo`) et nouvel appel.

## Coût

0 €. Une vingtaine de minutes.

## Résultats

| Phase | Retour de la fonction | `demo_previous` | `demo_stats` |
|---|---|---|---|
| A, d'origine | `dropped:demo_previous:30d` (`NOTICE: drop cascades to materialized view demo_stats`) | supprimée | **supprimée**, sa lecture rend `relation "demo_stats" does not exist` |
| B, corrigée | erreur `2BP01: cannot drop table demo_previous because other objects depend on it` | conservée | conservée, lisible |
| B, après réparation | `dropped:demo_previous:30d` | supprimée | conservée, liée à `demo` |

Après la suppression de la phase B : la table servie `demo` garde ses 50 lignes et accepte un
`INSERT` (sa séquence est la sienne), les index et la séquence de l'ancienne table sont partis avec
elle. Ce que la table possède ne bloque donc pas un `DROP` sans `CASCADE`.

Les autres retours sont inchangés : `kept:demo_previous:2d` (succès il y a 2 jours),
`no_history:demo_previous` (aucun succès), `absent:nexistepas_previous`, et les deux refus d'entrée
(nom invalide, seuil hors `[1, 365]`). Droits après le correctif : `anon` et `authenticated` sans
`EXECUTE`, `service_role` avec, une seule surcharge, `SECURITY DEFINER` et `search_path` conservés.

Lecture de la prod le même jour (`pg_depend`, lecture seule) : `annuaire_ameli_previous` et
`centres_sante_previous`, les deux seules copies présentes, n'ont que des dépendants qui leur
appartiennent (index, clé primaire, séquence, valeurs par défaut, contrainte, policy, table TOAST).
Les matviews et la vue servies sont liées aux tables servies (`ameli_nomenclature_stats` à
`annuaire_ameli`, `finess_hosted_activities` à `finess` et `rpps`, cinq matviews à `rpps`,
`iris_full` à `iris`). Dans l'état d'aujourd'hui, un `DROP` sans `CASCADE` passe.

Trouvé en revue et rejoué sur la base jetable : une VUE suit aussi sa table par OID. Après un
`RENAME`, `pg_get_viewdef` montre que la vue lit la table renommée. À la prochaine bascule IRIS
(cron du 2027-01-20, ou lancement manuel), `iris_full` restera donc liée aux tables
`iris*_previous` : elle servira l'ancien millésime, et le nettoyage échouera en 2BP01 pour les 4
tables IRIS tant que la vue n'est pas recréée. Avec `CASCADE` la vue aurait été détruite, et les
4 RPC IRIS avec. Le commentaire de `20260528T220000` (« résolue par nom, aucune bombe OID ») est
faux. Rien dans `iris.ts` ne recrée la vue après la bascule.

## Limites

- Cas d'école à une table et une matview : le comportement de `DROP … RESTRICT` ne dépend pas du
  nombre d'objets, mais les matviews réelles n'ont pas été rejouées.
- La fonction corrigée n'a pas été appelée en prod (elle supprime) : seule sa définition y sera
  relue après l'apply.
- `ingest_atomic_swap` garde son propre `DROP <prod>_previous_OLD CASCADE`, exécuté à la bascule
  suivante sur la copie d'avant. Non modifié : chemin commun aux 7 ingestions. La copie visée n'a
  plus de dépendant quand les matviews ont été reconstruites ; pour IRIS, c'est ce `DROP` qui
  détruirait `iris_full` à la 2e bascule.
- La protection vaut jusqu'à la bascule SUIVANTE de la source, pas au-delà : si une matview est
  encore liée à `<prod>_previous` à ce moment-là, le `CASCADE` de la bascule l'emporte, puis la
  reconstruction du même run la recrée (quelques minutes de 42P01). Gain net pour une source
  mensuelle ou qui stagne (RPPS), faible pour Ameli qui rebascule chaque lundi.
- La vue `iris_full` n'est pas réparée ici : il faut la recréer après chaque bascule IRIS (backlog P1,
  avant le 2027-01-20).

## Décision

Migration `20261122T210000_drop_stale_previous_sans_cascade.sql` : une seule ligne change
(`CASCADE` retiré), vérifié par `drop-stale-previous-migration.test.ts`. Une matview encore liée
fait échouer le nettoyage en 2BP01, le workflow alerte, rien n'est supprimé ; la réparation
(reconstruction des matviews de la source, ou de la vue `iris_full`) est rappelée dans l'alerte
de `cleanup-stale-previous.yml`. À appliquer en prod avant le merge.
