---
name: france-data-mcp
description: Use the france-data-mcp MCP server to answer questions with French public open data — healthcare supply (FINESS facilities, RPPS and Ameli health professionals, CNAM health centres), demographics (INSEE population, IRIS neighbourhood profiles, FILOSOFI income), companies (SIRENE, DINUM Recherche Entreprises), real estate (DVF prices, Sit@del building permits, PLU AU zones) and geocoding (IGN Géoplateforme, geo.api.gouv.fr). Trigger on any question about French hospitals, clinics, labs, pharmacies, EHPAD, doctors, nurses, medical density, "désert médical", commune or neighbourhood demographics, SIRET/SIREN/FINESS/RPPS lookups, site openings and closures, or "étude d'implantation" in France.
---

# france-data-mcp — French public data for agents

`france-data-mcp` is a free, read-only MCP server that crosses 13 French public
registries. It answers factual questions about healthcare supply, demographics,
companies and real estate in France, and exposes how fresh each source is.

It returns **raw facts, never business verdicts**. It will not say "medical
desert" or "go / no-go". You apply the reasoning grid; the server supplies the
numbers and the caveats that come with them.

## When to use this skill

Use it when the user asks about France and the answer lives in a public registry:

- "Combien de laboratoires d'analyses autour de cette adresse ?" / "How many labs within 5 km of this address?"
- "Quelle est la densité de cardiologues dans le Nord comparée à la France ?" / "Cardiologist density in Nord vs national?"
- "Cet établissement FINESS est-il encore ouvert ?" / "Is this FINESS facility still operating?"
- "Profil socio-démographique du quartier autour de ce point" / "Demographic profile of the neighbourhood around this point"
- "Trouve l'Institut Gustave Roussy et les médecins qui y exercent" / "Find Gustave Roussy and the doctors who work there"
- "Prix médian au m² et permis de construire autour de cette adresse" / "Median price per m² and building permits near this address"

Do not use it for: individual patient data, opening hours or fees, road travel
times, non-French territories, or private company financials beyond what DINUM
publishes.

## Installation

Remote endpoint (no install, no database): `https://france-data-mcp.vercel.app/mcp`

| Client | Config |
|---|---|
| claude.ai | Settings → Connectors → Add custom connector → URL above, Authentication "None" |
| Claude Code | `~/.claude.json` → `mcpServers` → `{ "type": "http", "url": "https://france-data-mcp.vercel.app/mcp" }` |
| Cursor | `~/.cursor/mcp.json` → same configuration |

Stdio wrapper for Claude Desktop and other stdio-only clients (forwards to the
same HTTPS endpoint):

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

Also listed on the official MCP registry as `io.github.cturkieh/france-data-mcp`.
Self-hosting and per-client details:
https://github.com/cturkieh/france-data-mcp/blob/main/docs/installation-claude.md

Public rate limit: 60 `tools/call` per minute per IP. Over the limit you get
JSON-RPC error `-32000` with `data.retryAfterSeconds`: wait, then retry. Do not
fan out dozens of parallel calls; prefer the aggregator tools.

## Five rules that apply to every tool

1. **"Not found" is not an error.** Lookup tools return a `LookupResult`
   discriminated by `found`. `found: false` carries `lookupStatus`
   (`not_found` or `ambiguous`) and a `message` that usually names the next tool
   to try. Report "absent from the registry", never "the server failed".
   Invalid input is a real error (JSON-RPC `-32602`): fix the argument.
2. **Read `perimetre` before quoting a count.** Counting tools attach a
   `perimetre` object (`source`, `lens`, `compte`, `exclut`,
   `completeness_note`). Restate `completeness_note` to the reader. Example:
   FINESS files each site under ONE dominant category, so `famille: "labo"`
   does not count hospital lab platforms.
3. **`activite_hebergee` is juxtaposed, never added.** When a single family is
   filtered, FINESS tools may add `activite_hebergee` = sites hosting that
   activity under another category. Present it next to the main `count` with
   its `note`. Never sum the two.
