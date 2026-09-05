#!/usr/bin/env node
/**
 * Régénère `finess-categories-labels.json` depuis le serveur multi-terminologies
 * (SMT) de l'ANS — nomenclature officielle des catégories d'entité géographique
 * d'exercice, référencée par le `coding.system` du schéma FINESS nouvelle
 * génération.
 *
 * Pourquoi figer le fichier dans le repo plutôt qu'appeler le SMT au run :
 * l'ingestion doit rester déterministe et hors-ligne. Une indisponibilité du
 * SMT ne doit jamais faire tomber le cron FINESS ni, pire, produire un swap
 * avec des `categorie_libelle` NULL en masse.
 *
 * Usage : node scripts/ingest/refresh-finess-categories.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SMT_URL =
  "https://smt.esante.gouv.fr/fhir/CodeSystem/tre-r397-categorie-entite-geographique-exercice";

const res = await fetch(SMT_URL, { headers: { Accept: "application/fhir+json" } });
if (!res.ok) {
  console.error(`[finess-categories] SMT HTTP ${res.status} — nomenclature NON régénérée`);
  process.exit(1);
}
const body = await res.json();
const concepts = Array.isArray(body.concept) ? body.concept : [];
if (concepts.length < 300) {
  console.error(
    `[finess-categories] seulement ${concepts.length} concepts (< 300 attendus) — réponse SMT suspecte, abandon`,
  );
  process.exit(1);
}

const labels = {};
for (const c of concepts) {
  if (typeof c.code === "string" && typeof c.display === "string") labels[c.code] = c.display;
}

const out = join(dirname(fileURLToPath(import.meta.url)), "finess-categories-labels.json");

// Ne jamais ÉCRASER une nomenclature par une plus petite : un SMT en
// déploiement partiel (310 concepts au lieu de 428) passerait le plancher
// absolu ci-dessus et effacerait ~120 libellés — ensuite servis NULL à des
// dizaines de milliers d'établissements. Le compte courant est la référence.
if (existsSync(out)) {
  const current = Object.keys(JSON.parse(readFileSync(out, "utf8")).labels ?? {}).length;
  const next = Object.keys(labels).length;
  if (next < current * 0.95) {
    console.error(
      `[finess-categories] ${next} libellés reçus < 95 % des ${current} actuels — SMT partiel ? Fichier NON écrasé`,
    );
    process.exit(1);
  }
}
writeFileSync(
  out,
  `${JSON.stringify({ source: SMT_URL, refreshedAt: new Date().toISOString(), labels }, null, 2)}\n`,
);
console.log(`[finess-categories] ${Object.keys(labels).length} libellés écrits dans ${out}`);
