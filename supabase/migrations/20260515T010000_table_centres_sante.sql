-- V0.10 — Centres de santé (CDS).
-- Source : data.gouv `annuaire-sante-ameli` section CDS (CNAM), CSV ~3 Mo, MAJ hebdo.
-- ~3K CDS uniques (CSV dénormalisé par profession exercée → ~8-15K lignes brutes).
-- Encadrés L.6323-1 CSP : structures de soins ambulatoires non lucratives
-- (associations, mutuelles, communes, hôpitaux) — pivot via `etab_finess`
-- vers FINESS DREES (catégorie 124 / 125 dépréciée).
--
-- Différenciateur métier vs FINESS : carte_vitale, apcv (Application Carte
-- Vitale), spécialités exercées sur place. PAS d'horaires/tarifs/secteur 1/2
-- (CNAM les a explicitement retirés du nouvel annuaire post-2025).
--
-- Reuses the FINESS/Ameli playbook : geog GENERATED STORED for ST_DWithin
-- index lookup, code_departement CHAR(3) for fast dept filter, RLS anon
-- read, atomic swap. Différences :
--   - PK = `etab_finess` CHAR(9) (clé naturelle stable, pivot direct FINESS).
--     Idempotence du swap rename (pas de ON CONFLICT).
--   - Spécialités dénormalisées en TEXT[] (1 row CDS = N lignes CSV
--     groupées). Index GIN pour les filtres `&& ARRAY[...]` (array overlap) performants.
--   - code_insee NULLABLE : enrichi à l'ingestion via geo.api.gouv (CP+ville)
--     OU pivot FINESS, selon disponibilité.
--   - Code 125 (CDS dentaire) traité comme alias de 124 (en voie d'extinction
--     côté CNAM) — stocké tel quel, normalisation côté lecture si besoin.

CREATE TABLE IF NOT EXISTS centres_sante (
  -- Pivot FINESS : clé naturelle stable, jointure directe avec finess.num_finess.
  etab_finess               CHAR(9)      PRIMARY KEY,
  -- Identité
  etab_raison_sociale       TEXT         NOT NULL,
  -- Donnée métier (différenciateur vs FINESS)
  accepte_carte_vitale      BOOLEAN      NOT NULL,
  accepte_apcv              BOOLEAN      NOT NULL,
  -- Spécialités exercées sur place (dénormalisation CSV → array Postgres).
  -- Annexe A CNAM : 70+ codes. Tableaux alignés (specialites_codes[i] ↔
  -- specialites_libelles[i]). Tri stable par code à l'ingestion pour
  -- déduplication idempotente.
  specialites_codes         TEXT[]       NOT NULL,
  specialites_libelles      TEXT[]       NOT NULL,
  -- Type d'établissement (Annexe B). `124` = CDS standard, `125` = CDS
  -- dentaire (déprécié CNAM, en voie d'extinction). Stocké tel quel —
  -- la normalisation 125→124 est laissée au caller MCP si pertinent.
  type_etab_code            TEXT         NOT NULL,
  type_etab_libelle         TEXT         NOT NULL,
  -- Contact
  telephone                 TEXT,
  -- Adresse (4 champs CSV → adresse ligne unique côté lecture lib).
  voie                      TEXT,
  complement_voie           TEXT,
  lieu_dit                  TEXT,
  code_postal               CHAR(5)      NOT NULL,
  ville                     TEXT         NOT NULL,
  code_departement          CHAR(3)      NOT NULL,
  -- Nullable : présent quand commune matching réussit (geo.api OU pivot FINESS).
  code_insee                CHAR(5),
  -- Geo : centroïde commune (geo.api.gouv) OU coords FINESS si pivot dispo.
  -- Pas de coords natives dans le CSV CDS (lesson : aligné avec annuaire_ameli).
  geom                      geometry(Point, 4326),
  -- Generated geography column powers ST_DWithin index lookups (FINESS lesson).
  geog                      GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
  -- raw JSONB par défaut vide (économie 150-560 MB DB) — populer uniquement
  -- si futur tool MCP en a besoin (lesson V0.4 ameli).
  raw                       JSONB        DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ  DEFAULT now()
);

-- Spatial index : ST_DWithin queries radius (sub-100ms attendu sur ~3K rows).
CREATE INDEX IF NOT EXISTS centres_sante_geog_gist        ON centres_sante USING GIST (geog);
-- NOTE perf : sur ~3K rows, ST_DWithin + ORDER BY geog <-> point fait un
-- seq scan + sort de toute façon (le GIST KNN n'est rentable qu'au-delà de
-- ~10K rows). Les 4 index ci-dessous (dept/insee/type/GIN) n'apportent AUCUN
-- gain runtime à ce volume — ils sont conservés délibérément par symétrie
-- de pattern avec annuaire_ameli/finess (485K/95K rows où ils SONT justifiés)
-- et comme future-proofing si le volume CDS croît (ex: extension CDS infirmiers
-- isolés, ~+5K). Coût write/disk négligeable sur 3K rows. Ne PAS les retirer
-- "pour optimiser" : le maintien du pattern uniforme inter-sources prime.
-- Department-level filters (dense queries Paris/Marseille/Lyon si volume croît).
CREATE INDEX IF NOT EXISTS centres_sante_dept_idx         ON centres_sante (code_departement);
-- Commune-level filters (panorama_sante_territoire complement).
CREATE INDEX IF NOT EXISTS centres_sante_insee_idx        ON centres_sante (code_insee);
-- Type filters (CDS standard 124 vs dentaire 125).
CREATE INDEX IF NOT EXISTS centres_sante_type_idx         ON centres_sante (type_etab_code);
-- GIN sur specialites_codes pour `&& ARRAY['01','22']` (array overlap any-of)
-- ou `@> ARRAY['53']` (array contains all). Coût ~5% disk vs B-tree, OK sur 3K.
CREATE INDEX IF NOT EXISTS centres_sante_specialites_gin  ON centres_sante USING GIN (specialites_codes);

ALTER TABLE centres_sante ENABLE ROW LEVEL SECURITY;

-- Anon SELECT only — même contrat que finess / annuaire_ameli. La policy
-- staging DOIT utiliser le même nom + même USING clause pour que le swap
-- rename préserve l'accès anon (lesson V0.2 RLS staging).
DROP POLICY IF EXISTS "anon read centres_sante" ON centres_sante;
CREATE POLICY "anon read centres_sante" ON centres_sante
  FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
