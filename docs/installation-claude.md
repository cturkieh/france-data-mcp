# Installer le MCP `france-data-mcp` dans Claude

Ce guide explique comment ajouter le serveur MCP `france-data-mcp` à différents clients Claude.

> ✅ Le serveur public est déployé et opérationnel sur `https://france-data-mcp.vercel.app/mcp`. Tu peux le brancher directement, ou héberger ton propre fork (section _self-hosting_ en bas de page).

---

## Pour claude.ai (web et desktop)

### Prérequis

- Un abonnement Claude Pro, Max, Team ou Enterprise (les Custom Connectors ne sont pas disponibles sur le plan gratuit).

### Étapes

1. Va sur [claude.ai](https://claude.ai) → ton avatar → **Settings**
2. Onglet **Connectors**
3. Bouton **Add custom connector**
4. Renseigne :
   - **Name** : `France Data` (ou ce que tu veux)
   - **Remote MCP server URL** : `https://france-data-mcp.vercel.app/mcp` (ou ton URL self-hostée)
   - **Authentication** : laisse "None"
5. Clique **Save**.
6. Dans une conversation, active le connecteur via l'icône **Connectors** sous le composer.

Tu peux maintenant poser des questions du type :

> *« Trouve-moi tous les médecins généralistes dans un rayon de 5 km autour du 64 Cours Aristide Briand à Charleville-Mézières, avec leur secteur conventionnel. »*

---

## Pour Claude Code (CLI)

Ajoute dans `~/.claude.json` sous `mcpServers` :

```json
{
  "mcpServers": {
    "france-data": {
      "type": "http",
      "url": "https://france-data-mcp.vercel.app/mcp"
    }
  }
}
```

Puis relance Claude Code.

---

## Pour Cursor

Dans `~/.cursor/mcp.json` :

```json
{
  "mcpServers": {
    "france-data": {
      "type": "http",
      "url": "https://france-data-mcp.vercel.app/mcp"
    }
  }
}
```

---

## Self-hosting

Si tu préfères héberger ton propre serveur MCP (gratuit sur Vercel free tier) :

```bash
git clone https://github.com/cturkieh/france-data-mcp.git
cd france-data-mcp
pnpm install
pnpm build
vercel --prod
```

Tu obtiens alors une URL `https://<ton-projet>.vercel.app/mcp` que tu peux brancher à n'importe quel client MCP.

### Variables d'environnement à configurer (Vercel dashboard ou CLI `vercel env add`)

**Obligatoires** (pour que les tools FINESS / Ameli / RPPS fonctionnent) :

| Variable | Source |
|---|---|
| `SUPABASE_URL` | Projet Supabase contenant les tables ingérées |
| `SUPABASE_ANON_KEY` | idem |
| `SUPABASE_SERVICE_ROLE_KEY` | idem (pour les ingestions cron) |

**Optionnelles mais fortement recommandées pour un endpoint public** :

| Variable | Effet |
|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Rate limit distribué entre instances serverless. Sans, fallback in-memory qui ne protège qu'une instance chaude isolée. Base gratuite sur [console.upstash.com/redis](https://console.upstash.com/redis), région Frankfurt eu-west-1. |
| `RATE_LIMIT_PER_MINUTE` | Plafond par IP (default `60`). |
| `RATE_LIMIT_ENABLED` | `false` désactive (dev local uniquement). |
| `INSEE_SIRENE_API_KEY` | Fallback authentifié `entreprise_by_siren` quand DINUM ne connaît pas un SIREN (cas diffusion partielle INSEE). Inscription gratuite sur [portail-api.insee.fr](https://portail-api.insee.fr). |
| `ANS_FHIR_API_KEY` | Fallback live FHIR `professionnel_by_rpps` quand le RPPS n'est pas en base locale. Inscription gratuite sur [portal.api.esante.gouv.fr](https://portal.api.esante.gouv.fr). |

Pour l'ingestion des CSV source (FINESS bimestriel ~95 K rows, Ameli hebdo ~462 K rows, RPPS mensuel ~2,2 M rows + 800 Mo de CSV), voir [docs/ingestion.md](ingestion.md).

---

## Outils exposés (31 — V0.9.0)

**🗺️ Territoire** : `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`

**🏢 Entreprises** : `entreprises_in_radius`, `entreprise_by_siren`, `etablissement_by_siret`

**🏥 Établissements FINESS** : `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`

**👨‍⚕️ Professionnels Ameli (libéraux conventionnés)** : `professionnels_in_radius`, `professionnels_par_specialite_dept`, `lister_specialites_ameli`, `lister_types_ps_ameli`

**🩺 Tous les PS — RPPS / Annuaire Santé ANS** : `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`, `rpps_dans_etablissement`, `rpps_search_by_name`, `professionnel_by_rpps`

**📊 Démographie & densités — INSEE Melodi (V0.8 + V0.9)** : `population_par_commune`, `population_par_departement`, `densite_professionnels_sante` (département OU commune), `densite_etablissements_sante`, `lister_specialites_medicales`

**🧭 Agrégateur santé territoire (V0.9)** : `panorama_sante_territoire`

**🔀 Croisement multi-source** : `data_freshness`, `verifier_site_actif`, `compare_raison_sociale_finess_vs_rpps`, `historique_etablissement`, `reconcilier_finess_sirene`, `finess_sirene_coverage_in_radius`

Voir le [README](../README.md#outils-mcp-31-tools) pour la description détaillée de chaque tool.

---

## Limites & garde-fous publics (V0.5.7)

L'endpoint public applique un **rate limit de 60 requêtes par minute par IP** sur les appels `tools/call` (le handshake `initialize` / `tools/list` / `ping` reste libre). En dépassement, le serveur retourne une erreur JSON-RPC code `-32000` avec `data.retryAfterSeconds` indiquant quand réessayer.

Pour un usage intensif (script de prospection batchant des centaines de communes, par ex.), il y a 3 options :

1. **Throttler côté client** — respecter `retryAfterSeconds` et étaler les appels (recommandé).
2. **Self-host avec ton propre rate limit** (voir section _Self-hosting_ ci-dessous, env vars `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_ENABLED`).
3. **Ouvrir une issue** si tu as un cas d'usage civic-tech / recherche qui mérite un quota dédié.

Toutes les requêtes sont loggées en JSON structuré (`ts`, `method`, `tool`, `ip_hash` SHA-256, `user_agent`, `duration_ms`, `status`, `outcome`). Aucun argument tool n'est persisté ; les IPs sont hashées avant log/stockage Redis (RGPD-friendly).
