import { describe, expect, it } from "vitest";
import {
  readAllMigrationsSql as allMigrationsSql,
  indexStatement,
  latestFunctionBody,
} from "./migration-sql.js";

// Garde-fou structurel SANS DB (Fix I-1 + corrective skip-scan + REFONTE
// 2026-05-18 STEP d'index post-enrichment) — concatene TOUTES les migrations
// SQL et ne valide QUE la DERNIERE def des RPC + les statements d'index VIVANTS.
//
// REFONTE 2026-05-18 (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md) :
// les 2 index fonctionnels partiels d'eligibilite BAN ne sont PLUS crees par un
// `CREATE INDEX ... ON rpps` autonome. Ils sont crees EXCLUSIVEMENT par la RPC
// `ingest_build_rpps_staging_ban_indexes()` (migration 20260519T100000) sur
// `rpps_staging` (rpps_staging_ban_eligible_normkey_idx + _id_idx) et voyagent
// dans `rpps` via le RENAME du swap. Ce guard valide donc la parite du
// PREDICAT entre 5 sites VIVANTS :
//   (a) corps de `rpps_count_ban_eligible_rows` (WHERE du count) -- pilote
//       `eligibleRowCount`, le early-return `=== 0`, et l'`expectedTotal` de
//       runBatchedRpc ;
//   (b) corps de `rpps_distinct_eligible_keys` (skip-scan : >=2 occurrences --
//       la query de SAUT `keyexpr > $1` et la query du REPRESENTANT
//       `keyexpr = $1`) -- pilote QUELLES cles sont enumerees ;
//   (c) statement `rpps_staging_ban_eligible_normkey_idx` posé par
//       `ingest_build_rpps_staging_ban_indexes` (saut skip-scan) ;
//   (d) statement `rpps_staging_ban_eligible_normkey_id_idx` posé par la
//       meme RPC (composite (keyexpr, id) du representant MIN(id)).
//
// Si un futur edit NARROW UNIQUEMENT le count (ex. ajoute
// `AND adresse IS NOT NULL` qu'a (a)), le count diverge SILENCIEUSEMENT de
// l'enumeration -> `eligibleRowCount` faussement bas ou 0 -> le cron prend son
// early-return `eligibleRowCount === 0`, log la ligne success-shaped
// (0 new / 0 cached ... 0 rows_applied) et RETURN alors que du vrai travail
// existe = panne TOTALE silencieuse de classe S-1 rapportee comme succes.
// Symetriquement, si l'index composite (d) avait un WHERE plus etroit que (c),
// le planner servirait le representant MIN(id) d'un sous-ensemble -> cles
// perdues OU re-scan O(N) du groupe geant.
//
// Methode (meme discipline que ban-eligibility-index-expr-parity.test.ts) : on
// isole les REGIONS EXECUTABLES VIVANTES (DERNIER corps `$$...$$` de chaque
// fonction, DERNIER statement `CREATE INDEX ... WHERE <pred>;` par nom -- ici
// les 2 statements vivent DANS le corps `$$...$$` de la RPC de build, ce que
// `indexStatement` capture globalement) AVANT toute assertion. Les commentaires
// WHY `--` et litteraux `COMMENT ON ... IS '...'` mentionnent LEGITIMEMENT le
// predicat en prose ; les confondre avec du code ferait un faux positif/negatif.
// On ancre donc les regex sur de VRAIS statements / corps de fonction, jamais
// un `.includes()` brut.

// Parsing migrations : helpers partagés (voir ./migration-sql.ts). Ce guard
// compare le SENS du prédicat → corps de fonction / statement d'index BRUTS
// (la canonicalisation est faite plus bas par normalizePredicate).

/**
 * Normalise un fragment de predicat pour comparaison byte-exacte de SENS.
 * Artefacts syntaxiques inoffensifs neutralises :
 *  - le count est dans un litteral `format('...')` -> quotes SQL doublees `''` ;
 *  - le corps RPC qualifie `t.colonne` (alias FROM `%I t`), les index non ;
 *  - parentheses englobantes variables (count `( <pred> )`, distinct idem,
 *    index `WHERE <pred>;` sans parenthese).
 * Canonicalisation : lowercase ; `''`->`'` ; retire l'alias `t.` ; compacte le
 * whitespace ; retire un `;` final ; retire les espaces colles aux parentheses ;
 * retire UN SEUL niveau de parenthese englobante exterieure si elle enveloppe
 * TOUT le predicat. Deux sites SEMANTIQUEMENT identiques -> MEME chaine.
 */