4. **Read `geo_precision` per result.** `adresse` and `etablissement_finess`
   mean an exact point. `centroide_commune` means the commune centre (about
   3 km off): every professional of that commune gets the same `distance_km`,
   so never rank them individually. Pass `precise_only: true` for short radii.
5. **Never mix code systems.** Ameli codes (`specialite_code`, `type_ps_code`)
   and ANS / RPPS codes (`profession_code`, `savoir_faire_code`) are distinct:
   `"10"` is "Médecin" at ANS and "Neurochirurgien" at Ameli. A wrong code
   silently returns zero rows. Discover codes with `lister_nomenclature` first.

## Tool map (37 tools)

Format: **tool** — when to call it · key arguments · trap.

### Territory and geocoding

- **autocomplete_commune** — find a commune from a name or postcode · `nom` | `codePostal` | `code` · ambiguous names ("Saint-Martin"): keep `boostPopulation` and confirm with the user.
- **get_commune_by_code** — commune details from an INSEE code · `code` · merged communes return `found: false`.
- **geocode_adresse** — street address to coordinates · `adresse`, optional `codePostal` · if `confidence_low: true` (score < 0.5) do not use the point for a decision. Never geocode a hospital name: use `etablissement_finess_by_nom`.
- **reverse_geocode** — coordinates to nearest address · `lon`, `lat` · `null` at sea or outside France = no result, not an outage.

### Demographics (INSEE)

- **population** — population of an IRIS (9 chars), commune (5) or département (2-3) · `code` · Paris, Lyon, Marseille arrondissements are not exposed: use the parent commune or département. Mayotte is absent.
- **profil_iris** — age, socio-professional mix, families, income of a neighbourhood or catchment · exactly one of `lat`+`lon` or `code_iris`, optional `rayon_km` (≤ 10) · with a radius, `revenu_median_pondere` is a population-weighted proxy, not a true median; check `couverture` (FILOSOFI covers communes ≥ 5 000 inhabitants only).

### Companies (SIRENE / DINUM)

- **entreprises_in_radius** — companies by NAF code, around a point or in an area · either `lat`+`lon`+`radiusKm` (≤ 50) or `q`/`naf` + `codePostal`/`departement`, never both modes · set `includeDirigeants: false` for volume enumeration.
- **entreprise_by_siren** — legal unit and its sites · `siren` · read `enrichmentStatus`: the `etablissements` list may be truncated (`partial`, `failed`).
- **etablissement_by_siret** — one site, active or closed · `siret` · no coordinates returned; `actif: false` + `dateFermeture` reveal a closure.

### Health facilities (FINESS)

24 families: mco, ssr, sld, had, psychiatrie, dialyse, ambulatoire, labo,
imagerie, pharmacie, msp_cpts, ehpad, residence_autonomie,
senior_accompagnement, ssiad, aide_domicile, handicap_enfants,
handicap_adultes, addictologie, enfance_protection, pmi, hebergement_social,
prevention_sante, groupement. Only facilities **in service** are indexed.

- **etablissement_finess_by_nom** — find a facility by its name · `nom` (proper name, not acronyms: "IGR" is unknown), plus `nom_commune` | `code_insee` | `departement` · read `statut` (`unique` / `ambigu` / `aucun`). On `ambigu` with `commune_prouvee: null`, ask for the commune; never take the first candidate. On `aucun` with low `meilleure_similarite`, retry with the distinctive word ("Pompidou") plus the commune.
- **etablissements_finess_in_radius** — facilities around a point · `lon`, `lat`, `radius_km`, `familles` · `imagerie` usually returns 0 (FINESS does not list imaging practices). Sites without `coords` are invisible to radius search.
- **etablissements_finess_by_categorie** — exhaustive list by family in a département or commune · `categorie`, then one of `departement` | `code_insee` | `nom_commune` · `perimetre` and `activite_hebergee` apply.
- **etablissement_by_finess** — full record from a 9-digit FINESS number · `num_finess` · `siret_ans` is declared by ANS and not verified against SIRENE.

