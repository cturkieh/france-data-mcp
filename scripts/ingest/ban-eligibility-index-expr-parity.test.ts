import { describe, expect, it } from "vitest";
import {
  readAllMigrationsSql as allMigrationsSql,
  indexStatement as sharedIndexStatement,
  latestFunctionBody as sharedLatestFunctionBody,
} from "./migration-sql.js";

// Garde-fou structurel SANS DB (Task 1 hardening + corrective skip-scan +
// REFONTE 2026-05-18 STEP d'index post-enrichment) — lit TOUTES les migrations
// SQL et ne valide QUE la DERNIÈRE définition des RPC + les statements d'index
// VIVANTS.
//
// REFONTE 2026-05-18 (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md) :
// les 2 index fonctionnels partiels d'éligibilité BAN ne sont PLUS créés par un
// `CREATE INDEX ... ON rpps` autonome (bombe 57014 réfutée comme cause mais
// AGGRAVANT prouvé). Ils sont désormais créés EXCLUSIVEMENT par la RPC
// `ingest_build_rpps_staging_ban_indexes()` (migration 20260519T100000), sur
// `rpps_staging`, APRÈS l'enrichment FINESS et AVANT le swap atomique :
//   rpps_staging_ban_eligible_normkey_idx     (clé-seule, sauts skip-scan)
//   rpps_staging_ban_eligible_normkey_id_idx  (composite (keyexpr, id),
//                                              représentant MIN(id))
// Ces 2 index voyagent dans `rpps` via le RENAME du swap (la table SERVIE a
// donc toujours les 2 index, arrivés par le dernier swap). Ce guard valide
// donc la parité d'EXPRESSION entre : (a) les 2 `CREATE INDEX` posés par la
// RPC de build, (b) tous les sites de clé du corps skip-scan de
// `rpps_distinct_eligible_keys`. Il EXIGE aussi qu'AUCUN `CREATE INDEX
// rpps_ban_eligible_normkey*` autonome sur la table `rpps` ne réapparaisse
// (re-introduction = re-bombe : maintenu par row pendant l'INSERT 2,24 M +
// l'UPDATE d'enrichment).
//
// Classe de bug visée (le SEUL chemin mécaniquement non garanti vers le
// blocker timeout 60 s) : les index sont posés sur l'expression
// `rpps_address_key_for_index(adresse, code_postal, code_insee)` (wrapper
// IMMUTABLE AVEC `SET search_path` → NON inliné → indexable). La RPC
// `rpps_distinct_eligible_keys` DOIT utiliser EXACTEMENT cette même
// expression à TOUS ses sites de clé (le `SELECT keyexpr` du saut, le
// `keyexpr > $1` du keyset, le `keyexpr = $1` du représentant et son
// `ORDER BY keyexpr, id`) — sinon le planner juge les index inapplicables →
// full-scan silencieux sur 2,24 M lignes → timeout 60 s qui RÉGRESSE le
// blocker, sans AUCUN bruit (cron muet 30 min comme la root cause).
//
// Le piège exact à détecter : si un index OU le corps de la RPC appelait le
// JUMEAU NU `rpps_normalize_address_key(...)` (et non le wrapper), le jumeau
// (`LANGUAGE sql IMMUTABLE` SANS `SET search_path`) serait INLINÉ par
// Postgres → l'expression d'index ne correspondrait plus à celle de la RPC
// (ou échouerait carrément à la construction) → index inapplicable.
//
// Méthode (même discipline que staging-parity.test.ts) : on concatène toutes
// les migrations (ordre = tri nom = ordre d'application Supabase), on isole le
// DERNIER corps `$$...$$` des fonctions + les statements `CREATE INDEX`
// VIVANTS AVANT toute assertion — les commentaires WHY et littéraux
// `COMMENT ON ... IS '...'` mentionnent LÉGITIMEMENT `rpps_normalize_address_key`
// en prose ; les confondre avec du code ferait un faux positif (test rouge
// alors que la migration est correcte) ou un faux négatif (test vert sur une
// dérive réelle). On ancre donc les regex sur de VRAIS statements, jamais un
// `.includes()` brut du fichier entier.

const WRAPPER = "rpps_address_key_for_index(";
const TWIN = "rpps_normalize_address_key(";

