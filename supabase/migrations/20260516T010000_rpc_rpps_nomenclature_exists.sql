-- Dette #1 (backlog Robustesse, 2026-05-16) — RPC de validation nomenclature
-- ANS au boundary : `rpps_nomenclature_exists(p_profession_code,
-- p_savoir_faire_code) → (profession_known BOOLEAN, savoir_faire_known BOOLEAN)`.
--
-- Problème adressé : `densite_professionnels_sante` avec un code ANS
-- inexistant — ou un code Ameli homographe passé à un paramètre ANS
-- (`specialite_code`/`type_ps_code` = nomenclature DISTINCTE) — fait
-- retourner `countPs=0` → densité 0 → faux « désert médical » plausible et
-- INDISTINGUABLE d'un vrai zéro. La description MCP (audit B3) prévient le LLM
-- mais ne protège PAS un caller programmatique npm. Asymétrie : la densité
-- throw déjà si la population est introuvable, jamais si le code est inconnu.
--
-- Source de vérité = nomenclature RÉELLEMENT présente en base (pas une liste
-- hardcodée qui driftrait). UNE SEULE matview source pour les 2 codes :
-- `rpps_count_stats`, GROUP BY de TOUTES les lignes `rpps` SANS clause WHERE
-- (incluant profession_code ET savoir_faire_code, NULL compris). C'est aussi
-- la source réelle de `count_rpps` → la validation voit exactement ce que le
-- count comptera.
--
-- ⚠ NE PAS valider savoir_faire_code contre `rpps_savoir_faire_stats` : cette
-- matview est filtrée `WHERE savoir_faire_code IS NOT NULL AND
-- profession_code IS NOT NULL`. Un savoir_faire n'apparaissant QUE sur des
-- lignes à profession_code NULL existe en données réelles ANS et en serait
-- absent → RangeError sur un code POURTANT valide (faux positif = nouvelle
-- panne silencieuse côté caller, pire que la dette corrigée). `rpps_count_stats`
-- n'a pas ce filtre : les 2 branches y sont symétriques.
--
-- Refresh post-swap à chaque ingest RPPS (mensuel) — un code apparu au dernier
-- ingest est validé dès le swap.
--
-- Garde-fou matview ENTIÈREMENT vide (DB neuve / 1er ingest pas encore swappé)
-- : on renvoie `known=true` (NE PAS bloquer un code valide par un faux positif).
-- La table `rpps` réellement vide est attrapée EN AVAL par `count_rpps*`
-- (RAISE P0002). LIMITE CONNUE : une matview STALE / à demi rafraîchie (non
-- vide mais sans un code ajouté au dernier ingest) n'est PAS détectée ici NI
-- par P0002 — c'est la responsabilité du refresh post-swap + audit trail
-- ingest (un refresh raté doit marquer le run `failed`/`partial`, pas noop).
--
-- Param NULL = « non fourni » → known=true trivial (rien à valider). Le helper
-- lib `assertKnownRppsCodes` n'appelle même pas la RPC si les 2 sont nuls
-- (happy-path défaut médecin non pénalisé d'un aller-retour).
--
-- LANGUAGE sql STABLE : aucune écriture, aucun EXECUTE format nécessaire
-- (matview ~50-100 K lignes ; EXISTS court-circuite à la 1re ligne, <50 ms
-- même en seq scan, et ce chemin n'est emprunté que sur appel avec code
-- explicite, donc rare).

DROP FUNCTION IF EXISTS rpps_nomenclature_exists(TEXT, TEXT);

CREATE OR REPLACE FUNCTION rpps_nomenclature_exists(
  p_profession_code   TEXT,
  p_savoir_faire_code TEXT
) RETURNS TABLE (
  profession_known    BOOLEAN,
  savoir_faire_known  BOOLEAN
)
LANGUAGE sql STABLE
SET statement_timeout = '5s'
AS $$
  SELECT
    (
      p_profession_code IS NULL
      OR NOT EXISTS (SELECT 1 FROM rpps_count_stats)
      OR EXISTS (
        SELECT 1 FROM rpps_count_stats WHERE profession_code = p_profession_code
      )
    ),
    (
      p_savoir_faire_code IS NULL
      OR NOT EXISTS (SELECT 1 FROM rpps_count_stats)
      OR EXISTS (
        SELECT 1 FROM rpps_count_stats WHERE savoir_faire_code = p_savoir_faire_code
      )
    );
$$;

GRANT EXECUTE ON FUNCTION rpps_nomenclature_exists TO anon;

COMMENT ON FUNCTION rpps_nomenclature_exists IS
  'Dette #1 (2026-05-16) — valide profession_code ET savoir_faire_code ANS contre la SEULE matview rpps_count_stats (non filtrée, source réelle de count_rpps). PAS rpps_savoir_faire_stats (filtrée profession_code IS NOT NULL → faux positif sur savoir_faire-only). Garde-fou anti faux « désert médical » silencieux. Matview vide → known=true (P0002 en aval sur rpps vide ; matview stale = responsabilité refresh post-swap).';
