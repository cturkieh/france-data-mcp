# Cadrage — Complétude territoriale & lentilles de source

> **Statut** : cadrage validé, aucun code écrit · **Date** : 2026-05-22 ·
> **Base** : V0.16.0 · **Type** : document de décision
>
> Archive technique exhaustive. Présentation visuelle → `.html` jumeau.
> Supersede l'item backlog « Identification des labos hospitaliers » (P2),
> élargi à un chantier générique sur décision de Cyril (2026-05-22).

---

## TL;DR

Le MCP enveloppe 3 sources de données — FINESS, Ameli, RPPS — qui ont chacune
une **lentille structurelle** : une sélection intégrée que les tools ne
déclarent pas. `famille=labo` ne voit que les laboratoires *autonomes* et rate
~330 plateaux de biologie hospitaliers ; les tools Ameli ne voient que le
*libéral conventionné* et ratent ~49 % de l'effectif soignant (les salariés).
Le défaut produit : **un compte filtré-par-lentille rendu comme un compte
territorial réel, sans le dire** — biais silencieux pour une ARS ou un
journaliste.

Le chantier se découpe en 2 phases : **Phase 1 — Transparence** (chaque tool
déclare sa lentille ; correction de la dérive du catalogue FINESS ;
faible coût, actionnable maintenant) puis **Phase 2 — Complétude ciblée**
(reconstruction des activités manquantes via le signal `num_finess` de RPPS,
déjà en base ; décision sur chiffres mesurés, post-Phase 1).

---

## 1. Origine du chantier

Constaté pendant le fix V0.16 (succession M&A) : sur 4 057 établissements FINESS
de catégorie `611` « Laboratoire de Biologie Médicale », **5 seulement** portent
un libellé hospitalier. Les plateaux de biologie des hôpitaux ne sont quasiment
pas répertoriés comme « labo » dans FINESS.

L'item a d'abord été tracé comme « Identification des labos hospitaliers ».
Recadrage de Cyril, 2026-05-22 :

> « J'ai pris l'exemple des labos hospitaliers, mais cela doit s'appliquer dans
> tous les autres cas des autres spécialités couvertes par le MCP, le MCP étant
> générique toutes professions, et utilisé par des journalistes, ARS, etc. »

Le chantier n'est donc pas « réparer le cas labo » mais **caractériser et
traiter une limite structurelle générique** dont les labos hospitaliers sont
l'instance qui a fait surface. Périmètre arbitré avec Cyril : **FINESS
établissements + professionnels RPPS / Ameli**.

---

## 2. Le diagnostic — la thèse des lentilles

### 2.1 Trois sources, trois lentilles

Le MCP expose des données issues de 3 référentiels publics distincts. Chacun a
été constitué pour répondre à une question précise — et ne contient donc qu'une
**projection** de la réalité, pas la réalité entière :

