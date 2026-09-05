---
name: release-process
description: "Checklist de release maintainer : bump 3 sources, server.json ≤ 100 caractères, CHANGELOG, tag, CI, npm OTP, mcp-publisher, Release GitHub auto, vérification registry MCP paginée, Glama sync/build/release. À charger pour pnpm release ou toute publication."
---

# Release process (maintainer-only)

> Déplacé verbatim depuis `CLAUDE.md` le 2026-09-06 (budget). Source de vérité pour ce périmètre ; `CLAUDE.md` ne garde que les règles de tête.

**Maintainer-only** (npm publish OTP 2FA + mcp-publisher GitHub OAuth sur namespace `io.github.cturkieh/...`).

Séquence (voir `scripts/release.sh` qui automatise) :

1. ☐ `pnpm typecheck && pnpm lint && pnpm test:unit` verts
2. ☐ Bump version sur 3 sources : `package.json`, `server.json`, `src/core/version.ts`
   - ⚠️ **`server.json.description` ≤ 100 caractères (limite DURE du schéma registry MCP)** — `mcp-publisher publish` rejette en `422 expected length <= 100` sinon (prouvé V0.23.2 : une description enrichie ~230 car. publiait OK sur npm — pas de limite — mais bloquait le registry). npm/README portent le détail long ; `server.json` reste un pitch court. Vérifier : `jq -r '.description|length' server.json` + `mcp-publisher validate` (read-only, hit le schéma registry) AVANT le commit de release.
3. ☐ Éditer `CHANGELOG.md` (nouvelle section en haut)
4. ☐ `git commit + git tag -a vX.Y.Z + git push + git push origin vX.Y.Z`
5. ☐ Attendre CI vert (`gh run watch --exit-status`)
6. ☐ `pnpm build && pnpm publish --no-git-checks` (entrer OTP 2FA)
7. ☐ `mcp-publisher login github` (device code) → `mcp-publisher publish`
8. ☐ GitHub Release : **auto-créée par `release.yml` sur le push du tag** (étape 4) avec les notes du CHANGELOG. NE PAS lancer `gh release create` (422 `tag_name already exists`). Vérifier : `gh release view vX.Y.Z`
9. ☐ Vérifier : `npm view france-data-mcp version`, `/healthz`, et registry MCP.
   - ⚠️ **Le `search` registry PAGINE par 30 et n'est PAS trié globalement (updatedAt/semver) — la version qu'on vient de publier peut tomber PAGE 2** (faux négatif prouvé V0.26.1 2026-06-06 : `sort_by(updatedAt).last` sur la page 1 renvoyait 0.26.0 alors que 0.26.1 était active page 2). NE PAS se fier à une requête mono-page. Vérifier en **paginant via `metadata.nextCursor`** (camelCase, PAS `next_cursor`) ET en cherchant la version cible explicitement :
     ```bash
     V=0.26.1; base='https://registry.modelcontextprotocol.io/v0/servers?search=france-data-mcp'; cur=''
     while :; do url="$base"; [ -n "$cur" ] && url="$base&cursor=$(printf %s "$cur"|jq -sRr @uri)"
       r=$(curl -s "$url"); echo "$r" | jq -e --arg v "$V" '.servers[]|select(.server.name=="io.github.cturkieh/france-data-mcp" and .server.version==$v)' >/dev/null && { echo "✅ $V registry"; break; }
       cur=$(echo "$r" | jq -r '.metadata.nextCursor // empty'); [ -z "$cur" ] && { echo "❌ $V absente"; break; }; done
     ```
   - `mcp-publisher publish` qui renvoie `400 cannot publish duplicate version` = la version EST DÉJÀ publiée (garde d'idempotence, succès déguisé), PAS un échec — re-vérifier via la pagination ci-dessus avant de re-tenter.
10. ☐ **Glama** (annuaire MCP tiers, fiche publique [glama.ai/mcp/servers/cturkieh/france-data-mcp](https://glama.ai/mcp/servers/cturkieh/france-data-mcp)) — **3 étapes distinctes, la release est MANUELLE** : Glama sépare **sync** (récupère le dernier commit GitHub) → **build** (auto, depuis un commit ÉPINGLÉ, ne suit PAS les tags ; email « Build succeeded ») → **« Create a release »** (manuelle — sans elle la fiche reste gelée MÊME build OK). Après chaque version : admin → onglet **Repository → Sync** → attendre le build vert → **Create a release**. Le sync auto quotidien **peut se figer silencieusement** (vécu 2026-06 : bloqué depuis 2026-06-04, fiche restée à 0.23.1 alors que npm/registry = 0.26.1) → sync jammé > 15-20 min = **Discord Glama #support** (leur worker, PAS le repo ; icône Discord nav glama.ai — ce n'est PAS le serveur « Model Context Protocol » officiel). `glama.json` (racine, `maintainers`) lève l'item du score + aide le re-pickup. Détail : mémoire `glama-listing-update-mechanism`.

