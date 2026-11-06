# Banc : recherche RPPS par nom via un index de noms distincts

**Date :** 2026-11-06. **Statut :** concluant sur une copie locale des données réelles, avec une conception différente de la piste de départ (2 listes et 1 index). Implémentation en attente de validation, mesure en prod à faire après déploiement.

## Question

Un index trigramme sur les noms distincts supprime-t-il les timeouts de `rpps_search_by_name` (HTTP 500 PostgREST, SQLSTATE 57014, coupure à 10 s), sans perdre de résultats ?

## Protocole

En prod, dans une seule transaction, sur des tables temporaires `ON COMMIT DROP` :

1. Construire la liste des noms distincts avec leurs identifiants, et un index trigramme.
2. Pour chaque terme : trouver les noms proches (`%`, seuil 0,3), les trier par similarité, garder 2 000 lignes au plus.
3. Lire ces lignes dans `rpps` par clé primaire, à la place du futur index sur `lower(nom)`.

La référence est l'`EXPLAIN ANALYZE` de la requête de candidats actuelle, à plafond et filtre de catégorie identiques.

## Coût

Première série : 21 s de lecture sur la base de prod. Deuxième série et seuil : moins de 4 minutes de lecture. Copie locale : téléchargement du fichier public (829 Mo) et environ 40 minutes de machine locale ; en prod, seulement des lectures de catalogue et de réglages, et un échantillon de 1 % pour la taille des lignes. Aucune écriture permanente, aucun service payant.

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

**Conception retenue** (SQL en annexe) : deux tables de valeurs distinctes, noms et prénoms, chacune avec son index trigramme ; un index `(nom, prenom, id)` sur `rpps` ; l'index département existant. Sans filtre, les noms sont parcourus du plus proche au plus lointain, avec arrêt à la limite. Avec un filtre, une seule requête prend les noms et prénoms proches. Les index trigrammes de `rpps` ne servent plus : seules `rpps_search_by_name` et la création du staging y font référence.

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

Un premier passage, avant les swaps, comptait 203 recherches actuelles au-delà de 10 s : l'ordre de grandeur est de 9 à 12 %.

**Justesse.** La version finale rend les mêmes lignes que la référence dans 2 224 cas sur 2 224. La version actuelle : 1 915, soit 86 %. 26 cas limites ont aussi été comparés à la référence, tous identiques : limite 501, catégories rares, `---`, apostrophe, tiret, accents, 200 caractères.

**Contrepartie.** 456 recherches sur 2 224 lisent plus qu'aujourd'hui, dont une seule de plus de 2 500 lectures (environ 1 s de plus à froid). Exemples : `martin` + département passe de 2 360 à 3 605 lectures, `martin` + `jean` de 1 921 à 3 576, `le` + département rare de 303 à 2 837. Au second passage, les pages sont déjà en mémoire et ces recherches ne lisent plus rien sur disque.

**Ingestion, test de bout en bout avec la fonction de swap de la prod :**

- **Nom nouveau :** introuvable avant reconstruction, trouvé après. Aucune fiche rendue n'est fausse ni absente de la nouvelle table, car les listes ne portent que des valeurs.
- **Panne de reconstruction, puis swap suivant :** une matview témoin est détruite par le `DROP ... CASCADE` du swap. La liste en table ordinaire survit et la recherche continue, seuls les noms nouveaux manquent.
- **Reconstruction des 2 listes :** 2 à 3,5 s en local.
- **Insertion de 2,3 M de lignes, tous index en place :** 99 et 106 s avec les index actuels, 74 et 78 s avec la conception retenue.
- **Disque :** index `(nom, prenom, id)` de 128 Mo et listes de 42 Mo, contre 176 Mo pour les 2 index trigrammes retirés en prod.

## Limites

- Les durées sont estimées depuis une copie locale. Seule une mesure en prod après déploiement les confirmera. Le disque local est bien plus rapide, seuls les nombres de lectures sont comparables.
- Le plan de la version actuelle varie entre les passages (203 ou 273 cas au-delà de 10 s). Cette version sert de comparaison, pas de mesure exacte de la prod.
- Non mesurés : la durée de reconstruction en prod, le verrou de `RENAME` sous trafic, le coût de `ST_AsGeoJSON` dans la sortie (les lignes sont déjà lues, il ne change pas leur nombre).
- Non testé : la piste « nom exact d'abord », qui laisserait les fautes de frappe sur le chemin lent. Un serveur plus puissant non plus : il ne corrige pas le plafond qui perd des résultats.