| Source | Constituée pour | Lentille (ce qu'elle voit) | Angle mort |
|---|---|---|---|
| **FINESS** (ANS/DREES) | Recenser les *établissements* sanitaires/médico-sociaux | 1 **catégorie administrative dominante** par site géographique | Les activités *secondaires* hébergées dans un site d'une autre catégorie |
| **Ameli** (CNAM) | Facturer / annuaire des soins de ville | Professionnels en **exercice libéral conventionné** | Tout le personnel **salarié** (hôpital, centres, salariat) |
| **RPPS** (ANS) | Registre d'identité de **tous** les professionnels | Le plus complet : 2,24 M PS, tous modes d'exercice | `mode_exercice` non renseigné sur 16 % ; `num_finess` rempli à 41 % |

Le point central : **ces lentilles ne sont pas des bugs.** Ce sont des
propriétés intrinsèques des sources. Le bug est que **les tools du MCP
restituent le résultat filtré sans déclarer la lentille traversée.**

### 2.2 Lentille FINESS — une catégorie dominante par site

FINESS attribue à chaque établissement géographique **une** `categorie_code`
unique — son type administratif dominant. Or un site héberge en réalité
plusieurs activités. Le plateau de biologie d'un CHR n'a pas de FINESS
catégorie `611` : il est inclus dans le FINESS de l'hôpital, classé `101`
(C.H.R.).

Conséquence : **tout filtre `famille` bâti sur la catégorie sous-compte
mécaniquement chaque activité qui est *secondaire* sur un site
multi-activités.** Le mécanisme ne concerne pas que la biologie — il frappe
identiquement :

- **pharmacie** → les PUI (pharmacies à usage intérieur) des hôpitaux ;
- **imagerie** → la radiologie hospitalière noyée dans le FINESS de l'hôpital ;
- **dialyse, maternité, urgences…** → idem.

C'est un problème de **granularité / d'étiquetage** : l'activité existe sur le
terrain, mais n'est pas étiquetable au niveau du site.

### 2.3 Lentille Ameli — le libéral conventionné pur

L'annuaire Ameli est constitué par la CNAM à des fins de facturation et
d'annuaire des soins de ville. Il ne contient, **par construction**, que des
professionnels en exercice libéral conventionné. Mesure prod (cf. §3.3) : sur
462 771 lignes Ameli, **100 % sont de nature libérale** — zéro salarié pur.

C'est un problème de **couverture de population**, distinct du problème FINESS :
les enregistrements des salariés **n'existent simplement pas** dans la source.
Pas un défaut d'étiquetage — une absence.

### 2.4 RPPS — registre de référence (et ses propres trous)

RPPS (Annuaire Santé de l'ANS) est le registre d'identité de **tous** les
professionnels de santé, salariés inclus. C'est la source la plus complète pour
*dénombrer une population* de professionnels sur un territoire — et c'est aussi
elle qui porte le **signal d'enrichissement** de la Phase 2 (le lien
`num_finess`, cf. §3.4).

RPPS a néanmoins ses propres limites, à déclarer aussi : `mode_exercice` est
NULL sur 16 % des lignes ; `num_finess` n'est rempli que sur 41 %.

### 2.5 Le symptôme produit unique

Deux mécanismes distincts (étiquetage FINESS · couverture Ameli), un seul
symptôme produit : **un undercount non déclaré.**

Un caller — y compris un LLM qui orchestre le MCP pour le compte d'un
journaliste ou d'une ARS — interroge `densite_etablissements_sante famille=labo`
ou `professionnels_par_specialite_dept` et reçoit un nombre. Rien dans la
réponse n'indique que ce nombre est une projection partielle. Le nombre est lu
comme **le** chiffre territorial. C'est le pire type de biais : silencieux,
plausible, et propagé tel quel dans l'analyse aval (Geo Intel consomme le MCP
sans re-vérifier).

---

## 3. Preuves prod

Toutes les mesures ci-dessous ont été exécutées en production le 2026-05-22
(projet Supabase `france_data`). Requêtes complètes en Annexe A. Doctrine
`prove-rootcause-by-prod` : aucune affirmation de ce cadrage n'est inférée.

### 3.1 FINESS — le trou « activité secondaire »

**Le constat de base.** 4 057 établissements de catégorie `611` (LBM), dont
**5 seulement** à libellé hospitalier (`raison_sociale ILIKE` hôpital/CHU/CHR…).

**Le cas concret reproduit.** FINESS **`590048468`** « CENTRE DE BIOLOGIE
PATHOLOGIE », classé catégorie **`101` (C.H.R.)**. C'est un plateau de biologie
hospitalier — `famille=labo` (catégorie `611`) ne le trouvera jamais. À lui
seul, ce site a **591 techniciens de laboratoire + 79 pharmaciens + ~50
médecins biologistes/anatomo-pathologistes** rattachés via RPPS.

**Le `raw` jsonb est vide.** L'ingestion FINESS ne stocke aucun champ au-delà
des colonnes typées (pas de lien entité juridique, pas de discipline/activité).
Toute reconstruction des activités secondaires devra donc venir d'**ailleurs**
(cf. §6).

### 3.2 FINESS — dérive du catalogue de catégories

`src/sante/finess-categories.ts` catalogue ~50 codes (≈92 % du volume). La
comparaison du catalogue avec la liste *vivante* des `categorie_code` en prod
révèle une dérive à deux faces :

**a) Codes MORTS dans le catalogue (0 ligne en prod) :**

