# france-data-mcp

> A TypeScript MCP server that **cross-references and reconciles** 6 French public registries (INSEE SIRENE, FINESS DREES, RPPS / ANS Health Directory, Ameli Health Directory, IGN, DINUM). Detects closed SIRETs not yet propagated by DREES, distinguishes site vs group, exposes data freshness per source.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)
[![MCP](https://img.shields.io/badge/MCP-live-success)](https://france-data-mcp.vercel.app/mcp)
[![npm](https://img.shields.io/npm/v/france-data-mcp.svg)](https://www.npmjs.com/package/france-data-mcp)
[![smithery](https://smithery.ai/badge/@cturkieh/france-data)](https://smithery.ai/server/@cturkieh/france-data)

🇬🇧 Short English overview. [Full documentation in French →](README.md)

---

## Install

### Option 1 — Remote URL (claude.ai, Claude Code, Cursor)

`https://france-data-mcp.vercel.app/mcp`

| Client | Config |
|---|---|
| **claude.ai** | Settings → Connectors → Add custom connector → URL above |
| **Claude Code** | `~/.claude.json` → `mcpServers` → `{ "type": "http", "url": "..." }` |
| **Cursor** | `~/.cursor/mcp.json` → same configuration |

### Option 2 — npm stdio wrapper (native Claude Desktop, other clients)

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

The wrapper forwards stdio → remote HTTPS endpoint. No local DB to provision. Override possible: `FRANCE_DATA_MCP_URL=https://my-mirror.example/mcp`.

Client-by-client setup + self-hosting: [docs/installation-claude.md](docs/installation-claude.md).

---

## What it does

Brings together the most useful French government data sources under a uniform typed API and a single MCP server endpoint, with:

- Typed API (zero `any`), uniform rate-limit handling (exponential retry, `retry-after` aware)
- Hardened ingestion pipeline (SHA-256 short-circuit, atomic swap, post-swap canary)
- Cross-source reconciliation FINESS ↔ RPPS ↔ SIRENE — detects closed SIRETs still listed active, M&A renamings not yet propagated, inconsistent company names across registries
- Honest docs about what each source contains and its gotchas

---

## Tools (25)

- **Territory (4)**: `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`
- **Companies (3)**: `entreprises_in_radius`, `entreprise_by_siren` (+ INSEE SIRENE V3.11 fallback), `etablissement_by_siret`
- **FINESS healthcare facilities (3)**: `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`
- **Ameli licensed practitioners (4)**: `professionnels_in_radius`, `professionnels_par_specialite_dept`, `lister_specialites_ameli`, `lister_types_ps_ameli`
- **RPPS / ANS — all active practitioners (5)**: `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`, `rpps_dans_etablissement`, `rpps_search_by_name` (fuzzy trigram), `professionnel_by_rpps` (+ live FHIR ANS fallback)
- **Multi-source cross-checks (6)**: `data_freshness`, `verifier_site_actif`, `compare_raison_sociale_finess_vs_rpps`, `historique_etablissement`, `reconcilier_finess_sirene`, `finess_sirene_coverage_in_radius`

---

## Use cases

- Healthcare territorial analysis (supply mapping, access to care)
- Market research and competitive intelligence
- Local journalism with data
- Civic tech applications
- Any *"what's around this point?"* query on French open data

---

## Status

✅ **v0.7.4 — in production.** MCP server live at `https://france-data-mcp.vercel.app/mcp`, exposing **25 tools** with official MCP annotations (readOnly/idempotent/openWorld). ~95K FINESS facilities, ~462K Ameli practitioners, ~2.2M active RPPS practitioners. TypeScript strict, Biome clean, **603 tests passing**. Sentry error monitoring live (bot-noise filter active). See [CHANGELOG](CHANGELOG.md) for the full history.

### Roadmap

- **v0.8** — Composite health tools (`panorama_sante_territoire`, density analytics), INSEE Melodi (commune-level macro series)
- **v0.9+** — DOM-COM support, INSEE IRIS (infra-communal demographics)

---

## Public limits

- **Rate limit**: 60 req/min per IP on `tools/call` (handshake methods stay free). Over the limit: JSON-RPC error `-32000` with `data.retryAfterSeconds`.
- **Structured JSON logs** per request: `ts`, `method`, `tool`, `ip_hash` (SHA-256), `duration_ms`, `outcome`. No raw IPs, no tool args persisted (GDPR-friendly).
- **Sentry error monitoring** on internal 500s (tags `mcp.method`, `mcp.tool`, `mcp.outcome`).

For heavy use, throttle client-side or self-host.

---

## License

MIT for the code. Each data source keeps its own license (mostly Etalab Open License). See [main README](README.md#licence) for attribution requirements.
