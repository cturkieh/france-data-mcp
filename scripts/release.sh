#!/usr/bin/env bash
#
# Release semi-automatique france-data-mcp.
#
# Usage : ./scripts/release.sh 0.9.4
#
# Le script enchaîne tout ce qui peut être automatisé et te rend la main
# uniquement pour : édition CHANGELOG, npm publish (OTP 2FA interactif),
# mcp-publisher login (device code GitHub OAuth). Voir CLAUDE.md section
# "Release process" pour le détail.

set -euo pipefail

# Couleurs pour les prompts (ASCII-only, GitHub Actions / logs CI friendly)
readonly STEP="[STEP]"
readonly OK="[OK]"
readonly WAIT="[WAIT]"
readonly FAIL="[FAIL]"

usage() {
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.9.4"
  exit 2
}

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  usage
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "$FAIL Version doit matcher X.Y.Z (semver), reçu: $VERSION"
  exit 2
fi

cd "$(dirname "$0")/.."

# 1. Working tree clean
echo "$STEP 1/9 — Working tree clean ?"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "$FAIL Working tree non-clean. Commit ou stash d'abord."
  git status --short
  exit 1
fi
echo "$OK"

# 2. Branche main + sync remote
echo "$STEP 2/9 — Branche main sync avec origin"
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "$FAIL Pas sur main (actuel: $CURRENT_BRANCH)"
  exit 1
fi
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "$FAIL Local main diverge de origin/main. Pull/push d'abord."
  exit 1
fi
echo "$OK"

# 3. Typecheck + lint + tests
echo "$STEP 3/9 — pnpm typecheck && pnpm lint && pnpm test:unit"
pnpm typecheck
pnpm lint
pnpm test:unit
echo "$OK"

# 4. Bump version sur les 3 sources
echo "$STEP 4/9 — Bump version → $VERSION sur 3 sources"
PREV_VERSION=$(node -p "require('./package.json').version")
echo "       previous: $PREV_VERSION"
npm pkg set version="$VERSION"
# sed -i '' pour macOS BSD (POSIX strict). Sur Linux/CI, sed -i sans backup.
SED_INPLACE=(-i "")
if sed --version 2>/dev/null | grep -q GNU; then
  SED_INPLACE=(-i)
fi
sed "${SED_INPLACE[@]}" "s/\"version\": \"$PREV_VERSION\"/\"version\": \"$VERSION\"/g" server.json
sed "${SED_INPLACE[@]}" "s/VERSION = \"$PREV_VERSION\"/VERSION = \"$VERSION\"/" src/core/version.ts
echo "$OK package.json + server.json + src/core/version.ts → $VERSION"

# 5. Éditer CHANGELOG (interactif)
echo "$STEP 5/9 — Édite CHANGELOG.md avec la nouvelle section ## [$VERSION]"
echo "$WAIT Ouvre CHANGELOG.md, ajoute la section en haut, puis appuie sur ENTER pour continuer..."
read -r _
if ! grep -q "## \[$VERSION\]" CHANGELOG.md; then
  echo "$FAIL CHANGELOG.md ne contient pas de section ## [$VERSION]. Annulé."
  exit 1
fi
echo "$OK CHANGELOG section [$VERSION] détectée"

# 6. Commit + tag + push
echo "$STEP 6/9 — Commit + tag v$VERSION + push"
git add package.json server.json src/core/version.ts CHANGELOG.md
echo "$WAIT Tape ton message de commit (ENTER pour défaut 'feat(v$VERSION): release')..."
read -r COMMIT_MSG
if [[ -z "$COMMIT_MSG" ]]; then
  COMMIT_MSG="feat(v$VERSION): release"
fi
git commit -m "$COMMIT_MSG"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main
git push origin "v$VERSION"
echo "$OK"

# 7. Attendre CI vert
echo "$STEP 7/9 — Attendre CI GitHub Actions vert"
echo "$WAIT gh run watch (~3 min)..."
sleep 5  # laisse GitHub enregistrer le push
gh run watch --exit-status --compact
echo "$OK"

# 8. Build + interactif npm publish + mcp-publisher
echo "$STEP 8/9 — Build + publish"
pnpm build
echo ""
echo "$WAIT npm publish (OTP 2FA prompt interactif) :"
echo "       Tape dans ton terminal : pnpm publish --no-git-checks"
echo "       Puis appuie sur ENTER ici une fois fait..."
read -r _

echo ""
echo "$WAIT mcp-publisher (GitHub device code) :"
echo "       1. mcp-publisher validate"
echo "       2. mcp-publisher login github  (valide le code sur github.com/login/device)"
echo "       3. mcp-publisher publish"
echo "       Puis appuie sur ENTER ici une fois fait..."
read -r _
echo "$OK"

# 9. GitHub Release avec notes du CHANGELOG
echo "$STEP 9/9 — GitHub Release v$VERSION"
RELEASE_NOTES=$(awk "/^## \[$VERSION\]/,/^## \[/{ if(/^## \[/ && !/^## \[$VERSION\]/) exit; print }" CHANGELOG.md | sed '$d')
if [[ -z "$RELEASE_NOTES" ]]; then
  echo "$FAIL Impossible d'extraire les notes du CHANGELOG. Crée la release manuellement."
  exit 1
fi
gh release create "v$VERSION" --title "v$VERSION" --notes "$RELEASE_NOTES"
echo "$OK Release créée : https://github.com/cturkieh/france-data-mcp/releases/tag/v$VERSION"

echo ""
echo "$OK Release v$VERSION terminée. Vérifications finales :"
echo "   - npm view france-data-mcp version"
echo "   - curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=france-data-mcp' | jq '.servers[0].server.version'"
echo "   - curl -s https://france-data-mcp.vercel.app/healthz | jq .version"
