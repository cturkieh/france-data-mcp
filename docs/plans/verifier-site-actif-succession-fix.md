# Cadrage fix — `verifier_site_actif` : faux « fermé » sur les sites repris (M&A)

> **Statut** : cadrage pour décision — **aucune ligne de code écrite**.
> **Date** : 2026-05-22 · **Base** : V0.15.0 · **Sévérité** : P1 (faux négatif silencieux).
> Doc de décision : Cyril valide l'option + les arbitrages avant implémentation.
> Jumeau visuel : `verifier-site-actif-succession-fix.html`.

---

## 1. Résumé exécutif

`verifier_site_actif` (et 3 autres tools) déclare **« fermé » des sites qui sont
en réalité actifs**, dès lors que le site a changé d'exploitant (rachat / M&A).
Bug **confirmé et reproduit en prod** sur les 2 cas signalés (labos de Neuilly).

- **Cause** : le moteur de résolution SIRET (`resolveSiretsForFiness`) choisit le
  « meilleur » SIRET d'une adresse **sans jamais que le statut `actif` ne soit un
  critère**. Quand un ancien exploitant fermé et un repreneur actif coexistent à
  la même adresse, l'ancien fermé est retenu.
- **Portée** : défaut du moteur partagé → **4 tools**, **toutes les familles
  FINESS** (pas seulement les labos). Structurel, pas anecdotique.
- **Reco** : **Option A** (correction ciblée du moteur) **+ champ `succession`**
  exposé pour Geo Intel. **Pas de migration DB** (code TypeScript pur).
- **Décisions attendues de Cyril** : cf. § 12.

---

## 2. Le bug — preuve prod (2026-05-22)

Appels réels sur l'endpoint de production :

| Site | FINESS | Verdict du tool | Réalité SIRENE/DINUM |
|---|---|---|---|
| Neuilly Sablons — 3 R Garnier | `920026770` | ❌ `verdict_site: "ferme"` | SIRET `40309320600726` **BIOGROUP PARIS OUEST — actif** (créé 2018-12-21) |
| Pont de Neuilly — 85 av Ch. de Gaulle | `920026341` | ❌ `verdict_site: "ferme"` | SIRET `40309320600718` **BIOGROUP PARIS OUEST — actif** |

Vérification indépendante via DINUM `/near_point` sur 3 Rue Garnier : 4 sociétés
s'y sont succédé — LABO ANALY MEDIC (1986) → LABORATOIRE ZANA → BIO EPINE (2017)
→ **BIOGROUP PARIS OUEST (2018, actif)**. Le site fonctionne. Le tool affirme
le contraire avec assurance.

---

## 3. Cause-racine — deux mécanismes distincts

`resolveSiretsForFiness(numFiness, finess)` produit une liste `candidates[]` de
SIRET et désigne un `best_match`. `verdict_site = verdictFromActif(best_match.actif)`.
Le `best_match` est choisi **par score de ressemblance d'adresse uniquement** —
le statut `actif` n'entre nulle part dans la sélection.

### Mécanisme A — chemin RPPS (cas Neuilly Sablons)

1. Le moteur part des SIRET déclarés par les professionnels dans la table RPPS.
2. Ces déclarations pointent encore vers l'**ancienne** société (BIO EPINE).
3. DINUM ne liste alors que les établissements de **ce** SIREN → l'ancien
   établissement fermé matche l'adresse → devient `best_match`.
