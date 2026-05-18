// Calcul de la valeur `ban_last_status` du cache `geocoded_addresses`.
//
// Source de vérité UNIQUE pour le ternaire (ex-dupliqué octet-à-octet entre
// `scripts/ingest/rpps.ts` runBanGeocodeStep et `scripts/ban-backfill.mjs`).
// Partagé via `src/core/index` car `ban-backfill.mjs` (`.mjs`) en a besoin —
// même seam que `normalizeAddressKey`.
//
// IMPORTANT — sémantique préservée à l'octet près :
//  - `accepted` est l'état APRÈS le downgrade défensif R4 (rupture de contrat
//    client BAN : accepted=true à coords NULL → accepted=false). Le compteur
//    dédié S-3 (`contractBreachDowngrades`) est géré PAR L'APPELANT, hors de
//    cette fonction (le ternaire d'origine ne le consultait pas).
//  - Une rupture de contrat downgradée arrive ici avec `accepted=false` et
//    `isUnresolved=false` (resultScore non-null) ⇒ "rejected_low_score",
//    exactement comme les deux ternaires inline d'origine.

export type BanLastStatus = "accepted" | "unresolved" | "rejected_low_score";

/**
 * @param accepted    état accepté APRÈS downgrade défensif R4
 * @param isUnresolved `lat === null && lon === null && resultScore === null`
 */
export function banLastStatus(accepted: boolean, isUnresolved: boolean): BanLastStatus {
  return accepted ? "accepted" : isUnresolved ? "unresolved" : "rejected_low_score";
}
