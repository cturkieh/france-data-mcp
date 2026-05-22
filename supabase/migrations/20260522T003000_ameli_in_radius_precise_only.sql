-- `ameli_in_radius` gagne un param `p_precise_only BOOLEAN DEFAULT FALSE` —
-- jumeau du `p_precise_only` de `rpps_in_radius` (V0.12.0, migration
-- 20260520T100000_rpps_in_radius_precise_only.sql).
--
-- Quand true : seuls les PS géocodés à l'adresse BAN (`geom_source =
-- 'ban_address'`, ~77 % du référentiel post-Chantier C V0.14.0) sont
-- retournés — `distance_km` exacte au m près, classement intra-commune
-- fiable. Les ~23 % au centroïde commune (`geom_source = 'commune_centroid'`)
-- sont exclus.
--
-- Quand false (= défaut) : `%s` vide → requête VERBATIM la def 20260521T103000
-- → comportement V0.14.0 inchangé.
--
-- STRUCTURE — `RETURN QUERY EXECUTE format(...)`, PAS un `RETURN QUERY`
-- statique avec `(NOT p_precise_only OR geom_source = 'ban_address')` :
--   1. Le filtre `geom_source = 'ban_address'` DOIT être un LITTÉRAL pour que
--      le planner puisse élire le GiST PARTIEL `annuaire_ameli_geog_precise_gist`
--      (prédicat `WHERE geom_source = 'ban_address'`). Mélanger le param dans
--      la condition rendrait le partiel inéligible. Le fragment `%s` injecte
--      donc le littéral (ou rien) selon `p_precise_only`.
--   2. `EXECUTE` re-planifie à CHAQUE appel en custom plan (valeurs réelles) :
--      AUCUN generic plan plpgsql. Un `RETURN QUERY` statique met le plan en
--      cache et peut basculer en generic plan après ~5 appels — et un generic
--      plan ne peut PAS prouver l'éligibilité du partiel → repli GiST GLOBAL
--      `annuaire_ameli_geog_gist` + Filter post-index → en zone dense le bbox
--      ramène le cluster co-localisé `commune_centroid` → timeout 57014
--      (piège prouvé prod RPPS, cf. gotchas CLAUDE.md rpps-in-radius).
-- Même pattern `RETURN QUERY EXECUTE format(...) USING` que la fonction
-- voisine `ameli_by_specialite_dept` dans ce fichier.
--
-- POURQUOI pas le split CTE complet de RPPS (precise UNION ALL centroid +
-- matview `rpps_commune_centroids` + DROP du GiST global) : RPPS a dû le faire
-- car pré-V0.12 ses 2,2 M lignes étaient TOUTES au centroïde (cluster Paris
-- ~77 K co-localisées). `annuaire_ameli` ~462 K lignes dont ~77 % déjà en
-- adresse BAN, les ~23 % résiduels répartis sur ~35 K communes — le chemin
-- hybride (GiST global, KNN) absorbe déjà ces clusters en prod, et le chemin
-- précis a son GiST partiel dédié. Ni matview ni DROP du global requis.
--
-- ✅ GATE EXPLAIN exécuté en prod le 2026-05-22 (Paris centre, rayon 1 km,
-- requête standalone à littéral `geom_source = 'ban_address'` = la branche
-- précise une fois `%s` injecté) : `Index Scan using
-- annuaire_ameli_geog_precise_gist`, Execution Time 149 ms (cache froid),
-- aucun `Rows Removed by Filter` — les 3 critères GO remplis. Le chemin
-- hybride (sans filtre) : `Index Scan using annuaire_ameli_geog_gist`, 52 ms.
-- Détail : docs/plans/ameli-precise-only.md.
--
-- ⚠️ Postgres INTERDIT `CREATE OR REPLACE FUNCTION` quand la signature change
-- (ajout d'un param, même avec DEFAULT) → ERROR 42P13. DROP explicite
-- obligatoire AVANT le CREATE. Le DROP révoque le GRANT → re-GRANT après.
--
-- `ameli_by_specialite_dept` n'est PAS touchée (precise_only n'a pas de sens
-- pour un listing départemental non spatial).
--
-- APPLICATION : naming `YYYYMMDDThhmmss` → CLI Supabase `db push` saute, à
-- appliquer MANUELLEMENT en prod via dashboard SQL editor.

DROP FUNCTION IF EXISTS ameli_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT);

CREATE OR REPLACE FUNCTION ameli_in_radius(
  p_lat               DOUBLE PRECISION,
  p_lon               DOUBLE PRECISION,
  p_radius_meters     DOUBLE PRECISION,
  p_specialite_codes  TEXT[],
  p_type_ps_codes     TEXT[],
  p_limit             INT,
  p_precise_only      BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id                            BIGINT,
  nom                           TEXT,
  prenom                        TEXT,
  civilite                      TEXT,
  raison_sociale                TEXT,
  specialite_code               TEXT,
  specialite_libelle            TEXT,
  type_ps_code                  TEXT,
  type_ps_libelle               TEXT,
  adresse                       TEXT,
  code_postal                   CHAR(5),
  ville                         TEXT,
  code_departement              CHAR(3),
  code_insee                    CHAR(5),
  secteur_conventionnel_code    TEXT,
  secteur_conventionnel_libelle TEXT,
  nature_exercice_code          TEXT,
  nature_exercice_libelle       TEXT,
  option_tarifaire_code         TEXT,
  option_tarifaire_libelle      TEXT,
  telephone                     TEXT,
  geom                          JSONB,
  distance_meters               DOUBLE PRECISION,
  geom_source                   TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  -- `%s` = `AND a.geom_source = 'ban_address'` (littéral) quand precise_only,
  -- vide sinon. EXECUTE → custom plan à chaque appel (cf. en-tête).
  RETURN QUERY EXECUTE format($q$
    SELECT
      a.id,
      a.nom, a.prenom, a.civilite, a.raison_sociale,
      a.specialite_code, a.specialite_libelle,
      a.type_ps_code, a.type_ps_libelle,
      a.adresse, a.code_postal, a.ville,
      a.code_departement, a.code_insee,
      a.secteur_conventionnel_code, a.secteur_conventionnel_libelle,
      a.nature_exercice_code, a.nature_exercice_libelle,
      a.option_tarifaire_code, a.option_tarifaire_libelle,
      a.telephone,
      ST_AsGeoJSON(a.geom)::jsonb AS geom,
      ST_Distance(a.geog, $1) AS distance_meters,
      a.geom_source
    FROM annuaire_ameli a
    WHERE a.geog IS NOT NULL
      %s
      AND ST_DWithin(a.geog, $1, $2)
      AND (cardinality($3) = 0 OR a.specialite_code = ANY($3))
      AND (cardinality($4) = 0 OR a.type_ps_code    = ANY($4))
    ORDER BY a.geog <-> $1
    LIMIT $5
  $q$, CASE WHEN p_precise_only THEN $frag$AND a.geom_source = 'ban_address'$frag$ ELSE '' END)
  USING v_point, p_radius_meters, p_specialite_codes, p_type_ps_codes, p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION ameli_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT, BOOLEAN
) TO anon;

COMMENT ON FUNCTION ameli_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT, BOOLEAN
) IS
  'Recherche PS libéraux Ameli dans un rayon (PostGIS KNN). p_precise_only true → fragment littéral geom_source=ban_address injecté (GiST partiel, ~77 % post-Chantier C, distance exacte). false (défaut) → comportement V0.14.0 inchangé (hybride adresse + centroïde commune). RETURN QUERY EXECUTE = custom plan par appel, jamais de generic plan.';

NOTIFY pgrst, 'reload schema';