| Code | Libellé catalogue | Famille MCP | Conséquence |
|---|---|---|---|
| `108` | Etablissement de Convalescence et de Repos (libellé SMT ; l'ancien catalogue disait « C.H.U. ») | `ssr` depuis le 2026-09-06 | Inerte (0 établissement) — bénin |
| `600` | Foyer d'hébergement pour adultes handicapés | `handicap_adultes` | Inerte — bénin |
| **`619`** | **Cabinet d'imagerie médicale** | **`imagerie`** | **`famille=imagerie` renvoie 0 ligne, toujours — bug actif** |

> ⚠️ `imagerie` est l'**unique** code de sa famille. `famille=imagerie` est donc
> aujourd'hui une famille **entièrement morte** : un caller qui demande les
> centres d'imagerie d'un territoire reçoit un résultat vide, sans erreur.
> FINESS ne répertorie pas les cabinets d'imagerie comme établissements — la
> complétude `imagerie` dépendra **entièrement** de la Phase 2.

**b) Codes VIVANTS absents du catalogue (tombent en `autre` à tort) :**

| Code | Libellé prod | Lignes | Famille correcte |
|---|---|---|---|
| `610` | Laboratoire d'Analyses | 33 | `labo` |
| `612` | Autre Laboratoire de Biologie Médicale sans FSE | 22 | `labo` |
| `628` | Pharmacie Minière | 31 | `pharmacie` |
| `629` | Pharmacie Mutualiste | 46 | `pharmacie` |
| `695` | Groupement de coopération sanitaire de moyens — Exploitant | 29 | `groupement` |

`famille=labo` rate donc déjà **55 laboratoires autonomes** (`610`+`612`) — un
trou de complétude *direct*, indépendant du problème hospitalier. À évaluer
aussi : `122` (Soins Obstétriques), `294` (Consultations Cancer), `630`
(chirurgie esthétique) → candidats `mco`.

> La majorité des autres codes non catalogués (santé scolaire, écoles,
> structures expérimentales rares…) restent en `autre` **par design** — la
> règle des ~92 % du fichier `finess-categories.ts` est saine. La correction
> ne vise QUE les codes morts et les codes à famille évidente.

### 3.3 Ameli — la lentille libérale, mesurée

`annuaire_ameli` — répartition par `nature_exercice` :

| Nature d'exercice | Lignes |
|---|---|
| Libéral intégral | 426 083 |
| Libéral activité salarié | 23 290 |
| Libéral temps partiel hosp. | 10 930 |
| Libéral temps plein hosp. | 2 262 |
| Interdiction d'exercer | 98 |
| T. plein hosp. contrat mixte | 5 |
| **Total** | **462 771 — 100 % de nature libérale** |

RPPS, par contraste — répartition par `mode_exercice` :

| Mode d'exercice | Lignes | Part |
|---|---|---|
| Salarié | 1 098 007 | 49 % |
| Libéral / indépendant | 774 624 | 35 % |
| Non renseigné (NULL) | 363 825 | 16 % |
| Bénévole | 3 175 | <1 % |

**Undercount mesuré — les radiologues.** Ameli « Radiologue » = **28 314**.
RPPS, savoir-faire « Radio-diagnostic » (SM44) = 45 178, + variantes
(SM94 radiologie interventionnelle 1 238, etc.) ≈ **46 600**. Compter les
radiologues via Ameli = **~39 % manquants** (les hospitaliers).

**Cas extrême — les biologistes.** Ameli n'a aucune spécialité « biologiste »
dans son nomenclature des soins de ville. Les biologistes médicaux comptés via
Ameli ≈ **0**. RPPS : ~4 400 médecins biologistes + 61 946 techniciens de
laboratoire.

### 3.4 Le signal d'enrichissement — RPPS `num_finess`

RPPS porte deux colonnes de rattachement : `num_finess` (établissement
géographique) et `num_finess_ej` (entité juridique), remplies sur **920 495
lignes** (41 % de 2,24 M). Un professionnel salarié d'un hôpital a son
`num_finess` qui pointe vers le FINESS de l'hôpital.

**On peut donc reconstruire les activités secondaires d'un site** en regardant
les professionnels qui y sont rattachés. Mesure : les médecins biologistes RPPS
(`savoir_faire_libelle ILIKE 'Biologie médicale%'`), regroupés par la catégorie
FINESS de leur lieu de travail :

