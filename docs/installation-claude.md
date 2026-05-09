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
cd server
vercel --prod
```

Tu obtiens alors une URL `https://<ton-projet>.vercel.app/mcp` que tu peux brancher à n'importe quel client MCP.

---

## Outils exposés (13 — V0.4.6)

**🗺️ Territoire** : `autocomplete_commune`, `get_commune_by_code`, `geocode_adresse`, `reverse_geocode`

**🏢 Entreprises** : `entreprises_in_radius`, `entreprise_by_siren`

**🏥 Établissements FINESS** : `etablissements_finess_in_radius`, `etablissements_finess_by_categorie`, `etablissement_by_finess`

**👨‍⚕️ Professionnels Ameli** : `professionnels_in_radius`, `professionnels_par_specialite_dept`, `lister_specialites_ameli`, `lister_types_ps_ameli`

Voir le [README](../README.md#outils-mcp-exposés-13-tools--v046) pour la description détaillée de chaque tool.