function normalizePredicate(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/''/g, "'")
    .replace(/\bt\./g, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
  if (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") {
        depth--;
        if (depth === 0 && i !== s.length - 1) {
          wrapsAll = false;
          break;
        }
      }
    }
    if (wrapsAll) s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Extrait le predicat d'eligibilite brut d'un fragment executable.
 * Ancre sur la 1re reference a `geom_source = 'commune_centroid'` et borne par
 * la fermeture de la parenthese englobante (count/RPC) ou le `;` de fin de
 * statement (index).
 *
 * `occurrence` : pour le corps skip-scan, le predicat apparait >=2 fois (query
 * de saut + query du representant) -- on peut donc viser la N-ieme.
 */
function extractPredicate(
  executableFragment: string,
  mode: "paren" | "where",
  occurrence = 1,
): string {
  const s = executableFragment;
  if (mode === "paren") {
    // Trouve la N-ieme parenthese OUVRANTE qui precede immediatement un
    // `geom_source`/`t.geom_source` puis equilibre jusqu'a sa fermeture.
    const re = /\(\s*t?\.?\s*geom_source\b/gi;
    let seen = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      seen += 1;
      if (seen !== occurrence) continue;
      const anchor = m.index;
      let depth = 0;
      for (let i = anchor; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") {
          depth--;
          if (depth === 0) return s.slice(anchor, i + 1);
        }
      }
      return "";
    }
    return "";
  }
  const start = s.search(/\bgeom_source\b/i);
  if (start === -1) return "";
  const end = s.indexOf(";", start);
  return end === -1 ? s.slice(start) : s.slice(start, end + 1);
}

/**
 * Detecteur reutilisable (prouve positif ET negatif plus bas) : a partir du
 * TEXTE BRUT (toutes migrations), renvoie les predicats NORMALISES des 4+1
 * sites VIVANTS (count, distinct-saut, distinct-representant, index staging
 * x2 -- poses par ingest_build_rpps_staging_ban_indexes), ou des marqueurs
 * d'absence. Tous identiques => pas de derive.
 */
function eligibilityPredicates(rawSql: string): {
  count: string;
  distinctJump: string;
  distinctRepresentative: string;
  stagingIndexJump: string;
  stagingIndexComposite: string;
} {
  const sql = rawSql.toLowerCase();

  const countBody = latestFunctionBody(sql, "rpps_count_ban_eligible_rows");
  const distinctBody = latestFunctionBody(sql, "rpps_distinct_eligible_keys");
  // REFONTE : les 2 statements d'index VIVENT dans le corps $$...$$ de la RPC
  // ingest_build_rpps_staging_ban_indexes -- indexStatement scanne TOUT le SQL
  // concatene (corps de fonction inclus) donc les capture par nom.
  const stagingJump = indexStatement(sql, "rpps_staging_ban_eligible_normkey_idx");
  const stagingComposite = indexStatement(sql, "rpps_staging_ban_eligible_normkey_id_idx");

  return {
    count: countBody
      ? normalizePredicate(extractPredicate(countBody, "paren", 1))
      : "<corps rpps_count_ban_eligible_rows introuvable>",
    distinctJump: distinctBody
      ? normalizePredicate(extractPredicate(distinctBody, "paren", 1))
      : "<corps rpps_distinct_eligible_keys (saut) introuvable>",
    distinctRepresentative: distinctBody
      ? normalizePredicate(extractPredicate(distinctBody, "paren", 2))
      : "<corps rpps_distinct_eligible_keys (representant) introuvable>",
    stagingIndexJump: stagingJump
      ? normalizePredicate(extractPredicate(stagingJump, "where"))
      : "<statement rpps_staging_ban_eligible_normkey_idx introuvable>",
    stagingIndexComposite: stagingComposite
      ? normalizePredicate(extractPredicate(stagingComposite, "where"))
      : "<statement rpps_staging_ban_eligible_normkey_id_idx introuvable>",
  };
}

const FAIL_WHY =
  "derive de predicat entre count / enumeration / index -> le count diverge SILENCIEUSEMENT du set enumere -> le cron prend son early-return success-shaped avec 0 travail (panne TOTALE silencieuse de classe S-1 rapportee comme succes)";

const EXPECTED_CANONICAL =
  "geom_source = 'commune_centroid' or (geom is null and adresse is not null)";

