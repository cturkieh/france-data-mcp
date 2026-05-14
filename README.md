# france-data-mcp

> MCP TypeScript qui **croise et réconcilie** 6 référentiels publics français (INSEE SIRENE, FINESS DREES, RPPS / Annuaire Santé ANS, Annuaire Santé Ameli, IGN, DINUM). Détecte les SIRET fermés invisibles côté DREES, distingue site vs groupe, expose la fraîcheur de chaque source.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)
[![MCP](https://img.shields.io/badge/MCP-live-success)](https://france-data-mcp.vercel.app/mcp)
[![npm](https://img.shields.io/npm/v/france-data-mcp.svg)](https://www.npmjs.com/package/france-data-mcp)
[![smithery badge](https://smithery.ai/badge/cturkieh/france-data)](https://smithery.ai/servers/cturkieh/france-data)

🇫🇷 Documentation principale en français. [English version →](README.en.md)

---

## Installation

### Option 1 — URL distante (claude.ai, Claude Code, Cursor)

`https://france-data-mcp.vercel.app/mcp`

| Client | Config |
|---|---|
| **claude.ai** | Settings → Connectors → Add custom connector → URL ci-dessus |
| **Claude Code** | `~/.claude.json` → `mcpServers` → `{ "type": "http", "url": "..." }` |
| **Cursor** | `~/.cursor/mcp.json` → même configuration |

### Option 2 — Wrapper npm stdio (Claude Desktop natif, autres clients)

```json
{
  "mcpServers": {
    "france-data": {
      "command": "npx",
      "args": ["-y", "france-data-mcp"]
    }
  }
}
```

Le wrapper forwarde stdio → endpoint HTTPS distant. Aucune DB locale à provisionner. Override possible : `FRANCE_DATA_MCP_URL=https://mon-miroir.example/mcp`.

Détails par client + self-hosting : [docs/installation-claude.md](docs/installation-claude.md).

---

## Pourquoi ce projet

Les APIs officielles (INSEE, FINESS DREES, RPPS ANS, Annuaire Ameli, IGN, DINUM) existent mais sont **éclatées, sous-documentées et pleines de pièges** : rate limits, formats CSV propriétaires, latence DREES de 1-2 mois, diffusion partielle INSEE, mappings inconsistants Ameli ↔ RPPS.

`france-data-mcp` est **le premier MCP qui croise factuellement ces sources** pour répondre à des questions concrètes — cartographie d'offre de soins, étude de marché territoriale, journalisme local, civic-tech.

---

## Périmètre — 6 sources publiques croisées

- 🗺️ **Territoire** : geo.api.gouv.fr (DINUM, communes), IGN Géoplateforme (géocodage)
- 🏥 **Santé** : FINESS / DREES (~95 K établissements), Annuaire Santé Ameli (~462 K libéraux), RPPS / ANS (~2,2 M PS actifs)
- 🏢 **Entreprises** : DINUM Recherche Entreprises + INSEE SIRENE V3.11

**Cross-source** : réconciliation FINESS ↔ RPPS ↔ SIRENE pour détecter SIRET fermés, rebrandings, raisons sociales périmées.

---

## Outils MCP (31 tools)

### 🗺️ Territoire (4)
`autocomplete_commune` · `get_commune_by_code` · `geocode_adresse` · `reverse_geocode`

### 🏢 Entreprises (3)
`entreprises_in_radius` · `entreprise_by_siren` (+ fallback INSEE SIRENE V3.11) · `etablissement_by_siret`

### 🏥 Établissements santé FINESS (3)
`etablissements_finess_in_radius` · `etablissements_finess_by_categorie` · `etablissement_by_finess`

> 24 familles couvrant ~92 % du volume. Source DREES rafraîchie bimestriellement.

### 👨‍⚕️ Professionnels libéraux Ameli (4)
`professionnels_in_radius` · `professionnels_par_specialite_dept` · `lister_specialites_ameli` · `lister_types_ps_ameli`

> Libéraux **conventionnés uniquement** (~462 K).

### 🩺 Tous les PS — RPPS / Annuaire Santé ANS (5)
`professionnels_rpps_in_radius` · `professionnels_rpps_par_dept` · `rpps_dans_etablissement` · `rpps_search_by_name` (fuzzy) · `professionnel_by_rpps` (+ fallback FHIR ANS)

> ~2,2 M PS actifs (libéraux + salariés privés + hospitaliers contractuels + agents publics). Par défaut : Civils uniquement.

### 📊 Démographie & densités — INSEE Melodi (5)
Population de référence INSEE croisée avec RPPS / FINESS — méthodologie DREES (ratios pour 100 k hab.).

`population_par_commune` · `population_par_departement` · `densite_professionnels_sante` (+ comparaison nationale matview <50 ms) · `densite_etablissements_sante` (labos, pharmacies, EHPAD, hôpitaux) · `lister_specialites_medicales` (découverte des codes savoir_faire RPPS)

### 🧭 Agrégateur santé territoire (1) — V0.9
`panorama_sante_territoire` — 1 call pour population + densités médecins/infirmiers/pharmaciens vs national + count FINESS par famille (labo, pharmacie, EHPAD, MCO, MSP/CPTS). Granularité explicite (`niveau: commune`, `niveauEtablissements: departement | indisponible`).

### 🔀 Croisement multi-source (6)
Réconciliation FINESS ↔ RPPS ↔ SIRENE — faits bruts sans interprétation métier.

`data_freshness` · `verifier_site_actif` · `compare_raison_sociale_finess_vs_rpps` · `historique_etablissement` · `reconcilier_finess_sirene` · `finess_sirene_coverage_in_radius`

---

## Garde-fous publics

- **Rate limit** : 60 req/min par IP sur `tools/call` (les méthodes meta restent libres). Au-delà : erreur `-32000` avec `data.retryAfterSeconds`.
- **Logs JSON structurés** par requête : `ts`, `method`, `tool`, `ip_hash` (SHA-256 salé), `duration_ms`, `outcome`. Aucune IP en clair, aucun argument tool persisté.
- **Sentry error monitoring** sur les 500 internes (tags `mcp.method`, `mcp.tool`, `mcp.outcome`).
- **RGPD** : rétention 30j sur Axiom, hash IP salé, droits d'accès / effacement. Politique complète dans [PRIVACY.md](./PRIVACY.md).

Usage intensif : throttler côté client ou self-héberger.

---

## État du projet

✅ **V0.9.1 — en production.** 31 tools, ~95 K FINESS, ~462 K Ameli, ~2,2 M RPPS actifs. 741 tests verts, TypeScript strict, Biome clean. Référencé sur le [registry MCP Anthropic officiel](https://registry.modelcontextprotocol.io/v0.1/servers?search=france-data-mcp), mcp.so et glama.ai. Crons GitHub Actions (FINESS bimensuel, Ameli hebdo, RPPS mensuel) actifs. Observabilité : Sentry monitoring + Axiom log drain (rétention 30 j, fail-soft).

Voir [CHANGELOG](CHANGELOG.md) pour l'historique détaillé.

### Roadmap

- [ ] **V0.9.2** — RPC `count_finess_by_commune` (granularité commune côté établissements), circuit breaker 4xx Axiom, healthz endpoint
- [ ] **V1.0+** — Support DOM-COM (`code_insee CHAR(5)`), INSEE IRIS (démographie infra-communale)

---

## Contribuer

Ouvrir une issue pour discuter avant d'envoyer une PR.

---

## Licence

MIT — voir [LICENSE](LICENSE). Les **données** restent sous leurs licences respectives :

| Source | Licence | Mention obligatoire |
|---|---|---|
| FINESS | Licence Ouverte (Etalab) | « Source : FINESS, ANS/DREES » |
| Annuaire Santé Ameli | Art. L.1461-2 CSP | « Source : Annuaire santé Ameli, Assurance Maladie » |
| DINUM Recherche Entreprises | Licence Ouverte | « Source : Annuaire des Entreprises, DINUM » |
| INSEE | Licence Ouverte | « Source : Insee » |
| IGN Géoplateforme | Licence Ouverte | « © IGN/Géoplateforme » |
| geo.api.gouv.fr | Licence Ouverte | « Source : geo.api.gouv.fr (Etalab) » |

---

## Remerciements

DINUM, Etalab, Atlasanté, ANS, INSEE, IGN pour la qualité de leurs APIs. data.gouv.fr pour l'animation civic-tech. Anthropic pour le protocole MCP.
