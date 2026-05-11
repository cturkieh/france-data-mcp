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

✅ **v0.6.2 — in production.** MCP server live at `https://france-data-mcp.vercel.app/mcp`, exposing **24 tools**. ~95K FINESS facilities, ~462K Ameli practitioners and ~2.23M RPPS practitioners ingested and geocoded in WGS84. TypeScript strict, Biome clean, **517 tests passing**. v0.6 adds multi-source cross-checking (FINESS ↔ RPPS ↔ SIRENE) to detect closed SIRETs still listed active in FINESS, M&A renamings not yet propagated, and reconcile FINESS records against SIRENE via Sørensen-Dice scoring. See [CHANGELOG](CHANGELOG.md#062--2026-05-11).

## Tools (24)

- **Territory (4)**: `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`
- **Companies (3)**: `entreprises_in_radius`, `entreprise_by_siren` (with INSEE SIRENE V3.11 fallback), `etablissement_by_siret` (V0.6.0, SIRENE V3.11)
- **FINESS healthcare facilities (3)**: `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`
- **Ameli licensed practitioners (4)**: `professionnels_in_radius`, `professionnels_par_specialite_dept`, `lister_specialites_ameli`, `lister_types_ps_ameli`
- **RPPS / ANS — all active practitioners (5, V0.6.0)**: `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`, `rpps_dans_etablissement`, `rpps_search_by_name` (fuzzy trigram by identity), `professionnel_by_rpps` (with live FHIR ANS fallback). ANS source is pre-filtered to active PS only — no retired, suspended, struck-off or deceased records ever appear.
- **Multi-source cross-checks (5, V0.6.1 / V0.6.2)**: `data_freshness` (ingestion staleness per source), `verifier_site_actif` (FINESS ↔ RPPS ↔ SIRENE active/closed verdict), `compare_raison_sociale_finess_vs_rpps` (raw diff for M&A renaming detection), `historique_etablissement` (full SIRENE periods timeline), `reconcilier_finess_sirene` (Sørensen-Dice scoring with `match` / `partial` / `mismatch` verdict). No business interpretation — facts only, the caller decides.

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

## Public limits (V0.5.7)

The public endpoint enforces **60 req/min per IP** on `tools/call` (handshake methods `initialize` / `tools/list` / `ping` stay free). Over the limit, the server returns a JSON-RPC error code `-32000` with `data.retryAfterSeconds`. Heavy / batch users should throttle client-side or self-host. Every request is logged as structured JSON (`ts`, `method`, `tool`, `ip_hash` SHA-256, `user_agent`, `duration_ms`, `status`, `outcome`). No tool arguments are persisted; IPs are hashed before any log or Redis store (GDPR-friendly).

## Roadmap

- **v0.5.x** — INSEE Melodi (commune-level macro series, free, no key) for population denominators.
- **v0.6** — Composite tools (`panorama_sante_territoire`, density-per-specialty, PS-per-facility pivots) to make multi-source queries trivial for LLMs.
- **v0.7+** — INSEE IRIS demographics, CNAM dept-level, DVF real estate.

## License

MIT for the code. Each data source keeps its own license (mostly Etalab Open License). See [main README](README.md) for attribution requirements.
