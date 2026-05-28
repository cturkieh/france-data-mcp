-- Phase B étape 2 — tables démographiques IRIS (RP 2022, comptes BRUTS).
-- Cf. docs/plans/iris-infracommunal.md §3. Source INSEE RP 2022 niveau IRIS
-- (géo 01/01/2024, alignée avec les contours IGN de l'étape 1).
--
-- DEUX tables séparées par fichier source (arbitrage modèle de données) :
--   • iris_population : base-ic-evol-struct-pop-2022 (âge + CSP)
--   • iris_familles   : base-ic-couples-familles-menages-2022 (ménages/familles)
-- Jointes à `iris` sur code_iris (PK) au query-time → PAS de matview (pas de
-- bombe OID), refresh/swap INDÉPENDANTS par source. Le cron annuel unifié
-- (scripts/ingest/iris.ts) ingère contours + ces 2 blocs en un run.
--
-- COMPTES BRUTS (NUMERIC nullable — l'INSEE peut diffuser des estimations
-- décimales / des cellules vides par secret statistique sur petits effectifs).
-- Les PARTS (R3 du contrat profil_iris) sont calculées Σ/Σ au query-time, JAMAIS
-- pré-stockées (une moyenne de pourcentages biaiserait l'agrégat bassin).
--
-- PARITÉ PROD ↔ STAGING : staging-create recopie VERBATIM la table prod.
-- Garde-fou staging-parity.test.ts. Pas d'index hors PK (jointures sur code_iris).

-- ── iris_population (âge + CSP) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iris_population (
  code_iris          CHAR(9) PRIMARY KEY,   -- = iris.code_iris (colonne CSV "IRIS")
  pop_total          NUMERIC,               -- P22_POP
  pop_0_14           NUMERIC,               -- P22_POP0014
  pop_15_29          NUMERIC,               -- P22_POP1529
  pop_30_44          NUMERIC,               -- P22_POP3044
  pop_45_59          NUMERIC,               -- P22_POP4559
  pop_60_74          NUMERIC,               -- P22_POP6074
  pop_75p            NUMERIC,               -- P22_POP75P
  pop_65p            NUMERIC,               -- P22_POP65P (agrégat INSEE distinct, pas dérivé)
  pop_15p            NUMERIC,               -- C22_POP15P (dénominateur des parts CSP)
  csp_agriculteurs   NUMERIC,               -- C22_POP15P_STAT_GSEC11_21
  csp_artisans_comm  NUMERIC,               -- C22_POP15P_STAT_GSEC12_22 (artisans/comm/chefs)
  csp_cadres         NUMERIC,               -- C22_POP15P_STAT_GSEC13_23
  csp_prof_interm    NUMERIC,               -- C22_POP15P_STAT_GSEC14_24
  csp_employes       NUMERIC,               -- C22_POP15P_STAT_GSEC15_25
  csp_ouvriers       NUMERIC,               -- C22_POP15P_STAT_GSEC16_26
  csp_retraites      NUMERIC,               -- C22_POP15P_STAT_GSEC32
  csp_autres         NUMERIC,               -- C22_POP15P_STAT_GSEC40 (sans activité)
  created_at         TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE iris_population ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read iris_population" ON iris_population;
CREATE POLICY "anon read iris_population" ON iris_population FOR SELECT TO anon USING (true);

-- ── iris_familles (ménages / familles) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS iris_familles (
  code_iris                CHAR(9) PRIMARY KEY,
  menages_total            NUMERIC,          -- C22_MEN
  couples_avec_enfants     NUMERIC,          -- C22_MENCOUPAENF
  couples_sans_enfants     NUMERIC,          -- C22_MENCOUPSENF
  familles_monoparentales  NUMERIC,          -- C22_MENFAMMONO
  created_at               TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE iris_familles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read iris_familles" ON iris_familles;
CREATE POLICY "anon read iris_familles" ON iris_familles FOR SELECT TO anon USING (true);

-- ── Staging-creates (recopie VERBATIM des tables prod ci-dessus) ─────────────
CREATE OR REPLACE FUNCTION ingest_create_iris_population_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS iris_population_staging CASCADE;
  CREATE TABLE iris_population_staging (
    code_iris          CHAR(9) PRIMARY KEY,
    pop_total          NUMERIC,
    pop_0_14           NUMERIC,
    pop_15_29          NUMERIC,
    pop_30_44          NUMERIC,
    pop_45_59          NUMERIC,
    pop_60_74          NUMERIC,
    pop_75p            NUMERIC,
    pop_65p            NUMERIC,
    pop_15p            NUMERIC,
    csp_agriculteurs   NUMERIC,
    csp_artisans_comm  NUMERIC,
    csp_cadres         NUMERIC,
    csp_prof_interm    NUMERIC,
    csp_employes       NUMERIC,
    csp_ouvriers       NUMERIC,
    csp_retraites      NUMERIC,
    csp_autres         NUMERIC,
    created_at         TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE iris_population_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read iris_population" ON iris_population_staging FOR SELECT TO anon USING (true);
  NOTIFY pgrst, 'reload schema';
END;
$$;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_population_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_iris_population_staging TO service_role;

CREATE OR REPLACE FUNCTION ingest_create_iris_familles_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS iris_familles_staging CASCADE;
  CREATE TABLE iris_familles_staging (
    code_iris                CHAR(9) PRIMARY KEY,
    menages_total            NUMERIC,
    couples_avec_enfants     NUMERIC,
    couples_sans_enfants     NUMERIC,
    familles_monoparentales  NUMERIC,
    created_at               TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE iris_familles_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read iris_familles" ON iris_familles_staging FOR SELECT TO anon USING (true);
  NOTIFY pgrst, 'reload schema';
END;
$$;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_familles_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_iris_familles_staging TO service_role;

NOTIFY pgrst, 'reload schema';
