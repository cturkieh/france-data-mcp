-- Migration : RLS du domaine Immobilier (addendum de 20260606T120000_immobilier.sql).
-- ⚠️ NE PAS APPLIQUER AUTOMATIQUEMENT — validation humaine requise avant apply prod.
--
-- Pourquoi cet addendum séparé : la migration de base crée les tables DVF mais a
-- OMIS les policies RLS. Sur Supabase, RLS est actif par défaut sur les tables du
-- schéma public → sans policy, le rôle `anon` est TOTALEMENT verrouillé (prouvé
-- prod : `42501 new row violates row-level security policy for table dvf_mutations`).
-- La feature DVF (cache paresseux) était donc cassée telle que livrée.
--
-- Doctrine du projet (cf. src/storage/supabase.ts + cache geocoded_addresses,
-- migration 20260516T060000) :
--   • rôle `anon` (clé publique des MCP tools)  → LECTURE SEULE.
--   • rôle `service_role` (clé serveur)         → ÉCRITURES (bypass RLS).
--
-- Application de la doctrine au domaine DVF :
--   • dvf_mutations     : public land-sale data → policy SELECT anon (miroir
--                         "anon read finess"). Le RPC dvf_in_radius (SECURITY
--                         INVOKER) lit la table sous le rôle anon → policy requise.
--   • dvf_commune_cache : registre INTERNE du cache → AUCUNE policy anon (miroir
--                         geocoded_addresses). Lecture + écriture via service_role
--                         uniquement (getUntypedServiceClient côté dvf.ts).
--   • Les ÉCRITURES de dvf_mutations passent par service_role (jamais anon) —
--                         sinon tout porteur de la clé anon publique pourrait
--                         polluer le cache de prix.
--
-- Idempotent : ENABLE RLS est un no-op si déjà actif ; DROP POLICY IF EXISTS +
-- CREATE rejoue proprement ; les GRANT sont idempotents.

-- ---------------------------------------------------------------------------
-- 1. dvf_mutations — RLS ON + lecture anon + écritures service_role
-- ---------------------------------------------------------------------------

ALTER TABLE dvf_mutations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read dvf_mutations" ON dvf_mutations;
CREATE POLICY "anon read dvf_mutations" ON dvf_mutations
  FOR SELECT TO anon USING (true);

GRANT SELECT, INSERT, UPDATE ON dvf_mutations TO service_role;

-- ---------------------------------------------------------------------------
-- 2. dvf_commune_cache — RLS ON, table interne (aucune policy anon)
-- ---------------------------------------------------------------------------

ALTER TABLE dvf_commune_cache ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON dvf_commune_cache TO service_role;
