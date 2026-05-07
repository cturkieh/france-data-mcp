# france-data-mcp — serveur MCP HTTP

Endpoint HTTP qui expose les données publiques françaises via le protocole MCP (Model Context Protocol).

## Outils exposés (V0)

| Outil | Description | Source |
|-------|-------------|--------|
| `autocomplete_commune` | Recherche de communes par nom / CP / code INSEE | geo.api.gouv.fr |
| `get_commune_by_code` | Détail d'une commune par code INSEE | geo.api.gouv.fr |
| `geocode_adresse` | Adresse → coordonnées GPS | IGN Géoplateforme |
| `reverse_geocode` | Coordonnées GPS → adresse | IGN Géoplateforme |
| `entreprises_in_radius` | Entreprises par NAF + zone géo (avec CA, dirigeants…) | DINUM Recherche Entreprises |
| `entreprise_by_siren` | Détail d'une entreprise par SIREN | DINUM Recherche Entreprises |

> ⚠️ Les wrappers FINESS et Annuaire Santé Ameli sont disponibles dans la **lib npm** mais pas dans cette V0 du serveur, car ils requièrent un cache local volumineux (~35 Mo et ~146 Mo) incompatible avec Vercel serverless. Pour les utiliser : `npm install france-data-mcp` et appeler les fonctions en Node.js, ou monter sa propre instance avec stockage persistant.

## Déployer sur Vercel

```bash
cd server
pnpm install
vercel link        # attache le dossier à un projet Vercel
vercel --prod      # déploie en production
```

L'URL renvoyée (`https://<ton-projet>.vercel.app/mcp`) est prête à être collée dans claude.ai → Settings → Connectors.

## Tester en local

```bash
pnpm dev    # vercel dev sur http://localhost:3000
# Dans un autre terminal :
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Architecture

C'est une fonction serverless Vercel qui répond aux messages JSON-RPC 2.0 du protocole MCP. Pas de SSE, pas de session stateful : chaque requête HTTP est traitée indépendamment, ce qui permet de scaler horizontalement à coût quasi nul sur le free tier Vercel.

Méthodes MCP supportées : `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`.
