/**
 * Métadonnées de requête exposées dans les réponses des tools de listing.
 *
 * Pourquoi : le caller MCP (Claude.ai, Cursor, agent LLM) ne peut pas deviner
 * la nature du calcul de distance ni la précision géographique en lisant un
 * `distance_km: 2.67`. Or les sources varient : FINESS expose des coords
 * Lambert93 reprojetées en WGS84 (précision adresse), Ameli ne fournit que
 * le centroïde commune (~3 km moyenne). Sans cette transparence, un caller
 * peut prendre des décisions logistiques fausses (ex: "le LBM est à 2.67 km
 * vol d'oiseau" — mais la distance routière fait facilement +20-30%).
 *
 * Pattern aligné sur le bloc `fallback` déjà présent dans
 * `entreprises_in_radius` (cf. `api/tools.ts`) qui surface honnêtement la
 * stratégie de fallback API DINUM.
 */

/**
 * Précision géographique des coordonnées exposées dans les résultats.
 *
 * - `lambert93_natif_finess` : coords FINESS DREES (Lambert 93 reprojeté
 *   WGS84 à l'ingestion). Précision adresse ~10 m côté DREES.
 * - `centroide_commune_ameli` : coords Ameli (centroïde commune via
 *   `geo.api.gouv.fr/communes`). Précision ~3 km moyenne — adapté à
 *   l'analyse de densité, PAS au géocodage adresse.
 */
export type GeoPrecision =
  | "lambert93_natif_finess"
  | "centroide_commune_ameli"
  | "centroide_commune_ans"
  | "centroide_commune_ans_mixte"
  | "centroide_commune_cds"
  | "structure_finess";

/**
 * Précision géo exposée au niveau de CHAQUE PS (champ `geo_precision` des
 * résultats Ameli/RPPS), volontairement plus générique que `GeoPrecision`
 * (source-spécifique, au niveau global du résultat). Co-localisée avec
 * `coords`/`distance_km`.
 *
 * - `adresse` : coords BAN (rue, lieu-dit ou bâtiment) — `distance_km` exacte
 *   au m près, classement individuel fiable. Issu de `geom_source='ban_address'`
 *   en base (table `rpps`).
 * - `etablissement_finess` : coords FINESS DREES du site joint via `num_finess`
 *   — `distance_km` exacte au site (bâtiment FINESS). Issu de
 *   `geom_source='finess_join'` en base.
 * - `centroide_commune` : centroïde commune (~3 km moyenne) — `distance_km`
 *   IDENTIQUE pour tous les PS d'une même commune, NON discriminante pour
 *   classer/choisir un PS individuel (utiliser uniquement comme filtre de
 *   zone). Issu de `geom_source='commune_centroid'` en base.
 *
 * RPPS expose les 3 valeurs depuis V0.12.0 (post-PR #23 FINESS join + ban_join
 * keyset). Ameli expose uniquement `centroide_commune`. Le détail source
 * reste dans `query_metadata.geo_precision`.
 */
export type PerResultGeoPrecision = "adresse" | "etablissement_finess" | "centroide_commune";

/**
 * Méthode de calcul des distances exposées dans `distance_km`.
 *
 * - `haversine_postgis` : ST_Distance sur le type `geography` PostGIS.
 *   Distance vol d'oiseau, pas routière. Pour la distance routière,
 *   intégrer un service externe (OSRM, ORS) côté caller.
 */
export type DistanceType = "haversine_postgis";

export interface QueryMetadata {
  geo_precision: GeoPrecision;
  /** Présent uniquement quand la requête expose `distance_km` (radius). */
  distance_type?: DistanceType;
  /** Notes actionnables pour le caller (précision attendue, cross-checks…). */
  notes: string[];
}

