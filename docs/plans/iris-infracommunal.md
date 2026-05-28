# Phase B — IRIS infracommunal (démographie au quartier)

> **Cadrage pré-implémentation.** Cible release **0.22.0**. Jumeau visuel :
> `iris-infracommunal.html`. Date : 2026-05-28.
> **Phase B** d'un chantier en 2 temps — **dépend de Phase A**
> (`rationalisation-tools-mcp.md`, 0.21.0) : l'IRIS atterrit dans les tools
> consolidés (`population`, `panorama_sante_territoire`).
> **⚠️ Doc de contrat pour GEO Intel** : la Section 5 (`profil_iris`) est
> l'interface consommée — les règles d'agrégation y sont load-bearing.

---

## 1. Contexte (langage simple)

L'IRIS (« Îlots Regroupés pour l'Information Statistique ») est le **maillage
officiel le plus fin de l'INSEE** : ~16 000 zones de ~2 000 habitants. Les
communes denses (Paris, Lyon, Marseille, Bordeaux…) y sont découpées en
quartiers ; les petites communes = 1 IRIS = la commune.

**Pourquoi c'est utile (business)** : aujourd'hui le MCP raisonne à la maille
commune — trop grossier pour une décision d'implantation en ville. L'IRIS donne
la **demande** au grain quartier (âge, CSP, familles, revenu). Croisée avec
l'**offre** déjà en base (PS, labos, CDS), on obtient une carte des micro-zones
sous-dotées à forte demande — un outil d'aide à l'implantation/ciblage. La
valeur est concentrée en **zone urbaine** (en rural, 1 commune = 1 IRIS → aucun
gain vs commune).

## 2. Sources & millésimes (vérifiés 2026-05-28)

| Bloc | Source | Millésime dispo | Fréquence | Couverture |
|---|---|---|---|---|
| **Contours** (polygones) | IGN/INSEE « Contours…IRIS » | **2024** (géo 01/01/2024) | annuelle | France entière + DOM |
| **Âge / population / CSP** | INSEE RP base population | **2022** (géo 2024) | annuelle | totale |
| **Familles / ménages** | INSEE RP base couples-familles-ménages | **2022** | annuelle | totale |
| **Revenu** | INSEE **FILOSOFI** | **2021** | annuelle | **communes ≥ 5 000 hab** (secret statistique → trous) |

**Cohérence millésime** : contours **2024** + RP **2022** partagent la même
géographie (RP 2022 diffusé sur géo 01/01/2024) → jointure propre. FILOSOFI
**2021** a un an de retard → **jointure LEFT** obligatoire (un IRIS peut avoir
l'âge sans le revenu). Refresh **annuel** (cron ou manuel — pas de fraîcheur
temps réel à gérer).

## 3. Modèle de données

Table pivot `iris` :

| Colonne | Type | Note |
|---|---|---|
| `code_iris` | `CHAR(9)` PK | = `code_commune`(5) + n° IRIS(4) |
| `code_commune` | `CHAR(5)` | les 5 premiers car. — **clé de raccord au reste du MCP** |
| `libelle` | TEXT | nom du quartier |
| `geom` | `GEOMETRY(MultiPolygon,4326)` | contour |
| `geog` | `GEOGRAPHY ... STORED` + GiST | pour les requêtes rayon/point-in-polygon |
| `centroid_geog` | `GEOGRAPHY(Point)` STORED + GiST | centroïde îlot (agrégation bassin, cf. §5) |

Stats jointes sur `code_iris` (1 table par bloc OU colonnes dénormalisées —
arbitrage à l'implémentation) : `iris_population` (tranches d'âge en
**comptes**), `iris_familles`, `iris_csp`, `iris_revenu` (médiane + déciles,
nullable). Ingestion = pattern existant (download → SHA256 short-circuit → COPY
staging → validate → atomic swap → canary → `ingest_log`).

**Gotchas projet à respecter** :
- `ST_AsGeoJSON(geom)::jsonb` en sortie RPC (jamais hex EWKB).
- `geog`/`centroid_geog` **STORED** + GiST (cast runtime tue le plan).
- Point-in-polygon + rayon sur **`centroid_geog`** (KNN `geog <-> point` / `ST_DWithin`) — ~16K centroïdes distincts, pas le piège de cluster co-localisé V0.10.2.
- Matview/refresh post-swap : si une matview lit `FROM iris` (table swappée), la **reconstruire** post-swap (jamais REFRESH-only) — patron OID bombe (cf. CLAUDE.md).

## 4. Atterrissage dans les tools consolidés (Phase A)

- **`population`** : 3ᵉ granularité **`iris`** — un `code` de 9 car. est
  auto-détecté → population de l'îlot. Zéro nouveau tool.
