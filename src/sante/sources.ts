/**
 * Libellés source partagés entre les modules santé (V0.9).
 *
 * Source unique pour éviter le drift textuel chopé en V0.8.1 : les labels
 * apparaissaient à l'identique dans `densite.ts`, `panorama.ts`, et auraient
 * dérivé à la prochaine évolution de la fréquence d'ingest ou du nom officiel.
 *
 * Étendre cette table seulement quand une nouvelle source est consommée par
 * au moins 2 modules — sinon laisser inline reste OK.
 */
export const SOURCE_LABELS = {
  rpps: "RPPS / Annuaire Santé ANS (Supabase, mensuel)",
  finess: "FINESS DREES (Supabase, bimensuel)",
  melodi: "INSEE Melodi (DS_POPULATIONS_REFERENCE)",
  dinum: "Recherche Entreprises DINUM (live)",
  insee_sirene: "INSEE SIRENE V3.11 (live, fallback)",
  iris: "INSEE RP 2022 + FILOSOFI 2021, niveau IRIS (Supabase, annuel)",
} as const;
