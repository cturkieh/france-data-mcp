import { configDefaults, defineConfig } from "vitest/config";

// Les worktrees d'agents (`.claude/worktrees/<agent>/`) sont des clones
// complets du dépôt : sans cette exclusion, vitest y ramasse une seconde
// copie de chaque test (et fait échouer la suite locale sur un chantier en
// cours dans un autre worktree). `configDefaults.exclude` garde node_modules,
// dist, etc. Les scripts `test*` de package.json restent la source des
// options de parallélisme et du filtre intégration.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
