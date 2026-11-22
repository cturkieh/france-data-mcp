import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationsDir } from "./migration-sql.js";

// Garde-fou sur le TEXTE de la dernière définition de `ingest_drop_stale_previous`.
// Le comportement (matview liée conservée, erreur 2BP01, suppression après réparation) est
// prouvé sur une base jetable : `docs/experiences/2026-11-22-nettoyage-sans-cascade.md`.
// Les tests d'intégration ne voient pas les migrations au format T, d'où ce filet statique.

const ORIGINE = "20260514T080000_rpc_drop_stale_previous.sql";
const CORRECTIF = "20261122T210000_drop_stale_previous_sans_cascade.sql";

// Toute forme de (re)définition : nom nu, préfixé `public.`, entre guillemets. Les lecteurs
// partagés de `migration-sql.ts` exigent le nom nu et un corps `$$` : une redéfinition
// `public.ingest_drop_stale_previous … $fn$` leur échapperait, test vert avec CASCADE revenu.
const DEFINITION =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?ingest_drop_stale_previous"?\s*\(/;

function lire(file: string): string {
  return readFileSync(`${migrationsDir}/${file}`, "utf8").toLowerCase();
}

/** Retire les commentaires `--` : l'en-tête et le corps CITENT `CASCADE` pour l'interdire. */
function sansCommentaires(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Définition complète dans un fichier : de `create … function` à la fin du corps `$tag$…$tag$`. */
function definition(file: string): string {
  const sql = lire(file);
  const debut = sql.search(DEFINITION);
  if (debut < 0) throw new Error(`définition introuvable dans ${file}`);
  const m = sql.slice(debut).match(/^[\s\S]*?(\$[a-z_]*\$)[\s\S]*?\1/);
  if (!m) throw new Error(`corps de la fonction introuvable dans ${file}`);
  return m[0];
}

/** Corps seul, sans commentaires, espaces compactés (commentaires retirés AVANT de compacter). */
function corps(file: string): string {
  const def = definition(file);
  const tag = def.match(/\$[a-z_]*\$/)?.[0] as string;
  const interieur = def.slice(def.indexOf(tag) + tag.length, def.lastIndexOf(tag));
  return sansCommentaires(interieur).replace(/\s+/g, " ").trim();
}

describe("ingest_drop_stale_previous — ne détruit plus ce qui dépend de la copie de secours", () => {
  it("le correctif est la DERNIÈRE migration qui définit la fonction", () => {
    // Une redéfinition ultérieure doit passer par ici : mettre CORRECTIF à jour, donc relire
    // les assertions ci-dessous contre la nouvelle définition.
    const definissantes = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => DEFINITION.test(lire(f)));
    expect(definissantes).toEqual([ORIGINE, CORRECTIF]);
  });

  it("supprime la table SANS cascade", () => {
    // Avec CASCADE, une matview encore liée à `<prod>_previous` (run tué entre la bascule
    // et la reconstruction) part avec la copie : 42P01 sur les tools qui la lisent.
    expect(corps(CORRECTIF)).toContain("drop table if exists %i'");
    expect(corps(CORRECTIF)).not.toMatch(/\bcascade\b/);
  });

  it("garde SECURITY DEFINER et son search_path (CREATE OR REPLACE remplace tout l'en-tête)", () => {
    const def = definition(CORRECTIF);
    expect(def).toMatch(/security definer/);
    expect(def).toMatch(/set search_path = public, extensions/);
    expect(def).toMatch(/p_prod_table text,\s*p_source text,\s*p_max_age_days int default 7/);
  });

  it("seule la ligne du DROP diffère de la définition d'origine", () => {
    const origine = corps(ORIGINE);
    expect(origine).toContain("drop table if exists %i cascade");
    expect(corps(CORRECTIF)).toBe(
      origine.replace("drop table if exists %i cascade", "drop table if exists %i"),
    );
  });
});