| Catégorie FINESS du lieu de travail | Médecins biologistes | Sites distincts |
|---|---|---|
| `611` Laboratoire de Biologie Médicale | 1 267 | 360 |
| **`101` Centre Hospitalier Régional** | **935** | **95** |
| **`355` Centre Hospitalier** | **390** | **185** |
| `132` Établissement de Transfusion Sanguine | 145 | 87 |
| `365` Établissement de Soins Pluridisciplinaire | 36 | 18 |
| `131` Centre de Lutte Contre le Cancer | 30 | 12 |
| `114` Hôpital des armées | 16 | 6 |
| `109` / `696` / `697` / autres | ~30 | ~25 |

**Plus de 330 sites hospitaliers et cliniques** (catégories
`101`/`355`/`365`/`131`/`114`/`115`/`109`/`696`/`697`) hébergent une activité de
biologie repérable via RPPS — tous invisibles à `famille=labo`. En y ajoutant
les 87 centres de transfusion sanguine (`132`), on dépasse 400 sites. Et ce
décompte ne prend que les *médecins* biologistes : avec les pharmaciens
biologistes et les techniciens, la masse réelle est bien plus grande (cf. le cas
`590048468` : 700+ personnels de labo).

Le signal est **déjà en base, gratuit, et fonctionne**. Il généralise : imagerie
(manipulateurs ERM + radiologues), pharmacie (pharmaciens → PUI), etc.

### 3.5 Tableau récapitulatif des mesures

| # | Mesure | Valeur prod |
|---|---|---|
| M1 | Établissements FINESS catégorie `611` (LBM) | 4 057 |
| M2 | …dont à libellé hospitalier | 5 |
| M3 | Sites hospitaliers hébergeant une activité de biologie (via RPPS) | ~330 |
| M4 | Codes morts dans le catalogue MCP | 3 (`108`, `600`, `619`) |
| M5 | `famille=imagerie` — lignes renvoyées | 0 (code `619` mort) |
| M6 | Labos autonomes ratés par le catalogue (`610`+`612`) | 55 |
| M7 | Pharmacies ratées par le catalogue (`628`+`629`) | 77 |
| M8 | Lignes `annuaire_ameli` — nature libérale | 462 771 / 462 771 (100 %) |
| M9 | RPPS — part salariée | 1 098 007 (49 %) |
| M10 | Undercount radiologues via Ameli vs RPPS | ~39 % (28 314 vs ~46 600) |
| M11 | RPPS — lignes avec `num_finess` rempli | 920 495 (41 %) |

---

## 4. Tools MCP impactés

Tout tool qui *compte* ou *cartographie* par famille ou par spécialité hérite
du biais de lentille :

| Tool | Lentille héritée |
|---|---|
| `etablissements_finess_in_radius` (`familles`) | FINESS — catégorie dominante |
| `etablissements_finess_by_categorie` | FINESS — catégorie dominante |
| `densite_etablissements_sante` | FINESS — catégorie dominante |
| `panorama_sante_territoire` | FINESS + Ameli combinés |
| `finess_sirene_coverage_in_radius` | FINESS — catégorie dominante |
| `densite_professionnels_sante` | selon source (Ameli / RPPS) |
| `professionnels_in_radius`, `professionnels_par_specialite_dept` | Ameli — libéral conventionné |
| `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept` | RPPS — `mode_exercice`/`num_finess` partiels |

---

## 5. Phase 1 — Transparence

**Objectif** : que chaque tool **déclare** sa lentille. Aucune donnée n'est
enrichie. Cohérent avec la doctrine « le MCP juxtapose, ne résout pas ». Coût
faible, actionnable immédiatement, dé-risque le biais silencieux.

### 5.1 Métadonnée de périmètre

Ajouter aux tools de comptage/densité un champ **structuré** (pas un simple
caveat texte — un champ que le caller LLM peut lire et restituer) :

```jsonc
"perimetre": {
  "source": "FINESS",
  "lens": "categorie_dominante",
  "compte": "établissements dont la catégorie FINESS principale ∈ {611,610,612}",
  "exclut": "activités de biologie hébergées dans un établissement d'une autre catégorie (ex. plateau de biologie d'un CHR)",
  "completeness_note": "Pour les plateaux hospitaliers, voir la couche d'activités (Phase 2) — non disponible à ce jour."
}
```

- **Famille FINESS** → « compte les établissements dont la catégorie FINESS
  principale ∈ {…} ; les activités hébergées dans un établissement d'une autre
  catégorie ne sont pas comptées ».
