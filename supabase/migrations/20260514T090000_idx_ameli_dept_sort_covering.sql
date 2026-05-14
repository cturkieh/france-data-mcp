-- V0.9.4 — Index couvrant `(dept, insee, nom, prenom, id)` sur Ameli pour
-- éliminer le top-N heapsort sur `professionnels_par_specialite_dept`.
--
-- Symptôme prod (Sentry FRANCE-DATA-MCP-3, 3 events 13-14 mai 2026, dont
-- 2 sur user_agent `openai-mcp/1.0.0` et 1 sur `Claude-User`) : timeout
-- SQL 57014 (statement_timeout 8s anon) sur `getAmeliBySpecialiteDept`.
--
-- Diagnostic : la RPC `ameli_by_specialite_dept` (V0.4.1) utilise
-- `ORDER BY code_insee NULLS LAST, nom, prenom, id` + `OFFSET/LIMIT`. Les
-- composite indexes V0.4.1 `(code_departement, specialite_code)` et
-- `(code_departement, type_ps_code)` couvrent bien le WHERE mais l'ORDER BY
-- doit ensuite faire un top-N heapsort en RAM. Sur Paris (30K PS), avec
-- contention DB ponctuelle ou plan generic défavorable, le sort dépasse 8s.
--
-- Fix : index couvrant aligné sur le tri exact de la RPC. Postgres peut
-- alors faire un Index Range Scan + Index-Only ordering, sans sort, et
-- s'arrêter au LIMIT. Coût query : O(N log N) → O(LIMIT). Bénéficie
-- particulièrement au cas "department-only sans filtre" (cas non couvert
-- par les composite indexes existants).
--
-- Coût stockage : ~95 MB sur annuaire_ameli (485K × ~200 bytes/row).
-- Acceptable sur Supabase Pro 8 GB.
--
-- Pattern aligné avec V0.8.1 `rpps_profession_savoir_faire_partial_idx`
-- (même approche covering qui avait résolu un timeout 57014 similaire).
--
-- Note CONCURRENTLY : Supabase migrations tournent dans une transaction,
-- donc CREATE INDEX CONCURRENTLY n'est pas autorisé. Un CREATE INDEX
-- bloquant sur 485K rows finit en quelques secondes. ANALYZE final pour
-- rafraîchir les stats que le planner utilise pour choisir entre les 3
-- indexes composites disponibles.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) Index couvrant sur prod
-- ──────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS annuaire_ameli_dept_sort_covering_idx
  ON annuaire_ameli (code_departement, code_insee NULLS LAST, nom, prenom, id);

COMMENT ON INDEX annuaire_ameli_dept_sort_covering_idx IS
  'V0.9.4 — index couvrant ORDER BY de ameli_by_specialite_dept (évite top-N heapsort 57014).';

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Mirror staging — superset strict de 20260508000021 + nouveau covering
-- ──────────────────────────────────────────────────────────────────────────
--
-- Le pipeline d'ingestion hebdo Ameli :
--   1. `ingest_create_annuaire_ameli_staging()` → DROP + CREATE TABLE staging
--   2. INSERT … staging (~485K rows)
--   3. `ingest_atomic_swap('annuaire_ameli')` → renomme staging → prod
--
-- Sans répliquer le covering index sur la staging table, le swap atomique
-- (RENAME) perdrait l'index à la prochaine ingestion lundi prochain et le
-- timeout 57014 reviendrait silencieusement. Pattern V0.4.1 répété.

CREATE OR REPLACE FUNCTION ingest_create_annuaire_ameli_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS annuaire_ameli_staging CASCADE;
  CREATE TABLE annuaire_ameli_staging (
    id                            BIGSERIAL    PRIMARY KEY,
    nom                           TEXT         NOT NULL,
    prenom                        TEXT         NOT NULL,
    civilite                      TEXT,
    raison_sociale                TEXT,
    specialite_code               TEXT,
    specialite_libelle            TEXT,
    type_ps_code                  TEXT,
    type_ps_libelle               TEXT,
    activite_particuliere_code    TEXT,
    activite_particuliere_libelle TEXT,
    adresse                       TEXT,
    code_postal                   CHAR(5),
    ville                         TEXT,
    code_departement              CHAR(3)      NOT NULL,
    code_insee                    CHAR(5),
    secteur_conventionnel_code    TEXT,
    secteur_conventionnel_libelle TEXT,
    nature_exercice_code          TEXT,
    nature_exercice_libelle       TEXT,
    option_tarifaire_code         TEXT,
    option_tarifaire_libelle      TEXT,
    telephone                     TEXT,
    geom                          geometry(Point, 4326),
    geog                          GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    raw                           JSONB,
    created_at                    TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX annuaire_ameli_staging_geog_gist      ON annuaire_ameli_staging USING GIST (geog);
  CREATE INDEX annuaire_ameli_staging_dept_idx       ON annuaire_ameli_staging (code_departement);
  CREATE INDEX annuaire_ameli_staging_specialite_idx ON annuaire_ameli_staging (specialite_code);
  CREATE INDEX annuaire_ameli_staging_type_ps_idx    ON annuaire_ameli_staging (type_ps_code);
  CREATE INDEX annuaire_ameli_staging_insee_idx      ON annuaire_ameli_staging (code_insee);
  -- v0.4.1 composite indexes — survive the swap
  CREATE INDEX annuaire_ameli_staging_dept_spec_idx  ON annuaire_ameli_staging (code_departement, specialite_code);
  CREATE INDEX annuaire_ameli_staging_dept_type_idx  ON annuaire_ameli_staging (code_departement, type_ps_code);
  -- v0.9.4 covering index for ORDER BY of ameli_by_specialite_dept
  CREATE INDEX annuaire_ameli_staging_dept_sort_covering_idx
    ON annuaire_ameli_staging (code_departement, code_insee NULLS LAST, nom, prenom, id);

  ALTER TABLE annuaire_ameli_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read annuaire_ameli" ON annuaire_ameli_staging
    FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- (3) ANALYZE + reload schema cache
-- ──────────────────────────────────────────────────────────────────────────

ANALYZE annuaire_ameli;

NOTIFY pgrst, 'reload schema';
