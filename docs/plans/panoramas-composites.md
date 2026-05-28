# Phase C — Panoramas composites (outils 1-round-trip pour GEO Intel)

> **Cadrage pré-implémentation.** Cible release **0.23.0** (additive — 2 nouveaux
> tools, zéro breaking). Jumeau visuel : `panoramas-composites.html`. Date : 2026-05-28.
> **Phase C d'un chantier en 4 temps** : A rationalisation (0.21) → B IRIS +
> `profil_iris` (0.22) → **C panoramas (ce doc)** → D consommation GEO Intel.
> **C DÉPEND de B stabilisée** : réutilise `profil_iris` (§B5) et le
> `panorama_sante_territoire` IRIS-enrichi. Implémentation après déploiement de B.
> Auteur : Claude GEO Intel (consommateur), aligné avec l'auteur de A/B.

---

## 1. Contexte (langage simple)

L'étude d'implantation d'un labo (surface `/conversation` + `/report` de GEO
Intel) **timeout systématiquement à 300 s**. Cause : le LLM appelle les ~15
outils de la doctrine **un par un** à travers le connecteur MCP d'Anthropic, et
chaque aller-retour coûte ~5 s d'overhead connecteur + le temps que le modèle
relise les gros payloads et décide de la suite. 15 appels en série = hors délai.

La solution : **déplacer la composition à l'intérieur du serveur MCP**. Le LLM
appelle **UN** tool (`panorama_implantation_complet`), le MCP fait les ~10
sous-requêtes lui-même — en direct sur sa base Supabase, **sans connecteur, en
parallèle** — et renvoie un seul paquet structuré. C'est exactement le patron de
`panorama_sante_territoire` qui existe déjà ; ces nouveaux outils sont ses
**grands frères** taillés pour l'étude d'implantation complète.

## 2. Objectif

Ajouter **2 tools composites** qui collapsent une étude de ~15 round-trips
Anthropic à **2** :

- `panorama_implantation_complet(adresse|point, rayon_km?)` — la **vague socle**
  (~10 sous-requêtes indépendantes en parallèle).
- `enrichir_concurrents(finess[])` — la **vague enrichissement** (enquête top 3
  concurrents — dépend de la liste renvoyée par le socle).

**Net tools** : 32 (post-B) + 2 = **34** (toujours sous les 35 de départ).
**Additif** : aucun tool supprimé, aucun renommage → **zéro breaking** côté
clients. Gain visé : étude `/conversation` **~5 min → 30-60 s**, `toolCount`
qui chute de ~15 à ~3.

## 3. Le mécanisme — pourquoi côté MCP et pas côté GEO Intel

Si le « panorama » était du code côté GEO Intel, geo-intel devrait **quand
même** appeler les ~10 outils sous-jacents un par un à travers le connecteur
Anthropic → **même overhead, zéro gain**. Le seul levier qui supprime le
bottleneck est la composition **server-side** : 1 appel LLM → N requêtes DB
internes parallèles → 1 payload. D'où des **tools MCP**, pas de la logique
applicative. (Levier B « caps stricts » du backlog est intégré gratuitement :
le composite renvoie des **résumés** — count / top-N / moyenne — pas des listes
brutes de 100 lignes.)

## 4. `panorama_implantation_complet` — contrat

### 4.1 Entrée

| Param | Type | Note |
|---|---|---|
| `adresse` | string | OU `point` (exactement un). Géocodé en interne via IGN. |
| `point` | `{lat, lon}` | si déjà connu (skip géocodage). |
| `rayon_km` | number, défaut **5** | bassin de l'étude. 1 rayon unique V1 (per-section différé, YAGNI). |

### 4.2 Sortie