- **Tool Ameli** → « source CNAM : professionnels en exercice **libéral
  conventionné uniquement** ; exclut les praticiens salariés — ~49 % de
  l'effectif RPPS ».
- **Tool RPPS** → mentionner que `mode_exercice` est non renseigné sur ~16 %
  des lignes.

Le champ doit pouvoir se rendre en une phrase de caveat lisible — mais la forme
structurée prime, pour que le LLM caller le restitue sans le paraphraser de
travers.

### 5.2 Correction du catalogue FINESS

Corriger `src/sante/finess-categories.ts` selon §3.2 — c'est un trou de
complétude *direct*, pas seulement de la transparence :

1. **Codes morts** `108`, `600`, `619` → retirer ou annoter explicitement.
   Décider du sort de `famille=imagerie` : aujourd'hui morte → soit la marquer
   « non couverte par FINESS, voir Phase 2 », soit la documenter comme telle.
2. **Codes à reclasser** : `610`+`612` → `labo` · `628`+`629` → `pharmacie` ·
   `695` → `groupement`. Évaluer `122`/`294`/`630` → `mco`.
3. Le test invariant `finess-categories.test.ts` (qui vérifie `DELIBERATELY_AUTRE`)
   doit être mis à jour en cohérence — et idéalement renforcé pour détecter une
   *future* dérive (un code vivant en prod absent du catalogue).

### 5.3 Clarification du routage de tool

Les descriptions de tools sont lues par le LLM caller et orientent son choix.
Documenter explicitement, dans ces descriptions :

- pour **dénombrer tous les professionnels** d'une spécialité sur un territoire,
  la source complète est **RPPS** ;
- **Ameli** répond aux questions de **conventionnement / secteur / tarifs**, pas
  d'exhaustivité d'effectif.

Empêche le LLM d'utiliser Ameli comme proxy de complétude.

### 5.4 Effort & livrables

Surface : `finess-categories.ts`, les modules de tools (`finess-db.ts`,
`densite.ts`, `panorama.ts`, `annuaire-ameli.ts`, `rpps-db.ts`…), les
descriptions de tools, les tests. Pas de migration DB. Pas de nouvelle
ingestion. Estimation : **1 session de développement** avec discipline post-fix.

---

## 6. Phase 2 — Complétude ciblée

**Objectif** : reconstruire les activités secondaires là où le trou est gros
**et mesuré**. **Décision sur chiffres, post-Phase 1** — ce cadrage présente les
routes, ne tranche pas.

### 6.1 Route A — couche d'activités dérivée de RPPS

Construire une couche dérivée : *« un établissement FINESS héberge l'activité X
si ≥ N professionnels du type X y sont rattachés via `num_finess` »*. Matérialisée
en matview ou table dérivée, recalculée au cron RPPS.

- ✅ **Signal déjà en base** — aucune nouvelle ingestion (cf. §3.4).
- ✅ **Couvre la biologie** — prouvé : `101` CHR → 935 biologistes / 95 sites.
- ✅ **Généralise** : imagerie (manipulateurs ERM + radiologues), pharmacie
  (pharmaciens → PUI hospitalières).
- ⚠️ **Inférentiel** — le seuil `N` doit être calibré ; un faux positif est
  possible (un médecin avec un rattachement périmé).
- ⚠️ `num_finess` rempli à 41 % seulement — la couche est aussi complète que ce
  rattachement.

### 6.2 Route B — ingestion « FINESS autorisations d'activités de soin »

FINESS publie sur data.gouv.fr un dataset **séparé** du fichier des
établissements : « Extraction des autorisations d'activités de soin » (CSV /
Parquet, mensuel). Il liste les activités de soin *autorisées* par établissement.

- ✅ **Autoritaire** — donnée officielle d'autorisation ARS.
- ✅ Bon pour imagerie **EML** (scanner / IRM), chirurgie, médecine d'urgence,
  réanimation, soins critiques.
- ⚠️ **Nouvelle source** = nouveau cron / pipeline d'ingestion.
- ⚠️ **Ne couvre pas la biologie** — les LBM relèvent d'un régime
  d'accréditation distinct (COFRAC + autorisation ARS du LBM), pas du régime
  « activités de soin » AMF/AMM.
