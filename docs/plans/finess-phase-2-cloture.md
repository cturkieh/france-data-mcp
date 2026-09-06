# FINESS phase 2 — clôture : colonnes dédiées, précision par résultat, drain BAN factorisé, autorisations d'activité (décision)

> Plan pré-implémentation. Instruit le 2026-09-06 à partir de deux inventaires
> (code + jeu `finess-activites-1`) et de mesures prod du jour. Source de vérité
> pour la migration `20260907T…_finess_dedicated_columns.sql`, la refonte des
> workflows `ban-backfill-*.yml` et la décision sur les autorisations d'activité.
> Jumeau visuel : `finess-phase-2-cloture.html`.

## 0. Décisions arrêtées

| Item backlog | Décision | Lot |
|---|---|---|
| 2 — colonnes dédiées `siret`, `cle_ban`, `score_ban`, `geom_source` | **Fait**, une migration, `raw` cesse de porter la provenance | Lot 1 |
| 10 — `geo_precision` par résultat côté FINESS | **Fait** sur le vocabulaire existant (`adresse`), **sans centroïde communal** ; les 647 sans voie restent sans point, par doctrine | Lot 1 |
| (nouveau) SIRET natif ANS | Exposé comme fait brut `siret_ans` + **candidat du resolver**, mesuré contre SIRENE avant merge | Lot 1 |
| 9 — trois workflows de drain BAN identiques | **Fait** : un `workflow_call` + trois appelants ; **fermeture automatique** des issues `pending-geocode` en fin de drain | Lot 2 |
| 3 — consommer `finess-activites-1` | **Hors clôture.** Chantier produit à part entière (1,45 Go/jour, table relationnelle, 8 nomenclatures). Reclassé V1.0+ avec les faits mesurés | Décision |

Deux lots, deux PR, une version : **0.30.0** (le contrat `FinessResult` gagne
deux champs et une étiquette de métadonnée change de nom).

---

## 1. Pourquoi deux lots et une décision

Les items 2 et 10 touchent **la même migration** : sortir `geom_source` de
`raw` est le préalable commun. Les traiter séparément imposerait deux
recréations successives de `ingest_create_finess_staging` (chacune superset
strict de la précédente) et deux réécritures du test de vocabulaire fermé.

