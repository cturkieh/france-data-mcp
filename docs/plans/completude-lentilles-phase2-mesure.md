# Phase 2 — Rapport de mesure de calibrage du signal `num_finess`

> **Statut** : mesure exécutée, décision go/no-go posée · **Date** : 2026-05-22 ·
> **Mesuré sur** : prod Supabase `france_data` (RPPS 2,23 M · FINESS 93 403).
>
> Rapport de la Tâche 8 du plan `docs/plans/completude-lentilles-plan.md`.
> Débloque la rédaction du plan d'implémentation de la couche d'activités
> dérivée (Phase 2 Route A) — voir §5.

---

## TL;DR

Le signal d'enrichissement RPPS `num_finess` (« un site héberge l'activité X si
≥ N professionnels de type X y sont rattachés ») a été mesuré sur les 3 activités
candidates. **Verdict : Route A validée.**

| Activité | Sites détectés (N≥3) | Faux positifs (échantillon 25) | Décision |
|---|---|---|---|
| **Biologie** | ~662 | 0 / 25 | ✅ **GO** — seuil N=3 |
| **Imagerie** | ~1 553 | ~0 / 25 | ✅ **GO** — seuil N=3 |
| **Pharmacie** | ~872 | ~2 / 25 | 🟡 **GO conditionnel** — N=3 + exclusion des catégories non-soignantes |

Le gain est massif, surtout pour l'imagerie : la famille `imagerie` renvoie
**0 résultat aujourd'hui** (code `619` mort), or RPPS révèle **~1 550 sites**
hébergeant une activité d'imagerie.

---

## 1. Méthode

Pour chaque activité, on compte les établissements FINESS **dont la catégorie
n'est PAS celle de l'activité** mais qui ont ≥ N professionnels de cette activité
rattachés via `rpps.num_finess`. Deux mesures :

1. **Gain par seuil** — nombre de sites détectés pour `N ∈ {1, 2, 3, 5, 10}`.
   Le seuil filtre le bruit (un rattachement isolé / périmé).
2. **Échantillon de faux positifs** — 25 sites tirés au hasard parmi les
   détectés à N≥3, revus manuellement (vrai plateau de l'activité ? ou site
   où la profession est présente pour une autre raison ?).

Filtres d'activité (sur RPPS) :
- **Biologie** : `savoir_faire ILIKE 'Biologie médicale%'` OU
  `ILIKE 'Anatomie et cytologie%'` OU `profession = 'Technicien de Laboratoire'`.
- **Imagerie** : `profession = 'Manipulateur ERM'` OU
  `savoir_faire ILIKE 'Radio-diagnostic%'` OU `ILIKE 'Radiologie et imagerie%'`.
- **Pharmacie** : `profession = 'Pharmacien'`.

Requêtes complètes en Annexe A.

---

## 2. Biologie — ✅ GO

### Gain par seuil

| N≥1 | N≥2 | N≥3 | N≥5 | N≥10 |
|---|---|---|---|---|
| 991 | 733 | **662** | 615 | 522 |

Total personnels de biologie rattachés à des sites non-labo : **32 351**.

La courbe est **plate de N≥3 à N≥10** (662 → 522) : la grande majorité des
sites détectés ont un effectif substantiel — ce sont de vrais plateaux, pas du
bruit. La marche N≥1→N≥3 (991 → 662) élimine les 329 sites à 1-2 personnes.

### Faux positifs

Échantillon de 25 sites à N≥3 — **0 faux positif**. Tous légitimes :
CHR/CHU (Calmette CHU Lille, Hôtel-Dieu CHU Toulouse), CH (Mâcon, Auxerre,
Dunkerque, Gonesse…), CLCC (Oscar Lambret), établissements de transfusion
sanguine EFS (qualification biologique du don — activité de biologie réelle),
Hôpital Américain, GCS hospitaliers. Catégorie marginale : un « Centre
d'Examens de Santé » (347, 5 personnels) — réalise des bilans biologiques,
acceptable.

### Décision

**GO. Seuil recommandé : N=3.** Précision mesurée 100 % sur l'échantillon. Gain :
~662 plateaux hospitaliers de biologie, **invisibles à `famille=labo`**
aujourd'hui (qui ne voit que ~4 112 labos autonomes après la correction de
catalogue de la Phase 1).

