-- `rpps_search_by_name` : lookup PS par (nom, prenom?, dept?, categorieCodes?).
--
-- Comble un manque évident : on pouvait chercher PS par radius, par
-- dept+spécialité, ou par établissement FINESS, mais pas par identité
-- (nom + prénom).
--
-- Stratégie : trigram (pg_trgm) sur `nom` ET `prenom` avec similarity()
-- scoring + tri par pertinence. Plus tolérant aux accents/typos qu'un
-- `ILIKE` simple. Pas de wrapper `unaccent` ici parce que `unaccent`
-- n'est pas IMMUTABLE par défaut (param dictionary) — interdit en index
-- expression. Les nom/prénom RPPS sont déjà majuscule ASCII dans 99% du
-- CSV ANS, donc `lower()` + trigram suffit.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Index GIN trigram sur `nom` (champ NOT NULL le plus discriminant). Cap
-- d'optimisation : sur 2.2M rows RPPS, un `similarity(nom, 'martin') > 0.3`
-- bénéficie du trigram sinon c'est seq scan complet.
CREATE INDEX IF NOT EXISTS rpps_nom_trgm_idx
  ON rpps USING GIN (lower(nom) extensions.gin_trgm_ops);

-- Index complémentaire prenom pour le cas (nom + prenom) où le prenom
-- est plus discriminant que le nom (ex: "DUPONT JEAN-BAPTISTE-EMMANUEL").
CREATE INDEX IF NOT EXISTS rpps_prenom_trgm_idx
  ON rpps USING GIN (lower(prenom) extensions.gin_trgm_ops);

-- RPC `rpps_search_by_name` — SQL direct (pas `EXECUTE format`), parce qu'on
-- ne baker aucune valeur dans le texte SQL : tous les paramètres sont passés
-- via $N. Pour ce tool le `pg_trgm` opérator `%` consomme les statistiques
-- des indexes trigram indépendamment de la valeur du param. Pas besoin d'un
-- custom plan comme dans `rpps_par_specialite_dept` où la sélectivité par
-- département biaise massivement le planner.
DROP FUNCTION IF EXISTS rpps_search_by_name(TEXT, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS rpps_search_by_name(TEXT, TEXT, TEXT, TEXT[], INT);

CREATE OR REPLACE FUNCTION rpps_search_by_name(
  p_nom              TEXT,
  p_prenom           TEXT,
  p_departement      TEXT,
  p_categorie_codes  TEXT[],
  p_limit            INT
) RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  raison_sociale           TEXT,
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  geom                     JSONB,
  match_score              REAL
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_nom    TEXT    := lower(trim(p_nom));
  v_prenom TEXT    := lower(trim(coalesce(p_prenom, '')));
  -- Default `['C']` côté SQL en miroir du wrapper TS — un caller PostgREST
  -- direct passant `[]` recevra ainsi les Civils seuls, pas un set vide.
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C']);
BEGIN
  IF v_nom IS NULL OR v_nom = '' THEN
    RAISE EXCEPTION 'p_nom is required (non empty)' USING ERRCODE = '22023';
  END IF;
  IF p_departement IS NOT NULL AND p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  -- Le seuil trigram (% opérateur) est contrôlé par le GUC
  -- `pg_trgm.similarity_threshold` (default 0.3). On ne le surcharge pas ici :
  -- - augmenter (= moins de bruit) demanderait un SET LOCAL et exclurait
  --   des homonymies partielles que les callers peuvent vouloir surfacer
  -- - le `match_score` retourné permet au caller de filtrer plus strictement
  --   côté application (ex: `> 0.5` pour les usages exigeants)

  -- Branche 1 : nom + prenom → score combiné moyenne(nom, prenom)
  -- Branche 2 : nom seul → similarity(nom)
  IF v_prenom <> '' THEN
    RETURN QUERY
      SELECT
        r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
        r.profession_code, r.profession_libelle,
        r.savoir_faire_code, r.savoir_faire_libelle,
        r.mode_exercice_code, r.mode_exercice_libelle,
        r.categorie_code, r.categorie_libelle,
        r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
        r.adresse, r.code_postal, r.ville,
        r.code_departement, r.code_insee, r.telephone,
        ST_AsGeoJSON(r.geom)::jsonb AS geom,
        ((extensions.similarity(lower(r.nom), v_nom)
          + extensions.similarity(lower(r.prenom), v_prenom)) / 2.0)::REAL AS match_score
      FROM rpps r
      WHERE lower(r.nom) % v_nom
        AND lower(r.prenom) % v_prenom
        AND (p_departement IS NULL OR r.code_departement = p_departement::CHAR(3))
        AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL)
      ORDER BY match_score DESC, r.nom, r.prenom, r.id
      LIMIT p_limit;
  ELSE
    RETURN QUERY
      SELECT
        r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
        r.profession_code, r.profession_libelle,
        r.savoir_faire_code, r.savoir_faire_libelle,
        r.mode_exercice_code, r.mode_exercice_libelle,
        r.categorie_code, r.categorie_libelle,
        r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
        r.adresse, r.code_postal, r.ville,
        r.code_departement, r.code_insee, r.telephone,
        ST_AsGeoJSON(r.geom)::jsonb AS geom,
        extensions.similarity(lower(r.nom), v_nom)::REAL AS match_score
      FROM rpps r
      WHERE lower(r.nom) % v_nom
        AND (p_departement IS NULL OR r.code_departement = p_departement::CHAR(3))
        AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL)
      ORDER BY match_score DESC, r.nom, r.prenom, r.id
      LIMIT p_limit;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_search_by_name TO anon;

NOTIFY pgrst, 'reload schema';
