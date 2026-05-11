# france-data-mcp

> MCP TypeScript qui **croise et réconcilie** 6 référentiels publics français (INSEE SIRENE, FINESS DREES, RPPS / Annuaire Santé ANS, Annuaire Santé Ameli, IGN, DINUM). Détecte les SIRET fermés que DREES n'a pas encore propagés, distingue site vs groupe, expose la fraîcheur de chaque source.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)
[![MCP](https://img.shields.io/badge/MCP-live-success)](https://france-data-mcp.vercel.app/mcp)

🇫🇷 Documentation principale en français. [English version →](README.en.md)

---

## Pourquoi ce projet

Les API et MCP officiels (data.gouv.fr, service-public.fr, INSEE, IGN, ANS, DINUM…) existent mais ils sont **éclatés, sous-documentés et chacun a ses pièges** : rate limits, formats CSV propriétaires, latences DREES de 1-2 mois, diffusion partielle INSEE, mappings de codes inconsistants entre Ameli et RPPS, etc.

`france-data-mcp` est **le premier MCP qui croise factuellement ces sources** pour répondre à des questions concrètes :

- « Ce site FINESS est-il encore actif aujourd'hui ? » → cascade RPPS → DINUM avec scoring d'adresse Dice, distingue verdict site vs verdict groupe, capture les SIRET fermés invisibles côté DREES.
- « Quelle est la timeline complète d'un cabinet post-M&A ? » → reconstitution chronologique via SIRENE `periodesEtablissement` enrichie par DINUM.
- « FINESS et RPPS sont-ils d'accord sur la raison sociale ? » → primitive de comparaison brute, sans interprétation propriétaire d'enseignes.
- « Mes données sont-elles fraîches ? » → opt-in `include_freshness: true` sur tous les tools DB-backed.

Le tout avec une discipline production : API uniforme et typée (zéro `any`), rate limits gérés (retry exponentiel + `retry-after`), cache TTL par source, observabilité structurée (logs JSON, status discriminés `rejected` / `not_found` / `ambiguous` / `api_error`), documentation honnête sur les pièges de chaque source.

---

## Périmètre

**6 sources publiques croisées en une API unifiée :**

- 🗺️ **Territoire** : geo.api.gouv.fr (DINUM, communes), IGN Géoplateforme (géocodage adresse), INSEE Population IRIS (démographie infra-communale)
- 🏥 **Santé** : FINESS / DREES (établissements sanitaires & médico-sociaux), Annuaire Santé Ameli (libéraux conventionnés), RPPS / Annuaire Santé ANS (tous les PS, libéraux + salariés)
- 🏢 **Entreprises** : DINUM Recherche Entreprises + INSEE SIRENE V3.11 (fallback diffusion partielle)

**Cross-source** (V0.7.0+) : pivot FINESS ↔ RPPS ↔ SIRENE via le resolver `siret-resolver` — détecte les SIRET fermés invisibles côté DREES, distingue verdict site vs verdict groupe.

D'autres domaines (éducation, transport, économie, justice) pourront s'ajouter dans `src/<domaine>/` si besoin.

---

## Outils MCP exposés (24 tools)

### 🗺️ Territoire (4 tools)

| Tool | Description | Source |
|---|---|---|
| `autocomplete_commune` | Autocomplétion de commune par nom / CP / code INSEE | geo.api.gouv.fr |
| `get_commune_by_code` | Fiche complète d'une commune par code INSEE (5 chars) | geo.api.gouv.fr |
| `geocode_adresse` | Adresse → coordonnées GPS (avec score de confiance) | IGN Géoplateforme |
| `reverse_geocode` | Coordonnées GPS → adresse postale + commune | IGN Géoplateforme |

### 🏢 Entreprises (3 tools)

| Tool | Description | Source |
|---|---|---|
| `entreprises_in_radius` | Recherche d'entreprises dans un rayon par code(s) NAF | DINUM Recherche Entreprises (+ fallback Haversine côté client) |
| `entreprise_by_siren` | Fiche complète d'une entreprise par SIREN (sites, finances, dirigeants) | DINUM (+ fallback INSEE SIRENE V3.11 pour les SIREN diffusion partielle) |
| `etablissement_by_siret` | Fiche complète d'un établissement par SIRET (14 chiffres) : enseigne, NAF, dates création/fermeture, statut actif | INSEE SIRENE V3.11 (clé requise) |

### 🏥 Établissements de santé — FINESS (3 tools)

| Tool | Description |
|---|---|
| `etablissements_finess_in_radius` | Établissements FINESS dans un rayon, filtrage par famille |
| `etablissements_finess_by_categorie` | Liste FINESS par famille (+ département / commune optionnels) |
| `etablissement_by_finess` | Fiche d'un établissement par numéro FINESS 9 chiffres |

**24 familles** couvrant ~92 % du volume FINESS (95 K rows) :

| Famille | Codes inclus | Volumétrie |
|---|---|---|
| **Sanitaire** : `mco`, `ssr`, `sld`, `had`, `psychiatrie`, `dialyse`, `ambulatoire` | CHU, CH, CLCC, hôpitaux militaires, USLD, HAD, dialyse, CMP, CATTP, centres de santé | ~13 000 |
| **Bio / pharma / imagerie** : `labo`, `imagerie`, `pharmacie` | LBM, cabinets imagerie, officines + propharmacies | ~25 000 |
| **Pluri-pro** : `msp_cpts` | Maisons de Santé Pluriprofessionnelles + CPTS | ~2 700 |
| **Personnes âgées** : `ehpad`, `residence_autonomie`, `senior_accompagnement` | EHPAD/EHPA, résidences autonomie, centres de jour PA, CLIC | ~10 600 |
| **Domicile** : `ssiad`, `aide_domicile` | SSIAD, SAAD, SPASAD, oxygénothérapie | ~12 000 |
| **Handicap** : `handicap_enfants`, `handicap_adultes` | IME, ITEP, SESSAD, CAMSP, MAS, FAM, ESAT, SAVS, SAMSAH | ~11 500 |
| **Addictologie** : `addictologie` | CSAPA, CAARUD, ACT, LHSS, appartements thérapeutiques | ~1 100 |
| **Enfance / protection** : `enfance_protection`, `pmi` | MECS, foyers enfance, AEMO/AED, PMI, planning familial, CMS | ~6 100 |
| **Hébergement social** : `hebergement_social` | CHRS, FJT, maisons relais, CADA, CPH, lieux de vie | ~6 500 |
| **Prévention** : `prevention_sante` | Transfusion, dispensaires AT/AV, CES, centres de soins préventifs | ~1 100 |
| **Coopération** : `groupement` | GCS, GCSMS | ~1 900 |
| `autre` | Codes hors taxonomie ou rares (Etab. Thermal, etc.) | ~7 % résiduel |

Data is refreshed bimonthly from the ANS official extract. See [docs/ingestion.md](docs/ingestion.md).

**Limitations connues sur les fiches FINESS** :
- `email` est toujours `null` (la source DREES ne publie pas les emails — utiliser l'Annuaire Santé Ameli pour les pros libéraux).
- `distance_km` n'est rempli que sur les retours `etablissements_finess_in_radius` (pas de référence pour `by_categorie` / `by_finess`). La distance est **vol d'oiseau (haversine PostGIS)**, pas routière — pour la distance routière, croiser avec un service externe (OSRM, ORS).
- Les DOM-COM ne sont pas encore ingérés (v0.3 garde un `code_insee CHAR(5)` strict métropole + Corse ; v0.4 prévoit l'élargissement).
- **Latence DREES** : la base est régénérée bimestriellement par la DREES. Pour les structures émergentes (CPTS récemment agréées, MSP en cours d'ouverture), comptez **1 à 2 mois de retard** sur le terrain. Si une structure réelle n'apparaît pas dans FINESS, cross-checker avec l'ARS régionale ou Service Public (`mcp__claude_ai_Service_Public__rechercher_service_local`) avant de conclure à son inexistence.

**Métadonnées de réponse** : les retours `etablissements_finess_in_radius` / `etablissements_finess_by_categorie` exposent un champ `query_metadata` documentant la précision géo (`lambert93_natif_finess`), le type de distance (`haversine_postgis`) et les notes actionnables (latence DREES, distance non-routière). À lire pour ne pas surinterpréter les résultats.

### 👨‍⚕️ Professionnels de santé libéraux — Annuaire Ameli (4 tools)

| Tool | Description |
|---|---|
| `professionnels_in_radius` | Recherche de PS dans un rayon, filtrage par spécialité / type PS |
| `professionnels_par_specialite_dept` | Liste de PS par département (pagination via `offset`) |
| `lister_specialites_ameli` | Nomenclature live des spécialités (avec `libelle_clarifie` quand un libellé est partagé entre plusieurs codes) |
| `lister_types_ps_ameli` | Nomenclature live des types de PS (médecin, chirurgien-dentiste, auxiliaires médicaux) |

> Couverture Ameli : libéraux **conventionnés uniquement** (~462 K). Pour les salariés (hospitaliers, salariés en LBM/cabinet), voir RPPS ci-dessous.

### 🩺 Tous les professionnels — RPPS / Annuaire Santé ANS (5 tools)

| Tool | Description |
|---|---|
| `professionnels_rpps_in_radius` | Recherche de PS dans un rayon (libéraux + salariés). Filtres : profession ANS, savoir-faire (DES/DESC), mode d'exercice, `include_etudiants`, `include_agents_publics` |
| `professionnels_rpps_par_dept` | Listing départemental + pagination. Idéal pour compter ou lister tout le monde (vs Ameli libéraux uniquement) |
| `rpps_dans_etablissement` | Répond à *"qui travaille dans ce labo / hôpital ?"*. Filtre par numéro FINESS site |
| `rpps_search_by_name` | Recherche fuzzy par identité (nom + prénom optionnel + département optionnel). Trigram pg_trgm tolérant accents/typos. `match_score` ∈ [0..1] dans chaque résultat |
| `professionnel_by_rpps` | Fiche par identifiant national (11 ou 12 chiffres — IDNPS modernes émis depuis 2020 ont un préfixe `81` qui les fait à 12 chars, anciens IDs sans préfixe à 11 chars). Fallback live FHIR ANS si non trouvé en base locale |

### 🔀 Croisement multi-source (5 tools)

Primitives de réconciliation FINESS DREES ↔ RPPS ANS ↔ SIRENE INSEE pour détecter les divergences factuelles entre référentiels (SIRET fermés, rebrandings post-M&A, raisons sociales périmées). Aucune interprétation métier : ces tools renvoient les faits, le caller décide.

| Tool | Description |
|---|---|
| `data_freshness` | Retourne la fraîcheur des dumps ingérés (FINESS, Ameli, RPPS) : `last_success_at`, `staleness_days`, `cadence_hint`. Cache mémoire 5 min |
| `verifier_site_actif` | Croise DREES ↔ resolver RPPS+DINUM avec scoring d'adresse Dice. Détecte les SIRET fermés invisibles côté RPPS. Retourne `verdict_site` et `verdict_groupe` distincts, `best_match` SIRET physique, `dinum_errors` discriminés |
| `compare_raison_sociale_finess_vs_rpps` | Compare la raison sociale FINESS vs RPPS sur un même `num_finess`. Détecte les rebrandings post-M&A non encore propagés côté DREES |
| `historique_etablissement` | Reconstitue la timeline complète (ouvertures, fermetures, changements de NAF/enseigne) en interrogeant SIRENE `periodesEtablissement` pour chaque SIRET candidat du resolver (RPPS + DINUM matches). `status: success / partial / all_sirene_failed / all_sirene_not_found` |
| `reconcilier_finess_sirene` | Score de cohérence Sørensen-Dice (nom + adresse) entre FINESS DREES et SIRENE pour chaque candidat du resolver. Verdict `match` / `partial` / `mismatch`. `status` aligné sur historique_etablissement |

> Couverture RPPS : **~2,2 M PS actifs** (libéraux + salariés privés + hospitaliers contractuels + agents publics + étudiants + remplaçants). L'ANS pré-filtre la source aux PS actifs (cf. DSFT v3.1 §5.1.2 — pas de date de décès, activité ouverte) : aucun retraité, suspendu, radié ou décédé n'est exposé. ID national stable + lien `num_finess` (pivot PS↔FINESS). Snapshot mensuel data.gouv + fallback live FHIR ANS pour les lookups individuels.

**V0.5.1 — enrichissement FINESS post-INSERT.** Les PS sans adresse de structure exploitable (étudiants, salariés CH/CHU sans adresse site déclarée, libéraux à domicile — ~970 K rows skippées en V0.5.0) sont désormais ingérés avec `geom NULL`, puis géolocalisés à la précision adresse FINESS via JOIN sur `num_finess`. Champ `geom_source` interne = `commune_centroid` (~3 km moyenne) ou `finess_join` (adresse FINESS).

**Filtre catégorie professionnelle.** Nomenclature officielle ANS [TRE_R09](https://mos.esante.gouv.fr/NOS/TRE_R09-CategorieProfessionnelle/) — 3 codes en base :

| Code | Libellé ANS | Périmètre | Volume |
|---|---|---|---|
| `C` | Civil | Droit privé : libéraux, salariés privés, hospitaliers contractuels, salariés associatifs | ~97,2 % |
| `E` | Étudiant | PS en formation : internes, externes, élèves IDE/SF | ~2,5 % |
| `M` | Agent public | Statut fonction publique : PH titulaires, médecins militaires SSA, médecins inspecteurs ARS, médecins conseils CNAM, médecins scolaires Éducation nationale, médecins PMI collectivités. Le code `F` (« Fonctionnaire d'État ou de collectivité locale ») a été déprécié 2026-02-23 et fusionné dans `M` | ~0,3 % |

Par défaut, les tools RPPS ne renvoient que les **Civils (C)**. Pour élargir : passer `include_agents_publics: true` (ajoute `M`) et/ou `include_etudiants: true` (ajoute `E`). Le payload retour expose `categorie_code` + `categorie_libelle` sur chaque row pour permettre la dissociation côté caller.

**⚠️ Périmètre — à lire avant de construire un comptage**

L'Annuaire Santé Ameli répertorie **uniquement les professionnels de santé libéraux conventionnés** par l'Assurance Maladie. C'est une source riche pour la prospection commerciale et la cartographie d'offre libérale, mais elle n'est PAS un référentiel exhaustif des PS en France.

**Hors périmètre** :
- Médecins exclusivement hospitaliers / salariés (CH, CHU, cliniques privées non conventionnées en libéral)
- Biologistes médicaux salariés en LBM (les LBM eux-mêmes sont dans FINESS)
- Anatomopathologistes hospitaliers, médecins du travail, médecins légistes
- Tout PS dont l'activité libérale n'est pas enregistrée auprès de la CNAM

Pour un comptage tous statuts (libéraux + salariés + retraités inscrits), il faut le **RPPS / Annuaire Santé ANS** (esante.gouv.fr) — non couvert par ce serveur en v0.4. Le piège récurrent : voir « 41 anesthésistes département 08 » côté Ameli et conclure « il n'y a que 41 anesthésistes dans les Ardennes » alors que les hospitaliers sont absents par construction.

**Caractéristiques techniques** :
- **Précision géo** : centroïde commune (~3 km en moyenne), pas le numéro de rue. Adapté à l'analyse de densité, pas au géocodage adresse.
- **Distance** : vol d'oiseau (haversine PostGIS), pas routière. Pour la distance routière (logistique navette labo, par ex.), croiser avec OSRM / ORS côté caller.
- **Nomenclature `type_ps`** : 3 codes en base (`1` médecins, `2` auxiliaires médicaux fourre-tout — IDE/kinés/sages-femmes/podologues/orthophonistes/orthoptistes/IPA, `5` chirurgiens-dentistes). Le libellé natif Ameli pour le code `2` est trompeur (« Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…) ») — les chirurgiens-dentistes ont en réalité leur propre code (`5`). Pour cibler une profession précise (IDE seuls par exemple), utiliser **`specialite_code`** plutôt que `type_ps_code` ; nomenclature live exposée par les tools `lister_specialites_ameli` et `lister_types_ps_ameli`.
- **Multi-sites** : un PS exerçant sur N adresses apparaît N fois. Utiliser `dedupe_by_ps=true` pour regrouper par praticien et lister les sites en sous-objet. La source publique n'expose pas RPPS/ADELI, donc la dédup serveur se base sur `(nom, prenom, civilite, specialite_code, type_ps_code)`.
- **Pagination** : `professionnels_par_specialite_dept` accepte un `offset` (≥0, max 100 000) pour énumérer un département à fort effectif. Re-paginer tant que `truncated=true`.
- **Métadonnées de réponse (v0.4.3)** : `query_metadata` expose `geo_precision: "centroide_commune_ameli"` et `distance_type: "haversine_postgis"` pour rendre transparente la nature des coords et de la distance.
- **Lookups silencieux corrigés (v0.4.3)** : les tools `entreprise_by_siren`, `etablissement_by_finess`, `get_commune_by_code` retournent désormais un objet typé `{ found: false, lookupStatus, message }` au lieu de `null` brut quand l'identifiant est introuvable. Permet au caller LLM de distinguer « non indexé » / « régression API » / « commune fusionnée » et d'orienter vers la bonne action corrective.
- **Désambiguïsation libellés Ameli (v0.4.4)** : `lister_specialites_ameli` expose `libelle_clarifie` (data-driven via window function SQL) et `is_libelle_partage`. Quand 2+ codes spécialité partagent le même libellé (ex: « Médecin généraliste » sur codes 01, 22, 23), `libelle_clarifie` suffixe avec code + count compact (« Médecin généraliste (code 01, 55K) »).
- **Fallback SIRENE INSEE V3.11 (v0.4.5)** : `entreprise_by_siren` tente automatiquement un lookup via SIRENE INSEE V3.11 quand DINUM ne connaît pas le SIREN (cas diffusion partielle INSEE — ex: BIO ARD'AISNE 787120435). Activé via la seule variable `INSEE_SIRENE_API_KEY` (UUID issu de l'inscription gratuite sur https://portail-api.insee.fr, plan « api key »). Header HTTP `X-INSEE-Api-Key-Integration`, rate limit 30 req/min côté INSEE. No-op gracieux sans clé. Le champ `siren_source` (`"dinum"` | `"insee_v3"`) trace la provenance.
- **Signal `caFiable` (v0.4.4)** : `Finance.caFiable: false` quand `ca === 0 && resultatNet > 0` (pattern observé sur les SELARL pharma 47.73Z qui ne déclarent pas leur CA au RNE). Le caller décide d'afficher un warning ou d'ignorer la valeur.
- **CGU** : art. L.1461-2 CSP — toute application publique doit afficher « Source : Annuaire santé Ameli, Assurance Maladie » et la date de sync.

---

## Installation

### En tant que serveur MCP (recommandé)

Le serveur est déployé en production sur Vercel et s'ajoute en 3 clics à n'importe quel client MCP compatible (claude.ai, Claude Desktop, Cursor, Claude Code) :

**URL publique** : `https://france-data-mcp.vercel.app/mcp`

Voir [docs/installation-claude.md](docs/installation-claude.md) pour le pas-à-pas client par client.

### En tant que bibliothèque TypeScript (à venir sur npm)

Le code est utilisable directement depuis le repo (`pnpm install` puis `pnpm build`). La publication sur npm interviendra quand un cas d'usage hors-MCP en aura besoin — pour l'instant, le serveur MCP couvre 99 % des cas. Si tu en as besoin, ouvre une issue.

Exemple d'usage en TypeScript :

```typescript
import { searchCommunes, geocode } from "france-data-mcp/territoire";
import { searchProfessionnels, searchEtablissements } from "france-data-mcp/sante";

const villes = await searchCommunes({ nom: "Charleville", limit: 5 });
const point = await geocode("64 Cours Aristide Briand 08000 Charleville-Mézières");

const mg = await searchProfessionnels({
  specialite: "Médecin généraliste",
  center: point,
  radiusKm: 5,
});

const ehpad = await searchEtablissements({
  categorie: "EHPAD",
  center: point,
  radiusKm: 5,
});
```

---

## Garde-fous publics (V0.5.7)

L'endpoint MCP public est protégé par 2 mécanismes minimaux :

### Rate limit — 60 req/min par IP sur `tools/call`

- Sliding window Upstash Redis (latence ~50 ms depuis Vercel Frankfurt), fallback in-memory si Upstash indispo.
- **Ne s'applique PAS aux méthodes meta** `initialize`, `tools/list`, `ping` — sinon le handshake MCP casse pour les clients qui re-listent les tools souvent (Claude Desktop refresh périodique, etc.).
- Réponse en dépassement : JSON-RPC error code `-32000 Rate limit exceeded`, avec `data.retryAfterSeconds`, `data.limit`, `data.resetAt`. Le statut HTTP reste 200 (conformité JSON-RPC 2.0).
- **Anti-spoofing** : l'IP est extraite de `x-real-ip` (header non-spoofable posé par l'edge Vercel) en priorité, et seulement à défaut du DERNIER segment de `x-forwarded-for` (Vercel append la vraie IP en queue, pas en tête — prendre le premier segment serait un bypass trivial).
- IP hashée SHA-256 tronquée 16 chars avant tout log/stockage Redis (zéro IP en clair, RGPD-friendly).

### Logging JSON structuré — 1 ligne par requête

Chaque sous-requête JSON-RPC émet une ligne JSON dans `vercel logs` :

```json
{"ts":"2026-05-11T08:42:13.521Z","component":"mcp-endpoint","method":"tools/call","tool":"autocomplete_commune","ip_hash":"deadbeefcafe1234","user_agent":"Claude/1.0 (claude.ai)","duration_ms":42,"status":200,"outcome":"success","rl_remaining":59}
```

- `outcome` est un union fermé : `success | rate_limited | not_found | bad_request | internal_error`. Permet l'agrégation jq/BigQuery/Datadog sans surprise.
- Niveau auto : ≥500 → `console.error`, ≥400 → `console.warn`, sinon `console.log`.
- Aucun argument tool n'est loggé par défaut (sécurité). Pour debug ponctuel, prévoir un flag `LOG_TOOL_ARGS=true` à activer manuellement.
- Le payload des early-rejects (`405 method not allowed`, `400 missing body`) est aussi loggé → un client mal configuré ou un scraper apparaît dans les agrégations ops.

### Variables d'environnement (toutes optionnelles)

| Variable | Default | Effet |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | _vide_ | Active le rate limit Upstash. Sans cette var, fallback in-memory. |
| `UPSTASH_REDIS_REST_TOKEN` | _vide_ | Token associé à l'URL Upstash. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Plafond requêtes / minute / IP. |
| `RATE_LIMIT_ENABLED` | `true` | `false` désactive le rate limit (dev local uniquement). |

Pour le **self-hosting** : créer une base Upstash gratuite sur [console.upstash.com/redis](https://console.upstash.com/redis), région Frankfurt eu-west-1 recommandée (colocalisée avec Vercel CDG), copier l'URL + token depuis l'onglet "REST API", coller dans les env vars Vercel. Tier free suffit largement pour un MCP public.

---

## État du projet

✅ **Version 0.7.0 — en production.** Le serveur MCP est live sur `https://france-data-mcp.vercel.app/mcp` et expose **24 tools**. ~95 K établissements FINESS, ~462 K professionnels Ameli et **~2,2 M PS RPPS actifs** ingérés (l'ANS pré-filtre `PS_LibreAcces_Personne_activite` aux PS actifs à la source — cf. DSFT v3.1 §5.1.2 — donc aucun retraité, suspendu, radié ou décédé en base). **525 tests unitaires verts**, TypeScript strict, Biome lint clean. Crons GitHub Actions actifs (FINESS bimensuel, Ameli hebdo, RPPS mensuel).

**V0.7.0 (11 mai 2026)** — Refonte cross-source : pivot SIRET élargi via DINUM (capture les SIRET fermés invisibles côté DREES, cf. cas Biogroup Bd Bizet), dual verdict site/groupe, opt-in `include_freshness` sur 12 tools, discriminant 4 états sur fallback FHIR ANS. Fix bug critique SIRENE V3.11 `/siret/` (raisonSocialeUniteLegale retournait le SIREN brut sur **tous** les SIRET). Breaking changes documentés dans [CHANGELOG](CHANGELOG.md#070-2026-05-11).

**V0.5.7 (11 mai 2026)** — Garde-fous publics avant lancement Smithery / listings MCP : **rate limit 60 req/min par IP** sur `tools/call` (Upstash Redis sliding window + fallback in-memory), **logging JSON structuré** par requête (ts, method, tool, ip_hash SHA-256, user_agent, duration_ms, status, outcome). Anti-spoofing `extractIp` priorise `x-real-ip` (non-spoofable Vercel) plutôt que `x-forwarded-for[0]`. Voir section [Garde-fous publics](#garde-fous-publics-v057) ci-dessous et [CHANGELOG](CHANGELOG.md#057-2026-05-11).

**V0.5.6 (10 mai 2026)** — Canary RPPS : remplacement des 3 IDNPS placeholder V0.5.0 par 3 référents stables sourcés via le serveur MCP lui-même (Dr ABABEI psychiatre Paris, IDE ABBAS MOUSSA Aix, Pharmacien BLANCHARD Réunion). Bug pré-existant V0.5.0 → V0.5.5 fixé : regex `getRppsById` `/^\d{11}$/` rejetait les vrais IDs 12 chars en base (préfixe `81` Type d'identifiant PP nomenclature TRE_G08 ANS) — tool MCP `professionnel_by_rpps` était cassé en prod sans détection. Voir [CHANGELOG](CHANGELOG.md#056-2026-05-10).

**V0.5.5 (10 mai 2026)** — Catégories ANS [TRE_R09](https://mos.esante.gouv.fr/NOS/TRE_R09-CategorieProfessionnelle/) : breaking change MCP, `include_inactifs` retiré, remplacé par `include_etudiants` + `include_agents_publics`. Default = Civils seuls. Validation empirique base prod = 3 codes seulement (`C` 97,2 %, `E` 2,5 %, `M` 0,3 %), codes fictifs `R/S/D` supprimés. Voir [CHANGELOG](CHANGELOG.md#055-2026-05-10).

**V0.5.2/.3/.4** ont stabilisé `professionnels_rpps_par_dept` sur dept dense (75/13) : timeout 15 s → < 1 s. Diagnostic et fix dans le [CHANGELOG](CHANGELOG.md#054-2026-05-10) (PostgREST `json_to_record LATERAL` + `EXECUTE format ... %L` pour custom plan + index couvrant `(code_departement, code_insee, nom, prenom, id)`).

### Fait

- [x] `territoire` — geo.api.gouv + IGN géocodage (4 tools)
- [x] `entreprises` — DINUM Recherche Entreprises + fallback INSEE SIRENE V3.11 (2 tools)
- [x] `FINESS` — ingestion data.gouv → Supabase + PostGIS, 24 familles, atomic swap, canary post-swap (3 tools)
- [x] `Annuaire Santé Ameli` — pipeline weekly, géocodage centroïde commune, libellés data-driven (4 tools)
- [x] **`RPPS / Annuaire Santé ANS`** — pipeline mensuel ~2,2 M PS actifs, ID national stable (11 ou 12 chiffres), pivot PS↔FINESS, enrichissement FINESS post-INSERT, filtre catégorie pro granulaire (`include_etudiants` / `include_agents_publics`), fallback live FHIR ANS (4 tools, V0.5.6)
- [x] **Perf dept dense** — timeout 15 s → < 1 s sur dept 75/13 via index couvrant `(code_departement, code_insee, nom, prenom, id)` + `EXECUTE format` plpgsql pour custom plan PostgREST (V0.5.2 → V0.5.4)
- [x] **Nomenclature ANS TRE_R09 alignée** — 3 codes catégorie réels (Civil / Étudiant / Agent public), codes fictifs `R/S/D` supprimés, garde-fou runtime sur legacy `include_inactifs` (V0.5.5)
- [x] **Canary RPPS référents stables** — 3 IDNPS sourcés en prod (couverture 75/13/974 + Médecin/IDE/Pharmacien) au lieu des placeholders sentinel V0.5.0 (V0.5.6)
- [x] **Garde-fous publics V0.5.7** — rate limit 60 req/min par IP (Upstash + fallback in-memory), logging JSON structuré, anti-spoofing `x-real-ip`, throttle log Upstash par signature d'erreur, serialize-safe fallback
- [x] Pipeline ingestion durci — SHA256 short-circuit, threshold parsedCoordRejected, atomic swap reversible
- [x] Serveur MCP HTTP déployé sur Vercel
- [x] Documentation Charleville-Mézières reproductible (`examples/charleville.ts`)

### Roadmap

- [ ] **V0.5.x — INSEE Melodi** (séries macro communales sans clé, dénominateur population pour les densités).
- [ ] **V0.6 — Tools composites santé** (`panorama_sante_territoire`, `densite_PS_par_specialite_commune`, `etablissements_avec_PS`, etc.) : combinaisons FINESS + Ameli + RPPS + Melodi en un seul appel pour faciliter la vie aux LLM.
- [ ] **V0.7+** — INSEE IRIS (démographie infra-communale), CNAM dept-level, DVF immobilier.

---

## Pourquoi ce projet ?

Trois constats motivent l'existence de cette boîte à outils :

1. **Les données existent, l'agrégation manque.** Un développeur qui veut croiser FINESS + Annuaire Ameli + INSEE pour analyser une zone passe une journée à comprendre les formats, les rate limits et les pièges. Avec une bonne lib, c'est 5 minutes.
2. **Les MCP officiels gouv sont en construction.** `mcp.data.gouv.fr` est excellent mais générique. Cet outil propose une couche métier prête pour des cas d'usage *territoriaux* (ouverture/fermeture de site, prospection, étude de marché, journalisme local, civic-tech).
3. **L'écosystème français mérite d'être visible.** Plus on construit d'outils ouverts qui s'appuient sur l'open data français, plus on stimule l'écosystème.

---

## Contribuer

Les contributions sont bienvenues. Avant d'ouvrir une PR, jette un œil à [CONTRIBUTING.md](CONTRIBUTING.md) (à venir) ou ouvre une issue pour discuter.

---

## Licence

MIT — voir [LICENSE](LICENSE).

Les **données** récupérées via cette lib restent sous leurs licences respectives :

| Source | Licence | Mention obligatoire |
|--------|---------|---------------------|
| FINESS | Licence Ouverte (Etalab) | « Source : FINESS, ANS/DREES » |
| Annuaire Santé Ameli | Réutilisation soumise au respect de la vie privée (art. L.1461-2 CSP) | « Source : Annuaire santé Ameli, Assurance Maladie » |
| DINUM Recherche Entreprises | Licence Ouverte | « Source : Annuaire des Entreprises, DINUM » |
| INSEE | Licence Ouverte | « Source : Insee » |
| IGN Géoplateforme | Licence Ouverte | « © IGN/Géoplateforme » |
| geo.api.gouv.fr | Licence Ouverte | « Source : geo.api.gouv.fr (Etalab) » |

---

## Remerciements

- Les équipes **DINUM**, **Etalab**, **Atlasanté**, **ANS**, **INSEE** et **IGN** pour la qualité de leurs APIs et la mise à disposition de l'open data français.
- L'équipe **data.gouv.fr** pour le serveur MCP officiel et l'animation de la communauté.
- L'équipe **Anthropic** pour le protocole MCP qui rend ce projet possible.