## Décision

Retenir la conception en annexe. Écartés, chiffres ci-dessus : la liste seule, le seuil relevé (il casse la tolérance aux fautes sans supprimer la lenteur), et `work_mem` à 64 Mo (il supprime les blocs lossy sans changer la durée, 23,8 s sur `ab`).

Les listes sont des tables ordinaires, et non des matviews comme les 3 autres listes dérivées de `rpps` : une matview ne survit pas à une reconstruction ratée suivie d'un swap.

Les critères fixés avant cette série sont tenus, sauf un : `martin` filtré n'est pas strictement « non dégradé » (environ 0,5 s de plus à froid). Ce coût est accepté au regard des 273 recherches qui dépassent 10 s aujourd'hui.

Preuve attendue après implémentation : `EXPLAIN` en prod sur les termes de cette page, parité des index prod et staging, durée réelle de reconstruction à la première ingestion.

## Annexe : SQL mesuré

Sans PostGIS : la RPC de prod doit garder ses colonnes de sortie, dont `geom`, `geo_precision` et son `statement_timeout`.

```sql
create index rpps_nom_prenom_id_idx on rpps (nom, prenom, id);

-- Reconstruction après swap : table neuve, puis RENAME.
create table rpps_noms_rebuild as select nom, lower(nom) as nom_lower from rpps group by 1 order by 2;
create unique index rpps_noms_rebuild_pk on rpps_noms_rebuild (nom);
create index rpps_noms_rebuild_trgm on rpps_noms_rebuild using gin (nom_lower gin_trgm_ops);
-- Même chose pour rpps_prenoms (prenom, prenom_lower), puis analyze, drop de l'ancienne et rename.

create function v6(p_nom text, p_prenom text, p_departement text, p_categorie_codes text[], p_limit integer)
returns table(id bigint, rpps_id text, nom text, prenom text, code_departement char(3), match_score real)
language plpgsql stable
set plan_cache_mode = force_custom_plan
as $function$
declare
  v_nom text := lower(trim(p_nom));
  v_prenom text := lower(trim(coalesce(p_prenom, '')));
  v_categorie_codes text[] := coalesce(nullif(p_categorie_codes, array[]::text[]), array['C']);
  v_reste int := p_limit;
  v_lues int;
  v_n record;
  v_noms text[];
  v_prenoms text[];
begin
  if v_prenom = '' and p_departement is null and v_categorie_codes @> array['C'] then
    for v_n in
      select n.nom, similarity(n.nom_lower, v_nom)::real as s
      from rpps_noms n where n.nom_lower % v_nom
      order by s desc, n.nom
    loop
      return query
        select r.id, r.rpps_id, r.nom, r.prenom, r.code_departement, v_n.s
        from rpps r
        where r.nom = v_n.nom
          and (r.categorie_code = any(v_categorie_codes) or r.categorie_code is null)
        order by r.prenom, r.id
        limit v_reste;
      get diagnostics v_lues = row_count;
      v_reste := v_reste - v_lues;
      exit when v_reste <= 0;
    end loop;
    return;
  end if;

  select array_agg(n.nom) into v_noms from rpps_noms n where n.nom_lower % v_nom;
  if v_noms is null then return; end if;

  if v_prenom = '' then
    return query
      select r.id, r.rpps_id, r.nom, r.prenom, r.code_departement, similarity(lower(r.nom), v_nom)::real as s
      from rpps r
      where r.nom = any(v_noms)
        and (p_departement is null or r.code_departement = p_departement::char(3))
        and (r.categorie_code = any(v_categorie_codes) or r.categorie_code is null)
      order by s desc, r.nom, r.prenom, r.id
      limit p_limit;
    return;
  end if;

  select array_agg(n.prenom) into v_prenoms from rpps_prenoms n where n.prenom_lower % v_prenom;
  if v_prenoms is null then return; end if;
  return query
    select r.id, r.rpps_id, r.nom, r.prenom, r.code_departement,
      ((similarity(lower(r.nom), v_nom) + similarity(lower(r.prenom), v_prenom)) / 2.0)::real as s
    from rpps r
    where r.nom = any(v_noms)
      and r.prenom = any(v_prenoms)
      and (p_departement is null or r.code_departement = p_departement::char(3))
      and (r.categorie_code = any(v_categorie_codes) or r.categorie_code is null)
    order by s desc, r.nom, r.prenom, r.id
    limit p_limit;
end;
$function$;
```
