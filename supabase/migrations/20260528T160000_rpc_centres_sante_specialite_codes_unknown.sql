-- Garde-fou nomenclature CDS (2026-05-28) — jumeau de
-- `ameli_specialite_codes_unknown` (20260528T150000) pour les Centres de Santé.
-- RPC `centres_sante_specialite_codes_unknown(p_codes TEXT[]) → TABLE(unknown_code
-- TEXT)` : renvoie le sous-ensemble des codes fournis absents de la nomenclature
-- spécialité CDS (Annexe A CNAM) réellement présente en base.
--
-- Problème adressé : `centres_sante_in_radius` (`getCdsInRadius`) avec un
-- `specialite_code` inexistant — ou un code ANS homographe ('SM04') passé par
-- erreur — renvoyait 0 CDS INDISTINGUABLE d'un vrai zéro légitime (même classe
-- d'échec silencieux que le côté Ameli). Le helper lib
-- `assertKnownCdsSpecialiteCodes` (specialite-nomenclature-guard.ts) consomme
-- cette RPC et lève un RangeError (→ JSON-RPC -32602) si non vide.
--
-- SOURCE DE VÉRITÉ = table `centres_sante` (colonne array `specialites_codes`),
-- PAS la matview Ameli `ameli_nomenclature_stats` : la nomenclature CDS Annexe A
-- est DISTINCTE — 16 de ses ~81 codes sont absents de la matview Ameli (prouvé
-- prod 2026-05-28 : EXCEPT = 16). Valider le CDS contre la source Ameli
-- produirait 16 faux positifs (rejet de codes CDS valides) = re-régression de la
-- leçon dette #1 (« jamais valider contre une source qui n'est pas celle du
-- count »). `centres_sante` EST la source réelle du filtre `&&` de
-- `centres_sante_in_radius`, donc la validation voit exactement ce qui matchera.
--
-- Garde-fou table vide (DB neuve / 1er ingest CDS pas encore swappé) : on ne
-- signale AUCUN inconnu (anti faux positif). Le vrai vide est attrapé en aval
-- (résultat 0). `cs.specialites_codes @> ARRAY[c]` = appartenance (potentiel
-- index GIN ; ~3,5K CDS → EXISTS court-circuite, trivial). `SELECT DISTINCT`
-- dédoublonne les p_codes. LANGUAGE sql STABLE, `statement_timeout=5s` ; chemin
-- emprunté uniquement sur appel avec code explicite (le helper no-op sinon).

DROP FUNCTION IF EXISTS centres_sante_specialite_codes_unknown(TEXT[]);

CREATE OR REPLACE FUNCTION centres_sante_specialite_codes_unknown(
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
    EXISTS (SELECT 1 FROM centres_sante WHERE specialites_codes IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM centres_sante cs WHERE cs.specialites_codes @> ARRAY[c]
    );
$$;

GRANT EXECUTE ON FUNCTION centres_sante_specialite_codes_unknown TO anon;

COMMENT ON FUNCTION centres_sante_specialite_codes_unknown IS
  'Garde-fou nomenclature CDS (2026-05-28, jumeau ameli_specialite_codes_unknown) — renvoie les specialite_code fournis absents de centres_sante.specialites_codes (Annexe A CNAM, source reelle du filtre). PAS la matview Ameli (16 codes Annexe A en sont absents → faux positifs). Anti faux zero silencieux. Table vide → 0 inconnu (anti faux positif).';

NOTIFY pgrst, 'reload schema';