---

## 3. Imagerie — ✅ GO

### Gain par seuil

| N≥1 | N≥2 | N≥3 | N≥5 | N≥10 |
|---|---|---|---|---|
| 2 406 | 1 820 | **1 553** | 1 258 | 913 |

Total personnels d'imagerie rattachés : **43 803**.

### Faux positifs

Échantillon de 25 sites à N≥3 — **~0 faux positif**. Tous cohérents : cliniques
(`365`), CH/CHR, établissements de soins chirurgicaux (`128`), et — découverte
notable — de nombreux sites de catégorie **`698`** « Autre Établissement Loi
Hospitalière » et **`699`** « Entité Ayant Autorisation » dont les raisons
sociales sont explicitement des centres d'imagerie : « SCANNER LES ALBIZZIAS »,
« SCANNER JEAN DE BERRY », « IMAGERIE EN COUPE DU NORD BASSIN », « EML IRM-MAISON
CONSULTATIONS MÉDICALES », « EML SCM IMAG MED LES MASSUES ».

> **Découverte structurante.** L'imagerie de ville **existe** dans FINESS — mais
> classée sous les catégories fourre-tout `698`/`699` et les entités EML
> (Équipement Matériel Lourd), **jamais sous `619`** (qui est mort). Le signal
> RPPS la retrouve. C'est aussi un argument pour la **Route B** (ingestion FINESS
> « autorisations d'activités de soin » / EML) en complément ultérieur.

### Décision

**GO. Seuil recommandé : N=3.** Précision ~100 % sur l'échantillon. Gain
**spectaculaire** : `famille=imagerie` renvoie **0 résultat** aujourd'hui — la
couche dérivée exposerait ~1 553 sites.

---

## 4. Pharmacie — 🟡 GO conditionnel

### Gain par seuil

| N≥1 | N≥2 | N≥3 | N≥5 | N≥10 |
|---|---|---|---|---|
| 2 998 | 1 508 | **872** | 485 | 272 |

Total personnels « Pharmacien » rattachés à des sites non-officine/non-labo :
**13 129**.

La courbe **décroît fortement** (2 998 → 872 à N≥3 → 272 à N≥10) : beaucoup de
sites n'ont qu'1-2 pharmaciens. Le seuil compte ici davantage que pour la
biologie.

### Faux positifs

Échantillon de 25 sites à N≥3 — **~2 faux positifs / 25** (~92 % de précision) :
- Majorité **légitime** : CH/CHR, cliniques/hôpitaux privés (`365`), GCS dont
  certains explicitement « PUI » (« GCS LNA SANTE PUI SERRIS »), AGEPS APHP
  (l'agence pharmacie centrale de l'AP-HP).
- **Faux positif net** : « CFPPH » (catégorie `300` « Écoles Formant aux
  Professions Sanitaires ») — un **centre de formation** des préparateurs en
  pharmacie hospitalière, pas une PUI. La profession « Pharmacien » y est
  présente comme formateurs.
- **Borderline** : « GCS LBM BIOPARIV » (catégorie `696`) — un GCS de
  laboratoire ; ses pharmaciens sont des pharmaciens biologistes, pas une PUI.
- Cas à trancher : les établissements de transfusion `132` (EFS) — pharmaciens
  présents pour les médicaments dérivés du sang ; à inclure ou non selon la
  définition produit retenue.

### Décision

**GO conditionnel. Seuil recommandé : N=3, AVEC un gate de catégorie** excluant
les catégories non-soignantes — au minimum `300`/`330` (écoles), et décision
explicite à prendre sur `696` (GCS de moyens, dont GCS-LBM) et `132` (EFS). Sans
ce gate, ~8 % de bruit. Avec lui, la précision rejoint celle de la biologie.

---

## 5. Implications pour le plan d'implémentation Phase 2