- ⚠️ Nomenclature en transition (AMF/EML → AMM) ; **nouvelle version de FINESS
  annoncée pour l'été 2026** — risque de churn de format.

### 6.3 Recommandation

**Route A en v1** (biologie + imagerie + pharmacie) : signal en main, zéro
ingestion, couvre le cas labo qui a déclenché le chantier. **Route B en
complément ultérieur** pour les activités de soin autorisées (imagerie EML
surtout). La biologie ne sera couverte **que** par A.

### 6.4 Méthodologie de mesure pré-greenlight

Avant d'écrire la moindre ligne de Phase 2 (doctrine `prove-rootcause-by-prod`),
pour chaque activité candidate :

1. Mesurer le nombre de sites hospitaliers détectés via RPPS vs le count
   `famille` actuel — quantifier le gain.
2. Calibrer le seuil `N` : faire varier `N`, vérifier manuellement un
   échantillon de sites détectés (vrai plateau ? rattachement périmé ?).
3. Reporter le **taux de faux positifs** par valeur de `N`.
4. Décider activité par activité : la couche n'est exposée que pour les
   activités où le gain est net et le faux positif maîtrisé.

---

## 7. Périmètre — DANS / HORS

**DANS ce chantier :**
- La métadonnée de périmètre sur les tools de comptage/densité.
- La correction de la dérive du catalogue FINESS.
- La clarification du routage de tool (RPPS vs Ameli).
- La couche d'activités dérivée de RPPS (Phase 2, sur greenlight).

**HORS de ce chantier (à acter) :**
- Refonte de l'ingestion FINESS (stockage de champs supplémentaires) — pas
  nécessaire, la Route A n'en dépend pas.
- Chantier D « Fiche unifiée RPPS + Ameli » — distinct, déjà cadré séparément.
- Résolution fine / dédoublonnage type Geo Intel — le MCP juxtapose, ne résout
  pas.
- Ingestion Route B — différée, ré-instruite après la Route A.

---

## 8. Risques & garde-fous

| Risque | Garde-fou |
|---|---|
| Phase 2 — faux positif (site détecté à tort) | Seuil `N` calibré prod + revue manuelle d'échantillon avant exposition (§6.4) |
| Phase 2 — `num_finess` à 41 % → couche partielle | Déclarer la lentille de la couche elle-même (métadonnée §5.1 récursive) |
| Le caller LLM sur-interprète le caveat comme une erreur | Champ `perimetre` structuré + libellé neutre (« périmètre », pas « limite ») |
| Dérive future du catalogue FINESS (nouveaux codes) | Renforcer `finess-categories.test.ts` : échouer si un code vivant en prod n'est pas catalogué |
| Nouvelle version FINESS été 2026 (Route B) | Route B explicitement différée jusqu'à stabilisation du format |
| `famille=imagerie` morte non corrigée | Traitée dès Phase 1 (§5.2) — décision explicite sur le sort de la famille |

---

## 9. Séquencement

```
Phase 1 — Transparence  ──────────────────────────────►  actionnable maintenant
  └─ 5.1 métadonnée de périmètre
  └─ 5.2 correction catalogue FINESS  (+ sort de famille=imagerie)
  └─ 5.3 clarification routage tool
  └─ discipline post-fix + release

         ▼  (Phase 1 livrée → biais déclaré, plus silencieux)

Phase 2 — Complétude ciblée  ─────────────────────────►  décision sur chiffres
  └─ 6.4 méthodologie de mesure  (faux positifs par seuil N)
  └─ greenlight activité par activité
  └─ Route A — couche d'activités RPPS  (v1 : biologie/imagerie/pharmacie)
  └─ Route B — ingestion FINESS autorisations  (complément ultérieur)
```

Phase 1 transforme un cadrage en plan d'implémentation (skill `writing-plans`)
dès validation. Phase 2 reste « à instruire » avec sa méthodologie de mesure —
non actionnable tant que les chiffres de gain/faux-positif ne sont pas posés.

---

## 10. Décisions à acter

1. **Forme 2 phases** (transparence puis complétude) — validée par Cyril
   2026-05-22.
2. **Correction du catalogue FINESS intégrée à la Phase 1** — validée.
3. **Phase 2 : cadrage présente les 2 routes sans trancher** — validé.
4. **Sort de `famille=imagerie`** (catégorie `619` morte) : à décider en
   Phase 1 — la marquer « non couverte par FINESS » ou la retirer ?
