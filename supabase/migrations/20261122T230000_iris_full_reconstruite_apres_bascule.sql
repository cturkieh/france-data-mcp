-- `ingest_rebuild_iris_full()` : rattache la vue `iris_full` aux tables IRIS en place.
--
-- Le défaut : une VUE suit ses tables par OID, comme une matview, pas par nom. Le commentaire
-- de `20260528T220000` (« résolue PAR NOM, AUCUNE bombe OID ») était faux. `ingest_atomic_swap`
-- bascule par RENAME (`iris` → `iris_previous`, `iris_staging` → `iris`) : après une bascule
-- IRIS, `iris_full` lit donc `iris*_previous`. Les 5 RPC qui passent par la vue
-- (`iris_profil_by_code`, `iris_at_point`, `iris_in_radius`, `iris_in_radius_of_code`,
-- `iris_by_commune`) servent l'ancien millésime, le run finit en `success`. Ensuite le
-- nettoyage des copies échoue en 2BP01 pour les 4 tables, et la bascule suivante détruit la vue
-- (`DROP <prod>_previous_OLD CASCADE` d'`ingest_atomic_swap`) : les 5 RPC en 42P01.
-- Pas encore arrivé en prod : aucune bascule IRIS depuis la création de la vue (2026-05-28).
--
-- Le correctif : cette fonction redéfinit la vue par `CREATE OR REPLACE VIEW`. Les noms de
-- tables sont résolus à ce moment-là, donc sur les tables en place. `iris.ts` l'appelle avant
-- la première bascule (preuve que la fonction existe, et vue saine avant le `DROP … CASCADE`
-- de la bascule) puis après la dernière.
--
-- `CREATE OR REPLACE` et non `DROP` + `CREATE` : la vue garde son OID et ses droits, et la
-- fonction refuse de retirer une colonne (42P16). Si une migration ajoute un jour une colonne à
-- `iris_full` sans recopier sa définition ici, l'appel échoue avant toute bascule au lieu de
-- ramener la vue à l'ancienne forme. `iris-full-rebuild.test.ts` vérifie cette parité.
--
-- `lock_timeout` 5 s : la redéfinition prend un verrou exclusif sur la vue. Derrière une
-- lecture longue elle bloquerait toutes les lectures suivantes ; elle abandonne donc en 55P03
-- et `iris.ts` réessaie. `statement_timeout` posé ici parce que l'appel PostgREST hérite sinon
-- des 8 s d'`authenticator`. `pg_temp` en fin de `search_path` : sans lui, une fonction
-- `SECURITY DEFINER` cherche d'abord dans le schéma temporaire de la session.
--
-- La fonction relit ensuite dans le catalogue les tables dont la vue dépend, lève une erreur
-- si ce ne sont pas exactement les 4 tables servies, et rend cette liste.
--
-- Réparation à la main (alerte 2BP01 du nettoyage sur une table `iris*_previous`) :
--   SELECT ingest_rebuild_iris_full();
--
-- Rejoué sur une base jetable avant écriture : `docs/experiences/2026-11-22-iris-full-apres-bascule.md`.

CREATE OR REPLACE FUNCTION ingest_rebuild_iris_full()
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
SET lock_timeout = '5s'
AS $$
DECLARE
  v_attendues TEXT[] := ARRAY['iris', 'iris_familles', 'iris_population', 'iris_revenu'];
  v_liees     TEXT[];
BEGIN
  -- SELECT recopié de `20260528T220000` (parité testée). `security_invoker` est redit :
  -- un `CREATE OR REPLACE VIEW` sans `WITH` remet les options à zéro.
  CREATE OR REPLACE VIEW iris_full
  WITH (security_invoker = true) AS
  SELECT
    i.code_iris             AS code_iris,
    i.code_commune          AS code_commune,
    i.libelle               AS libelle,
    i.type_iris             AS type_iris,
    i.geog                  AS geog,
    i.centroid_geog         AS centroid_geog,
    p.pop_total, p.pop_0_14, p.pop_15_29, p.pop_30_44, p.pop_45_59, p.pop_60_74,
    p.pop_75p, p.pop_65p, p.pop_15p,
    p.csp_agriculteurs, p.csp_artisans_comm, p.csp_cadres, p.csp_prof_interm,
    p.csp_employes, p.csp_ouvriers, p.csp_retraites, p.csp_autres,
    f.menages_total, f.couples_avec_enfants, f.couples_sans_enfants, f.familles_monoparentales,
    r.revenu_median, r.revenu_d1, r.revenu_d9, r.taux_pauvrete
  FROM iris i
  LEFT JOIN iris_population p ON p.code_iris = i.code_iris
  LEFT JOIN iris_familles   f ON f.code_iris = i.code_iris
  LEFT JOIN iris_revenu     r ON r.code_iris = i.code_iris;

  -- Redit pour le cas où la vue vient d'être créée (détruite auparavant par un CASCADE).
  GRANT SELECT ON iris_full TO anon, authenticated, service_role;

  SELECT array_agg(DISTINCT c.relname::text ORDER BY c.relname::text)
    INTO v_liees
    FROM pg_rewrite w
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
                    AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class c ON c.oid = d.refobjid
    WHERE w.ev_class = 'public.iris_full'::regclass
      AND c.oid <> w.ev_class;

  IF v_liees IS DISTINCT FROM v_attendues THEN
    RAISE EXCEPTION 'iris_full liée à % au lieu de %', v_liees, v_attendues;
  END IF;

  RETURN v_liees;
END;
$$;

-- `pg_default_acl` de Supabase ouvre toute nouvelle fonction à la clé publique.
REVOKE EXECUTE ON FUNCTION ingest_rebuild_iris_full() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_iris_full() TO service_role;

COMMENT ON FUNCTION ingest_rebuild_iris_full IS
  'Redéfinit la vue iris_full (CREATE OR REPLACE VIEW, security_invoker) pour qu''elle lise les tables IRIS en place après une bascule. Rend les tables liées, lève une erreur si ce ne sont pas iris, iris_familles, iris_population, iris_revenu. Idempotente.';

-- Preuve à l'apply : la fonction tourne une fois contre la vue existante. Sur une base saine
-- elle ne change rien et rend {iris,iris_familles,iris_population,iris_revenu}.
SELECT ingest_rebuild_iris_full();

NOTIFY pgrst, 'reload schema';
