import { describe, expect, it } from "vitest";
import {
  readAllMigrationsSql as allMigrationsSql,
  indexStatement as sharedIndexStatement,
  latestFunctionBody as sharedLatestFunctionBody,
} from "./migration-sql.js";

// Garde-fou structurel SANS DB — jumeau Ameli de
// ban-eligibility-{predicate,index-expr}-parity.test.ts (eux hardcodés RPPS :
// noms + prédicat canonique RPPS `... OR (geom IS NULL ...)`, ils ne couvrent
// donc PAS Ameli). Ce guard valide la parité du dispositif backfill BAN Ameli
// (migration 20260601T000000) introduit par docs/plans/ameli-ban-backfill.md.
//
// Deux invariants load-bearing, chacun une classe de panne TOTALE silencieuse :
//
// (A) PARITÉ DU PRÉDICAT entre 6 sites VIVANTS. Le prédicat d'éligibilité Ameli
//     est `geom_source = 'commune_centroid' AND adresse IS NOT NULL` (Ameli n'a
//     pas de FINESS-join → pas de branche `geom IS NULL`, à la DIFFÉRENCE de
//     RPPS). Si UN site dérive (ex. le count gagne un `AND adresse <> ''`, ou
//     quelqu'un copie-colle la forme RPPS `OR (geom IS NULL ...)`), le count
//     diverge du set énuméré/posé → early-return success-shaped à 0 travail
//     (classe S-1), OU le ban_join pose un set ≠ de celui mesuré.
//       1. ameli_count_ban_eligible_rows           (backstop S-1)
//       2. ameli_distinct_eligible_keys            (saut + représentant)
//       3. ingest_build_ameli_staging_ban_indexes  (2 index partiels)
//       4. ingest_apply_ameli_ban_join_batch       (CTE batch — pose)
//       5. ameli_measure_ban_to_geocode            (mesure ban_to_geocode)
//
// (B) PARITÉ D'EXPRESSION DE CLÉ sur les sites INDEX-DÉPENDANTS. Le skip-scan
//     de `ameli_distinct_eligible_keys` + les 2 index posés par
//     `ingest_build_ameli_staging_ban_indexes` DOIVENT indexer/comparer le
//     WRAPPER `rpps_address_key_for_index(...)` (IMMUTABLE AVEC search_path →
//     non inliné → indexable), JAMAIS le jumeau nu `rpps_normalize_address_key`
//     (LANGUAGE sql sans search_path → inliné → expression ≠ index → planner
//     inapplicable → full-scan + timeout 60 s SILENCIEUX). Le ban_join + la
//     mesure utilisent LÉGITIMEMENT le jumeau nu (ils ne dépendent PAS du skip-
//     scan : ban_join keyset PK, mesure DISTINCT scan) → hors de cet invariant.
//
// Discipline anti-faux-vert (même que les guards RPPS) : on n'isole QUE les
// régions exécutables VIVANTES (dernier corps `$$...$$`, commentaires `--`
// retirés ; dernier statement d'index par nom), jamais un `.includes()` brut —
// la prose WHY + les `COMMENT ON ... IS '...'` citent légitimement le prédicat
// et le jumeau.

const WRAPPER = "rpps_address_key_for_index(";
const TWIN = "rpps_normalize_address_key(";

const indexStatement = (sql: string, name: string): string =>
  sharedIndexStatement(sql, name, { compact: true });
const fnBody = (sql: string, fn: string): string =>
  sharedLatestFunctionBody(sql, fn, { stripComments: true, compact: true });

const EXPECTED_PREDICATE = "geom_source = 'commune_centroid' and adresse is not null";

/**
 * Normalise un fragment de prédicat pour comparaison byte-exacte de SENS :
 * lowercase, quotes SQL dédoublées `''`→`'`, alias `t.` retiré, whitespace
 * compacté. Deux sites sémantiquement identiques → MÊME chaîne.
 */
function normalizePredicate(raw: string): string {
  return raw.toLowerCase().replace(/''/g, "'").replace(/\bt\./g, "").replace(/\s+/g, " ").trim();
}