- **`panorama_sante_territoire`** : nouveau bloc **demande** (démo IRIS du
  bassin), alimenté par l'agrégation `profil_iris` (pas de ré-agrégation
  dupliquée). Zéro nouveau tool.
- **`profil_iris`** : **1 seul nouveau tool** (cf. §5).

→ **31 → 32 tools.**

## 5. `profil_iris(point | code_iris, rayon_km?)` — CONTRAT (consommé par GEO Intel)

Coordination validée avec GEO Intel (2026-05-28).

**Entrée** : `point {lat, lon}` **OU** `code_iris` (exactement un) ; `rayon_km`
optionnel.

**Deux modes :**
- **Sans `rayon_km`** → profil de **l'îlot seul** sous le point (~2 000 hab).
  Usage ponctuel / lookup rapide.
- **Avec `rayon_km`** → **agrégat du bassin** = les îlots dont le **centroïde**
  est dans le disque. Usage étude d'implantation (le bassin, pas le pâté de
  maisons).

**Sortie (mode bassin)** — la « section demande » :

```jsonc
{
  "population_bassin": 48230,           // Σ population des îlots du bassin
  "age": { "part_65_plus": 0.213,       // Σ(65+) / Σ(pop) — sur COMPTES bruts
           "part_75_plus": 0.094 },
  "familles_avec_enfants": 6120,        // somme
  "csp": { "cadres": 0.18, ... },       // parts sur comptes bruts (Σ/Σ)
  "revenu_median_pondere": 24800,       // PROXY (cf. règle R1) — JAMAIS "médiane du bassin"
  "nb_iris_agreges": 27,
  "couverture": {                       // doctrine non-silencieuse (cf. §6)
    "revenu_pct_population": 0.84,      // % pop. du bassin couverte par FILOSOFI
    "iris_revenu_manquants": 4
  }
}
```

**3 règles d'agrégation LOAD-BEARING** (responsabilité serveur MCP, pas GEO Intel) :

- **R1 — Revenu : proxy, jamais médiane vraie.** La médiane d'une union ≠
  moyenne (même pondérée) des médianes d'îlots. On expose une **moyenne
  pondérée population des médianes**, calculée **uniquement sur les îlots
  couverts FILOSOFI**, labellisée `revenu_median_pondere` (approximation) +
  `couverture.revenu_pct_population`. Sans ce flag, biais silencieux (les îlots
  non couverts sont souvent systématiquement plus pauvres/riches). C'est
  exactement la doctrine d'échec silencieux fermée en V0.20.2.
- **R2 — Inclusion par centroïde.** Bassin = îlots dont le **centroïde** est
  dans le rayon (chaque îlot compté une fois, biais de bord équilibré). PAS
  « intersectant le disque » (qui compterait la population entière d'un îlot
  effleuré → surcompte). Affecte `population_bassin`.
- **R3 — Parts sur comptes bruts.** Toute part (âge, CSP) = `Σ(compte_catégorie)
  / Σ(compte_total)`, jamais une moyenne de pourcentages d'îlots. Familles/CSP
  en sommes absolues.

## 6. Doctrine couverture / dégradation jamais silencieuse

Alignée avec la Section 1 du socle GEO Intel : chaque section porte son drapeau
de couverture ; une donnée partielle est **dégradée explicitement**, jamais
omise en silence. Côté `profil_iris`, le bloc `couverture` porte le taux FILOSOFI
du bassin. Côté `population`/granularité iris, un `code_iris` absent → `not_found`
discriminé (jamais 0 silencieux).

## 7. Méthodologie de preuve

- Ingestion : canary post-swap (counts attendus ~16K IRIS, ~2000 hab/îlot
  médian), `ingest_log` success/partial/failed.
- `profil_iris` : tests unit sur les 3 règles d'agrégation (R1 proxy + couverture,
  R2 centroïde vs intersection, R3 comptes bruts), + acceptance prod sur un
  bassin urbain connu (ex. Paris 11ᵉ, rayon 2 km) vs un point rural (1 îlot).
- typecheck + lint + test:unit + pipeline `/review`.

## 8. Découpage interne (Phase B)

1. Ingestion contours IGN 2024 + table `iris` + GiST (fondation).
2. Blocs stats RP 2022 (âge, CSP, familles) — comptes bruts.
3. Bloc FILOSOFI 2021 (revenu) + couverture.
4. `population` granularité iris.
5. `profil_iris` (îlot seul, puis agrégation bassin R1/R2/R3).
6. Bloc demande dans `panorama_sante_territoire`.

## 9. Net & enchaînement

Net tools : 31 (post-A) + 1 (`profil_iris`) = **32**. On ajoute tout l'IRIS et
on reste **sous** les 35 de départ. Release **0.22.0** après stabilisation de
0.21.0 (Phase A).
