# Installer le MCP `france-data-mcp` dans Claude

Ce guide explique comment ajouter le serveur MCP `france-data-mcp` à différents clients Claude.

> ⚠️ Le serveur public hébergé n'est pas encore déployé. Cette documentation est anticipée. Section _self-hosting_ disponible dès maintenant.

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
   - **Remote MCP server URL** : `https://france-data-mcp.vercel.app/mcp` _(à venir — ou ton URL self-hostée)_
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
cd server
vercel --prod
```

Tu obtiens alors une URL `https://<ton-projet>.vercel.app/mcp` que tu peux brancher à n'importe quel client MCP.

---

## Outils exposés (à venir)

- `autocomplete_commune(query, limit)` — recherche de communes
- `geocode_adresse(adresse)` — coordonnées GPS d'une adresse
- `professionnels_in_radius(center, radiusKm, specialite?)` — professionnels de santé dans un rayon
- `etablissements_finess_in_radius(center, radiusKm, categorie?)` — établissements de santé dans un rayon
- `entreprises_naf_in_radius(naf, center, radiusKm)` — entreprises d'un code NAF dans un rayon
- `population_iris(communeOrPoint)` — données démographiques IRIS

Détails dans [docs/sante.md](sante.md) et [docs/territoire.md](territoire.md).
