# france-data-mcp

> Boîte à outils pour interroger les données publiques françaises depuis Claude, Cursor et toute application TypeScript. Un serveur MCP prêt à brancher + une bibliothèque npm.

[![npm](https://img.shields.io/npm/v/france-data-mcp.svg)](https://www.npmjs.com/package/france-data-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)

🇫🇷 Documentation principale en français. [English version →](README.en.md)

---

## À quoi ça sert ?

Les API et MCP officiels du gouvernement français existent (data.gouv.fr, service-public.fr, INSEE, IGN, ANS, DINUM…) mais ils sont éclatés, parfois sous-documentés, et chacun a ses pièges (rate limits, formats CSV propriétaires, migrations en cours, etc.).

`france-data-mcp` rassemble **les sources les plus utiles pour de l'intelligence territoriale** dans une seule lib TypeScript et un seul serveur MCP, avec :

- une API uniforme et typée (zéro `any`),
- une gestion homogène des rate limits (retry exponentiel, respect de `retry-after`),
- un cache sensible (TTL adapté à la fréquence de mise à jour de chaque source),
- une documentation honnête sur ce que chaque source contient, comment elle évolue, et quels écueils éviter.

---

## Périmètre

### 🗺️ Territoire (`france-data-mcp/territoire`)

| Source | Usage type |
|--------|------------|
| **geo.api.gouv.fr** (DINUM) | Autocomplétion de communes par nom / code postal / code INSEE |
| **IGN Géoplateforme** (`data.geopf.fr`) | Géocodage d'adresse → coordonnées GPS, géocodage inverse |
| **INSEE Population IRIS** | Démographie infra-communale (tranches d'âge, CSP) |

### 🏥 Santé (`france-data-mcp/sante`)

| Source | Usage type |
|--------|------------|
| **FINESS** (data.gouv.fr) | Recherche d'établissements sanitaires et médico-sociaux par catégorie / zone (CH, CHU, EHPAD, MSP, CPTS, pharmacies, laboratoires…) |
| **Annuaire Santé Ameli** (CNAM) | Recherche de professionnels de santé libéraux conventionnés (médecins, IDE, sages-femmes, pharmaciens) par spécialité / zone |
| **DINUM Recherche Entreprises** (filtrée NAF santé) | Identification d'entreprises de santé (NAF 8690B labos, 8610Z hôpitaux, 8690A SSR, etc.) avec CA, dirigeants, effectifs |

D'autres domaines (éducation, transport, économie, justice) pourront s'ajouter dans `src/<domaine>/` si besoin.

---

## Installation

### En tant que serveur MCP (le plus simple)

Ajoute ce serveur à Claude Desktop, claude.ai, Cursor, Claude Code, ou tout client MCP compatible :

**URL publique hébergée** : `https://france-data-mcp.vercel.app/mcp` _(déploiement à venir)_

Voir [docs/installation-claude.md](docs/installation-claude.md) pour le pas-à-pas (3 clics).

### En tant que bibliothèque TypeScript

```bash
npm install france-data-mcp
```

```typescript
import { searchCommunes, geocode } from "france-data-mcp/territoire";
import { searchProfessionnels, searchEtablissements } from "france-data-mcp/sante";

// Trouver une commune
const villes = await searchCommunes({ nom: "Charleville", limit: 5 });

// Géocoder une adresse
const point = await geocode("64 Cours Aristide Briand 08000 Charleville-Mézières");

// Tous les médecins généralistes dans 5 km autour de ce point
const mg = await searchProfessionnels({
  specialite: "Médecin généraliste",
  center: point,
  radiusKm: 5,
});

// Tous les EHPAD dans la même zone
const ehpad = await searchEtablissements({
  categorie: "EHPAD",
  center: point,
  radiusKm: 5,
});
```

---

## État du projet

🚧 **Version 0.1.0 — en développement actif.** Le repo est public dès le premier commit pour suivre la progression. Les premières fonctions stables seront disponibles à partir de la v0.2.

Roadmap rapide :

- [x] Setup monorepo, TypeScript, build tsup
- [ ] `territoire` : geo.api.gouv + IGN géocodage
- [ ] `sante` : FINESS + Annuaire Santé Ameli + DINUM
- [ ] Serveur MCP HTTP déployé sur Vercel
- [ ] Documentation complète + exemple Charleville reproductible
- [ ] Publication npm v0.2 + annonce communauté

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