/** Statement CREATE INDEX compacté (ce guard compare des expressions de clé). */
const indexStatement = (sql: string, indexName: string): string =>
  sharedIndexStatement(sql, indexName, { compact: true });

/**
 * Corps de la DERNIÈRE déf de `fnName`, commentaires `--` retirés + compacté :
 * le corps skip-scan ET le corps de la RPC de build d'index contiennent de la
 * prose INLINE décrivant la stratégie ; la confondre avec une vraie clause
 * exécutable ferait un FAUX POSITIF.
 */
const latestFunctionBody = (sql: string, fnName: string): string =>
  sharedLatestFunctionBody(sql, fnName, { stripComments: true, compact: true });

/**
 * Détecteur réutilisable (testé positif ET négatif plus bas) : à partir du
 * TEXTE BRUT (toutes migrations concaténées), isole les régions exécutables
 * VIVANTES et renvoie les violations de parité wrapper. Liste VIDE = pas de
 * dérive. Toute entrée = une expression de clé qui contourne le wrapper →
 * index inapplicable → timeout 60 s silencieux — OU un index BAN autonome
 * réintroduit sur la table `rpps` (re-bombe 57014, l'AGGRAVANT prouvé).
 */
function indexExprDriftViolations(rawSql: string): string[] {
  const sql = rawSql.toLowerCase();
  const violations: string[] = [];

  // REFONTE : les 2 SEULS `CREATE INDEX` BAN VIVANTS sont les 2 mirrors
  // `rpps_staging_*` posés par la RPC `ingest_build_rpps_staging_ban_indexes`
  // (ils voyagent dans `rpps` via le RENAME du swap — pas de `CREATE INDEX
  // ... ON rpps` autonome). Ils doivent indexer le WRAPPER, jamais le jumeau.
  const indexNames: Array<[string, "rpps_staging"]> = [
    ["rpps_staging_ban_eligible_normkey_idx", "rpps_staging"],
    ["rpps_staging_ban_eligible_normkey_id_idx", "rpps_staging"],
  ];
  for (const [name, table] of indexNames) {
    const stmt = indexStatement(sql, name);
    if (!stmt) {
      violations.push(`statement CREATE INDEX ${name} introuvable`);
      continue;
    }
    const keyMatch = stmt.match(new RegExp(`\\bon\\s+${table}\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)`));
    const keyExpr = keyMatch ? keyMatch[1] : "";
    if (!keyExpr.includes(WRAPPER)) {
      violations.push(`index ${name} : keyexpr n'utilise PAS ${WRAPPER}`);
    }
    if (keyExpr.includes(TWIN)) {
      violations.push(
        `index ${name} : keyexpr appelle le JUMEAU NU ${TWIN} (inliné → index inconstruisible/inapplicable)`,
      );
    }
  }

  // RE-BOMBE 57014 : un `CREATE INDEX rpps_ban_eligible_normkey*` autonome sur
  // la table `rpps` ne DOIT JAMAIS réapparaître (maintenu par row pendant
  // l'INSERT 2,24 M + l'UPDATE d'enrichment = l'AGGRAVANT prouvé). La RPC de
  // build ne crée QUE des index `rpps_staging_*` ; tout `rpps_ban_eligible_*`
  // VIVANT est une régression.
  for (const banned of ["rpps_ban_eligible_normkey_idx", "rpps_ban_eligible_normkey_id_idx"]) {
    const stmt = indexStatement(sql, banned);
    if (stmt) {
      violations.push(
        `RE-BOMBE 57014 : un CREATE INDEX autonome ${banned} sur la table rpps a été réintroduit — les index BAN ne doivent vivre QUE comme rpps_staging_* posés par ingest_build_rpps_staging_ban_indexes (voyagent via le swap)`,
      );
    }
  }

  // Les 2 mirrors staging DOIVENT être posés par la RPC de build (pas dans
  // ingest_create_rpps_staging — sinon re-bombe : maintenus pendant
  // l'INSERT/UPDATE). On exige que le corps de cette RPC contienne les 2
  // statements + le wrapper, jamais le jumeau nu.
  const buildBody = latestFunctionBody(sql, "ingest_build_rpps_staging_ban_indexes");
  if (!buildBody) {
    violations.push("corps $$...$$ de ingest_build_rpps_staging_ban_indexes introuvable");
  } else {
    for (const name of [
      "rpps_staging_ban_eligible_normkey_idx",
      "rpps_staging_ban_eligible_normkey_id_idx",
    ]) {
      if (!buildBody.includes(name)) {
        violations.push(
          `ingest_build_rpps_staging_ban_indexes : ne crée PAS ${name} (mirror absent → P0 au swap mensuel)`,
        );
      }
    }
    if (buildBody.includes(TWIN)) {
      violations.push(
        `ingest_build_rpps_staging_ban_indexes : le corps appelle le JUMEAU NU ${TWIN} — DOIT passer par ${WRAPPER}`,
      );
    }
    if (!buildBody.includes(WRAPPER)) {
      violations.push(`ingest_build_rpps_staging_ban_indexes : le corps n'utilise PAS ${WRAPPER}`);
    }
  }

  // REFONTE ban_join (2026-05-19) : ingest_apply_rpps_ban_join_batch calcule
  // la clé d'adresse de chaque ligne du lot pour la JOINdre au cache
  // geocoded_addresses.address_key. Elle DOIT passer par le WRAPPER (même
  // expression byte-identique que l'index/le count/l'énumération) et JAMAIS
  // le jumeau nu : sinon les clés calculées divergent de celles du cache →
  // JOIN sans match → 0 posé SILENCIEUX (classe S-1). Vérifié AVANT l'early
  // return rpps_distinct_eligible_keys ci-dessous (sinon un corps distinct
  // introuvable masquerait cette violation).
  const banJoinBody = latestFunctionBody(sql, "ingest_apply_rpps_ban_join_batch");
  if (!banJoinBody) {
    violations.push("corps $$...$$ de ingest_apply_rpps_ban_join_batch introuvable");
  } else {
    if (banJoinBody.includes(TWIN)) {
      violations.push(
        `ingest_apply_rpps_ban_join_batch : le corps appelle le JUMEAU NU ${TWIN} — DOIT passer par ${WRAPPER} (sinon clés != cache → JOIN sans match → 0 posé silencieux)`,
      );
    }
    if (!banJoinBody.includes(WRAPPER)) {
      violations.push(
        `ingest_apply_rpps_ban_join_batch : le corps n'utilise PAS ${WRAPPER} (jointure cache ne matcherait rien)`,
      );
    }
  }

  const body = latestFunctionBody(sql, "rpps_distinct_eligible_keys");
  if (!body) {
    violations.push("corps $$...$$ de rpps_distinct_eligible_keys introuvable");
    return violations;
  }

  // Skip-scan : le saut de groupe = `SELECT <keyexpr> ... ORDER BY <keyexpr>
  // LIMIT 1` ; le représentant = `... WHERE <keyexpr> = $1 ORDER BY <keyexpr>,
  // t.id LIMIT 1`. TOUT site de clé du corps exécutable DOIT passer par le
  // wrapper. Le seul site légitime du jumeau nu est DANS le wrapper (autre
  // migration) ; ce corps ne doit JAMAIS l'appeler en direct.
  if (body.includes(TWIN)) {
    violations.push(
      `rpps_distinct_eligible_keys : le corps exécutable appelle le JUMEAU NU ${TWIN} — DOIT passer par le wrapper ${WRAPPER}`,
    );
  }

  // Le keyset `> $1` (saut skip-scan) DOIT comparer le WRAPPER LUI-MÊME, collé
  // au `> $1`. L'ancien `/>\s*\$1/ || body.includes(WRAPPER)` acceptait le
  // wrapper N'IMPORTE OÙ (ex. seulement dans l'ORDER BY du représentant) avec
  // un keyset nu → détecteur réutilisable plus laxiste que sa promesse. On
  // exige la même regex précise que le `it("4.")` qui le backstoppe.
  if (!/rpps_address_key_for_index\([^)]*\)\s*>\s*\$1/.test(body)) {
    violations.push(
      `rpps_distinct_eligible_keys : keyset de saut (keyexpr > $1) absent ou n'utilise PAS ${WRAPPER}`,
    );
  }

  // Le représentant DOIT trier sur `<wrapper>..., t.id` (MIN(id) déterministe).
  const orderMatch = body.match(/order\s+by\s+([^$]+?)\s+limit\b/g);
  const orderClauses = orderMatch ?? [];
  if (orderClauses.length === 0) {
    violations.push("rpps_distinct_eligible_keys : aucune clause ORDER BY ... LIMIT");
  }
  for (const oc of orderClauses) {
    if (!oc.includes(WRAPPER)) {
      violations.push(`rpps_distinct_eligible_keys : une clause ORDER BY n'utilise PAS ${WRAPPER}`);
    }
    if (oc.includes(TWIN)) {
      violations.push(
        `rpps_distinct_eligible_keys : une clause ORDER BY appelle le JUMEAU NU ${TWIN}`,
      );
    }
  }
  // Le représentant déterministe exige un `order by <wrapper> ..., t.id`.
  if (!/order\s+by\s+rpps_address_key_for_index\([^)]*\)\s*,\s*t\.id\b/.test(body)) {
    violations.push(
      "rpps_distinct_eligible_keys : ORDER BY du représentant n'est pas `<wrapper>, t.id` (MIN(id) non déterministe)",
    );
  }

  return violations;
}

