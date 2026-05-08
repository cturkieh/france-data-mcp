-- V0.4 phase 1 — Annuaire Santé Ameli (PS libéraux conventionnés).
-- Source : data.gouv `annuaire-sante-ameli`, CSV ~154 Mo, MAJ hebdo.
-- Reuses the FINESS playbook : geog GENERATED STORED for ST_DWithin index lookup,
-- code_departement CHAR(3) for fast dept filter, RLS anon read, atomic swap.
--
-- Differences with FINESS:
--   - No stable identifier in the public CSV (RPPS/ADELI absent), so the PK
--     is a synthetic BIGSERIAL. Idempotence relies on the swap rename, not on
--     ON CONFLICT.
--   - No GPS coords in the CSV. Geocoding is computed client-side at ingestion
--     time from the commune centroid (geo.api.gouv.fr), so geom is populated
--     directly on INSERT — there's no `apply_geom_batch` RPC like FINESS needed.
--   - code_insee is NULLABLE: when commune matching fails (CP+ville unknown
--     in geo.api.gouv), we still store the row with the rest of the data.

CREATE TABLE IF NOT EXISTS annuaire_ameli (
  id                            BIGSERIAL    PRIMARY KEY,
  -- Identité
  nom                           TEXT         NOT NULL,
  prenom                        TEXT         NOT NULL,
  civilite                      TEXT,
  raison_sociale                TEXT,
  -- Spécialité / type
  specialite_code               TEXT,
  specialite_libelle            TEXT,
  type_ps_code                  TEXT,
  type_ps_libelle               TEXT,
  activite_particuliere_code    TEXT,
  activite_particuliere_libelle TEXT,
  -- Adresse texte (concaténation voie + complement + lieu_dit)
  adresse                       TEXT,
  code_postal                   CHAR(5),
  ville                         TEXT,
  code_departement              CHAR(3)      NOT NULL,
  -- Nullable: present only when commune matching succeeded
  code_insee                    CHAR(5),
  -- Conventions
  secteur_conventionnel_code    TEXT,
  secteur_conventionnel_libelle TEXT,
  nature_exercice_code          TEXT,
  nature_exercice_libelle       TEXT,
  option_tarifaire_code         TEXT,
  option_tarifaire_libelle      TEXT,
  -- Contact
  telephone                     TEXT,
  -- Geo: commune centroid resolved at ingestion time (NULL if commune unmatched).
  geom                          geometry(Point, 4326),
  -- Generated geography column powers ST_DWithin index lookups (FINESS lesson).
  geog                          GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
  raw                           JSONB,
  created_at                    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS annuaire_ameli_geog_gist        ON annuaire_ameli USING GIST (geog);
CREATE INDEX IF NOT EXISTS annuaire_ameli_dept_idx         ON annuaire_ameli (code_departement);
CREATE INDEX IF NOT EXISTS annuaire_ameli_specialite_idx   ON annuaire_ameli (specialite_code);
CREATE INDEX IF NOT EXISTS annuaire_ameli_type_ps_idx      ON annuaire_ameli (type_ps_code);
CREATE INDEX IF NOT EXISTS annuaire_ameli_insee_idx        ON annuaire_ameli (code_insee);

ALTER TABLE annuaire_ameli ENABLE ROW LEVEL SECURITY;

-- Anon SELECT only — same policy contract as `finess`. The staging policy
-- MUST use the exact same name + USING clause so the swap rename preserves
-- access (see FINESS V0.2 RLS staging gotcha).
DROP POLICY IF EXISTS "anon read annuaire_ameli" ON annuaire_ameli;
CREATE POLICY "anon read annuaire_ameli" ON annuaire_ameli
  FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