const SOURCE_NOTE: Record<GeoPrecision, string> = {
  centroide_commune_ameli:
    "Coordonnées Ameli = centroïde commune (~3 km moyenne). Adapté à l'analyse de densité médicale, pas au géocodage adresse.",
  lambert93_natif_finess:
    "FINESS DREES (sync bimestrielle) — référentiel peut avoir 1-2 mois de retard sur le terrain pour les structures émergentes (CPTS récentes, MSP en agrément). Cross-check ARS / Service Public si nécessaire.",
  /** @deprecated V0.12.0 — Plus aucune RPC RPPS ne produit cet alias ; toutes ont migré vers `centroide_commune_ans_mixte` (précision hybride par-résultat). Conservé pour rétrocompat de tout client qui aurait caché la string `geo_precision` côté query_metadata (Claude.ai, Cursor, agents loggant). Ne pas réintroduire dans un nouveau call site. */
  centroide_commune_ans:
    "Coordonnées RPPS/ANS = centroïde commune (~3 km moyenne). Source : Annuaire Santé ANS — Licence Ouverte v2.0. Pour une précision adresse, croiser num_finess avec etablissement_by_finess.",
  centroide_commune_ans_mixte:
    'Coordonnées RPPS HYBRIDES (V0.12.0) : la précision est MIXTE par résultat — lire `geo_precision` PAR PS. ~68,5 % sont précis (`"adresse"` BAN rue/bâtiment ou `"etablissement_finess"` site FINESS joint via num_finess) avec `distance_km` exacte ; ~31,5 % restent au centroïde commune (`"centroide_commune"`, ~3 km, `distance_km` non discriminante intra-commune). Source : Annuaire Santé ANS — Licence Ouverte v2.0. Pour FORCER 100 % de résultats précis (rayons courts <3 km, classement individuel), passer `precise_only: true` côté tool radius.',
  structure_finess:
    "Liste rattachée à un FINESS site. Le mode_exercice révèle la nature du lien (libéral / salarié). Couverture RPPS quand le PS l'a déclaré ; salariés CH/CHU/cliniques bien couverts.",
  centroide_commune_cds:
    "Coordonnées CDS = centroïde commune (~3 km moyenne) — pas de coords natives dans le CSV CNAM. Source : Annuaire santé Ameli, Assurance Maladie (mention obligatoire L.1461-2 CSP). Pivot via etab_finess vers FINESS DREES pour précision adresse.",
};

const HAVERSINE_NOTE =
  "Distance calculée en vol d'oiseau (haversine PostGIS). Pour la distance routière, croiser avec un service externe (OSRM, ORS).";

/**
 * Résolution effective d'une coordonnée au centroïde commune (~3 km moyenne
 * pour une commune FR). En deçà de ce rayon, un filtre `radius_km` est
 * inopérant : le filtre s'applique au centroïde unique partagé par tous les
 * PS d'une commune, donc soit la commune entière passe (tous `distance_km`
 * quasi égaux, non classables), soit rien ne passe — un résultat vide peut
 * être un FAUX négatif (centroïde hors rayon ≠ désert médical). Pas de
 * constante de ce type ailleurs ; `RADIUS_MIN_KM` (db-helpers) est une borne
 * d'input, pas une résolution géographique.
 */
export const CENTROIDE_COMMUNE_RESOLUTION_KM = 3;

/**
 * Précisions purement centroïde (100 % des résultats au centroïde commune).
 * NB : `centroide_commune_ans_mixte` EST volontairement EXCLU — en mode hybride
 * RPPS V0.12.0, la branche `precise` (`adresse`+`etablissement_finess`) garde
 * des distances exactes même à radius_km < 3 km, donc la note générique
 * `subCommuneRadiusNote` (« TOUS les PS d'une commune sont inclus ou exclus
 * en bloc ») serait FAUSSE et ferait pivoter à tort le caller vers FINESS.
 * Une note dédiée nuancée est injectée par `rppsRadiusMetadata` si applicable.
 * `centroide_commune_ans` y reste pour rétrocompat (deprecated, plus produit).
 */
const CENTROID_PRECISIONS = new Set<GeoPrecision>([
  "centroide_commune_ameli",
  "centroide_commune_ans",
  "centroide_commune_cds",
]);

/**
 * Gate partagée seuil radius_km. Factorisée pour qu'une dérive du seuil
 * (passage à 2 km après mesure prod, par ex.) ne nécessite qu'un seul patch
 * au lieu de 2 sites silencieusement désynchronisés (`isSubCommuneRadius`
 * pour le warning Ameli/CDS générique, `rppsRadiusMetadata` pour le warning
 * RPPS mixte nuancé — contenu différent, gate identique).
 */
function isShortRadius(radiusKm: number | undefined): radiusKm is number {
  return radiusKm !== undefined && radiusKm < CENTROIDE_COMMUNE_RESOLUTION_KM;
}

function isSubCommuneRadius(
  precision: GeoPrecision,
  radiusKm: number | undefined,
): radiusKm is number {
  return isShortRadius(radiusKm) && CENTROID_PRECISIONS.has(precision);
}

const subCommuneRadiusNote = (radiusKm: number): string =>
  `radius_km=${radiusKm} < ${CENTROIDE_COMMUNE_RESOLUTION_KM} km : incompatible avec une précision au centroïde commune. Le filtre rayon s'applique au centroïde unique de chaque commune, pas aux adresses réelles — TOUS les PS d'une commune sont inclus ou exclus en bloc, et \`distance_km\` ne discrimine pas les PS d'une même commune. Un résultat vide peut être un FAUX négatif (centroïde hors rayon), pas un désert médical. Pour une vraie géolocalisation adresse, pivoter via FINESS (etablissement_by_finess) ou élargir radius_km ≥ ${CENTROIDE_COMMUNE_RESOLUTION_KM}.`;