const FAIL_WHY =
  "dérive nom d'expression index ↔ RPC → le planner ignore l'index partiel → full-scan 2,24 M lignes → timeout 60 s : le blocker régresse SILENCIEUSEMENT (cron muet, aucune erreur)";

describe("rpps_ban_eligible : parité expression STEP build-index ↔ RPC skip-scan (name-drift guard)", () => {
  const rawSql = allMigrationsSql();
  const sql = rawSql.toLowerCase();

  it("1. ingest_build_rpps_staging_ban_indexes : CREATE INDEX rpps_staging_ban_eligible_normkey_idx (saut) keyexpr = wrapper", () => {
    const stmt = indexStatement(sql, "rpps_staging_ban_eligible_normkey_idx");
    expect(
      stmt.length,
      "statement CREATE INDEX rpps_staging_ban_eligible_normkey_idx introuvable (posé par ingest_build_rpps_staging_ban_indexes)",
    ).toBeGreaterThan(0);
    const keyExpr = (stmt.match(/\bon\s+rpps_staging\s*\(((?:[^()]|\([^()]*\))*)\)/) ?? [
      "",
      "",
    ])[1];
    expect(keyExpr.includes(WRAPPER), `index keyexpr DOIT utiliser ${WRAPPER} — ${FAIL_WHY}`).toBe(
      true,
    );
    expect(
      keyExpr.includes(TWIN),
      `index keyexpr NE DOIT PAS appeler le jumeau nu ${TWIN} — ${FAIL_WHY}`,
    ).toBe(false);
  });

  it("2. ingest_build_rpps_staging_ban_indexes : CREATE INDEX rpps_staging_ban_eligible_normkey_id_idx (composite représentant) : (wrapper, id)", () => {
    const stmt = indexStatement(sql, "rpps_staging_ban_eligible_normkey_id_idx");
    expect(
      stmt.length,
      "statement CREATE INDEX rpps_staging_ban_eligible_normkey_id_idx introuvable (représentant MIN(id) non couvert → seek O(N))",
    ).toBeGreaterThan(0);
    const keyExpr = (stmt.match(/\bon\s+rpps_staging\s*\(((?:[^()]|\([^()]*\))*)\)/) ?? [
      "",
      "",
    ])[1];
    expect(
      keyExpr.includes(WRAPPER),
      `index composite keyexpr DOIT utiliser ${WRAPPER} — ${FAIL_WHY}`,
    ).toBe(true);
    expect(keyExpr.includes(TWIN), `index composite NE DOIT PAS appeler ${TWIN}`).toBe(false);
    // Composite : la 2e colonne DOIT être `id` (sinon le seek du représentant
    // MIN(id) n'est pas couvert → re-scan O(taille du groupe geant)).
    expect(
      /,\s*id\s*$/.test(keyExpr.trim()),
      `index composite DOIT se terminer par , id (représentant MIN(id) couvert) — vu: ${keyExpr}`,
    ).toBe(true);
  });

  it("2b. AUCUN CREATE INDEX rpps_ban_eligible_normkey* autonome sur la table rpps (re-bombe 57014 interdite)", () => {
    // Les index BAN ne doivent vivre QUE comme `rpps_staging_*` posés par la
    // RPC de build (ils voyagent dans `rpps` via le swap). Un `CREATE INDEX
    // ... ON rpps` autonome les maintiendrait par row pendant l'INSERT 2,24 M
    // + l'UPDATE d'enrichment = l'AGGRAVANT prouvé du 57014.
    expect(
      indexStatement(sql, "rpps_ban_eligible_normkey_idx"),
      "RE-BOMBE : CREATE INDEX rpps_ban_eligible_normkey_idx autonome sur la table rpps réintroduit",
    ).toBe("");
    expect(
      indexStatement(sql, "rpps_ban_eligible_normkey_id_idx"),
      "RE-BOMBE : CREATE INDEX rpps_ban_eligible_normkey_id_idx autonome sur la table rpps réintroduit",
    ).toBe("");
  });

  it("3. rpps_distinct_eligible_keys : DERNIÈRE déf, corps n'appelle JAMAIS le jumeau nu", () => {
    const body = latestFunctionBody(sql, "rpps_distinct_eligible_keys");
    expect(
      body.length,
      "corps de la DERNIÈRE déf de rpps_distinct_eligible_keys introuvable",
    ).toBeGreaterThan(0);
    // Scope = DERNIER corps $$...$$ (skip-scan) UNIQUEMENT — les en-têtes WHY +
    // COMMENT ON ... IS mentionnent le jumeau en prose, légitimement, hors corps.
    expect(
      body.includes(TWIN),
      `le corps de rpps_distinct_eligible_keys appelle le jumeau nu ${TWIN} : DOIT passer par ${WRAPPER} — ${FAIL_WHY}`,
    ).toBe(false);
    // Robustesse : le corps skip-scan référence le wrapper à de NOMBREUX sites
    // (saut: SELECT keyexpr + keyset `> $1` + ORDER BY keyexpr ; représentant:
    // `= $1` + ORDER BY keyexpr, id). Plancher ≥ 5 pour la nouvelle forme.
    const wrapperHits = body.split(WRAPPER).length - 1;
    expect(
      wrapperHits,
      `attendu ≥ 5 occurrences du wrapper dans le corps skip-scan (saut keyexpr + keyset + représentant), vu ${wrapperHits}`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("4. rpps_distinct_eligible_keys : keyset de saut (keyexpr > $1) utilise le wrapper", () => {
    const body = latestFunctionBody(sql, "rpps_distinct_eligible_keys");
    expect(body.length).toBeGreaterThan(0);
    expect(/>\s*\$1/.test(body), "keyset de saut `keyexpr > $1` introuvable").toBe(true);
    // La comparaison keyset DOIT porter sur le wrapper (sinon ordre ≠ index).
    expect(
      /rpps_address_key_for_index\([^)]*\)\s*>\s*\$1/.test(body),
      `keyset DOIT comparer ${WRAPPER} > $1 — ${FAIL_WHY}`,
    ).toBe(true);
  });

  it("5. rpps_distinct_eligible_keys : ORDER BY du représentant = `<wrapper>, t.id`", () => {
    const body = latestFunctionBody(sql, "rpps_distinct_eligible_keys");
    expect(
      /order\s+by\s+rpps_address_key_for_index\([^)]*\)\s*,\s*t\.id\b/.test(body),
      `ORDER BY du représentant DOIT être \`${WRAPPER}...), t.id\` (MIN(id) déterministe) — ${FAIL_WHY}`,
    ).toBe(true);
  });

  it("6. ingest_build_rpps_staging_ban_indexes : son corps pose les 2 mirrors via le wrapper (jamais le jumeau nu)", () => {
    const buildBody = latestFunctionBody(sql, "ingest_build_rpps_staging_ban_indexes");
    expect(
      buildBody.length,
      "corps $$...$$ de ingest_build_rpps_staging_ban_indexes introuvable (STEP d'index absent → P0 au swap)",
    ).toBeGreaterThan(0);
    for (const name of [
      "rpps_staging_ban_eligible_normkey_idx",
      "rpps_staging_ban_eligible_normkey_id_idx",
    ]) {
      expect(
        buildBody.includes(name),
        `ingest_build_rpps_staging_ban_indexes ne crée pas ${name} (mirror perdu → P0 au swap mensuel)`,
      ).toBe(true);
    }
    expect(
      buildBody.includes(TWIN),
      `ingest_build_rpps_staging_ban_indexes appelle le jumeau nu ${TWIN} — DOIT passer par ${WRAPPER}`,
    ).toBe(false);
    expect(
      buildBody.includes(WRAPPER),
      `ingest_build_rpps_staging_ban_indexes n'utilise PAS ${WRAPPER} — ${FAIL_WHY}`,
    ).toBe(true);
  });

  it("la migration RÉELLE ne présente AUCUNE violation (guard vert aujourd'hui, locke l'invariant)", () => {
    expect(indexExprDriftViolations(rawSql)).toEqual([]);
  });
});

// Preuve que le détecteur MORD vraiment (positif + négatif), pas vert à vide —
// même discipline que les `describe` de parsing de staging-parity.test.ts.
describe("indexExprDriftViolations : prouvé sur échantillon positif ET négatif (skip-scan)", () => {
  // Échantillon POSITIF minimal (skip-scan, wrapper partout, STEP d'index
  // BAN-free hors staging-create) : 0 violation.
  const GOOD = `
CREATE OR REPLACE FUNCTION ingest_build_rpps_staging_ban_indexes()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee))
    WHERE geom_source = 'commune_centroid';
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_id_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid';
END;
$$;
CREATE OR REPLACE FUNCTION ingest_apply_rpps_ban_join_batch(p_after BIGINT, p_limit INT)
RETURNS TABLE(last_id BIGINT, applied INT) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT id, rpps_address_key_for_index(adresse, code_postal, code_insee) AS akey
    FROM rpps_staging WHERE id > p_after ORDER BY id LIMIT p_limit
  ),
  upd AS (
    UPDATE rpps_staging r SET geom_source = 'ban_address'
    FROM batch b JOIN geocoded_addresses g ON g.address_key = b.akey
    WHERE r.id = b.id RETURNING 1
  )
  SELECT max(b.id)::BIGINT, (SELECT count(*)::INT FROM upd) FROM batch b;
END;
$$;
CREATE OR REPLACE FUNCTION rpps_distinct_eligible_keys(p TEXT, a TEXT, l INT)
RETURNS TABLE (k TEXT) LANGUAGE plpgsql AS $$
DECLARE v_prev TEXT := a; v_key TEXT;
BEGIN
  FOR i IN 1..l LOOP
    EXECUTE format($q$
      SELECT rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      FROM %I t
      WHERE ( $1 IS NULL OR rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) > $1 )
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      LIMIT 1
    $q$, v) INTO v_key USING v_prev;
    EXIT WHEN v_key IS NULL;
    EXECUTE format($q$
      SELECT btrim(t.adresse)
      FROM %I t
      WHERE rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) = $1
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id
      LIMIT 1
    $q$, v) INTO adresse USING v_key;
    v_prev := v_key;
  END LOOP;
END;
$$;`;

  // Échantillon NÉGATIF : la query de SAUT appelle le JUMEAU NU (inliné →
  // expr ≠ index → full-scan + timeout 60 s). Le commentaire WHY mentionne
  // pourtant le jumeau LÉGITIMEMENT — le détecteur ne doit PAS s'y tromper
  // (il ne flague QUE le DERNIER corps exécutable, pas la prose).
  const BAD = `
-- POURQUOI : la clé délègue à rpps_normalize_address_key (source de vérité).
CREATE OR REPLACE FUNCTION ingest_build_rpps_staging_ban_indexes()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee))
    WHERE geom_source = 'commune_centroid';
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_id_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid';
END;
$$;
COMMENT ON FUNCTION ingest_build_rpps_staging_ban_indexes() IS 'délègue à rpps_normalize_address_key';
CREATE OR REPLACE FUNCTION ingest_apply_rpps_ban_join_batch(p_after BIGINT, p_limit INT)
RETURNS TABLE(last_id BIGINT, applied INT) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT id, rpps_address_key_for_index(adresse, code_postal, code_insee) AS akey
    FROM rpps_staging WHERE id > p_after ORDER BY id LIMIT p_limit
  ),
  upd AS (
    UPDATE rpps_staging r SET geom_source = 'ban_address'
    FROM batch b JOIN geocoded_addresses g ON g.address_key = b.akey
    WHERE r.id = b.id RETURNING 1
  )
  SELECT max(b.id)::BIGINT, (SELECT count(*)::INT FROM upd) FROM batch b;
END;
$$;
CREATE OR REPLACE FUNCTION rpps_distinct_eligible_keys(p TEXT, a TEXT, l INT)
RETURNS TABLE (k TEXT) LANGUAGE plpgsql AS $$
DECLARE v_prev TEXT := a; v_key TEXT;
BEGIN
  FOR i IN 1..l LOOP
    EXECUTE format($q$
      SELECT rpps_normalize_address_key(t.adresse, t.code_postal, t.code_insee)
      FROM %I t
      WHERE ( $1 IS NULL OR rpps_normalize_address_key(t.adresse, t.code_postal, t.code_insee) > $1 )
      ORDER BY rpps_normalize_address_key(t.adresse, t.code_postal, t.code_insee)
      LIMIT 1
    $q$, v) INTO v_key USING v_prev;
    EXIT WHEN v_key IS NULL;
    v_prev := v_key;
  END LOOP;
END;
$$;`;

  // Échantillon RE-BOMBE : un CREATE INDEX rpps_ban_eligible_normkey_idx
  // autonome sur la table `rpps` réintroduit (l'AGGRAVANT 57014).
  const REBOMB = `${GOOD}
CREATE INDEX IF NOT EXISTS rpps_ban_eligible_normkey_idx
  ON rpps (rpps_address_key_for_index(adresse, code_postal, code_insee))
  WHERE geom_source = 'commune_centroid';`;

  it("échantillon POSITIF (skip-scan, wrapper partout, STEP build-index) → 0 violation", () => {
    expect(indexExprDriftViolations(GOOD)).toEqual([]);
  });

  it("échantillon NÉGATIF (jumeau nu dans la query de saut) → violations DÉTECTÉES", () => {
    const v = indexExprDriftViolations(BAD);
    expect(v.length).toBeGreaterThan(0);
    // Le détecteur flague le corps exécutable contournant le wrapper, MAIS
    // pas la prose WHY/COMMENT (qui cite le jumeau légitimement) ni les index
    // (eux restent au wrapper).
    expect(v.some((m) => m.includes("corps exécutable") && m.includes("JUMEAU NU"))).toBe(true);
    expect(
      v.some((m) => m.includes("rpps_staging_ban_eligible_normkey_idx") && m.includes("JUMEAU NU")),
    ).toBe(false);
  });

  it("échantillon RE-BOMBE (CREATE INDEX rpps_ban_eligible* autonome sur rpps) → violation DÉTECTÉE", () => {
    const v = indexExprDriftViolations(REBOMB);
    expect(v.some((m) => m.includes("RE-BOMBE 57014"))).toBe(true);
  });

  it("le détecteur NE confond PAS la prose WHY/COMMENT (jumeau cité) avec du code", () => {
    const withProse = `
-- rpps_normalize_address_key rpps_normalize_address_key rpps_normalize_address_key
${GOOD}
-- encore rpps_normalize_address_key en prose d'en-tête WHY
COMMENT ON FUNCTION rpps_distinct_eligible_keys(TEXT) IS 'délègue au jumeau rpps_normalize_address_key';`;
    expect(indexExprDriftViolations(withProse)).toEqual([]);
  });

  it("DERNIÈRE déf gagne : un corps DISTINCT ON mort n'est PAS validé à la place du skip-scan", () => {
    // Un ancien corps `DISTINCT ON` (forme MORTE 20260517T120000) suivi du
    // skip-scan corrigé : le détecteur DOIT ne lire que le dernier (vert).
    const deadThenFixed = `
CREATE OR REPLACE FUNCTION rpps_distinct_eligible_keys(p TEXT, a TEXT, l INT)
RETURNS TABLE (k TEXT) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE format($q$
    SELECT DISTINCT ON (rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee))
           rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
    FROM %I t
    ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id
    LIMIT $2
  $q$, v) USING a, l;
END;
$$;
${GOOD}`;
    // Le DERNIER corps (skip-scan GOOD) est lu → 0 violation (le corps mort
    // DISTINCT ON ci-dessus est ignoré, exactement le faux-PASS qu'on évite).
    expect(indexExprDriftViolations(deadThenFixed)).toEqual([]);
  });
});
