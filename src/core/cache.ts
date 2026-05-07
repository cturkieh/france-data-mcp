/**
 * Cache fichier local pour les dumps publics téléchargés (FINESS, Annuaire Ameli, INSEE…).
 *
 * Stratégie : un fichier de cache par dataset, refresh si plus vieux que `ttlMs`.
 * Pas de coordination multi-process — si deux processus tentent de refresh en
 * parallèle, le second écrase le premier (acceptable pour des dumps de référence
 * publics).
 *
 * Localisation par défaut : `~/.cache/france-data-mcp/` (suit XDG-ish sur macOS/Linux).
 */

import { existsSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CacheOptions = {
  /** Dossier où stocker les caches (défaut : ~/.cache/france-data-mcp) */
  cacheDir?: string;
  /** Durée de vie en millisecondes avant refresh */
  ttlMs?: number;
  /** Forcer le refresh même si le cache est encore valide */
  force?: boolean;
  /** User-Agent à envoyer pour le téléchargement */
  userAgent?: string;
  signal?: AbortSignal;
};

export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "france-data-mcp");

/**
 * Télécharge un fichier depuis une URL et le stocke en cache local.
 * Si le cache existe et a moins de `ttlMs`, on retourne le chemin sans re-télécharger.
 *
 * Renvoie le chemin local du fichier prêt à l'emploi.
 */
export async function downloadWithCache(
  url: string,
  cacheFileName: string,
  options: CacheOptions = {},
): Promise<string> {
  const {
    cacheDir = DEFAULT_CACHE_DIR,
    ttlMs = 7 * 24 * 60 * 60 * 1000,
    force = false,
    userAgent = "france-data-mcp/0.1.0 (+https://github.com/cturkieh/france-data-mcp)",
    signal,
  } = options;

  const cachePath = join(cacheDir, cacheFileName);

  if (!force && (await isCacheFresh(cachePath, ttlMs))) {
    return cachePath;
  }

  await mkdir(dirname(cachePath), { recursive: true });

  const response = await fetch(url, {
    headers: { "User-Agent": userAgent },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  // Écriture atomique : on écrit dans un fichier .tmp, puis on `rename` qui est
  // atomique au niveau du FS. Si le download échoue ou que l'écriture est
  // interrompue, on n'a jamais un cachePath corrompu.
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, cachePath);
    return cachePath;
  } catch (err) {
    console.error(
      `[france-data-mcp] cache write failed for ${url} → ${cachePath}: ${(err as Error).message}`,
    );
    await unlink(tmpPath).catch((unlinkErr: unknown) => {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `[france-data-mcp] failed to clean up temp cache file ${tmpPath} (${code ?? "unknown"}): ${(unlinkErr as Error).message}`,
        );
      }
    });
    throw err;
  }
}

async function isCacheFresh(filePath: string, ttlMs: number): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const stats = await stat(filePath);
    const ageMs = Date.now() - stats.mtimeMs;
    return ageMs < ttlMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = race entre existsSync et stat, OK on retélécharge
    if (code === "ENOENT") return false;
    // EACCES, EROFS, ENOSPC = problème système réel, on doit le savoir
    console.error(
      `[france-data-mcp] cache stat failed unexpectedly for ${filePath} (${code ?? "unknown"}): ${(err as Error).message}`,
    );
    throw err;
  }
}