```jsonc
{
  "meta": {
    "adresse_demandee": "Lille, rue Nationale",
    "point": { "lat": 50.633, "lon": 3.057 },
    "code_insee": "59350", "code_dept": "59", "commune": "Lille",
    "rayon_km": 5,
    "geocode": { "score": 0.96, "confidence_low": false },
    "plm_mode": false,                  // true si Paris/Lyon/Marseille (fallback dept)
    "sources": [/* labels FINESS/RPPS/INSEE/FILOSOFI/IGN */],
    "generated_at": "2026-05-28T…Z"
  },
  "couverture": {                       // ← garde-fou anti-incomplétude (1 par section)
    "territoire":   "ok",
    "demande":      "partiel:revenu_pct_population=0.84",
    "concurrents":  "ok",
    "pourvoyeurs":  "ok",
    "prescripteurs":"ok",
    "cds":          "ok",
    "referentiels": "ok"
  },
  "territoire": {                       // = panorama_sante_territoire (commune), IRIS-enrichi
    "population_commune": 236710,
    "densites": { "medecins": {…vs_national}, "infirmiers": {…}, "pharmaciens": {…} },
    "niveau_etablissements": "departement"
  },
  "demande": {                          // = profil_iris(point, rayon) — le BASSIN, cf. §B5
    "population_bassin": 48230,
    "age": { "part_65_plus": 0.213, "part_75_plus": 0.094 },
    "revenu_median_pondere": 24800,     // PROXY (R1) — JAMAIS "médiane du bassin"
    "familles_avec_enfants": 6120,
    "csp": { "cadres": 0.18, … },
    "nb_iris_agreges": 27,
    "couverture": { "revenu_pct_population": 0.84, "iris_revenu_manquants": 4 }
  },
  "concurrents": {                      // FINESS famille=labo dans rayon
    "count": 23,
    "top": [ { "finess":"590000123","raison_sociale":"…","distance_km":0.34,
               "coords":{…},"siren":"823456789" }, … /* 10-15 triés distance */ ],
    "au_dela_count": 9
  },
  "pourvoyeurs": {                      // FINESS famille=[mco,ehpad,ssr,dialyse]
    "mco":     { "count": 4, "top3": [...] },
    "ehpad":   { "count": 18, "top3": [...] },
    "ssr":     { "count": 3, "top3": [...] },
    "dialyse": { "count": 2, "top3": [...] }
  },
  "prescripteurs": {
    "mg":   { "count": 142, "precis_count": 97, "top": [ {…,"distance_km":0.21,"geo_precision":"adresse"} ] },
    "idel": { "count": 88,  "precis_count": 61, "top": [ … ] }
  },
  "cds": { "count": 3, "liste": [ { "nom":"…","commune":"Lille" } ] },  // distance = commune, jamais individuelle
  "referentiels": { "coverage_status":"ok", "finess_only": 2, "sirene_only": 5 }
}
```

### 4.3 Composition interne (mapping section → brique réutilisée)

| Section | Brique lib interne · source | Réutilise |
|---|---|---|
| `meta`/ancrage | géocodage IGN → point ; dérive `code_insee`/`code_dept` | — |
| `territoire` | `panoramaSanteTerritoire(codeInsee)` (IRIS-enrichi en B) · RPPS/FINESS/INSEE | **Phase B** |
| `demande` | agrégation `profil_iris(point, rayon)` (R1/R2/R3 côté serveur) · INSEE/FILOSOFI | **Phase B** |
| `concurrents` | helper radius FINESS `famille=labo` · FINESS | famille `*_in_radius` |
| `pourvoyeurs` | helper radius FINESS `famille=[mco,ehpad,ssr,dialyse]` · FINESS | idem |
| `prescripteurs` | MG `professionnels_rpps_in_radius(precise_only)` + IDEL `professionnels_in_radius(spe=24)` · ANS+Ameli | idem |
| `cds` | helper radius CDS · CNAM/Ameli | idem |
| `referentiels` | helper coverage FINESS↔SIRENE `naf=8690B` · FINESS/SIRENE | idem |

`data_freshness` → injecté dans `meta.sources`. Toutes les sous-requêtes
indépendantes lancées via `Promise.all` (parallélisme intra-tool).

### 4.4 Doctrine de dégradation (jamais silencieuse)

