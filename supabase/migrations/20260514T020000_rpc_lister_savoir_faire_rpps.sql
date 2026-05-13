-- V0.8 — RPC `lister_savoir_faire_rpps(p_profession_code TEXT)
--   → TABLE(code, libelle, count_ps)`.
--
-- Énumère les codes savoir_faire (spécialités fines DES/DESC) présents dans
-- la base RPPS, avec leur libellé et le nombre de PS qui les portent.
-- Triés par count_ps décroissant pour faciliter la découverte côté LLM
-- (les spécialités les plus courantes en haut).
--
-- `p_profession_code` filtre le périmètre : pour les médecins (code '10'),
-- retourne les spécialités médicales (cardiologie, dermatologie, etc.).
-- NULL → tous savoir_faire confondus (peu utile en pratique mais supporté).
--
-- Pattern miroir de `ameli_lister_specialites` (cf. migration ingest 0017).
-- Pas de filtre dept ici : les spécialités sont la même nomenclature
-- nationale, le LLM utilise ce listing pour ensuite filtrer par dept dans
-- d'autres tools (densite_professionnels_sante, professionnels_rpps_par_dept).

DROP FUNCTION IF EXISTS lister_savoir_faire_rpps(TEXT);

CREATE OR REPLACE FUNCTION lister_savoir_faire_rpps(
  p_profession_code TEXT
) RETURNS TABLE (
  code        TEXT,
  libelle     TEXT,
  count_ps    BIGINT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    r.savoir_faire_code   AS code,
    MAX(r.savoir_faire_libelle) AS libelle,
    COUNT(*)::BIGINT      AS count_ps
  FROM rpps r
  WHERE r.savoir_faire_code IS NOT NULL
    AND (p_profession_code IS NULL OR r.profession_code = p_profession_code)
  GROUP BY r.savoir_faire_code
  ORDER BY count_ps DESC, r.savoir_faire_code;
$$;

GRANT EXECUTE ON FUNCTION lister_savoir_faire_rpps TO anon;

COMMENT ON FUNCTION lister_savoir_faire_rpps IS
  'Liste les savoir_faire RPPS (spécialités fines) avec count par code, filtré par profession. Tool d''aide LLM V0.8 lister_specialites_medicales.';