/**
 * Extrait TOUTES les occurrences VIVANTES du prédicat d'éligibilité d'un
 * fragment exécutable. Ancre sur `geom_source = 'commune_centroid'` et capture
 * jusqu'à `adresse is not null` (forme Ameli, paren-wrappée ou nue). Renvoie []
 * si aucune (→ le test 1 mord : extraction cassée / mauvais prédicat).
 */
function extractPredicates(fragment: string): string[] {
  // Capture le prédicat COMPLET depuis `geom_source = 'commune_centroid'`
  // jusqu'au premier terminateur de clause (`)`, ORDER BY, fin de littéral
  // `$q$`, LIMIT, `;`, fin). Capturer le clause entière (pas seulement l'ancre)
  // est load-bearing : un narrowing en SUFFIXE (`... AND adresse <> ''`) doit
  // faire diverger la chaîne normalisée du canonique.
  const re = /geom_source\s*=\s*''?commune_centroid''?.*?(?=\)|order\s+by|\$q\$|limit\b|;|$)/gis;
  return (fragment.match(re) ?? []).map(normalizePredicate);
}

/**
 * Détecteur réutilisable (prouvé positif ET négatif) : à partir du SQL brut,
 * renvoie les violations de parité (prédicat + wrapper) du dispositif Ameli.
 * Liste vide = pas de dérive.
 */
function ameliEligibilityViolations(rawSql: string): string[] {
  const sql = rawSql.toLowerCase();
  const violations: string[] = [];

  const sites: Array<[string, string]> = [
    ["ameli_count_ban_eligible_rows", fnBody(sql, "ameli_count_ban_eligible_rows")],
    ["ameli_distinct_eligible_keys", fnBody(sql, "ameli_distinct_eligible_keys")],
    [
      "ingest_build_ameli_staging_ban_indexes",
      fnBody(sql, "ingest_build_ameli_staging_ban_indexes"),
    ],
    ["ingest_apply_ameli_ban_join_batch", fnBody(sql, "ingest_apply_ameli_ban_join_batch")],
    ["ameli_measure_ban_to_geocode", fnBody(sql, "ameli_measure_ban_to_geocode")],
  ];

  for (const [name, body] of sites) {
    if (!body) {
      violations.push(`corps $$...$$ de ${name} introuvable (guard inerte)`);
      continue;
    }
    const preds = extractPredicates(body);
    if (preds.length === 0) {
      violations.push(
        `${name} : aucun prédicat d'éligibilité Ameli extrait (dérive ou extraction cassée)`,
      );
      continue;
    }
    for (const p of preds) {
      if (p !== EXPECTED_PREDICATE) {
        violations.push(
          `${name} : prédicat ${JSON.stringify(p)} != ${JSON.stringify(EXPECTED_PREDICATE)}`,
        );
      }
    }
    // Copie-coller de la forme RPPS = bug : le `OR (geom IS NULL ...)` ferait
    // diverger Ameli de son ban_join (qui n'a pas cette branche).
    if (body.includes("geom is null")) {
      violations.push(
        `${name} : contient \`geom is null\` (forme RPPS copiée par erreur — Ameli n'a pas de branche geom NULL)`,
      );
    }
  }

  // (B) Sites INDEX-DÉPENDANTS : wrapper obligatoire, jamais le jumeau nu.
  const enumBody = fnBody(sql, "ameli_distinct_eligible_keys");
  if (enumBody) {
    if (enumBody.includes(TWIN)) {
      violations.push(
        `ameli_distinct_eligible_keys : corps appelle le JUMEAU NU ${TWIN} (inliné → index inapplicable → timeout)`,
      );
    }
    const wrapperHits = enumBody.split(WRAPPER).length - 1;
    if (wrapperHits < 5) {
      violations.push(
        `ameli_distinct_eligible_keys : attendu >= 5 occurrences du wrapper (saut + keyset + représentant), vu ${wrapperHits}`,
      );
    }
    if (!/rpps_address_key_for_index\([^)]*\)\s*>\s*\$1/.test(enumBody)) {
      violations.push(
        "ameli_distinct_eligible_keys : keyset de saut (keyexpr > $1) n'utilise PAS le wrapper",
      );
    }
    if (!/order\s+by\s+rpps_address_key_for_index\([^)]*\)\s*,\s*t\.id\b/.test(enumBody)) {
      violations.push(
        "ameli_distinct_eligible_keys : ORDER BY du représentant n'est pas `<wrapper>, t.id` (MIN(id) non déterministe)",
      );
    }
  }

  for (const name of [
    "ameli_staging_ban_eligible_normkey_idx",
    "ameli_staging_ban_eligible_normkey_id_idx",
  ]) {
    const stmt = indexStatement(sql, name);
    if (!stmt) {
      violations.push(
        `statement CREATE INDEX ${name} introuvable (posé par ingest_build_ameli_staging_ban_indexes)`,
      );
      continue;
    }
    const keyExpr = (stmt.match(/\bon\s+annuaire_ameli_staging\s*\(((?:[^()]|\([^()]*\))*)\)/) ?? [
      "",
      "",
    ])[1];
    if (!keyExpr.includes(WRAPPER)) {
      violations.push(`index ${name} : keyexpr n'utilise PAS ${WRAPPER}`);
    }
    if (keyExpr.includes(TWIN)) {
      violations.push(`index ${name} : keyexpr appelle le JUMEAU NU ${TWIN}`);
    }
  }
  // Le composite DOIT se terminer par `, id` (représentant MIN(id) couvert).
  const composite = indexStatement(sql, "ameli_staging_ban_eligible_normkey_id_idx");
  if (composite) {
    const keyExpr = (composite.match(
      /\bon\s+annuaire_ameli_staging\s*\(((?:[^()]|\([^()]*\))*)\)/,
    ) ?? ["", ""])[1];
    if (!/,\s*id\s*$/.test(keyExpr.trim())) {
      violations.push(
        `index composite ameli_staging_ban_eligible_normkey_id_idx ne se termine PAS par , id — vu: ${keyExpr}`,
      );
    }
  }

  return violations;
}