Divergence **assumée** vs `panorama_sante_territoire` (qui rejette TOUT si une
sous-requête échoue). Justification : le petit panorama a 4 sous-appels
**homogènes** (densités d'une même commune) où un échec = panne systémique
probable ; le grand frère a 7 sections **hétérogènes** sur 5 sources distinctes
(FINESS, Ameli, RPPS, INSEE, FILOSOFI) — une source down ne doit pas annihiler
les 6 autres. Donc :

- **Échec d'ancrage** (géocode échoue, `confidence_low`, `code_insee`
  indérivable) → **rejet total** (`-32602`). Rien n'est possible sans le point.
- **Échec d'une section** → la section passe `"indisponible:<raison>"` dans
  `couverture`, **le reste est renvoyé**, + `console.warn` structuré (observabilité
  MCP). Ce n'est PAS un échec silencieux (explicitement flaggé) → le LLM client
  voit le trou et le comble via l'outil unitaire. C'est la doctrine « zéro catch
  silencieux » du projet, appliquée à un composite hétérogène.

### 4.5 Pièges internalisés DANS le tool (le LLM n'a plus à y penser)

- **PLM (Paris/Lyon/Marseille)** : commune PLM détectée → sous-appels
  densité/territoire basculés sur `code_dept` (sinon `RangeError`), `meta.plm_mode=true`.
- **`geo_precision`** : `prescripteurs` renvoie `precis_count` distinct (RPPS
  `precise_only`, Ameli filtré côté code) ; `cds` ne porte jamais de distance
  individuelle (centroïde commune à 100 %).
- **Ameli ≠ ANS/RPPS** : nomenclatures cloisonnées dans le code, jamais croisées.
- **Couverture FILOSOFI** : `demande.couverture.revenu_pct_population` remonté
  dans `couverture.demande` (cohérent R1).

## 5. `enrichir_concurrents` — contrat (vague enrichissement)

### 5.1 Entrée

| Param | Type | Note |
|---|---|---|
| `finess` | string[] | les FINESS à enquêter (typiquement le top 3 de `concurrents.top`). |
| `max` | number, défaut **3** | cap dur (`inspect_site` ~7 K tokens/appel — jamais 10+). |

### 5.2 Sortie

```jsonc
{
  "concurrents": [
    {
      "finess": "590000123", "raison_sociale": "…",
      "statut_actif": true, "equipe_count": 12,
      "historique_recent": [ /* changements datés */ ],
      "ma_signal": { "rebranding_detecte": true, "ecart_finess_rpps": "FINESS en retard vs RPPS" },
      "groupe": { "siren":"823456789", "denomination":"Biogroup …", "est_grand_groupe": true },
      "couverture": "ok"               // ou "partiel:<raison>" par concurrent
    }
  ],
  "meta": { "sources": [...], "generated_at": "…" }
}
```

### 5.3 Composition interne (par FINESS, en parallèle)

- `inspect_site(finess, historique_detail=false)` → identité + statut + équipe + historique.
- `compare_raison_sociale_finess_vs_rpps(finess)` → signal M&A (rebranding en cours).
- `entreprise_by_siren(siren)` → groupe parent (Biogroup/Cerballiance/…).

Dégradation par concurrent (drapeau `couverture` individuel), même doctrine §4.4.

## 6. Réutilisation & frontières

- **Réutilise sans modifier** : `panorama_sante_territoire` (Phase B le possède
  et l'enrichit IRIS — section `territoire`), `profil_iris` (Phase B — section
  `demande`), les helpers radius de la famille `*_in_radius` (déjà partagés au
  niveau code, cf. §A4 de la rationalisation).
- **Distinction de scope `demande`** : `panorama_sante_territoire` porte une
  demande **commune** (Phase B §4) ; le grand frère porte une demande **bassin**
  (le rayon, via `profil_iris(point, rayon)`). On garde les deux honnêtes :
  commune = contexte, bassin = actionnable. Pas de duplication de calcul (même
  agrégation R1/R2/R3 centralisée côté serveur).
- **Ne fusionne pas** la famille `*_in_radius` (frontière §A4 respectée).

## 7. Architecture / impact fichiers (france-data-mcp)

- `src/sante/panorama-implantation.ts` — nouveau module composite (orchestration
  `Promise.all` + dégradation par section + pièges §4.5). Appelle les briques lib
  existantes, **aucune nouvelle requête DB brute** au-delà de ce qui existe.