### Health professionals

Two registries, two scopes. **Ameli** = private-practice, contracted
professionals only. **RPPS** (Annuaire Santé ANS) = all statuses, including
salaried and hospital staff.

- **lister_nomenclature** — discover codes before filtering · `referentiel`: `ameli_specialites` | `ameli_types_ps` | `rpps_savoir_faire` · call it instead of guessing codes.
- **professionnels_in_radius** (Ameli) — contracted professionals around a point · `lon`, `lat`, `radius_km`, `specialite_codes` · Ameli `type_ps` "2" is a catch-all (nurses, physios, midwives…): filter by `specialite_codes` for one profession; `dedupe_by_ps: true` merges multi-site practitioners.
- **professionnels_par_specialite_dept** (Ameli) — same, by département · `departement`, `specialite_code` · paginate with `offset` while `truncated: true`.
- **professionnels_rpps_in_radius** (RPPS) — all professionals around a point · `center: { lat, lon }`, `radius_km`, `profession_codes`, `savoir_faire_codes`, `mode_exercice_codes` · default category is civilians; public agents and students are opt-in flags.
- **professionnels_rpps_par_dept** (RPPS) — all professionals of a département · `departement`, filters · paginate with `offset`.
- **rpps_dans_etablissement** — who works at a FINESS site · `num_finess` · coverage depends on what professionals declared; no coordinates in output.
- **rpps_search_by_name** — find a professional by name · `nom`, `prenom`, `departement` · common names score ~1.0 for every homonym: always narrow by département or first name.
- **professionnel_by_rpps** — full record from an RPPS id (11 or 12 digits) · `rpps_id` · one entry per practice site; `source` says `db` or live `ans_fhir`.

### Health centres (CNAM)

- **centres_sante_in_radius** — non-profit health centres (L.6323-1 CSP) around a point, with carte Vitale, APCV and on-site specialties · `lon`, `lat`, `radius_km`, `specialite_codes` · coordinates are the commune centroid: pivot to `etablissement_by_finess` for the exact address.
- **centres_sante_by_finess** — one health centre · `num_finess` · `found: false` for non-centre structures: use `etablissement_by_finess`.

### Density and territory aggregates

- **densite_sante** — density per 100 000 inhabitants, with optional national comparison · `cible` (`professionnels` RPPS or `etablissements` FINESS + mandatory `famille`), then one of `code_dept` | `code_insee` | `nom_commune`, `compare_national: true` · `code_dept` alone is the calculation scope; with `nom_commune` it is only a **disambiguation hint**. Paris, Lyon, Marseille at commune level raise an error: use the département (75, 69, 13).
- **panorama_sante_territoire** — one-call health overview of a commune (population, doctor / nurse / pharmacist densities vs national, FINESS counts, IRIS demand block) · `code_insee` or `nom_commune` (+ `departement` hint) · mixed granularity: densities are at commune level, FINESS counts at **département** level (`niveauEtablissements`). Not supported for Paris, Lyon, Marseille.
- **panorama_implantation_complet** — one-call site study around an address (territory, catchment demand, competing labs, upstream providers, prescribers, health centres, registry quality) · `adresse` or `point` + `code_insee`, `rayon_km` · read `couverture` per section (`ok` / `partiel:<reason>` / `indisponible:<reason>`) and fill gaps with the unit tools. Returns summaries, never raw lists.
- **enrichir_concurrents** — deep dive on up to 3 competitors (active status, team size, rebranding signal, parent group) · `finess` (array), `max` ≤ 3 · heavy (~7 K tokens per site): never loop it over 10+ sites.

### Cross-source checks (facts, no interpretation)

