-- FINESS = Fichier National des Établissements Sanitaires et Sociaux (ANS)
-- Source: ANS bimonthly CSV at data.gouv.fr / finess.sante.gouv.fr
-- Volume: ~80K rows, refreshed every 2 months

CREATE TABLE finess (
  num_finess          CHAR(9)      PRIMARY KEY,
  raison_sociale      TEXT         NOT NULL,
  categorie_code      VARCHAR(4),
  categorie_libelle   TEXT,
  num_voie            VARCHAR(10),
  type_voie           VARCHAR(50),
  voie                TEXT,
  code_postal         CHAR(5),
  code_insee          CHAR(5)      NOT NULL,
  ville               TEXT,
  telephone           VARCHAR(20),
  email               TEXT,
  date_ouverture      DATE,
  date_maj            DATE,
  geom                geometry(Point, 4326),
  raw                 JSONB,
  created_at          TIMESTAMPTZ  DEFAULT now()
);

-- Spatial index for ST_DWithin queries (sub-100ms on 80K rows)
CREATE INDEX finess_geom_gist     ON finess USING GIST (geom);
-- Lookups by category (e.g. all EHPAD)
CREATE INDEX finess_categorie_idx ON finess (categorie_code);
-- Department-prefix lookups (left(code_insee, 2))
CREATE INDEX finess_dept_idx      ON finess (left(code_insee, 2));

-- Read-only public access via RLS
ALTER TABLE finess ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon read finess" ON finess FOR SELECT TO anon USING (true);
