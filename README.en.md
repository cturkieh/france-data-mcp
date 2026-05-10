# france-data-mcp

> A toolkit to query French public data from Claude, Cursor and any TypeScript app. A ready-to-plug MCP server.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)
[![MCP](https://img.shields.io/badge/MCP-live-success)](https://france-data-mcp.vercel.app/mcp)

🇬🇧 Short English overview. [Full documentation in French →](README.md)

---

## What it does

Brings together the most useful French government data sources (FINESS healthcare facilities, Annuaire Santé Ameli licensed practitioners, DINUM Recherche Entreprises, IGN geocoding, geo.api.gouv.fr, INSEE SIRENE) under a uniform TypeScript API and a single MCP server, with:

- Typed API (no `any`)
- Uniform rate-limit handling (exponential retry, `retry-after` aware)
- Hardened ingestion pipeline (SHA256 short-circuit, atomic swap, post-swap canary)
- Honest documentation about what each source contains and the gotchas

## Status

✅ **v0.5.5 — in production.** MCP server live at `https://france-data-mcp.vercel.app/mcp`, exposing 17 tools. ~95K FINESS facilities, ~462K Ameli practitioners and ~2.23M RPPS practitioners ingested and geocoded in WGS84. TypeScript strict, Biome clean. v0.5.5 aligns the RPPS professional-category filter on the official ANS [TRE_R09](https://mos.esante.gouv.fr/NOS/TRE_R09-CategorieProfessionnelle/) nomenclature: 3 codes only (`C` Civil, `E` Student, `M` Public agent), default returns Civils only, breaking change `include_inactifs` → `include_etudiants` + `include_agents_publics`. See [CHANGELOG](CHANGELOG.md) for diagnostic details.

## Tools (17)

- **Territory (4)**: `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`
- **Companies (2)**: `entreprises_in_radius`, `entreprise_by_siren` (with INSEE SIRENE V3.11 fallback)
- **FINESS healthcare facilities (3)**: `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`
- **Ameli licensed practitioners (4)**: `professionnels_in_radius`, `professionnels_par_specialite_dept`, `lister_specialites_ameli`, `lister_types_ps_ameli`
- **RPPS / ANS — all active practitioners (4, V0.5.5)**: `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`, `rpps_dans_etablissement`, `professionnel_by_rpps` (with live FHIR ANS fallback). ANS source is pre-filtered to active PS only — no retired, suspended, struck-off or deceased records ever appear.

## Use cases

- Site location analysis (where to open a clinic, lab, pharmacy)
- Healthcare territorial intelligence
- Local journalism with data
- Civic tech applications
- Market studies for healthcare and services
- Anything that needs *"what's around this point?"* with French open data

## Install

As an MCP server (recommended):

```
URL: https://france-data-mcp.vercel.app/mcp
```

See [docs/installation-claude.md](docs/installation-claude.md) for client-by-client setup (claude.ai, Claude Desktop, Cursor, Claude Code).

## Roadmap

- **v0.5.x** — INSEE Melodi (commune-level macro series, free, no key) for population denominators.
- **v0.6** — Composite tools (`panorama_sante_territoire`, density-per-specialty, PS-per-facility pivots) to make multi-source queries trivial for LLMs.
- **v0.7+** — INSEE IRIS demographics, CNAM dept-level, DVF real estate.

## License

MIT for the code. Each data source keeps its own license (mostly Etalab Open License). See [main README](README.md) for attribution requirements.
