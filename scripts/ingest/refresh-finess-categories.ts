import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIfMain } from "./shared.js";

/**
 * Régénère `src/sante/finess-categories-labels.ts` depuis le serveur
 * multi-terminologies (SMT) de l'ANS — nomenclature officielle TRE_R397 des
 * catégories d'entité géographique d'exercice, référencée par le
 * `coding.system` du schéma FINESS nouvelle génération. SOURCE UNIQUE des
 * libellés : l'ingestion (`categorie_libelle` en base) ET la lib publiée
 * (`FINESS_CATEGORIES`, `libelleCategorieFiness`) en dérivent.
 *
 * Pourquoi figer le fichier dans le repo plutôt qu'appeler le SMT au run :
 * l'ingestion doit rester déterministe et hors-ligne. Une indisponibilité du
 * SMT ne doit jamais faire tomber le cron FINESS ni produire un swap avec des
 * `categorie_libelle` NULL en masse. Module TS (pas JSON) : aucune dépendance
 * au support des import attributes chez tsup/Vercel/npm.
 *
 * REPRODUCTIBLE PAR CONSTRUCTION (revue 2026-09-06) : `renderLabelsModule` est
 * la seule façon d'écrire le fichier, l'ordre est celui du SMT (jamais de tri
 * dépendant d'ICU), l'indentation est celle de Biome, et le test
 * `refresh-finess-categories.test.ts` impose que le fichier committé soit
 * byte-identique au rendu de son propre contenu — sinon la revue d'un vrai
 * changement de nomenclature se noierait dans un diff de reformatage.
 *
 * Usage : pnpm finess:refresh-categories
 */

export const SMT_URL =
  "https://smt.esante.gouv.fr/fhir/CodeSystem/tre-r397-categorie-entite-geographique-exercice";

/** Chemin du module généré (relatif à ce script). */
export const LABELS_MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/sante/finess-categories-labels.ts",
);

/** Plancher absolu de concepts RETENUS (≈ 428 réels) : en dessous, réponse SMT suspecte. */
export const MIN_LABELS = 300;
/** Une régénération ne peut pas perdre plus de 5 % des libellés actuels (SMT partiel). */
export const MIN_KEEP_RATIO = 0.95;

const COUNT_MARKER = "@generated-count";

/**
 * Rend le module TS. Marqueur `// @generated-count N` en tête : c'est ce que
 * le garde anti-rétrécissement relit — un commentaire, insensible au formateur,
 * là où une regex sur l'indentation des entrées comptait 0 ligne après
 * passage de Biome (garde morte, prouvé en revue).
 */
export function renderLabelsModule(
  labels: Readonly<Record<string, string>>,
  refreshedAt: string,
): string {
  const entries = Object.entries(labels)
    .map(([code, label]) => `  ${JSON.stringify(code)}: ${JSON.stringify(label)},`)
    .join("\n");
  return [
    "// GÉNÉRÉ par `scripts/ingest/refresh-finess-categories.ts` — NE PAS ÉDITER À LA MAIN.",
    "// Nomenclature officielle TRE_R397 « catégorie d'entité géographique d'exercice »",
    "// (serveur multi-terminologies ANS), figée dans le repo : l'ingestion FINESS et la",
    "// lib publiée doivent rester déterministes et hors-ligne. Ordre = réponse SMT.",
    `// ${COUNT_MARKER} ${Object.keys(labels).length}`,
    `// source ${SMT_URL}`,
    "",
    "/** Date de la dernière régénération — exposée à l'ingestion (âge de la nomenclature). */",
    `export const FINESS_CATEGORIE_LABELS_REFRESHED_AT = ${JSON.stringify(refreshedAt)};`,
    "",
    `/** code TRE_R397 → libellé officiel (${Object.keys(labels).length} concepts au ${refreshedAt.slice(0, 10)}). */`,
    "export const SMT_CATEGORIE_LABELS = {",
    entries,
    "} as const satisfies Record<string, string>;",
    "",
  ].join("\n");
}

