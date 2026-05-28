-- Garde-fou nomenclature Ameli (2026-05-28) — jumeau ANS de
-- `rpps_nomenclature_exists` (dette #1, 20260516T010000). RPC
-- `ameli_specialite_codes_unknown(p_codes TEXT[]) → TABLE(unknown_code TEXT)` :
-- renvoie le sous-ensemble des codes fournis qui n'existent PAS dans la
-- nomenclature spécialité Ameli réellement présente en base.
--
-- Problème adressé : `professionnels_in_radius` / `professionnels_par_specialite_dept`
-- avec un `specialite_code` inexistant — ou un code ANS homographe
-- (`savoir_faire_code` type 'SM04', nomenclature DISTINCTE) passé par erreur à
-- un paramètre Ameli — renvoyait 0 résultat INDISTINGUABLE d'un vrai zéro
-- légitime. La différenciation des descriptions de tools jumeaux rend la
-- confusion improbable mais ne la ferme pas pour un caller programmatique npm.
-- Le helper lib `assertKnownAmeliSpecialiteCodes` (specialite-nomenclature-guard.ts)
-- consomme cette RPC et lève un RangeError (→ JSON-RPC -32602) si non vide.
--
-- Source de vérité = matview `ameli_nomenclature_stats` (GROUP BY de TOUTES les
-- lignes `annuaire_ameli`, SANS filtre — c'est aussi la source réelle des counts
-- des tools `ameli_lister_specialites` / `ameli_by_specialite_dept`). La
-- validation voit donc exactement ce que le filtre `= ANY(...)` matchera. NE PAS
-- valider contre une liste hardcodée (driftrait) ni contre une matview dérivée
-- filtrée (faux positif sur un code valide exclu par le filtre — leçon dette #1).
--
-- Garde-fou matview ENTIÈREMENT vide en spécialités (DB neuve / 1er ingest pas
-- encore swappé) : on ne signale AUCUN code inconnu (NE PAS bloquer un code
-- valide par un faux positif). Le vrai vide est attrapé EN AVAL (résultat 0).
-- LIMITE CONNUE (identique au jumeau ANS) : une matview STALE / à demi
-- rafraîchie (non vide mais sans un code ajouté au dernier ingest) n'est pas
-- détectée ici — responsabilité du rebuild post-swap + audit trail ingest.
--
-- `SELECT DISTINCT` : un p_codes avec doublons ne remonte pas le même inconnu
-- plusieurs fois. LANGUAGE sql STABLE, aucune écriture. `statement_timeout=5s`
-- (matview ~65 lignes, EXISTS court-circuite — chemin emprunté uniquement sur
-- appel avec code explicite, donc rare ; le helper no-op si aucun code).

DROP FUNCTION IF EXISTS ameli_specialite_codes_unknown(TEXT[]);

CREATE OR REPLACE FUNCTION ameli_specialite_codes_unknown(
  p_codes TEXT[]
) RETURNS TABLE (
  unknown_code TEXT
)
LANGUAGE sql STABLE
SET statement_timeout = '5s'
AS $$
  SELECT DISTINCT c AS unknown_code
  FROM unnest(p_codes) AS c
  WHERE
    -- Matview non vide en spécialités, sinon ne bloque rien (anti faux positif).
    EXISTS (SELECT 1 FROM ameli_nomenclature_stats WHERE specialite_code IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM ameli_nomenclature_stats s WHERE s.specialite_code = c
    );
$$;

GRANT EXECUTE ON FUNCTION ameli_specialite_codes_unknown TO anon;

COMMENT ON FUNCTION ameli_specialite_codes_unknown IS
  'Garde-fou nomenclature Ameli (2026-05-28, jumeau rpps_nomenclature_exists) — renvoie les specialite_code fournis absents de la matview ameli_nomenclature_stats (non filtrée, source réelle des counts). Anti faux zéro silencieux (code inexistant OU code ANS homographe). Matview vide en spécialités → 0 inconnu (anti faux positif ; matview stale = responsabilité rebuild post-swap).';

NOTIFY pgrst, 'reload schema';