L'item 9 est indépendant (YAML + un test), et c'est l'endroit naturel pour
corriger un défaut vu ce matin : les issues `pending-geocode` (#56, #63) ne se
ferment jamais seules, même file vidée.

L'item 3 n'est pas une finition : le flux structures ne contient **aucun**
champ d'activité, tout serait nouveau (§4).

---

## 2. Lot 1 — schéma `finess` : colonnes dédiées, `geo_precision`, SIRET ANS

### 2.1 Mesures prod (2026-09-06, 104 734 établissements en service)

| `raw->>'geom_source'` | Lignes | Avec SIRET ANS | Avec clé BAN |
|---|---|---|---|
| `ans` | 78 243 | 69 469 | 78 243 |
| `previous_ingest` | 21 222 | 18 544 | 186 |
| `ban_address` | 2 720 | 1 986 | 0 |
| absent (`geom IS NULL`) | 2 549 | 1 543 | 0 |

Les 2 549 sans point = 647 sans voie (jamais géocodables) + 1 902 rejets BAN.

SIRET : sur 3 000 EGE porteurs d'un SIRET ANS bien formé, 1 241 ont un SIRET
côté `rpps` et **1 241 concordent** (0 désaccord). Ce n'est pas une preuve
d'actualité : les deux référentiels sortent du même producteur (ANS). La
confrontation qui compte est contre SIRENE (§2.5). Point clé : **59 % de
l'échantillon n'a aucun SIRET côté RPPS** — le SIRET ANS couvre là où la
cascade actuelle n'a que le repli géographique.

État du code : `FinessRawExtras { siret?, cle_ban?, score_ban?, geom_source? }`
écrit dans `raw` (`finess-ans-parse.ts:202-207, 492-498`). Aucune lecture de
`raw` en TS ; en SQL, seul `raw->>'geom_source'` est lu par trois RPC
d'ingestion (`20260905T210000`, `20260905T213000`, `20260906T120000`).
`staging-parity.test.ts` **ne couvre pas finess** ; le garde est
`finess-column-rules-parity.test.ts` (règles par colonne `CHAR/VARCHAR` +
vocabulaire `geom_source` fermé vérifié textuellement sur le SQL).

### 2.2 Migration `20260907T…_finess_dedicated_columns.sql` (format T, apply via MCP)

```sql
ALTER TABLE finess
  ADD COLUMN siret       CHAR(14),
  ADD COLUMN cle_ban     TEXT,
  ADD COLUMN score_ban   REAL,
  ADD COLUMN geom_source TEXT
    CHECK (geom_source IN ('ans','previous_ingest','ban_address')),
  ADD CONSTRAINT finess_geom_source_iff_geom
    CHECK ((geom IS NULL) = (geom_source IS NULL));

-- Peuplement one-shot depuis raw (~105 K lignes, < 10 s), puis raw ne porte
-- plus la provenance : le cron suivant écrit les colonnes directement.
UPDATE finess SET
  siret       = CASE WHEN raw->>'siret' ~ '^\d{14}$' THEN raw->>'siret' END,
  cle_ban     = raw->>'cle_ban',
  score_ban   = CASE WHEN raw->>'score_ban' ~ '^[0-9.]+$' THEN (raw->>'score_ban')::REAL END,
  geom_source = CASE WHEN geom IS NOT NULL THEN raw->>'geom_source' END;

CREATE INDEX finess_siret_idx ON finess (siret) WHERE siret IS NOT NULL;
```

Puis, dans la même migration :

- `ingest_create_finess_staging()` recréée en **superset strict** (4 colonnes
  + index `siret` + la contrainte, recopie verbatim de la dernière définition
  `20260509000001:24-73`) ;
- les trois RPC d'ingestion réécrites : `ingest_apply_finess_geom_previous`
  (repli) et `ingest_apply_finess_ban_join` (pose) écrivent **la colonne**
  `geom_source` (plus `jsonb_build_object` dans `raw`) ; la RPC de diff agrège
  `staging_geom_source` depuis la colonne ; `finess_is_ban_eligible` inchangée ;
- les trois RPC de lecture (`finess_in_radius`, `finess_by_categorie`,
  `finess_by_num_finess`) : `DROP FUNCTION` puis recréation avec `siret` et
  `geom_source` dans `RETURNS TABLE` (changement de signature de retour).

Invariant nouveau, porté par la contrainte : un point a toujours une
provenance, une ligne sans point n'en a jamais.

### 2.3 Parseur et cron

- `FinessStagingRow` gagne `siret | null` (validé `^\d{14}$`, sinon `null` +
  compteur `siret_malformed` dans le log de parse), `cle_ban | null`,
  `score_ban: number | null` (`Number` + `isFinite`), `geom_source` (colonne,
  `null` si `geom` nul). `FinessRawExtras` disparaît : `raw` = payload ANS brut.
- `COLUMN_RULES` gagne la règle `siret` (le test de parité l'exige pour tout
  `CHAR(n)`).
- `finess-column-rules-parity.test.ts` : le bloc « vocabulaire fermé » vérifie
  désormais les littéraux affectés à **la colonne** (`SET geom_source = 'x'`,
  `CHECK (... IN (...))`) contre `GEOM_SOURCES` TS ; le `CASE` du repli est
  vérifié sur `f.geom_source`.
- **Trou comblé** : `staging-parity.test.ts` gagne un bloc `finess`
  (colonnes + index prod ↔ `ingest_create_finess_staging`), au même patron que
  `annuaire_ameli`.
- `src/storage/supabase-types.ts` : colonnes ajoutées.

### 2.4 Lib et tools : `geo_precision` par résultat, `siret_ans`

- `FinessResult` (`src/sante/finess-db.ts:30-45`) gagne
  `geo_precision?: PerResultGeoPrecision` (posé **seulement si `coords`**,
  comme Ameli, `ameli-db.ts:438`) et `siret_ans: string | null` (fait brut,
  jamais interprété, doctrine `succession`).
- Mapping `finessGeoPrecisionFromSource(geom_source)` : les trois valeurs →
  `adresse` (point ANS natif, point BAN accepté par précision rue/lieu-dit/
  numéro, ou hérité de l'un des deux). Warn 1-shot si la RPC ne renvoie pas
  la colonne (drift prod ↔ lib), `_resetXForTesting`. **Pas de valeur
  `centroide_commune`** : voir §2.6.
- Étiquette globale : `lambert93_natif_finess` est un mensonge depuis le
  2026-09-05 (points WGS84 natifs ANS ou BAN). Renommée
  **`point_etablissement_finess`**, notes (`query-metadata.ts:20-22,128`)
  réécrites (« FINESS ANS, flux quotidien, cron le 1ᵉʳ et le 15 »). Changement
  de contrat documenté au CHANGELOG (raison du 0.30.0).
- `panorama_implantation_complet` : `countPrecis()` (`:221-224`) appliqué aux
  FINESS comme aux RPPS/Ameli.
- Descriptions des tools `etablissements_finess_in_radius`,
  `etablissements_finess_by_categorie`, `etablissement_by_finess` : une phrase
  sur `geo_precision` et `siret_ans`.

### 2.5 Resolver SIRET : le SIRET ANS devient un candidat

`resolveSiretsForFiness` (`siret-resolver.ts:438`) ne lit aucun SIRET FINESS.
Sa cascade : SIRET distincts côté `rpps` → DINUM par SIREN → repli
géographique 150 m avec « actif prime ». Le SIRET ANS entre **en source 1, à
côté des SIRET RPPS** (dédoublonnés, même validation `^\d{14}$`) : la cascade
existante valide chaque candidat contre DINUM et fait primer l'établissement
actif, donc un SIRET ANS périmé est traité comme l'est déjà un SIRET RPPS
périmé. `method` gagne la valeur `siret_ans` quand c'est lui qui a porté le
`best_match`. Aucune recalibration des seuils (mémoire `v016-succession-fix`).

**Mesure avant merge** (script one-shot en scratchpad, DINUM live, ~300 EGE
tirés au sort parmi ceux SANS SIRET RPPS) : part des SIRET ANS actifs selon
DINUM, part où le `best_match` actuel (repli géographique) est **différent**
du SIRET ANS et lequel est actif. Chiffres reportés dans l'en-tête de la
migration et le CHANGELOG. Seuil de renoncement : si > 10 % des SIRET ANS
sont fermés côté DINUM **et** que le repli géographique trouvait l'actif,
le SIRET ANS reste un fait brut sans entrer dans la cascade.

### 2.6 Les 647 sans voie : décision

Un `geo_precision` FINESS ne « débloque » les 647 que si l'on admet en base un
centroïde communal marqué comme tel. La doctrine du repo le refuse : le cron
RPPS recopie le point FINESS dans `rpps` sous `geom_source = 'finess_join'`,
tier **précis** du GiST partiel `rpps_geog_precise_gist` (prédicat verrouillé
par `staging-parity.test.ts:236-320`). Admettre un centroïde ici, c'est
contaminer la précision RPPS.

**Décision : pas de centroïde.** Les 647 restent visibles par catégorie et par
numéro, `coords: null`, sans `geo_precision`, invisibles des recherches par
rayon. C'est la vérité. Le déclencheur du backlog (« un caller signale un
établissement absent d'une recherche par rayon ») n'est jamais survenu ; item
10 clos par décision, tracée ici et au CHANGELOG.

### 2.7 Méthode de preuve du lot 1

1. **Unit** (`pnpm test:unit`) : parité staging finess (nouveau bloc), règles
   de colonnes + vocabulaire fermé réécrits, contrat `FinessResult`
   (`finess-db.test.ts`, `tools.test.ts`), mapping + warn de drift, resolver
   avec candidat ANS (accord / désaccord / SIRET fermé, DINUM mocké),
   parseur (`siret` malformé → `null` + compteur).
2. **Migration** appliquée en prod via MCP `apply_migration` ; vérification
   immédiate : `count(*) FILTER (WHERE geom_source IS NULL) = count(*) FILTER
   (WHERE geom IS NULL) = 2 549`, distribution des colonnes = tableau §2.1,
   `EXPLAIN` de `finess_in_radius` inchangé (KNN GiST).
3. **Dry-run cron sans swap** (`workflow_dispatch` « Ingest FINESS », mode
   dry-run) : diff propre, **0 point déplacé**, `staging_geom_source` égal à
   la distribution prod à la marge du flux du jour, `siret_malformed` reporté.
4. **Run réel forcé**, puis appels MCP prod : `etablissement_by_finess` sur un
   EGE `ans`, un `ban_address`, un sans point ; `etablissements_finess_in_radius`
   avec `geo_precision` sur chaque résultat ; `reconcilier_finess_sirene` sur
   un EGE sans SIRET RPPS → `method = siret_ans`.
5. **Non-régression géo** : taux de points déplacés au run réel = 0 ; couverture
   ≥ 97,5 %.

---

## 3. Lot 2 — `workflow_call` de drain BAN + fermeture automatique des issues

### 3.1 État

Trois fichiers de 121-132 lignes, **six valeurs varient** (nom, workflow
surveillé, groupe de concurrence, nom du step, `--source`, labels) plus un
bloc propre à FINESS (code de sortie 2 = canari avec backlog restant,
`ban-backfill-finess.yml:104-110`) et deux textes d'alerte divergents.
Aucun `on: workflow_call` dans le repo ; cinq composites, dont la contrainte
prouvée (run #33960886473) : une composite ne peut référencer ni `job.*` ni
`secrets.*` — argument pour un `workflow_call`, qui accepte `secrets: inherit`.

### 3.2 Design

`.github/workflows/ban-backfill.yml` (`on: workflow_call`) :

- inputs : `source` (rpps|ameli|finess), `source-label`, `issue-labels`,
  `failure-modes`, `killed-hint`, `max` (canari), `tolerate-canary-backlog`
  (bool, `true` pour FINESS : exit 2 → succès) ;
- `secrets: inherit` ; `permissions: contents: read, issues: write` ;
- steps : checkout **en premier**, preflight secrets, pnpm/node, drain, step
  **« Close pending-geocode issue »** (nouveau, §3.3), step « Alert on failure
  or cancelled run » inchangé.

Trois appelants de ~30 lignes : `name`, `on: workflow_run` (nom du cron
surveillé) + `workflow_dispatch` (input `max`), `concurrency`, garde
`conclusion == 'success'`, `permissions` (GitHub exige leur redéclaration chez
l'appelant), `jobs.backfill.uses: ./.github/workflows/ban-backfill.yml` avec
`with:` (6 valeurs) et `secrets: inherit`.

### 3.3 Fermeture automatique des issues `pending-geocode`

Aujourd'hui `notify-pending-geocode` ouvre ou commente l'issue quand des
adresses restent à géocoder après un cron, et rien ne la ferme. Le drain est
exactement le signal de fermeture. Règle : drain terminé en **exit 0** (file
vidée, pas un canari en exit 2) → l'issue ouverte portant les labels
`pending-geocode,<source>` est fermée avec un commentaire « ✅ File vidée par
le drain du <date> : N adresses traitées, M acceptées. Run : … ».

Implémentation : `upsert-ops-issue` gagne un input `action: open|close`
(l'invariant « émetteur unique d'issue » du test reste vrai) ; le script
`ban-backfill.mjs` écrit ses compteurs en `GITHUB_OUTPUT` (`processed`,
`accepted`, `remaining`) — il les a déjà en log. Best-effort : échec de
fermeture = log LOUD, jamais un run rouge.

### 3.4 `workflows-alerting.test.ts`

Partition par **parse YAML** (déjà importé) : réutilisable (`on.workflow_call`),
appelants (`jobs.*.uses`), workflows à steps. Assertions :

- le réutilisable porte checkout en premier + step d'alerte `failure() ||
  cancelled()` + `issues: write` ;
- chaque appelant : `permissions.issues == write`, `uses` pointe le
  réutilisable, `with.source` ∈ {rpps, ameli, finess} et cohérent avec le nom
  du fichier, `secrets: inherit` ;
- le compte de workflows alertants passe de 9 à 7 + 1 réutilisable (le test
  l'affirme explicitement, plus de `>= 8` implicite) ;
- nouveau : chaque source de `notify-pending-geocode` a un drain qui ferme
  (`action: close` présent dans le réutilisable).

### 3.5 Méthode de preuve du lot 2

1. `pnpm test:unit` (partition, invariants, `ban-backfill.mjs` outputs).
2. `workflow_dispatch` de **chaque** appelant avec `max` canari → 3 runs verts,
   step d'alerte présent et skippé, FINESS en exit 2 toléré.
3. Fermeture auto : ouvrir à la main une issue labellisée
   `pending-geocode,ameli`, lancer le drain Ameli (file vide, mesure = 0) →
   issue fermée avec le commentaire ; la relancer avec `max=1` sur RPPS → pas
   de fermeture (canari).
4. Chemin d'alerte : annuler un run manuellement → issue + email (déjà prouvé
   le 2026-09-05 sur ces mêmes composites, à rejouer une fois sur le
   réutilisable).

---

## 4. Décision — `finess-activites-1` hors clôture (faits mesurés le 2026-09-06)

- Fiche data.gouv `finess-activites-1`, ANS, Licence Ouverte, **quotidien**,
  ressource stable `ed12913c-6bb2-4e47-8434-2f6e4f961c8e`. Le snapshot annuel
  annoncé **n'existe pas** (404 garanti). Schéma officiel
  `ansforge/finess` (`schema-activites-v1.json`), avec **deux erreurs
  vérifiées** (`typeActiviteSMSSE` déclaré codé par une nomenclature de motif
  d'arrêté ; sémantique de `statutCapacite` inversée par rapport à TRE_R330).
- **58 Mo compressés, 1,45 Go décompressés** (2× le flux structures) :
  294 329 activités exercées (161 034 actives) sur 139 817 EGE, 187 371
  lignes de capacité. Clé de jointure = `numFinessEge` = notre `num_finess`.
- **Aucune nomenclature jointe** : 8 catalogues TRE à figer et surveiller
  (un seul aujourd'hui, TRE_R397). `typeActiviteSMSSE` (100 % des lignes)
  n'est résoluble par aucune nomenclature publique.
- Ce que ça apporterait : `activite_hebergee` est aujourd'hui une **inférence
  RPPS** (≥ 3 professionnels d'un savoir-faire sur le site). Le déclaratif
  la recoupe partiellement : biologie 5 785 sites déclarants dont ~1 260
  hors labo (la lentille en voit 688, l'inférence rate la majorité) ;
  imagerie 1 685 vs 1 631 (recoupement 2/3) ; **pharmacie : rien**. Plus deux
  matières absentes de toute source : le **parc d'équipements lourds** par
  site (1 246 sites scanner, 1 156 IRM, 231 TEMP, 226 TEP autorisés) et les
  **capacités** (36 940 établissements avec lits/places), avec deux pièges de
  comptage qui multiplient par 3 à 4 si l'on somme naïvement.

C'est un domaine produit nouveau (autorisations, équipements, capacités),
avec sa table relationnelle, son cron, ses nomenclatures et ses tools. Il ne
« termine » pas la migration ANS. **Reclassé V1.0+ au backlog** avec ces
faits, pour ne pas les réinstruire.

---

## 5. Ordre, versions, PR

| Étape | Livrable | Version |
|---|---|---|
| Lot 1 | PR `feat/finess-dedicated-columns-geo-precision` : migration + parseur + lib + resolver + tests ; mesure SIRET dans l'en-tête de migration | 0.30.0 |
| Lot 2 | PR `refactor/ban-backfill-workflow-call` : réutilisable + 3 appelants + fermeture auto + test | même release |
| Docs | CHANGELOG (deux entrées + décisions items 3 et 10), backlog (items 2, 9, 10 retirés ; item 3 reclassé V1.0+), `PROJECT-STATE.html` | — |

Cyril merge chaque PR ; la migration du lot 1 est appliquée en prod par
Claude via MCP **avant** le run de preuve, comme pour les lots précédents.

## 6. Risques et parades

| Risque | Parade |
|---|---|
| `DROP FUNCTION` des RPC de lecture = fenêtre sans RPC pendant l'apply | Une seule transaction de migration ; l'apply MCP est atomique |
| Contrainte `geom IFF geom_source` fait échouer un swap si une RPC oublie la colonne | Le dry-run sans swap l'attrape ; la contrainte existe aussi en staging (superset) |
| Renommage de l'étiquette `lambert93_natif_finess` casse un caller qui la matche | Documenté CHANGELOG 0.30.0 ; valeur d'un champ de métadonnées, pas d'un résultat |
| SIRET ANS périmé promu `best_match` | Impossible par construction : DINUM valide chaque candidat, « actif prime » ; mesure §2.5 avant merge |
| Appelants `workflow_call` sans `permissions` → issue non créée | Assertion dédiée du test ; run réel de chaque appelant |
