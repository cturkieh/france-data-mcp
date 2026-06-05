# france-data-mcp

> A TypeScript MCP server that **cross-references and reconciles** 8 French public registries (INSEE SIRENE & IRIS, FINESS DREES, RPPS / ANS Health Directory, Ameli Health Directory, CNAM Health Centers, IGN, DINUM). Detects closed SIRETs not yet propagated by DREES, distinguishes site vs group, cross-references care supply with neighbourhood demographics, exposes data freshness per source.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/cturkieh/france-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cturkieh/france-data-mcp/actions)
[![MCP](https://img.shields.io/badge/MCP-live-success)](https://france-data-mcp.vercel.app/mcp)
[![npm](https://img.shields.io/npm/v/france-data-mcp.svg)](https://www.npmjs.com/package/france-data-mcp)
[![smithery badge](https://smithery.ai/badge/cturkieh/france-data)](https://smithery.ai/servers/cturkieh/france-data)

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
- Cross-source reconciliation FINESS ↔ RPPS ↔ SIRENE ↔ CNAM — detects closed SIRETs still listed active, M&A renamings not yet propagated, inconsistent company names across registries
- Honest docs about what each source contains and its gotchas

---

## Tools (34)

- **Territory (4)**: `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`
- **Companies (3)**: `entreprises_in_radius`, `entreprise_by_siren` (+ INSEE SIRENE V3.11 fallback), `etablissement_by_siret`
- **FINESS healthcare facilities (3)**: `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`
- **Ameli licensed practitioners (2)**: `professionnels_in_radius`, `professionnels_par_specialite_dept`
- **RPPS / ANS — all active practitioners (5)**: `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`, `rpps_dans_etablissement`, `rpps_search_by_name` (fuzzy trigram), `professionnel_by_rpps` (+ live FHIR ANS fallback)
- **Health Centers — CNAM directory (2)**: `centres_sante_in_radius`, `centres_sante_by_finess` — non-profit ambulatory care structures (L.6323-1 CSP, ~3 K). Exposes **Vitale card**, **APCV** and **specialties practised on site** (CNAM Annex A); weekly sync
- **Demographics & densities — INSEE Melodi + IRIS (3)**: `population` (IRIS 9-char, commune 5-char **or** department 2-3 char — granularity auto-detected from code length), `densite_sante` (`cible: professionnels` RPPS **or** `etablissements` FINESS — labs, pharmacies, nursing homes, hospitals; + national benchmark), `profil_iris` (`point` **or** `code_iris`, `rayon_km?`) — neighbourhood/catchment demographic profile (age, occupation, families, income) from INSEE Census 2022 + FILOSOFI 2021, to cross-reference with care supply
- **Nomenclature discovery (1)**: `lister_nomenclature` (`referentiel: ameli_specialites | ameli_types_ps | rpps_savoir_faire`) — Ameli specialty/type_ps codes **and** RPPS savoir_faire in a single tool (replaces the 3 former `lister_*`)
- **Aggregators & composite studies (4)**: `panorama_sante_territoire` (V0.9 — population + densities vs national + FINESS counts per family + IRIS demand block), `inspect_site` (V0.10 — 360° view of a facility: FINESS + SIRENE status + linked practitioners + INSEE history), `panorama_implantation_complet` (V0.23 — lab siting study in one call: 7 sections — territory, IRIS catchment demand, competitors, ecosystem drivers, prescribers, health centers, registry quality), `enrichir_concurrents` (V0.23 — deep-dive on top competitors: active status + team + M&A signal + parent group, hard cap `max=3`)
- **Multi-source cross-checks (7)**: `data_freshness`, `verifier_site_actif`, `compare_raison_sociale_finess_vs_rpps`, `compare_adresse_cnam_vs_finess`, `historique_etablissement`, `reconcilier_finess_sirene`, `finess_sirene_coverage_in_radius`

---

## Use cases

- Healthcare territorial analysis (supply mapping, access to care)
- Market research and competitive intelligence
- Local journalism with data
- Civic tech applications
- Any *"what's around this point?"* query on French open data

---

## Status

✅ **v0.25.0 — in production.** Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=france-data-mcp). Details: [CHANGELOG](CHANGELOG.md).

### Roadmap

- [x] **v0.22.0**: INSEE IRIS (mainland) — neighbourhood-level demographics (age, occupation, families, income).
- [x] **v0.23.0**: composite panoramas (`panorama_implantation_complet`, `enrichir_concurrents`) — siting studies in one call.
- [x] **v0.24.0**: BAN geocoding of Ameli addresses — building/street precision instead of the commune centroid (BAN acceptance 0.37% → 67%).
- [x] **v0.25.0**: RPPS cron hardening (hosted-activities matview, geocoding measurement) + BAN re-geocoding automation (GitHub button).
- [ ] **v1.0+**: DOM-COM (IRIS + health), DPC.

---

## Public limits

- **Rate limit**: 60 req/min per IP on `tools/call` (handshake methods stay free). Over the limit: JSON-RPC error `-32000` with `data.retryAfterSeconds`.
- **Structured JSON logs** per request: `ts`, `method`, `tool`, `ip_hash` (salted SHA-256), `duration_ms`, `outcome`. No raw IPs, no tool args persisted.
- **Sentry error monitoring** on internal 500s (tags `mcp.method`, `mcp.tool`, `mcp.outcome`).
- **GDPR**: 30-day Axiom retention, salted IP hash, access/erasure rights. Full policy in [PRIVACY.md](./PRIVACY.md).

For heavy use, throttle client-side or self-host.

---

## License

MIT for the code. Each data source keeps its own license (mostly Etalab Open License). See [main README](README.md#licence) for attribution requirements.
