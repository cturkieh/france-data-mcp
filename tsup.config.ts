import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "territoire/index": "src/territoire/index.ts",
    "sante/index": "src/sante/index.ts",
    cli: "bin/cli.ts",
  },
  format: ["esm"],
  // Pas de .d.ts pour le CLI (pas d'API publique consommée par les types).
  dts: { entry: ["src/index.ts", "src/territoire/index.ts", "src/sante/index.ts"] },
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  target: "node22",
  // tsup détecte le shebang `#!/usr/bin/env node` en tête de bin/cli.ts et
  // chmod +x le fichier de sortie automatiquement.
});
