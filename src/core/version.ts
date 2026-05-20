/**
 * Version courante du serveur MCP + wrapper npm. Source de vérité partagée :
 *  - `api/mcp.ts` → expose via `initialize.serverInfo.version` au client MCP
 *  - `bin/cli.ts` → expose dans le User-Agent HTTP + le banner stderr
 *
 * Synchronisée manuellement avec `package.json.version` à chaque release.
 * Une déclaration en TS pur évite la friction des import attributes JSON
 * (instables entre tsup/esbuild/@vercel/node).
 */
export const VERSION = "0.12.0";
