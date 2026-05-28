/**
 * Garde-fous nomenclature « code spécialité » — jumeaux du garde-fou ANS
 * `assertKnownRppsCodes` (cf. `rpps-db.ts`, dette #1). Valident un ou plusieurs
 * codes spécialité contre la nomenclature réellement présente en base (source
 * NON filtrée = source réelle des counts, via RPC dédiée) :
 *
 * - `assertKnownAmeliSpecialiteCodes` → `specialite_code` Ameli, source matview
 *   `ameli_nomenclature_stats` (RPC `ameli_specialite_codes_unknown`).
 * - `assertKnownCdsSpecialiteCodes` → `specialite_code` CDS (Annexe A CNAM),
 *   source table `centres_sante` (RPC `centres_sante_specialite_codes_unknown`).
 *   Nomenclature DISTINCTE de la matview Ameli — 16 codes Annexe A en sont
 *   absents (prouvé prod 2026-05-28) ⇒ NE PAS valider le CDS contre la source
 *   Ameli (ce serait 16 faux positifs = re-régression dette #1).
 *
 * Pourquoi : sans ces garde-fous, un code spécialité inexistant — ou un code ANS
 * homographe (`savoir_faire_code` type `SM04`, nomenclature DISTINCTE) passé par
 * erreur — fait retourner 0 résultat INDISTINGUABLE d'un vrai zéro légitime. La
 * différenciation des descriptions de tools rend la confusion improbable mais ne
 * la ferme pas pour un caller programmatique npm ; ces garde-fous la ferment.
 *
 * Vivent dans un module séparé des consommateurs (`ameli-db.ts`, `cds-db.ts`)
 * pour les tester en isolation (spying intra-module ESM impossible) — ≠ guard ANS
 * inline dans `rpps-db.ts` (consommé depuis `densite.ts`, déjà cross-module).
 *
 * `RangeError` → mappe JSON-RPC `-32602 Invalid params` au boundary MCP. No-op
 * (zéro I/O) si aucun code fourni. Garde matview/table source vide → la RPC
 * renvoie 0 inconnu (ne bloque pas un code valide ; le vrai vide est attrapé en
 * aval), jumeau de la garde empty-source du côté ANS.
 *
 * Asymétrie ASSUMÉE vs le jumeau ANS : `assertKnownRppsCodes` throw si la RPC
 * renvoie 0 ligne (invariant « toujours 1 ligne booléenne »). Ici la RPC est
 * `RETURNS TABLE` à cardinalité variable — 0 ligne = « aucun code inconnu » =
 * cas nominal légitime, donc PAS de throw sur data vide (ne pas chercher un
 * `if (!row) throw` ici, ce serait un faux invariant).
 */

import { getUntypedAnonClient } from "../storage/supabase.js";
import { formatRpcError } from "./db-helpers.js";

/**
 * Cœur partagé Ameli/CDS : appelle une RPC `(p_codes TEXT[]) → TABLE(unknown_code
 * TEXT)` et renvoie les codes absents de la nomenclature ciblée. No-op (zéro I/O)
 * si aucun code. `Error` (pas `RangeError`) si la RPC échoue — distingue « erreur
 * API » de « code invalide » (le caller mappe `RangeError`→-32602, pas `Error`).
 */
async function findUnknownSpecialiteCodes(
  codes: readonly string[] | undefined,
  rpc: string,
): Promise<string[]> {
  if (!codes || codes.length === 0) return [];
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc(rpc, { p_codes: codes });
  if (error) throw new Error(formatRpcError(rpc, error));
  return ((data ?? []) as Array<{ unknown_code: string | null }>)
    .map((r) => r.unknown_code)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

export async function assertKnownAmeliSpecialiteCodes(
  codes: readonly string[] | undefined,
): Promise<void> {
  const unknown = await findUnknownSpecialiteCodes(codes, "ameli_specialite_codes_unknown");
  if (unknown.length > 0) {
    const list = unknown.map((c) => `'${c}'`).join(", ");
    throw new RangeError(
      `Code(s) spécialité Ameli inconnu(s) dans la nomenclature : specialite_code ${list}. Rappel : les codes Ameli (specialite_code / type_ps_code, libéraux conventionnés Assurance Maladie) sont une nomenclature DISTINCTE des codes ANS (profession_code / savoir_faire_code) — un même nombre y désigne des choses différentes. Découvrir les codes Ameli valides via le tool lister_specialites_ameli.`,
    );
  }
}

export async function assertKnownCdsSpecialiteCodes(
  codes: readonly string[] | undefined,
): Promise<void> {
  const unknown = await findUnknownSpecialiteCodes(codes, "centres_sante_specialite_codes_unknown");
  if (unknown.length > 0) {
    const list = unknown.map((c) => `'${c}'`).join(", ");
    throw new RangeError(
      `Code(s) spécialité CDS inconnu(s) dans la nomenclature Annexe A CNAM : specialite_code ${list}. Rappel : ces codes sont une nomenclature DISTINCTE des codes ANS (profession_code / savoir_faire_code, ex 'SM04') — ne pas confondre. Les codes valides présents en base sont ceux exposés par le champ specialites.codes de centres_sante_by_finess.`,
    );
  }
}