describe("ameli_ban_eligible : parité prédicat + expression de clé (drift guard)", () => {
  const rawSql = allMigrationsSql();

  it("la migration RÉELLE ne présente AUCUNE violation (locke l'invariant)", () => {
    expect(ameliEligibilityViolations(rawSql)).toEqual([]);
  });

  it("les 5 corps de fonction Ameli existent et exposent le prédicat canonique", () => {
    const sql = rawSql.toLowerCase();
    for (const fn of [
      "ameli_count_ban_eligible_rows",
      "ameli_distinct_eligible_keys",
      "ingest_build_ameli_staging_ban_indexes",
      "ingest_apply_ameli_ban_join_batch",
      "ameli_measure_ban_to_geocode",
    ]) {
      const body = fnBody(sql, fn);
      expect(body.length, `corps de ${fn} introuvable`).toBeGreaterThan(0);
      expect(extractPredicates(body).length, `prédicat Ameli absent de ${fn}`).toBeGreaterThan(0);
    }
  });
});

// Preuve que le détecteur MORD (positif + négatif + immunité prose).
describe("ameliEligibilityViolations : prouvé positif ET négatif", () => {
  const GOOD = `
CREATE OR REPLACE FUNCTION ameli_count_ban_eligible_rows(p TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT count(*) FROM %I t WHERE (t.geom_source = ''commune_centroid'' AND t.adresse IS NOT NULL)', v) INTO c;
  RETURN c;
END; $$;
CREATE OR REPLACE FUNCTION ingest_build_ameli_staging_ban_indexes() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS ameli_staging_ban_eligible_normkey_idx
    ON annuaire_ameli_staging (rpps_address_key_for_index(adresse, code_postal, code_insee))
    WHERE geom_source = 'commune_centroid' AND adresse IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ameli_staging_ban_eligible_normkey_id_idx
    ON annuaire_ameli_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid' AND adresse IS NOT NULL;
END; $$;
CREATE OR REPLACE FUNCTION ameli_distinct_eligible_keys(p TEXT, a TEXT, l INT) RETURNS TABLE (k TEXT) LANGUAGE plpgsql AS $$
DECLARE v_prev TEXT := a; v_key TEXT;
BEGIN
  FOR i IN 1..l LOOP
    EXECUTE format($q$
      SELECT rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      FROM %I t
      WHERE ( t.geom_source = 'commune_centroid' AND t.adresse IS NOT NULL )
        AND ( $1 IS NULL OR rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) > $1 )
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) LIMIT 1
    $q$, v) INTO v_key USING v_prev;
    EXIT WHEN v_key IS NULL;
    EXECUTE format($q$
      SELECT btrim(t.adresse) FROM %I t
      WHERE ( t.geom_source = 'commune_centroid' AND t.adresse IS NOT NULL )
        AND rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) = $1
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id LIMIT 1
    $q$, v) INTO adresse USING v_key;
    v_prev := v_key;
  END LOOP;
END; $$;
CREATE OR REPLACE FUNCTION ingest_apply_ameli_ban_join_batch(p_after BIGINT, p_limit INT)
RETURNS TABLE(last_id BIGINT, applied INT) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY WITH batch AS (
    SELECT id, rpps_normalize_address_key(adresse, code_postal, code_insee) AS akey
    FROM annuaire_ameli_staging
    WHERE id > p_after AND geom_source = 'commune_centroid' AND adresse IS NOT NULL
    ORDER BY id LIMIT p_limit
  ), upd AS (
    UPDATE annuaire_ameli_staging r SET geom_source = 'ban_address'
    FROM batch b JOIN geocoded_addresses g ON g.address_key = b.akey AND g.accepted = true
    WHERE r.id = b.id RETURNING 1
  )
  SELECT max(b.id)::BIGINT, (SELECT count(*)::INT FROM upd) FROM batch b;
END; $$;
CREATE OR REPLACE FUNCTION ameli_measure_ban_to_geocode(p TEXT) RETURNS TABLE(eligible_distinct BIGINT, to_geocode_distinct BIGINT) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE format($q$
    WITH staging_eligible AS (
      SELECT DISTINCT rpps_normalize_address_key(t.adresse, t.code_postal, t.code_insee) AS k
      FROM %I t WHERE t.geom_source = 'commune_centroid' AND t.adresse IS NOT NULL
    )
    SELECT count(*)::BIGINT, count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM geocoded_addresses g WHERE g.address_key = se.k AND (g.accepted = true OR g.ban_attempt_count >= 3)
    ))::BIGINT FROM staging_eligible se
  $q$, v);
END; $$;`;

  it("échantillon POSITIF → 0 violation", () => {
    expect(ameliEligibilityViolations(GOOD)).toEqual([]);
  });

  it("NÉGATIF : count narrowe seul (`AND adresse <> ''`) → divergence détectée", () => {
    const BAD = GOOD.replace(
      "WHERE (t.geom_source = ''commune_centroid'' AND t.adresse IS NOT NULL)",
      "WHERE (t.geom_source = ''commune_centroid'' AND t.adresse IS NOT NULL AND t.adresse <> '''')",
    );
    const v = ameliEligibilityViolations(BAD);
    expect(v.some((m) => m.includes("ameli_count_ban_eligible_rows") && m.includes("!="))).toBe(
      true,
    );
  });

  it("NÉGATIF : forme RPPS `OR (geom IS NULL ...)` copiée → détectée", () => {
    const BAD = GOOD.replace(
      "WHERE geom_source = 'commune_centroid' AND adresse IS NOT NULL;\n  CREATE INDEX IF NOT EXISTS ameli_staging_ban_eligible_normkey_id_idx",
      "WHERE geom_source = 'commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL);\n  CREATE INDEX IF NOT EXISTS ameli_staging_ban_eligible_normkey_id_idx",
    );
    const v = ameliEligibilityViolations(BAD);
    expect(v.some((m) => m.includes("geom is null"))).toBe(true);
  });

  it("NÉGATIF : enum appelle le jumeau nu → détecté", () => {
    const BAD = GOOD.replaceAll(
      "rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)",
      "rpps_normalize_address_key(t.adresse, t.code_postal, t.code_insee)",
    );
    const v = ameliEligibilityViolations(BAD);
    expect(
      v.some((m) => m.includes("ameli_distinct_eligible_keys") && m.includes("JUMEAU NU")),
    ).toBe(true);
  });

  it("immunité prose : un COMMENT citant le jumeau / une fausse forme NE casse PAS le guard", () => {
    const withProse = `${GOOD}
COMMENT ON FUNCTION ameli_distinct_eligible_keys(TEXT, TEXT, INT) IS 'délègue à rpps_normalize_address_key ; prédicat geom IS NULL bidon en prose';`;
    expect(ameliEligibilityViolations(withProse)).toEqual([]);
  });
});
