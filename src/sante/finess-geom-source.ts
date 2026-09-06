/**
 * Provenance du point `geom` d'une ligne FINESS — colonne `finess.geom_source`
 * (migration 20260906T160000, avant : `raw->>'geom_source'`), vocabulaire
 * FERMÉ par la contrainte CHECK `finess_geom_source_vocab` et par
 * `geom ⇔ geom_source` (un point a toujours une provenance, une ligne sans
 * point n'en a jamais).
 *
 * SOURCE UNIQUE des valeurs, partagée par le parseur (`scripts/ingest/
 * finess-ans-parse.ts`, pose `ans`), les RPC du cron (`previous_ingest` par
 * `ingest_apply_finess_geom_previous`, `ban_address` par
 * `ingest_apply_finess_ban_join` — parité des littéraux SQL ET du CHECK testée
 * dans `finess-column-rules-parity.test.ts`) et la lib (`finess-db.ts`, garde
 * `assertFinessPointProvenance`). Vit dans `src/` parce que la lib en dépend :
 * les scripts importent `src/`, jamais l'inverse.
 *
 * Vocabulaire propre à FINESS — seule `ban_address` est commune avec
 * RPPS/Ameli, avec la même sémantique ; `finess_join` et `commune_centroid`
 * n'existent que côté RPPS/Ameli (ne JAMAIS les écrire ici : un centroïde
 * dans finess.geom serait recopié par le cron RPPS en `finess_join`, tier
 * précis du GiST partiel). Les trois valeurs désignent donc toutes un point à
 * l'adresse → `geo_precision: "adresse"` côté lib.
 */
export const GEOM_SOURCES = {
  /** Point WGS84 natif du flux ANS, posé par le parseur (centroïde communal refusé). */
  ANS: "ans",
  /** Point repris de la prod précédente pour un `num_finess` connu sans coordonnées ANS. */
  PREVIOUS_INGEST: "previous_ingest",
  /** Point BAN du cache `geocoded_addresses`, accepté par PRÉCISION (rue/lieu-dit/bâtiment). */
  BAN_ADDRESS: "ban_address",
} as const;
export type FinessGeomSource = (typeof GEOM_SOURCES)[keyof typeof GEOM_SOURCES];

const GEOM_SOURCE_VALUES: ReadonlySet<string> = new Set(Object.values(GEOM_SOURCES));

/** `true` si `value` est une provenance du vocabulaire fermé. */
export function isFinessGeomSource(value: unknown): value is FinessGeomSource {
  return typeof value === "string" && GEOM_SOURCE_VALUES.has(value);
}