5. **Release** : Phase 1 en version dédiée (V0.17.0 ?) ou groupée.

---

## Annexe A — Requêtes SQL de mesure

```sql
-- M1 / M2 — labos catégorie 611, dont hospitaliers
SELECT count(*) AS total_611,
       count(*) FILTER (WHERE raison_sociale ILIKE ANY(ARRAY[
         '%hopit%','%hôpit%','%hospit%','%chu%','%c.h.%','%centre hospit%',
         '%ap-hp%','%aphp%','%ap-hm%','%hospices civils%','%hcl%'])) AS hospitalier_ish
FROM finess WHERE categorie_code='611';

-- M3 — biologistes RPPS par catégorie FINESS du lieu de travail
SELECT f.categorie_code, f.categorie_libelle,
       count(DISTINCT r.id) AS biologistes,
       count(DISTINCT r.num_finess) AS sites
FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
WHERE r.savoir_faire_libelle ILIKE 'Biologie médicale%'
GROUP BY 1,2 ORDER BY biologistes DESC;

-- M4 / M5 / M6 / M7 — liste vivante des catégories FINESS (à differ du catalogue)
SELECT categorie_code, categorie_libelle, count(*) n
FROM finess GROUP BY 1,2 ORDER BY categorie_code;

-- M8 — nature d'exercice Ameli
SELECT nature_exercice_libelle, count(*) n
FROM annuaire_ameli GROUP BY 1 ORDER BY 2 DESC;

-- M9 — mode d'exercice RPPS
SELECT mode_exercice_code, mode_exercice_libelle, count(*) n
FROM rpps GROUP BY 1,2 ORDER BY 3 DESC;

-- M10 — radiologues : Ameli vs RPPS
SELECT specialite_libelle, count(*) n FROM annuaire_ameli
  WHERE specialite_libelle='Radiologue' GROUP BY 1;
SELECT savoir_faire_code, savoir_faire_libelle, count(*) n FROM rpps
  WHERE savoir_faire_libelle ILIKE '%radio%' GROUP BY 1,2 ORDER BY 3 DESC;

-- M11 — taux de remplissage num_finess dans RPPS
SELECT count(*) FILTER (WHERE num_finess IS NOT NULL AND num_finess<>'') AS with_finess,
       count(*) AS total
FROM rpps;

-- Cas concret 590048468 — personnels du plateau de biologie hospitalier
SELECT profession_libelle, savoir_faire_libelle, count(*) n
FROM rpps WHERE num_finess='590048468' GROUP BY 1,2 ORDER BY n DESC;
```

## Annexe B — Références

- FINESS — Extraction du fichier des établissements (data.gouv.fr) :
  https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements
- FINESS — Extraction des autorisations d'activités de soin (data.gouv.fr) :
  https://www.data.gouv.fr/datasets/finess-extraction-des-autorisations-dactivites-de-soins/
- Code source du catalogue de catégories : `src/sante/finess-categories.ts`
- Doctrine : mémoire `prove-rootcause-by-prod`
- Cadrage frère (mécanisme de succession, distinct) :
  `docs/plans/verifier-site-actif-succession-fix.md`

## Annexe C — Glossaire

| Terme | Définition |
|---|---|
| **Lentille** | Sélection structurelle intégrée à une source — ce qu'elle voit et son angle mort. |
| **FINESS** | Fichier National des Établissements Sanitaires et Sociaux (ANS/DREES). |
| **LBM** | Laboratoire de Biologie Médicale. |
| **PUI** | Pharmacie à Usage Intérieur — pharmacie d'un établissement de santé. |
| **EML** | Équipement Matériel Lourd (scanner, IRM…) — soumis à autorisation ARS. |
| **AMF / AMM** | Régimes de nomenclature des autorisations d'activités de soin (AMF en cours de remplacement par AMM). |
| **RPPS** | Répertoire Partagé des Professionnels de Santé (ANS). |
| **Activité secondaire** | Activité réellement présente sur un site mais non reflétée par sa `categorie_code` FINESS dominante. |
| **`num_finess`** | Colonne RPPS de rattachement d'un professionnel à un établissement géographique FINESS. |