- **verifier_site_actif** — is a FINESS site still operating? · `num_finess` · two verdicts: `verdict_site` (the one for a territorial audit) and `verdict_groupe` (the parent company). `succession` lists closed operators at the same place: report it as a fact, not as "acquisition".
- **inspect_site** — 360° view of a FINESS site (identity, status, staff sample, history) · `num_finess`, `historique_detail: false` for a lighter payload · the staff list is a bounded sample, not a total.
- **historique_etablissement** — timeline of openings, closures, NAF and sign changes · `num_finess`.
- **reconcilier_finess_sirene** — similarity score between a FINESS record and candidate SIRETs · `num_finess` · `skipped` explains rejected candidates.
- **compare_raison_sociale_finess_vs_rpps** — name divergence between FINESS and RPPS (post-merger rebranding signal) · `num_finess`.
- **compare_adresse_cnam_vs_finess** — address divergence for a health centre · `num_finess` · `match_after_abbreviation_normalization` is the same address, not a move.
- **finess_sirene_coverage_in_radius** — ratio FINESS sites / active SIRENE sites for a NAF code in a radius · `lon`, `lat`, `naf`, optional `familles` · read `coverage_status`: `computed` is the only status with a meaningful ratio; `scope_empty_unknown_naf` and `scope_empty_familles_incompatible` mean the NAF code maps to no FINESS family.
- **data_freshness** — age of each ingested source · no argument · see "Citing" below.

### Real estate

- **dynamique_immobiliere** — growth potential around a point: building permits (Sit@del), PLU AU zones, land sales (DVF) · `lat`, `lon`, `rayon_km` · two registers: `note` (volumes, for scoring) and `info` (context, not scored). The current year (`info.permis.annee_en_cours`) is partial: never add it to totals or compare it to a full year. In Paris, Lyon, Marseille permits are city-wide (`partiel:ville_entiere_plm`).
- **cout_foncier** — median residential price per m² (P25 / P75, sales count, period) · `lat`, `lon`, `rayon_km` · residential only: for a commercial unit it is a proxy. Context for a business case, not an attractiveness score.

## Workflows

### 1. Map healthcare supply around an address

"Quelle est l'offre de soins dans un rayon de 3 km autour du 12 rue Nationale à Lille ?"
"What healthcare supply is within 3 km of 12 rue Nationale, Lille?"

1. `geocode_adresse` → point (stop if `confidence_low: true` and ask the user).
2. `etablissements_finess_in_radius` with the families of interest. Quote `count`, `perimetre.completeness_note` and `activite_hebergee` separately.
3. `lister_nomenclature` → codes, then `professionnels_rpps_in_radius` (all statuses) or `professionnels_in_radius` (contracted private practice) with `precise_only: true` for a short radius.
4. `centres_sante_in_radius` for non-profit health centres.
5. Optional: `profil_iris` with `rayon_km` for the demand side.

### 2. Verify a facility by its name

"L'Hôpital Foch est-il toujours actif, et qui y exerce ?"
"Is Hôpital Foch still active, and who works there?"

1. `etablissement_finess_by_nom` with `nom` and, if known, `nom_commune`. Act on `statut`; on `ambigu` without `commune_prouvee`, ask which one.
2. `inspect_site` on the chosen `num_finess` (or `verifier_site_actif` for the verdict only).
3. `rpps_dans_etablissement` for the full staff list if the sample was truncated.

### 3. Socio-demographic profile of a commune

"Profil socio-démographique de Villeneuve-d'Ascq et densité médicale."
"Socio-demographic profile and medical density of Villeneuve-d'Ascq."

1. `autocomplete_commune` → INSEE code (confirm homonyms).
2. `panorama_sante_territoire` for the one-call overview, or `population` + `densite_sante` (`compare_national: true`) for a precise figure.
3. `profil_iris` with `code_iris` or a point for neighbourhood detail.
4. For Paris, Lyon, Marseille, work at département level (75, 69, 13).

### 4. Lab site study (étude d'implantation)

"Étude d'implantation d'un laboratoire au 64 cours Aristide Briand, Charleville-Mézières."
"Site study for a medical lab at 64 cours Aristide Briand, Charleville-Mézières."