describe("rpps_ban_eligible : parite du PREDICAT count <-> skip-scan <-> index staging x2 (drift guard)", () => {
  const rawSql = allMigrationsSql();
  const preds = eligibilityPredicates(rawSql);
  const all = [
    preds.count,
    preds.distinctJump,
    preds.distinctRepresentative,
    preds.stagingIndexJump,
    preds.stagingIndexComposite,
  ];

  it("1. chacun des 5 sites expose un predicat NON vide ET contenant geom_source (regions executables isolees)", () => {
    const sites: Array<[string, string]> = [
      ["count", preds.count],
      ["query de SAUT", preds.distinctJump],
      ["REPRESENTANT", preds.distinctRepresentative],
      ["index staging (saut)", preds.stagingIndexJump],
      ["index staging (composite)", preds.stagingIndexComposite],
    ];
    // TROIS echecs distincts qui DOIVENT tous rougir : (a) marqueur d'absence
    // `<... introuvable>` (corps/statement non trouve) ; (b) extraction VIDE
    // `""` (ancre extractPredicate non matchee) ; (c) extraction d'un fragment
    // qui ne contient meme pas `geom_source`. L'ancien `not.toMatch(/^</)`
    // seul laissait passer `""` -> guard predicate-parity DESARMABLE en faux
    // vert (deux `""` egaux passent les tests 2/3 alors que le predicat a
    // derive).
    for (const [label, pred] of sites) {
      expect(pred, `predicat ${label} : marqueur d'absence`).not.toMatch(/^</);
      expect(
        pred.length,
        `predicat ${label} VIDE (extractPredicate n'a rien ancre — guard inerte)`,
      ).toBeGreaterThan(0);
      expect(pred, `predicat ${label} ne contient pas geom_source (extraction cassee)`).toContain(
        "geom_source",
      );
    }
  });

  it("2. count == query de saut (sinon le count ment sur ce qui sera reellement traite)", () => {
    expect(preds.count, `predicat count != predicat enumeration-saut -- ${FAIL_WHY}`).toBe(
      preds.distinctJump,
    );
  });

  it("3. query de saut == query du representant (un seul predicat skip-scan)", () => {
    expect(
      preds.distinctJump,
      `predicat saut != predicat representant -- le representant MIN(id) viendrait d'un sous-ensemble DIFFERENT des cles enumerees -- ${FAIL_WHY}`,
    ).toBe(preds.distinctRepresentative);
  });

  it("4. enumeration == index staging SAUT == index staging COMPOSITE (planner sert les 2 apres swap)", () => {
    expect(preds.distinctJump, `predicat enumeration != index staging saut -- ${FAIL_WHY}`).toBe(
      preds.stagingIndexJump,
    );
    expect(
      preds.stagingIndexJump,
      `index staging saut != index staging composite -- le representant MIN(id) servirait un sous-ensemble -> cles perdues / re-scan O(N) -- ${FAIL_WHY}`,
    ).toBe(preds.stagingIndexComposite);
  });

  it("5. les 5 sites normalisent vers la MEME chaine canonique attendue", () => {
    expect(
      new Set(all).size,
      `les 5 predicats DOIVENT etre identiques -- ${FAIL_WHY} -- vu : ${JSON.stringify(all)}`,
    ).toBe(1);
    // Locke aussi la FORME : si tous derivaient ENSEMBLE, l'egalite mutuelle
    // resterait verte mais la forme attendue changerait -> ce garde mord aussi.
    expect(preds.count, `forme canonique du predicat inattendue -- ${FAIL_WHY}`).toBe(
      EXPECTED_CANONICAL,
    );
  });
});