/**
 * Builder unique pour les 4 cas (Ameli/FINESS × radius/list). Factorise les
 * 4 helpers historiques. Si une nouvelle source spatiale arrive (IRIS, RPPS),
 * ajouter une entrée à `SOURCE_NOTE` et un alias à la fin du fichier.
 */
function buildMetadata(
  precision: GeoPrecision,
  withDistance: boolean,
  radiusKm?: number,
): QueryMetadata {
  const notes = [SOURCE_NOTE[precision]];
  const result: QueryMetadata = { geo_precision: precision, notes };
  if (withDistance) {
    result.distance_type = "haversine_postgis";
    notes.push(HAVERSINE_NOTE);
  }
  if (isSubCommuneRadius(precision, radiusKm)) {
    notes.push(subCommuneRadiusNote(radiusKm));
  }
  return result;
}

export const ameliRadiusMetadata = (radiusKm?: number): QueryMetadata =>
  buildMetadata("centroide_commune_ameli", true, radiusKm);

export const ameliDeptMetadata = (): QueryMetadata =>
  buildMetadata("centroide_commune_ameli", false);

export const finessRadiusMetadata = (): QueryMetadata =>
  buildMetadata("lambert93_natif_finess", true);

export const finessByCategorieMetadata = (): QueryMetadata =>
  buildMetadata("lambert93_natif_finess", false);

/**
 * Metadata pour `rpps_in_radius` : depuis V0.12.0 la précision est MIXTE par
 * résultat (lire `geo_precision` de chaque PS — 3 valeurs possibles). La note
 * globale pointe vers cette colonne et explique le filtre `precise_only`.
 *
 * À radius_km < CENTROIDE_COMMUNE_RESOLUTION_KM, on ne déclenche PAS la note
 * générique (la branche précise reste fiable) — on injecte une note nuancée
 * spécifique au mode hybride RPPS.
 */
export const rppsRadiusMetadata = (radiusKm?: number): QueryMetadata => {
  const md = buildMetadata("centroide_commune_ans_mixte", true, radiusKm);
  if (isShortRadius(radiusKm)) {
    md.notes.push(
      `radius_km=${radiusKm} < ${CENTROIDE_COMMUNE_RESOLUTION_KM} km : la branche centroïde commune résiduelle (~31,5 % des PS) reste imprécise (TOUS les PS d'une commune passent ou non en bloc, distance_km non discriminante intra-commune). La branche précise (~68,5 %, geo_precision ∈ {adresse, etablissement_finess}) reste fiable. Pour un résultat strictement classable et 100 % précis à ce rayon, passer precise_only: true (ou élargir radius_km ≥ ${CENTROIDE_COMMUNE_RESOLUTION_KM} pour un mix hybride exploitable).`,
    );
  }
  return md;
};

/**
 * Listing départemental : pas de spatial — la précision MIXTE PAR RÉSULTAT
 * reste pertinente (pour les callers qui croisent ensuite `coords`/`num_finess`).
 */
export const rppsDeptMetadata = (): QueryMetadata =>
  buildMetadata("centroide_commune_ans_mixte", false);

export const rppsEtablissementMetadata = (): QueryMetadata =>
  buildMetadata("structure_finess", false);

export const cdsRadiusMetadata = (radiusKm?: number): QueryMetadata =>
  buildMetadata("centroide_commune_cds", true, radiusKm);

/**
 * Métadonnées pour `rpps_search_by_name` : recherche fuzzy par identité.
 * Depuis V0.12.0, la géo précision est MIXTE par-résultat (lire `geo_precision`
 * de chaque PS — `adresse`/`etablissement_finess`/`centroide_commune`). L'ajout
 * sémantique propre à ce tool reste la note de scoring trigram : résultats
 * triés par pertinence et non par exactitude, un `match_score < 0.5` signale
 * souvent une homonymie partielle à confirmer côté caller.
 */
export const rppsSearchByNameMetadata = (): QueryMetadata => {
  const md = buildMetadata("centroide_commune_ans_mixte", false);
  md.notes.push(
    "Résultats triés par similarité trigram (pg_trgm) sur nom + prénom. Le champ `match_score` (0..1) indique la pertinence — un score < 0.5 = homonymie partielle, à confirmer côté caller.",
    "Sur un nom TRÈS commun sans `departement` ni `prenom`, les candidats sont plafonnés (cap interne) AVANT le tri de pertinence : le résultat est alors un ÉCHANTILLON non exhaustif (et non strictement les plus pertinents au niveau national). Préciser `departement=` ou `prenom=` pour un résultat exhaustif et stable.",
  );
  return md;
};