1. `panorama_implantation_complet` with `adresse` and `rayon_km`.
2. For each section not `ok` in `couverture`, call the matching unit tool.
3. `enrichir_concurrents` on the first three `concurrents.top` FINESS numbers.
4. `dynamique_immobiliere` and `cout_foncier` for growth and land cost, kept apart from the attractiveness score.

### 5. Has a site closed or changed hands?

"Ce labo est-il toujours exploité par la même société ?"
"Is this lab still run by the same company?"

1. `verifier_site_actif` → `verdict_site`, `verdict_groupe`, `succession`.
2. `compare_raison_sociale_finess_vs_rpps` → rebranding signal.
3. `historique_etablissement` for dated periods, `entreprise_by_siren` on the active SIREN for the parent group.

## Citing results

- **Freshness.** Before an audit, call `data_freshness`, or pass
  `include_freshness: true` to tools that accept it. Judge on
  `data_age_days` (age of the last run that actually changed the data), never
  on `staleness_days` alone: in 2026 the FINESS source dried up for four
  months while `staleness_days` stayed low. Alert when
  `data_age_days > expected_max_age_days`. Live sources (DINUM, SIRENE, ANS
  FHIR) are not listed: they are real time.
- **Scope.** Always say which registry and which lens a figure comes from:
  "47 labs (FINESS, dominant category; hospital lab platforms not counted)".
  Ameli figures cover contracted private practice only; RPPS covers all
  statuses. Say "per 100 000 inhabitants, INSEE municipal population".
- **Granularity.** Say whether a figure is at IRIS, commune or département
  level, and whether distances are exact or commune-centroid.
- **Mandatory source mentions** (licences of the data, not of the code):

| Source | Mention |
|---|---|
| FINESS | « Source : FINESS, ANS/DREES » |
| Annuaire santé Ameli / CNAM | « Source : Annuaire santé Ameli, Assurance Maladie » (art. L.1461-2 CSP, give the sync date) |
| RPPS | « Source : Annuaire Santé, Agence du Numérique en Santé (ANS) » |
| INSEE (population, IRIS, SIRENE) | « Source : Insee » |
| DINUM | « Source : Annuaire des Entreprises, DINUM » |
| IGN / apicarto | « © IGN/Géoplateforme », « GPU — apicarto IGN » |
| geo.api.gouv.fr | « Source : geo.api.gouv.fr (Etalab) » |
| DVF | « Source : DVF, DGFiP / Etalab » |
| Sit@del | « Source : Sit@del, SDES (API DiDo) » |

## Limits — what the server does not do

- **No unified practitioner record across RPPS and Ameli.** Ameli does not
  expose the RPPS id, and name matching was measured below acceptable
  uniqueness in dense areas. Query both registries and present them side by
  side, without merging people.
- **No business verdicts.** No "medical desert" label, no go / no-go, no
  acquirer identification. `succession` and name divergences are raw facts.
- **No commune-level density for Paris, Lyon, Marseille.** INSEE publishes
  population for the whole city, registries attach professionals to
  arrondissements. Use the département.
- **No closed facilities in FINESS lookups.** Only in-service facilities are
  indexed; a closed site returns `found: false`. Use SIRENE tools for closures.
- **No imaging practices** in FINESS (`imagerie` is usually empty), no emails,
  no opening hours, fees or sector 1/2 for health centres.
- **No road distances.** `distance_km` is straight-line.
- **No commercial property prices.** `cout_foncier` is residential DVF only.
- **No real-time FINESS / RPPS / Ameli.** They are ingested snapshots
  (FINESS twice a month, Ameli weekly, RPPS monthly); check freshness.
- **Mayotte** is absent from INSEE Melodi population; IRIS demand data does
  not cover overseas départements in `panorama_sante_territoire`.

## Links

- Repository and README: https://github.com/cturkieh/france-data-mcp
- Changelog: https://github.com/cturkieh/france-data-mcp/blob/main/CHANGELOG.md
- npm: https://www.npmjs.com/package/france-data-mcp
- Privacy: https://github.com/cturkieh/france-data-mcp/blob/main/PRIVACY.md
