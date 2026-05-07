# france-data-mcp

> A toolkit to query French public data from Claude, Cursor and any TypeScript app. A ready-to-plug MCP server + an npm library.

[![npm](https://img.shields.io/npm/v/france-data-mcp.svg)](https://www.npmjs.com/package/france-data-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

🇬🇧 Short English overview. [Full documentation in French →](README.md)

---

## What it does

Brings together the most useful French government data sources (INSEE, FINESS, Annuaire Santé Ameli, IGN geocoding, geo.api.gouv.fr, DINUM Recherche Entreprises) under a uniform TypeScript API and a single MCP server, with:

- Typed API (no `any`)
- Uniform rate-limit handling (exponential retry, `retry-after` aware)
- Sensible caching (TTL matched to each source's update cadence)
- Honest documentation about what each source contains and the gotchas

## Scope

- **🗺️ Territory** (`france-data-mcp/territoire`): commune autocomplete, address geocoding, IRIS-level demographics
- **🏥 Health** (`france-data-mcp/sante`): healthcare facilities (FINESS), licensed practitioners (Annuaire Ameli), health-sector companies (DINUM)

## Use cases

- Site location analysis (where to open a clinic, lab, pharmacy)
- Local journalism with data
- Civic tech applications
- Market studies for healthcare and services
- Anything that needs *"what's around this point?"* with French open data

## Install

As an MCP server (easiest):

```
URL: https://france-data-mcp.vercel.app/mcp (deployment in progress)
```

As a TypeScript lib:

```bash
npm install france-data-mcp
```

```ts
import { searchCommunes, geocode } from "france-data-mcp/territoire";
import { searchProfessionnels } from "france-data-mcp/sante";

const villes = await searchCommunes({ nom: "Charleville", limit: 5 });
const point = await geocode("64 Cours Aristide Briand 08000 Charleville-Mézières");
const mg = await searchProfessionnels({ specialite: "Médecin généraliste", center: point, radiusKm: 5 });
```

## Status

🚧 v0.1.0 — active development. First stable functions in v0.2. Public from day one to track progress.

## License

MIT for the code. Each data source keeps its own license (mostly Etalab Open License). See main README for attribution requirements.