4. Le filet de secours géographique (`tryAddressFallback`, qui balaye **toutes**
   les sociétés autour de l'adresse) **n'est jamais armé** : sa condition de
   déclenchement est `best_match === null`. Or `best_match` n'est pas `null` — il
   est « rempli » par le SIRET fermé.
5. **Conséquence** : le SIRET du repreneur (autre SIREN) n'est jamais découvert.
   Il n'apparaît même pas dans `candidates[]`.

### Mécanisme B — chemin fallback géographique (cas Pont de Neuilly)

1. RPPS vide → le fallback géographique **est** armé.
2. `/near_point` découvre **bien** Biogroup actif (présent dans `candidates[]`).
3. Mais deux filtres l'écartent :
   - **Tri par `score_adresse`** : l'ancien BIO EPINE fermé est enregistré
     « 85 **AV** Charles de Gaulle » = identique au libellé FINESS → Dice 1.00.
     Biogroup est « 85 **AVENUE** Charles de Gaulle » → Dice 0.9375. Un simple
     écart d'abréviation fait gagner le site fermé.
   - **Name filter** (`NAME_DISQUALIFY_THRESHOLD = 0.2`) : le libellé FINESS dit
     encore « BIOEPINE » → le filtre juge Biogroup « hors-sujet » (`score_nom`
     0.148 < 0.2) et le **disqualifie**, ne gardant que l'ancien (0.326).

### Le défaut central

- Le statut `actif` n'est **jamais** un critère de sélection du `best_match`.
- La règle de succession existante (`disambiguateFallbackCandidates`, statut
  `by_active_succession`) ne couvre pas le cas réel :
  - elle n'opère **que** dans le fallback géo (jamais sur le chemin RPPS) ;
  - elle exige le **même SIREN** (`allSameGroup` = `siren|adresse`). Or un rachat
    = **changement d'unité légale** = SIREN différent → la règle ne s'applique pas.
- Pire : le name filter **favorise activement l'ancien exploitant**, parce que le
  référentiel FINESS conserve l'ancienne enseigne (latence DREES — ici largement
  au-delà de « 1-2 mois » : le libellé porte toujours « BPO-BIOEPINE »).

> **Note** : un commentaire du code (`NAME_DISQUALIFY_THRESHOLD`, `siret-resolver.ts`)
> affirme que ce cas « est protégé par le chemin RPPS ». **La prod prouve le
> contraire.** L'hypothèse à corriger explicitement dans le fix.

---

## 4. Portée — pourquoi corriger dans le MCP

### 4 tools touchés (tout consommateur de `resolveSiretsForFiness`)

`verifier_site_actif` · `historique_etablissement` · `reconcilier_finess_sirene`
· `inspect_site`

### Toutes les familles FINESS consolidées

Le mécanisme — *site change d'exploitant → nouveau SIREN → ancien établissement
fermé retenu* — frappe toute famille où il y a de la consolidation : pharmacies
(transferts de licence), EHPAD (Emeis, Korian, DomusVi), imagerie, cliniques MCO
(Ramsay, Elsan, Vivalto), labos. **Ce n'est pas un défaut « labo ».**

### Niveau 1 vs Niveau 2 — et la frontière MCP / Geo Intel

| Question | Qui répond | Nature | État actuel |
|---|---|---|---|
| « Ce site (ce FINESS) est-il actif ? » | **MCP** | Réparer un **fait faux** | ❌ faux — à corriger |
| « Quels SIRET se sont succédé à cette adresse ? » | **MCP** | **Fait brut** | ⚠️ partiel — invisible dans le Mécanisme A |
| « Le site A a-t-il été racheté par B ? » | **Geo Intel** | **Interprétation** M&A | hors périmètre MCP — volontaire |

Corriger le verdict actif/fermé **n'est pas de l'interprétation** : c'est réparer
un fait erroné. Exposer la succession de SIRET est du fait brut. Le mot « rachat »
reste à Geo Intel. **Le fix ne franchit donc pas la doctrine « concaténé MCP /
résolu Geo Intel ».**

Pourquoi le MCP et pas Geo Intel : Geo Intel **consomme** le MCP et lui fait
confiance — il ne re-vérifie pas SIRENE. Un fait faux en entrée corrompt tout
l'étage aval, **non rattrapable**.

---

## 5. Insight de conception — le bon critère de co-localisation

Le `score_adresse` (Sørensen-Dice textuel) **ne discrimine pas le numéro de voie**.
Preuve prod : sur le FINESS Pont de Neuilly (85 av Ch. de Gaulle), le voisin
`SOPHIE ALLALI MEDIONI` au **48** av Ch. de Gaulle obtient `score_adresse = 0.8958`
— quasi aussi haut que le vrai repreneur. Le Dice noie le numéro de rue dans les
bigrammes communs (rue + CP + ville).

→ **Le critère robuste de co-localisation est la distance géographique** : le
point GPS de l'établissement DINUM vs les coordonnées du FINESS.

