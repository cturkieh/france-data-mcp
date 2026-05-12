# france-data-mcp

> MCP TypeScript qui **croise et réconcilie** 6 référentiels publics français (INSEE SIRENE, FINESS DREES, RPPS / Annuaire Santé ANS, Annuaire Santé Ameli, IGN, DINUM). Détecte les SIRET fermés que DREES n'a pas encore propagés, distingue site vs groupe, expose la fraîcheur de chaque source.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)
[![MCP](https://img.shields.io/badge/MCP-live-success)](https://france-data-mcp.vercel.app/mcp)

🇫🇷 Documentation principale en français. [English version →](README.en.md)

---

## Installation rapide

**URL publique** : `https://france-data-mcp.vercel.app/mcp`

| Client | Configuration |
|---|---|
| **claude.ai** | Settings → Connectors → Add custom connector → URL ci-dessus |
| **Claude Code** | `~/.claude.json` → `mcpServers` → `{ "type": "http", "url": "..." }` |
| **Cursor** | `~/.cursor/mcp.json` → même configuration |

Voir [docs/installation-claude.md](docs/installation-claude.md) pour le détail client par client et le self-hosting.

---

## Pourquoi ce projet

Les API officielles (INSEE, FINESS DREES, RPPS ANS, Annuaire Ameli, IGN, DINUM) existent mais sont **éclatées, sous-documentées et pleines de pièges** : rate limits, formats CSV propriétaires, latences DREES de 1-2 mois, diffusion partielle INSEE, mappings inconsistants entre Ameli et RPPS.

`france-data-mcp` est **le premier MCP qui croise factuellement ces sources** pour répondre à des questions concrètes — cartographie d'offre de soins, étude de marché territoriale, journalisme local, civic-tech, tout usage nécessitant *« qu'est-ce qui se trouve autour de ce point ? »* avec les données ouvertes françaises.

---

## Périmètre — 6 sources publiques croisées

- 🗺️ **Territoire** : geo.api.gouv.fr (DINUM, communes), IGN Géoplateforme (géocodage)
- 🏥 **Santé** : FINESS / DREES (~95 K établissements), Annuaire Santé Ameli (~462 K libéraux), RPPS / Annuaire Santé ANS (~2,2 M PS actifs)
- 🏢 **Entreprises** : DINUM Recherche Entreprises + INSEE SIRENE V3.11

**Cross-source** : réconciliation FINESS ↔ RPPS ↔ SIRENE pour détecter les divergences entre référentiels (SIRET fermés, rebrandings, raisons sociales périmées).

---

## Outils MCP exposés (24 tools)

### 🗺️ Territoire (4 tools)

| Tool | Description | Source |
|---|---|---|
| `autocomplete_commune` | Autocomplétion commune par nom / CP / code INSEE | geo.api.gouv.fr |
| `get_commune_by_code` | Fiche complète par code INSEE (5 chars) | geo.api.gouv.fr |
| `geocode_adresse` | Adresse → coordonnées GPS (avec score de confiance) | IGN Géoplateforme |
| `reverse_geocode` | Coordonnées GPS → adresse postale + commune | IGN Géoplateforme |

### 🏢 Entreprises (3 tools)

| Tool | Description | Source |
|---|---|---|
| `entreprises_in_radius` | Entreprises dans un rayon par code(s) NAF | DINUM Recherche Entreprises |
| `entreprise_by_siren` | Fiche entreprise (sites, finances, dirigeants) | DINUM + fallback INSEE SIRENE V3.11 |
| `etablissement_by_siret` | Fiche établissement par SIRET (14 chiffres) | INSEE SIRENE V3.11 |

### 🏥 Établissements de santé — FINESS (3 tools)

| Tool | Description |
|---|---|
| `etablissements_finess_in_radius` | Établissements FINESS dans un rayon, filtrage par famille |
| `etablissements_finess_by_categorie` | Liste FINESS par famille (+ département / commune optionnels) |
| `etablissement_by_finess` | Fiche par numéro FINESS (9 chiffres) |

24 familles couvrant ~92 % du volume : sanitaire, médico-social, libéral, hébergement social, addictologie, prévention, coopération. Source DREES rafraîchie bimestriellement — voir [docs/ingestion.md](docs/ingestion.md).

### 👨‍⚕️ Professionnels de santé libéraux — Annuaire Ameli (4 tools)

| Tool | Description |
|---|---|
| `professionnels_in_radius` | PS dans un rayon, filtrage par spécialité / type |
| `professionnels_par_specialite_dept` | Liste de PS par département (pagination) |
| `lister_specialites_ameli` | Nomenclature live des spécialités |
| `lister_types_ps_ameli` | Nomenclature live des types de PS |

> Couverture : libéraux **conventionnés uniquement** (~462 K). Pour les salariés et hospitaliers, voir RPPS ci-dessous.

### 🩺 Tous les professionnels — RPPS / Annuaire Santé ANS (5 tools)

| Tool | Description |
|---|---|
| `professionnels_rpps_in_radius` | PS dans un rayon (libéraux + salariés). Filtres : profession ANS, savoir-faire, mode d'exercice |
| `professionnels_rpps_par_dept` | Listing départemental + pagination |
| `rpps_dans_etablissement` | Qui travaille dans cet établissement ? (filtre par numéro FINESS) |
| `rpps_search_by_name` | Recherche fuzzy par identité (nom + prénom + département optionnel) |
| `professionnel_by_rpps` | Fiche par identifiant national IDNPS (11 ou 12 chiffres) |

> Couverture RPPS : **~2,2 M PS actifs** (libéraux + salariés privés + hospitaliers contractuels + agents publics). Source ANS pré-filtrée aux PS actifs : aucun retraité, suspendu, radié ou décédé. Par défaut, seuls les Civils sont retournés — ajouter `include_agents_publics: true` et/ou `include_etudiants: true` pour élargir.

### 🔀 Croisement multi-source (5 tools)

Primitives de réconciliation FINESS ↔ RPPS ↔ SIRENE. Faits bruts sans interprétation métier — le caller décide.

| Tool | Description |
|---|---|
| `data_freshness` | Fraîcheur des dumps ingérés (date, staleness_days, cadence) |
| `verifier_site_actif` | Croise DREES ↔ RPPS ↔ DINUM avec scoring Dice. Verdict site + groupe, détecte les SIRET fermés invisibles côté DREES |
| `compare_raison_sociale_finess_vs_rpps` | Compare raison sociale FINESS vs RPPS sur un même numéro |
| `historique_etablissement` | Timeline complète via SIRENE `periodesEtablissement` |
| `reconcilier_finess_sirene` | Score Sørensen-Dice FINESS vs SIRENE — verdict `match` / `partial` / `mismatch` |

---

## Garde-fous publics

L'endpoint public applique un **rate limit de 60 req/min par IP** sur `tools/call`. Au-delà : erreur JSON-RPC `-32000` avec `data.retryAfterSeconds`. Toutes les requêtes sont loggées en JSON structuré (`ts`, `method`, `tool`, `ip_hash` SHA-256, `duration_ms`, `outcome`) ; IPs hashées avant tout stockage (RGPD-friendly).

Pour un usage intensif, throttler côté client ou self-héberger avec un plafond adapté — voir [docs/installation-claude.md](docs/installation-claude.md#self-hosting).

---

## État du projet

✅ **V0.7.0 — en production.** 24 tools, ~95 K établissements FINESS, ~462 K professionnels Ameli, ~2,2 M PS RPPS actifs. 525 tests unitaires verts, TypeScript strict, Biome lint clean. Crons GitHub Actions actifs (FINESS bimensuel, Ameli hebdo, RPPS mensuel). Voir [CHANGELOG](CHANGELOG.md) pour l'historique complet.

### Roadmap

- [ ] **V0.7.1** — Fallback INSEE `/siret?q=siren:XXX` pour les SIREN multi-sites quand DINUM retourne `enrichmentStatus: "partial"`
- [ ] **V0.8** — Tools composites santé (`panorama_sante_territoire`, densités par spécialité), INSEE Melodi (séries macro communales)
- [ ] **V0.9+** — Support DOM-COM, INSEE IRIS (démographie infra-communale)

---

## Contribuer

Les contributions sont bienvenues. Ouvrir une issue pour discuter avant d'envoyer une PR.

---

## Licence

MIT — voir [LICENSE](LICENSE).

Les **données** récupérées via cette lib restent sous leurs licences respectives :

| Source | Licence | Mention obligatoire |
|--------|---------|---------------------|
| FINESS | Licence Ouverte (Etalab) | « Source : FINESS, ANS/DREES » |
| Annuaire Santé Ameli | Réutilisation soumise (art. L.1461-2 CSP) | « Source : Annuaire santé Ameli, Assurance Maladie » |
| DINUM Recherche Entreprises | Licence Ouverte | « Source : Annuaire des Entreprises, DINUM » |
| INSEE | Licence Ouverte | « Source : Insee » |
| IGN Géoplateforme | Licence Ouverte | « © IGN/Géoplateforme » |
| geo.api.gouv.fr | Licence Ouverte | « Source : geo.api.gouv.fr (Etalab) » |

---

## Remerciements

- Les équipes **DINUM**, **Etalab**, **Atlasanté**, **ANS**, **INSEE** et **IGN** pour la qualité de leurs APIs et la mise à disposition de l'open data français.
- L'équipe **data.gouv.fr** pour le serveur MCP officiel et l'animation de la communauté.
- L'équipe **Anthropic** pour le protocole MCP qui rend ce projet possible.