- `src/sante/enrichir-concurrents.ts` — nouveau module (boucle bornée + dedup).
- `api/tools.ts` — 2 nouvelles défs (descriptions riches : sections, drapeaux
  de couverture, doctrine de dégradation, quand préférer l'outil unitaire).
- `api/tools.test.ts` (+ tests modules) — couverture par section, dégradation
  par section (mock une source down → section `indisponible`, reste OK),
  ancrage KO → rejet total, PLM → `plm_mode`, caps top-N.
- **Aucune** migration DB (réutilise les tables existantes + IRIS de B).

## 8. Phase D — consommation GEO Intel (repo geo-intel)

Mini-plan d'application (codé après C déployée) :

1. **`lib/anthropic.ts`** — migrer les 3 allowlists (§A6) : `population_par_*`
   → `population` ; `densite_*` → `densite_sante` ; **ajouter**
   `panorama_implantation_complet`, `enrichir_concurrents`, `profil_iris`
   (+ `population`, `densite_sante`). `STUDY_/REPORT_ALLOWED_TOOLS` rétrécissent
   (fusions) puis s'élargissent (composites).
2. **`lib/report-orchestration.ts`** — étape `7_densite_ps` → noms fusionnés ;
   ajouter le suivi de couverture des nouveaux composites.
3. **`lib/prompts-study.ts` + `lib/prompts.ts`** — réécrire la doctrine §6.4 :
   de « 11 étapes en série » à **« 1 appel `panorama_implantation_complet`,
   puis (au besoin) creuser via les outils unitaires, puis `enrichir_concurrents`
   sur le top 3 »**. Migrer les **signatures** d'appel (cf. §A6 — la table A/B
   est déjà au grain paramètre).
4. **Wiring** : `/api/chat` et `/api/report` profitent automatiquement (le LLM
   appelle le composite via l'allowlist). Vérifier le timeout client (180 s)
   redevient large.
5. **Tests** : `tests/unit/anthropic.test.ts` (allowlists migrées),
   `tests/unit/prompts*.test.ts` (doctrine réécrite).

## 9. Méthodologie de preuve

- **Côté MCP (C)** : TDD — tests rouges → modules → vert. Acceptance prod : appel
  réel `panorama_implantation_complet(Lille rue Nationale, 5)` < 5 s server-side,
  payload complet avec drapeaux ; un mock source-down rend la section
  `indisponible` (reste OK) ; `enrichir_concurrents(top3)` < 5 s. Pipeline `/review`.
- **Côté GEO Intel (D)** : **avant/après chronométré** sur une vraie étude SELAS
  via `/conversation` — cible **~5 min → 30-60 s**, `toolCount` log `streamMessage
  end` de ~15 → ~3. Test de couverture : chaque section a son drapeau, dégradation
  jamais silencieuse (cf. mémoire `mcp-tool-calls-overhead-bottleneck`).

## 10. Dépendances & séquençage

```
A rationalisation (0.21) ──► B IRIS + profil_iris (0.22) ──► C panoramas (0.23) ──► D geo-intel
   [autre Claude]              [autre Claude]                  [moi, après B stable]   [moi]
```

C n'est PAS implémentée avant que B soit **déployée et stabilisée** (décision
Cyril). Ce spec est gelé contre les contrats A (§A6) et B (§B5) — prêt à
dégainer dès l'atterrissage de B.

## 11. Risques

| Risque | Mitigation |
|---|---|
| Composite trop gros / payload lourd | Résumés (count/top-N) pas listes brutes ; top-N capé ; sections optionnelles via `couverture` |
| Section incomplète servie en silence | Drapeau `couverture` par section + `console.warn` ; doctrine §4.4 |
| Divergence de dégradation vs petit panorama | Documentée §4.4 (hétérogène ≠ homogène) ; tests dédiés |
| Contrat B bouge après ce spec | Spec gelé contre §B5 ; implémentation séquencée après B stable |
| LLM n'utilise plus les outils unitaires | Composites **additifs** (unitaires restent dans l'allowlist) ; doctrine « pars du panorama, creuse au besoin » |