/** Compte déclaré par le marqueur du fichier actuel ; `null` si absent (garde inopérante → crier). */
export function readGeneratedCount(moduleSource: string): number | null {
  const m = moduleSource.match(new RegExp(`^// ${COUNT_MARKER} (\\d+)$`, "m"));
  return m ? Number(m[1]) : null;
}

/** Extrait les libellés du module généré (pour le test de reproductibilité). */
export function parseLabelsModule(moduleSource: string): {
  labels: Record<string, string>;
  refreshedAt: string;
} {
  const refreshedAt = moduleSource.match(
    /^export const FINESS_CATEGORIE_LABELS_REFRESHED_AT = "([^"]+)";$/m,
  )?.[1];
  if (!refreshedAt) throw new Error("FINESS_CATEGORIE_LABELS_REFRESHED_AT introuvable");
  const start = moduleSource.indexOf("export const SMT_CATEGORIE_LABELS = {");
  const end = moduleSource.indexOf("} as const satisfies Record<string, string>;", start);
  if (start < 0 || end < 0) throw new Error("bloc SMT_CATEGORIE_LABELS introuvable");
  const labels: Record<string, string> = {};
  for (const line of moduleSource.slice(start, end).split("\n")) {
    const m = line.match(/^ {2}("[^"]+"): (".*"),$/);
    if (m) labels[JSON.parse(m[1] ?? '""') as string] = JSON.parse(m[2] ?? '""') as string;
  }
  return { labels, refreshedAt };
}

/**
 * Décision d'écriture, PURE : `null` = OK, sinon la raison du refus. Le
 * plancher porte sur ce qu'on RETIENT (code + display présents), pas sur le
 * tableau brut — un renommage `display` → `designation` côté ANS donnerait
 * 428 concepts reçus et 0 libellé, le plancher brut passerait.
 */
export function refuseReason(next: number, currentSource: string | null): string | null {
  if (next < MIN_LABELS) {
    return `seulement ${next} libellés retenus (< ${MIN_LABELS} attendus) — réponse SMT suspecte, abandon`;
  }
  if (currentSource === null) return null; // premier rendu : pas de référence
  const current = readGeneratedCount(currentSource);
  if (current === null) {
    return `impossible de lire le compte du fichier actuel (marqueur ${COUNT_MARKER} absent) — garde de non-régression INOPÉRANTE, fichier NON écrasé ; régénérer à la main après vérification`;
  }
  if (next < current * MIN_KEEP_RATIO) {
    return `${next} libellés reçus < ${Math.round(MIN_KEEP_RATIO * 100)} % des ${current} actuels — SMT partiel ? Fichier NON écrasé`;
  }
  return null;
}

async function main(): Promise<void> {
  const res = await fetch(SMT_URL, { headers: { Accept: "application/fhir+json" } });
  if (!res.ok) {
    console.error(`[finess-categories] SMT HTTP ${res.status} — nomenclature NON régénérée`);
    process.exit(1);
  }
  const body = (await res.json()) as { concept?: unknown };
  const concepts = Array.isArray(body.concept) ? (body.concept as unknown[]) : [];
  const labels: Record<string, string> = {};
  for (const c of concepts) {
    const { code, display } = (c ?? {}) as { code?: unknown; display?: unknown };
    if (typeof code === "string" && typeof display === "string") labels[code] = display;
  }
  const currentSource = existsSync(LABELS_MODULE_PATH)
    ? readFileSync(LABELS_MODULE_PATH, "utf8")
    : null;
  const refusal = refuseReason(Object.keys(labels).length, currentSource);
  if (refusal !== null) {
    console.error(`[finess-categories] ${refusal}`);
    process.exit(1);
  }
  writeFileSync(LABELS_MODULE_PATH, renderLabelsModule(labels, new Date().toISOString()));
  console.log(
    `[finess-categories] ${Object.keys(labels).length} libellés écrits dans ${LABELS_MODULE_PATH}`,
  );
}

await runIfMain(import.meta.url, main);
