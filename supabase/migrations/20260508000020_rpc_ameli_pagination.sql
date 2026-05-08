-- V0.4.1 — Ajoute le paramètre `p_offset` au RPC `ameli_by_specialite_dept`.
--
-- Audit Charleville (2026-05-08) : pour énumérer un département à fort effectif
-- (ex: Paris IDE > 1000), le caller atteint `truncated=true` au premier appel
-- mais n'a aucun moyen de récupérer la suite. Sans pagination, l'outil est
-- limité à 500 PS max par département-spécialité.
--
-- Schéma de signature : on ajoute `p_offset INT DEFAULT 0` en fin de
-- signature pour préserver la compat des callers déjà déployés (le wrapper
-- TypeScript passe désormais `p_offset` explicitement).
--
-- Stabilité du tri : OFFSET sans ORDER BY déterministe est un piège classique
-- (PG peut renvoyer des doublons / sauts de pages selon le plan). Le tri
-- existant `code_insee NULLS LAST, nom, prenom` n'est PAS unique (deux
-- "DUPONT JEAN" dans la même commune produisent un tie). On ajoute `id` en
-- dernière clé pour briser le tie — `id` est BIGSERIAL donc unique par
-- ingest, et stable sur la durée de vie du dump (régénéré chaque hebdo).

DROP FUNCTION IF EXISTS ameli_by_specialite_dept(TEXT, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS ameli_by_specialite_dept(TEXT, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION ameli_by_specialite_dept(
  p_departement     TEXT,
  p_specialite_code TEXT,
  p_type_ps_code    TEXT,
  p_limit           INT,
  p_offset          INT DEFAULT 0
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
  distance_meters               DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
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
    NULL::DOUBLE PRECISION       AS distance_meters
  FROM annuaire_ameli a
  WHERE a.code_departement = p_departement
    AND (p_specialite_code IS NULL OR a.specialite_code = p_specialite_code)
    AND (p_type_ps_code    IS NULL OR a.type_ps_code    = p_type_ps_code)
  ORDER BY a.code_insee NULLS LAST, a.nom, a.prenom, a.id
  OFFSET p_offset
  LIMIT  p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION ameli_by_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