La Route A (couche d'activités dérivée de RPPS `num_finess`) du cadrage
`completude-lentilles-sources.md` §6.1 est **validée empiriquement**. Le plan
d'implémentation Phase 2 (à rédiger via `superpowers:writing-plans`) peut être
écrit sur les paramètres suivants, désormais prouvés :

1. **Couche dérivée** : une matview (ou table) `finess_hosted_activities`
   mappant `num_finess → activités[]`, calculée par jointure
   `finess ⟕ rpps ON num_finess`, recalculée au cron RPPS mensuel.
2. **Activités v1** : biologie + imagerie (signal propre, N=3, GO franc).
3. **Activité v1.1** : pharmacie, avec le gate de catégorie (N=3 + exclusion
   `300`/`330` + décision `696`/`132`).
4. **Exposition** : une option des tools `famille` (ex. `inclure_activites_hebergees:
   true`) qui ajoute, aux établissements de catégorie X, les sites hébergeant
   l'activité X. Le champ `perimetre` (Phase 1) doit alors basculer sa
   `completeness_note` pour refléter que la couche est active.
5. **Garde-fou** : tout site ajouté via la couche dérivée doit être
   distinguable (provenance `source: 'activite_hebergee'`) d'un établissement de
   catégorie native — le MCP juxtapose, ne fond pas les deux.

La **Route B** (ingestion FINESS « autorisations d'activités de soin » / EML)
reste différée — la mesure imagerie montre qu'elle apporterait surtout une
confirmation autoritaire pour les EML, non un gain de couverture que la Route A
ne donne pas déjà.

---

## 6. Synthèse du gain territorial

| Activité | Couverture AVANT (tools actuels) | Sites cachés révélés (N≥3) |
|---|---|---|
| Biologie | ~4 112 labos autonomes (`famille=labo`) | **+662** plateaux hospitaliers |
| Imagerie | **0** (`famille=imagerie`, code `619` mort) | **+1 553** sites |
| Pharmacie | ~20 400 officines (`famille=pharmacie`) | **+872** PUI / pharmacies hospitalières |

---

## Annexe A — Requêtes SQL de mesure

```sql
-- Gain par seuil — biologie (idem imagerie / pharmacie en changeant le filtre)
WITH bio AS (
  SELECT f.num_finess, f.categorie_code, count(DISTINCT r.id) AS personnels
  FROM finess f JOIN rpps r ON r.num_finess = f.num_finess
  WHERE f.categorie_code NOT IN ('610','611','612')
    AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
          OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
          OR r.profession_libelle = 'Technicien de Laboratoire' )
  GROUP BY 1,2 )
SELECT
  count(*) FILTER (WHERE personnels >= 1)  AS sites_n1,
  count(*) FILTER (WHERE personnels >= 2)  AS sites_n2,
  count(*) FILTER (WHERE personnels >= 3)  AS sites_n3,
  count(*) FILTER (WHERE personnels >= 5)  AS sites_n5,
  count(*) FILTER (WHERE personnels >= 10) AS sites_n10,
  sum(personnels) AS personnels_total
FROM bio;

-- Filtre imagerie :
--   f.categorie_code IS DISTINCT FROM '619'
--   AND ( r.profession_libelle = 'Manipulateur ERM'
--         OR r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'
--         OR r.savoir_faire_libelle ILIKE 'Radiologie et imagerie%' )
-- Filtre pharmacie :
--   f.categorie_code NOT IN ('620','627','628','629','610','611','612')
--   AND r.profession_libelle = 'Pharmacien'

-- Échantillon de faux positifs (N≥3) — revue manuelle
SELECT f.categorie_code, f.categorie_libelle,
       count(DISTINCT r.id) AS personnels, f.raison_sociale
FROM finess f JOIN rpps r ON r.num_finess = f.num_finess
WHERE <filtre activité>
GROUP BY 1,2,f.num_finess,f.raison_sociale
HAVING count(DISTINCT r.id) >= 3
ORDER BY random() LIMIT 25;
```

## Annexe B — Décisions ouvertes pour le plan Phase 2

1. **Pharmacie — gate de catégorie** : liste exacte des catégories FINESS
   exclues du comptage PUI (a minima `300`/`330` écoles ; trancher `696`/`132`).
2. **Seuil N** : N=3 retenu pour les 3 activités sur la base de cette mesure ;
   à figer dans la couche dérivée (paramètre, pas magie).
3. **EFS (`132`)** : compte-t-il comme « biologie » ? (retenu oui ici) et/ou
   « pharmacie » ? Décision produit.
4. **Nom du flag d'exposition** côté tools (`inclure_activites_hebergees` ?).
