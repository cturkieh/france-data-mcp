# france-data-mcp

> A TypeScript MCP server that **cross-references and reconciles** 6 French public registries (INSEE SIRENE, FINESS DREES, RPPS / ANS Health Directory, Ameli Health Directory, IGN, DINUM). Detects closed SIRETs not yet propagated by DREES, distinguishes site vs group, exposes data freshness per source.

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
- Cross-source reconciliation FINESS ↔ RPPS ↔ SIRENE — detects closed SIRETs still listed active, M&A renamings not yet propagated, inconsistent company names across registries
- Honest docs about what each source contains and its gotchas

---

## Tools (35)

- **Territory (4)**: `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`
- **Companies (3)**: `entreprises_in_radius`, `entreprise_by_siren` (+ INSEE SIRENE V3.11 fallback), `etablissement_by_siret`
- **FINESS healthcare facilities (3)**: `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`
- **Ameli licensed practitioners (4)**: `professionnels_in_radius`, `professionnels_par_specialite_dept`, `lister_specialites_ameli`, `lister_types_ps_ameli`
- **RPPS / ANS — all active practitioners (5)**: `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`, `rpps_dans_etablissement`, `rpps_search_by_name` (fuzzy trigram), `professionnel_by_rpps` (+ live FHIR ANS fallback)
- **Demographics & densities — INSEE Melodi (5)**: `population_par_commune`, `population_par_departement`, `densite_professionnels_sante` (department OR commune, DREES methodology, per 100k inhab. + national benchmark), `densite_etablissements_sante` (labs, pharmacies, nursing homes, hospitals), `lister_specialites_medicales` (RPPS savoir_faire discovery)
- **Territory health snapshot (1) — V0.9**: `panorama_sante_territoire` — single-call aggregator (population + multi-PS densities vs national + FINESS counts per family)
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

✅ **v0.13.0 — in production.** 35 tools, 4 ingested health sources (FINESS, Ameli, RPPS, CDS) + live INSEE / DINUM / IGN. 1,257 tests, TypeScript strict. Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=france-data-mcp). Observability: Sentry + Axiom + `/healthz`. **68.5% of RPPS practitioners precisely geolocated** (FINESS building or BAN street) — exposed via per-result `geo_precision` + `precise_only` filter on 4 RPPS tools.

**New in v0.13 — Resolver V2**: geographic fallback via DINUM `/near_point` filtered by NAF compatible with the FINESS family, triggered when the V0.7 RPPS pivot fails (labs with no RPPS-declared biologist, EHPADs / pharmacies without site holder, business relocations). Many-to-many NAF gate (`naf-finess-mapping.ts`) preserves the Franco-Britannique safety net (a lab is never matched to a co-located nursing school). Full traceability exposed: `method` / `fallback_reason` / `naf_filter_used` / `disambiguation_status` on `verifier_site_actif` / `historique_etablissement` / `reconcilier_finess_sirene` / `inspect_site`. Bonus: dynamic `geo_precision` label (reflects actual row distribution) + `includeDirigeants` toggle on `entreprises_in_radius` (token-saving for bulk enumeration).

Full history: [CHANGELOG](CHANGELOG.md). Project discipline: prove every root cause against production / official docs BEFORE coding the fix.

### Roadmap

- [ ] **Dense-zone timeout fix**: `rpps_in_radius` with `preciseOnly=true` over dense Paris + 1 km radius triggers `57014 statement timeout`. Reproduced in production V0.13. To diagnose via `EXPLAIN ANALYZE` then fix (missing indices or planner hint).
- [ ] **Ameli address geocoding**: fetch precise BAN coordinates instead of commune centroid on Ameli addresses — bonus 1 from Claude.ai feedback, standalone, high impact.
- [ ] **Unified RPPS + Ameli professional sheet** (concatenated, not resolved — "concatenated MCP / resolved Geo Intel" doctrine): one practitioner, two sources juxtaposed, divergences exposed to the caller.
- [ ] **`finess_sirene_coverage_in_radius` matching fix**: IFSI/lab matching via the `naf-finess-mapping.ts` table (table is ready, to be wired into `coverage.ts`).
- [ ] **Phase 2 — recurring re-geocoding automation**: bounded BAN step inline in the RPPS cron (diff staging → POST BAN on delta → upsert cache). Pending Phase 1 production numbers.
- [ ] **v1.0+**: DOM-COM support (`code_insee CHAR(5)`), INSEE IRIS (infra-communal demographics), DPC (PS training history).

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