// Preuve que le detecteur MORD vraiment (positif + negatif + immunite prose),
// pas vert a vide -- meme discipline que ban-eligibility-index-expr-parity.
describe("eligibilityPredicates : prouve sur echantillon positif, negatif ET prose (skip-scan)", () => {
  // Echantillon POSITIF : tous les sites byte-identiques -> 1 predicat
  // canonique. Les 2 index vivent dans le corps de la RPC de build (REFONTE).
  const GOOD = `
CREATE OR REPLACE FUNCTION ingest_build_rpps_staging_ban_indexes()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee))
    WHERE geom_source = 'commune_centroid'
          OR (geom IS NULL AND adresse IS NOT NULL);
  CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_id_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid'
          OR (geom IS NULL AND adresse IS NOT NULL);
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
      WHERE ( t.geom_source = 'commune_centroid'
              OR (t.geom IS NULL AND t.adresse IS NOT NULL) )
        AND ( $1 IS NULL OR rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) > $1 )
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      LIMIT 1
    $q$, v) INTO v_key USING v_prev;
    EXIT WHEN v_key IS NULL;
    EXECUTE format($q$
      SELECT btrim(t.adresse)
      FROM %I t
      WHERE ( t.geom_source = 'commune_centroid'
              OR (t.geom IS NULL AND t.adresse IS NOT NULL) )
        AND rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) = $1
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id
      LIMIT 1
    $q$, v) INTO adresse USING v_key;
    v_prev := v_key;
  END LOOP;
END;
$$;
CREATE OR REPLACE FUNCTION rpps_count_ban_eligible_rows(p TEXT) RETURNS BIGINT
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'SELECT count(*) FROM %I t WHERE (t.geom_source = ''commune_centroid'' OR (t.geom IS NULL AND t.adresse IS NOT NULL))',
    v
  ) INTO c;
  RETURN c;
END;
$$;`;

  // Echantillon NEGATIF : SEUL le count est narrow (gagne `AND adresse <> ''`)
  // -- exactement le scenario S-1 : count faussement bas -> early-return
  // success-shaped. La prose WHY cite pourtant le predicat legitimement.
  const BAD = GOOD.replace(
    "WHERE (t.geom_source = ''commune_centroid'' OR (t.geom IS NULL AND t.adresse IS NOT NULL))",
    "WHERE (t.geom_source = ''commune_centroid'' OR (t.geom IS NULL AND t.adresse IS NOT NULL AND t.adresse <> ''''))",
  );

  // Echantillon NEGATIF 2 : SEUL l'index composite (representant) est narrow
  // -> le representant MIN(id) viendrait d'un sous-ensemble != des cles
  // enumerees.
  const BAD_COMPOSITE = GOOD.replace(
    `CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_id_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid'
          OR (geom IS NULL AND adresse IS NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS rpps_staging_ban_eligible_normkey_id_idx
    ON rpps_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid';`,
  );

  it("echantillon POSITIF (5 sites identiques) -> 1 seul predicat canonique", () => {
    const p = eligibilityPredicates(GOOD);
    expect(p.count).toBe(EXPECTED_CANONICAL);
    expect(
      new Set([
        p.count,
        p.distinctJump,
        p.distinctRepresentative,
        p.stagingIndexJump,
        p.stagingIndexComposite,
      ]).size,
    ).toBe(1);
  });

  it("echantillon NEGATIF (count narrowe seul) -> divergence DETECTEE", () => {
    const p = eligibilityPredicates(BAD);
    expect(p.count).not.toBe(p.distinctJump);
    expect(p.count).not.toBe(p.stagingIndexJump);
    // ... mais enumeration + index staging restent coherents (seul le count a
    // ete altere -> pas de faux positif ailleurs).
    expect(p.distinctJump).toBe(p.distinctRepresentative);
    expect(p.distinctJump).toBe(p.stagingIndexJump);
    expect(p.stagingIndexJump).toBe(p.stagingIndexComposite);
    expect(p.distinctJump).toBe(EXPECTED_CANONICAL);
  });

  it("echantillon NEGATIF 2 (index composite narrowe seul) -> divergence DETECTEE", () => {
    const p = eligibilityPredicates(BAD_COMPOSITE);
    // Le composite (representant) diverge du saut/count -> le garde mord la
    // derive "representant servant un sous-ensemble".
    expect(p.stagingIndexComposite).not.toBe(p.stagingIndexJump);
    expect(p.stagingIndexComposite).not.toBe(p.count);
    expect(p.stagingIndexComposite).not.toBe(p.distinctRepresentative);
    // ... les autres sites restent coherents.
    expect(p.count).toBe(p.distinctJump);
    expect(p.distinctJump).toBe(p.stagingIndexJump);
  });

  it("le detecteur NE confond PAS la prose WHY/COMMENT (predicat cite) avec du code", () => {
    const withProse = `
-- POURQUOI : eligibilite = geom_source = 'commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL).
-- Une variante FAUSSE en prose : geom_source = 'finess_join' AND adresse <> '' (NE doit PAS etre lue).
${GOOD}
COMMENT ON FUNCTION rpps_count_ban_eligible_rows(TEXT) IS 'predicat: geom_source=commune_centroid OR (geom NULL AND adresse NOT NULL) -- variante prose bidon: AND adresse <> ''x''';
COMMENT ON FUNCTION ingest_build_rpps_staging_ban_indexes() IS 'WHERE geom_source = ''finess_join'' (prose trompeuse, hors statement)';`;
    const p = eligibilityPredicates(withProse);
    expect(p.count).toBe(EXPECTED_CANONICAL);
    expect(
      new Set([
        p.count,
        p.distinctJump,
        p.distinctRepresentative,
        p.stagingIndexJump,
        p.stagingIndexComposite,
      ]).size,
    ).toBe(1);
  });
});
