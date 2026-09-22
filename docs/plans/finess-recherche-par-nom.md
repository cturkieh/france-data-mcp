# Retrouver un établissement de santé par son nom — `finess_search_by_name`

> Plan pré-implémentation. Instruit et mesuré le 2026-09-21 (lectures seules en
> prod, rien n'est codé). Chantier suivant Sit@del. Jumeau visuel :
> `finess-recherche-par-nom.html`.

## 0. Le problème, en clair

Question posée à l'outil : « dois-je implanter un centre de collecte à
l'Institut Gustave Roussy ? ». Le lieu part au géocodeur d'adresses (BAN, servie
par l'IGN). La BAN est un annuaire de **rues** : elle ne connaît aucun
établissement. Elle accroche le mot « Gustave » et propose des rues.

| Texte envoyé à la BAN (rejoué le 2026-09-21) | Réponse | Confiance |
|---|---|---|
| « Institut Gustave Roussy, Villejuif » | Rue Gustave **Flaubert**, Villejuif | 0,40 |
| « institut gustave roussy » | Rue Gustave Roussy, **Perpignan** | 0,52 |
| la question entière | aucun résultat | — |
| « 114 rue Édouard Vaillant 94800 Villejuif » | adresse exacte | 0,97 |

Aucune donnée fausse n'a été servie (le contrôle de cohérence commune de
geo-intel, en place depuis le 2026-09-09, refuse un score bas). Le trou qui
reste : un **nom de lieu sans adresse** + une conversation qui a dérivé vers une
autre commune. Le sinistre que ce contrôle doit empêcher est le rapport
« Villejuif » du 2026-07-07 rempli avec La Courneuve.

## 1. Correction d'une prémisse

« On a déjà l'outil côté MCP » est **faux** (vérifié dans le code et la liste des
tools) : FINESS se cherche par numéro, par catégorie ou par rayon — jamais par
nom. Seul le RPPS a `rpps_search_by_name`. `finess.raison_sociale` n'a aucun
index de recherche textuelle. L'extension `pg_trgm` est déjà installée en prod.

## 2. Mesures (prod, 104 726 établissements)

14 noms tapés « comme un humain », similarité trigramme par mots
(`word_similarity`), sans aucun réglage :

| Résultat | Cas |
|---|---|
| **10 / 14 justes du premier coup** | IGR, Curie, Foch, Léon Bérard, Pitié-Salpêtrière, CHU de Nantes, Timone, Pellegrin, Hôpital privé d'Antony, Hôpital Américain |
| Rattrapés en séparant **nom** et **territoire** | Clinique Pasteur Toulouse (la ville dans le texte polluait), Paul Brousse → 100 % |
| Bruit d'homonymes | « Necker » : pharmacies Necker avant l'hôpital → trier par catégorie d'établissement |
| Échec | « Georges Pompidou » : FINESS écrit `HOP EUROPEEN G POMPIDOU` (abréviations administratives) |

Deux faits structurants :

1. **L'IGR a 4 fiches FINESS** (CLCC, site EFS, service de santé au travail à
   Villejuif ; un site à Chevilly-Larue). Une règle « résultat unique » échoue
   sur le cas d'école. La bonne règle : **tous les candidats au-dessus du seuil
   sont dans la même commune → la commune est prouvée.** C'est exactement ce
   dont le contrôle anti-« La Courneuve » a besoin ; le point précis est un
   bonus (ici deux adresses du même campus).
2. **1,02 s par recherche sans index** (seq scan, `EXPLAIN ANALYZE`). Acceptable
   pour mesurer, pas pour servir → index GIN trigramme.

## 3. Qui fait quoi : Claude extrait, FINESS vérifie

La question est posée à Claude, qui appelle les tools : il **sait** que l'IGR est
à Villejuif. Le défaut est que le champ d'entrée s'appelle « adresse » et qu'il y
glisse un nom d'établissement. Mais lui faire confiance seul est fragile : sur
une clinique peu connue il peut inventer une adresse plausible.

| Maillon | Rôle |
|---|---|
| Claude (geo-intel) | sépare `etablissement`, `commune`, `adresse` — champs distincts, décrits dans le schéma du tool |
| `finess_search_by_name` (ce chantier) | vérifie le nom contre le référentiel, rend candidats + verdict de commune |
| BAN | reste le géocodeur des **adresses** ; n'est plus interrogée avec un nom |
| Contrôle de cohérence commune (geo-intel) | reste le filet final — FINESS ne couvre **que la santé** (« Centre commercial X », « Gare de Y » : trou inchangé) |

