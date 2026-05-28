-- Phase B étape 3 — revenu IRIS (INSEE FILOSOFI 2021, dispositif « disponible »).
-- Cf. docs/plans/iris-infracommunal.md §2-3. 4e bloc du cron unifié iris.ts.
--
-- COUVERTURE PARTIELLE par design : FILOSOFI ne diffuse l'IRIS QUE pour les
-- communes ≥ 5 000 hab (secret statistique) → ~16K IRIS sur les 48 569 de
-- `iris`. Jointure LEFT obligatoire ; les IRIS sans revenu (rural / petites
-- communes) restent visibles avec revenu NULL. profil_iris (étape 5) exposera
-- le taux de couverture FILOSOFI du bassin (doctrine non-silencieuse, R1).
--
-- Toutes colonnes NUMERIC nullable. Source = BASE_TD_FILO_IRIS_2021_DISP
-- (revenu DISPONIBLE par unité de consommation, recommandé pour le niveau de
-- vie ; le « déclaré » est avant redistribution). Séparateur décimal VIRGULE
-- côté CSV (géré par parseNum côté cron). PAS de matview → pas de bombe OID.

CREATE TABLE IF NOT EXISTS iris_revenu (
  code_iris       CHAR(9) PRIMARY KEY,   -- = iris.code_iris (colonne CSV "IRIS")
  revenu_median   NUMERIC,               -- DISP_MED21 : médiane du revenu disponible/UC (€)
  revenu_d1       NUMERIC,               -- DISP_D121 : 1er décile (€)
  revenu_d9       NUMERIC,               -- DISP_D921 : 9e décile (€)
  taux_pauvrete   NUMERIC,               -- DISP_TP6021 : taux de pauvreté seuil 60 % (%)
  created_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE iris_revenu ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read iris_revenu" ON iris_revenu;
CREATE POLICY "anon read iris_revenu" ON iris_revenu FOR SELECT TO anon USING (true);

CREATE OR REPLACE FUNCTION ingest_create_iris_revenu_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS iris_revenu_staging CASCADE;
  CREATE TABLE iris_revenu_staging (
    code_iris       CHAR(9) PRIMARY KEY,
    revenu_median   NUMERIC,
    revenu_d1       NUMERIC,
    revenu_d9       NUMERIC,
    taux_pauvrete   NUMERIC,
    created_at      TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE iris_revenu_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read iris_revenu" ON iris_revenu_staging FOR SELECT TO anon USING (true);
  NOTIFY pgrst, 'reload schema';
END;
$$;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_revenu_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_iris_revenu_staging TO service_role;

NOTIFY pgrst, 'reload schema';