- Disponible : `Etablissement.point` est fourni par `/near_point` (`dinum.ts:47`),
  et `finess.coords` existe déjà (`tryAddressFallback` s'en sert).
- Vérifié prod : BIOGROUP au 3 R Garnier est à **~2 m** des coords FINESS Neuilly
  Sablons — co-localisation indiscutable. Un voisin de rue est à 50-250 m.
- Le `score_adresse` Dice **reste utile** comme signal secondaire / fallback
  quand un candidat n'a pas de coords — mais n'est plus le juge de co-localisation.

---

## 6. Leviers de correction

| # | Levier | Effet | Fichier |
|---|---|---|---|
| **L1** | Armer le fallback géo aussi quand `best_match` trouvé est **fermé** (`best_match === null \|\| best_match.actif === false`) | Rend le repreneur actif **visible** (corrige Mécanisme A) | `siret-resolver.ts` |
| **L2** | **« Actif prime »** : `best_match` = le candidat **actif**, NAF-compatible, **co-localisé** (distance géo < seuil) le plus pertinent. Un candidat fermé n'est `best_match` que si **aucun** actif co-localisé n'existe | Cœur du fix — corrige les 2 mécanismes | `siret-resolver.ts` |
| **L3** | Réordonner la désambiguïsation : **statut actif AVANT name filter**. Le name filter ne départage plus qu'**entre candidats de même statut** | Empêche le name filter de tuer un actif ; préserve son utilité (cas EYLAU/CHOUAIEB) | `siret-resolver.ts` |
| **L4** | Exposer un champ **`succession`** : exploitant actif retenu + SIRET fermés co-localisés (dates) | Matière brute pour Geo Intel (Niveau 2) | `cross-source.ts`, `siret-resolver.ts` |

L1+L2+L3 forment un tout indissociable (L1 sans L2 rend le repreneur visible mais
ne le choisit pas ; L2 sans L1 ne voit pas le repreneur dans le Mécanisme A).

---

## 7. Options

### Option A — Correction ciblée du moteur **(recommandée)**

L1 + L2 + L3 + L4. Logique de sélection `best_match` **unifiée** entre chemin RPPS
et fallback géo, pilotée par : gate NAF → co-localisation géo → statut actif →
départage (récence / nom / signal RPPS).

- **Effort** : moyen. 2 fichiers cœur (`siret-resolver.ts`, `cross-source.ts`) +
  tests. **Pas de migration DB.**
- **Risque** : maîtrisé (cf. § 9). Seuil de co-localisation à calibrer prod.
- **Couvre** : les 2 mécanismes, les 4 tools, toutes les familles.

### Option B — Option A + normalisation des abréviations de voie

Ajoute l'expansion `AV→AVENUE`, `BD→BOULEVARD`, `R→RUE`… dans `address-match.ts`.

- **Gain** : améliore le `score_adresse` de **tout** le MCP (réconciliation, etc.).
- **Coût** : `address-match.ts` est consommé partout → surface de non-régression
  large. **Non nécessaire pour ce bug** (le critère devient la distance géo, § 5).
- **Verdict** : bon chantier d'hygiène, mais **à traiter séparément**, pas dans ce fix.

### Option C — Refonte « résolution par adresse d'abord »

Abandonner le pivot RPPS→SIREN ; partir systématiquement de l'adresse FINESS,
`/near_point` toujours, classer tous les SIRET du métier.

- **Gain** : modèle conceptuellement plus simple.
- **Coût** : gros refactor, risque de régression élevé, coût DINUM systématique
  (un `/near_point` par appel, même quand le pivot RPPS suffisait).
- **Verdict** : **hors scope**. À reconsidérer seulement si Option A se révèle
  insuffisante en validation prod.

---

## 8. Plan d'implémentation — Option A

| Lot | Contenu | Poids |
|---|---|---|
| **L0 — Calibrage prod** | Échantillonner des FINESS (sites repris connus + sites vraiment fermés). Mesurer la distance géo `point` DINUM ↔ `coords` FINESS pour repreneurs vs voisins. **Fixer le seuil de co-localisation** (hypothèse de départ : ~30-40 m « même bâtiment »). Doctrine *prove-by-prod*. | léger |
| **L1 — Armement fallback** | Élargir la condition de déclenchement : `best_match === null \|\| best_match.actif === false`. | léger |
| **L2 — Sélection unifiée** | Refondre la fin de `resolveSiretsForFiness` : fonction de choix `best_match` commune RPPS + fallback. Critère = NAF-compatible → co-localisé (distance géo) → **actif prioritaire** → départage récence/nom/RPPS. | lourd |
| **L3 — Réordonnancement** | Généraliser `by_active_succession` (retirer la contrainte « même SIREN », s'appuyer sur la distance géo). Placer le statut actif **avant** le name filter. | moyen |
| **L4 — Champ `succession`** | Ajouter à `SiretResolution` / `VerifierSiteActifResult` : exploitant actif retenu + `exploitants_precedents[]` (SIRET fermés co-localisés + dates). Mettre à jour l'`explication` LLM (sans le mot « rachat »). | moyen |
| **L5 — Tests** | Cf. § 10. Unitaires + intégration. | moyen |
| **L6 — Docs** | `CHANGELOG`, `CLAUDE.md` (nouveau gotcha + corriger le commentaire faux), `README` si le contrat de sortie change, mémoire. | léger |
| **L7 — Discipline + release** | `/simplify`, `/review` P1+P2, `typecheck`+`lint`+`test`, puis validation prod sur les 84 FINESS « BIOEPINE » + échantillon vrais fermés. | moyen |

**Pas de migration SQL.** Le déploiement est un simple push de code (npm + Vercel).
Ordre global : 1 session de développement focalisée, discipline post-fix incluse.

---

## 9. Risques & mitigations

| Risque | Gravité | Mitigation |
|---|---|---|
| **Faux positif inverse** : un vrai site fermé déclaré « actif » à cause d'un voisin actif du même métier | élevée | Critère = **distance géo stricte** (§ 5), pas le Dice. Seuil « même bâtiment » calibré L0. Gate NAF conservé. |
| Régression cas EYLAU/CHOUAIEB (V0.13.1) | moyenne | Le name filter **reste** — il départage désormais entre candidats de même statut. Test de non-régression EYLAU obligatoire (L5). |
| Candidat sans coordonnées (chemin RPPS pur, fallback INSEE) | faible | Fallback sur `score_adresse` Dice quand `point` absent. Dans le cas « succession », les candidats actifs viennent de `/near_point` → coords présentes. |
| Surcoût DINUM (un `/near_point` de plus par site « fermé selon RPPS ») | faible | Borné, caché côté serveur. Acceptable. |
| Seuil de co-localisation mal calibré | moyenne | L0 dédié + validation prod L7 sur échantillon réel avant release. |

---

## 10. Stratégie de test

| Cas | Attendu |
|---|---|
| Neuilly Sablons `920026770` (Mécanisme A) | `verdict_site: "actif"`, `best_match` = SIRET Biogroup actif |
| Pont de Neuilly `920026341` (Mécanisme B) | `verdict_site: "actif"`, `best_match` = SIRET Biogroup actif |
| EYLAU `920028487` (non-régression V0.13.1) | comportement inchangé |
| Site **vraiment** fermé (aucun actif co-localisé) | `verdict_site: "ferme"` — préservé |
| Voisin actif même métier, **autre bâtiment** (piège faux positif) | le voisin **n'est pas** promu `best_match` |
| Champ `succession` | exploitant actif + exploitants précédents fermés listés |

Tests unitaires `siret-resolver` + intégration. Re-seed `rpps_staging` si test
d'intégration touchant cette table (convention `CLAUDE.md`).

---

## 11. Validation prod (post-déploiement, L7)

1. Rejouer `verifier_site_actif` sur les **84 FINESS** au libellé « BIOEPINE » →
   mesurer le taux de bascule « ferme » → « actif ».
2. Échantillon de FINESS **vraiment fermés** (sites disparus) → vérifier qu'ils
   restent « ferme » (pas de faux positif inverse).
3. Échantillon multi-familles (pharmacie, EHPAD) repris → vérifier la généralité.

---

## 12. Décisions à acter par Cyril

1. **Option A** validée ? (reco : oui — B et C écartées / différées.)
2. **Champ `succession`** exposé dès ce fix ? (reco : oui — c'est précisément la
   matière Niveau 2 dont Geo Intel a besoin, coût marginal.)
3. **Seuil de co-localisation** : laisser le calibrage L0 le fixer sur données
   prod, ou imposer une valeur d'emblée ? (reco : calibrage L0.)
4. Ce fix part-il en **release dédiée** (V0.15.1 / V0.16.0) ou groupé avec
   d'autres travaux ?

---

## 13. Recalibrage V0.16.1 — rayon 50 → 100 m + bande « même site » (2026-05-30)

> **Statut** : implémenté, tests verts. Demande GEO Intel (2 faux négatifs prouvés
> prod 2026-05-29). Code TypeScript pur — **pas de migration**.

### Le problème résiduel après V0.16

Le seuil `COLOCATION_RADIUS_M = 50 m` calibré en V0.16 (L0) sous-estimait le
**décalage de géocodage DREES**. Le point FINESS (Lambert93 DREES, souvent grossier)
est décalé de plusieurs dizaines de mètres du point BAN de l'adresse réelle — et ce
décalage est **partagé par tous les SIRET de cette adresse** (ils géocodent au même
point BAN). Conséquence : un repreneur actif et son ancien exploitant fermé, **à la
même adresse**, ressortent à la distance IDENTIQUE du FINESS — mais si cette distance
dépasse 50 m, l'étape « actif prime » ne s'arme pas → faux négatif `ferme`.

### Preuve prod (2026-05-29, mesures `verifier_site_actif`)

| FINESS | Site | Repreneur actif manqué | Distance | Cascade pré-fix |
|---|---|---|---|---|
| 930023627 | Cerballiance Aulnay | SIRET 32838652900312 | **52,1 m** | `by_rpps_signal` → ancien fermé 45214478500055 (52,1 m) |
| 920028354 | EYLAU Courbevoie | SIRET 78465202600336 | **96,6 m** | `by_name_score` → ancien fermé 39483357800161 (96,6 m, EYLAU score_nom 0,09) |

Dans les deux cas, **tous** les SIRET de l'adresse sont à la distance unique
(52,1 / 96,6 m) — confirmant que la distance mesure l'offset FINESS↔adresse, pas un
étalement intra-adresse. Le cas 2 est le pire : le name filter disqualifiait EYLAU
(le libellé FINESS dit encore « Parc Monceau ») — d'où l'importance de l'« actif
prime » placé AVANT le name filter (déjà acquis en V0.16, juste hors de portée à 50 m).

### Le fix (2 leviers indissociables)

1. **`COLOCATION_RADIUS_M` 50 → 100 m.** Couvre les décalages DREES observés (≤ 97 m)
   tout en restant sous le **voisin-piège** d'une autre adresse, testé à ~110 m
   (garde-fou faux positif inverse V0.16 conservé, reste vert). Le site EYLAU légitime
   à 46,6 m (V0.16) reste co-localisé dans les deux calibrations.

2. **Bande « même site » relative — `COLOCATION_SAME_SITE_TOLERANCE_M = 30 m`.** Le
   rayon élargi ramène désormais dans le périmètre des voisins d'une autre adresse à
   50-100 m (plan §5 : voisins « 50-250 m »). Sans garde-fou, un voisin actif y serait
   promu. La bande restreint l'arbitrage du `best_match` aux co-localisés à `≤
   min(distance) + 30 m` : un prédécesseur fermé nettement plus proche qu'un actif
   lointain garde le verdict `ferme`. 30 m absorbe le bruit de géocodage intra-adresse
   (nul sur les 2 cas prod, où l'écart actif↔fermé est de 0 m).

### Pourquoi pas un simple bump à 150 m (rejet du « bump aveugle »)

À 150 m le voisin-piège à 110 m entrerait dans le rayon → faux positif. La fenêtre
sûre est (96,6 ; 110) m → **100 m**, étroite mais ancrée sur 4 points (2 repreneurs
réels + voisin-piège testé + EYLAU légitime). La bande relative (levier 2) fait le
travail de discrimination fine que le rayon absolu ne peut pas faire seul.

### Garde-fous

`cross-source.test.ts` : 3 tests V0.16.1 (Cerballiance 52,1 m, EYLAU 96,6 m, bande
même-site voisin 80 m / prédécesseur 30 m → `ferme`) + le faux positif inverse
historique (~110 m) inchangé. Constantes documentées inline dans `siret-resolver.ts`.

### Impact aval (GEO Intel)

`enrichir_concurrents` consomme ce verdict pour ses `competitor_alerts` M&A — le fix
améliore directement la qualité des rapports d'implantation, sans changement côté
GEO Intel (contrat de sortie inchangé : `verdict_site`, `succession`).