## 4. Conception

- **RPC `finess_search_by_name(p_query, p_code_insee, p_code_departement, p_limit)`** :
  `word_similarity(p_query, lower(raison_sociale))`, filtre territoire optionnel
  (hint, passé par `applyCommuneResolver` côté boundary), tri similarité puis
  rang de catégorie (hôpitaux/cliniques/CLCC avant pharmacies et annexes), puis
  longueur du libellé. `SET statement_timeout` fonction ; sortie
  `ST_AsGeoJSON(geom)::jsonb`.
- **Index GIN `gin_trgm_ops` sur `lower(raison_sociale)`**, recopié VERBATIM dans
  `ingest_create_finess_staging` (parité prod ↔ staging, `staging-parity.test.ts`)
  — sinon perdu en silence au prochain swap.
- **Normalisation côté TS** (`core/`, primitives texte existantes) : accents,
  casse, retrait des mots génériques (`hopital`, `clinique`, `centre`, `chu`) et
  du nom de commune du texte cherché.
- **Table d'abréviations FINESS** (`HOP`, `CTRE`, `CH`, `G` initiale…) : à
  dimensionner sur mesure, pas a priori (§5).
- **Sortie** : `LookupResult` — `candidates[]` (num_finess, raison_sociale,
  catégorie, commune, point, `geo_precision`, score) + `commune_prouvee`
  (`code_insee` si tous les candidats retenus concordent, sinon `null` + raison
  `ambiguous_communes`). Jamais de « meilleur candidat » servi seul quand les
  communes divergent : non résolu plutôt que faux.

## 5. Avant de coder : la mesure qui fixe les seuils

Rejouer la recherche sur les **noms réellement tapés** dans les rapports geo-intel
(export à fournir) — pas sur mes 14 exemples. Par classes : juste / ambigu /
introuvable / faux. Le seuil de similarité et la liste d'abréviations sortent de
cette mesure (doctrine projet : seuils sur mesure, jamais sur extrapolation).

## 6. Preuves attendues

| Preuve | Attendu |
|---|---|
| « Institut Gustave Roussy » (+ Villejuif en hint) | `commune_prouvee = 94076`, candidats IGR |
| « Institut Gustave Roussy » sans hint | 94076 **et** 94021 au-dessus du seuil → à arbitrer par la mesure §5 (seuil à 1,00 vs 0,63) |
| Nom ambigu (« Clinique Pasteur » sans territoire) | `commune_prouvee = null`, jamais un mauvais établissement |
| `EXPLAIN ANALYZE` après index | Bitmap Index Scan trigramme, < 50 ms |
| Swap FINESS suivant | l'index survit (`staging-parity.test.ts`) |

## 7. Lots

1. Migration index + RPC, test de parité staging, mesure `EXPLAIN`.
2. Lib `src/sante/` + tool MCP + validators boundary + tests (dont strings PostgREST).
3. Mesure sur noms réels → seuils + abréviations.
4. Côté geo-intel : champs séparés + appel du tool avant la BAN.

## 8. Addendum post-implémentation (2026-09-22)

- **§5 remplacé** : Sonnet nettoie l'entrée avant d'appeler le tool (nom
  propre + commune), la mesure a porté sur 25 noms de grands établissements,
  pas sur un export geo-intel. Seuil de décision **0,8** (vrais à 1,00, faux
  ≤ 0,79). Recalibrage futur sur les noms réellement envoyés par Sonnet
  (`docs/backlog.md`).
- **Abréviations écartées** (mesuré) : « CH de Bretagne Sud » n'existe pas
  sous ce nom dans FINESS ; « ch » court ajoute du bruit. « Georges Pompidou »
  reste un `aucun` documenté (`HOP EUROPEEN G POMPIDOU`) — relancer
  « Pompidou » + Paris donne l'HEGP en tête.
- **Rang par famille en TS** (`finess-categories.ts`, source unique), pas en
  SQL. **Commune prouvée au niveau commune-mère** (75056), pas arrondissement.
- Tool livré : `etablissement_finess_by_nom` ; preuve : `scripts/finess-name-parity.ts`.
