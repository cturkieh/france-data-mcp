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
  | "centroide_commune_cds"
  | "structure_finess";

/**
 * Précision géo exposée au niveau de CHAQUE PS (champ `geo_precision` des
 * résultats Ameli/RPPS), volontairement plus générique que `GeoPrecision`
 * (source-spécifique, au niveau global du résultat). Co-localisée avec
 * `coords`/`distance_km` pour rappeler, par PS, que tous les PS d'une même
 * commune partagent ces valeurs (centroïde) et ne peuvent pas être classés
 * entre eux par `distance_km`. Le détail source reste dans
 * `query_metadata.geo_precision`.
 */
export type PerResultGeoPrecision = "centroide_commune";

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
  centroide_commune_ans:
    "Coordonnées RPPS/ANS = centroïde commune (~3 km moyenne). Source : Annuaire Santé ANS — Licence Ouverte v2.0. Pour une précision adresse, croiser num_finess avec etablissement_by_finess.",
  structure_finess:
    "Liste rattachée à un FINESS site. Le mode_exercice révèle la nature du lien (libéral / salarié). Couverture RPPS quand le PS l'a déclaré ; salariés CH/CHU/cliniques bien couverts.",
  centroide_commune_cds:
    "Coordonnées CDS = centroïde commune (~3 km moyenne) — pas de coords natives dans le CSV CNAM. Source : Annuaire santé Ameli, Assurance Maladie (mention obligatoire L.1461-2 CSP). Pivot via etab_finess vers FINESS DREES pour précision adresse.",
};

const HAVERSINE_NOTE =
  "Distance calculée en vol d'oiseau (haversine PostGIS). Pour la distance routière, croiser avec un service externe (OSRM, ORS).";

/**
 * Builder unique pour les 4 cas (Ameli/FINESS × radius/list). Factorise les
 * 4 helpers historiques. Si une nouvelle source spatiale arrive (IRIS, RPPS),
 * ajouter une entrée à `SOURCE_NOTE` et un alias à la fin du fichier.
 */
function buildMetadata(precision: GeoPrecision, withDistance: boolean): QueryMetadata {
  const notes = [SOURCE_NOTE[precision]];
  const result: QueryMetadata = { geo_precision: precision, notes };
  if (withDistance) {
    result.distance_type = "haversine_postgis";
    notes.push(HAVERSINE_NOTE);
  }
  return result;
}

export const ameliRadiusMetadata = (): QueryMetadata =>
  buildMetadata("centroide_commune_ameli", true);

export const ameliDeptMetadata = (): QueryMetadata =>
  buildMetadata("centroide_commune_ameli", false);

export const finessRadiusMetadata = (): QueryMetadata =>
  buildMetadata("lambert93_natif_finess", true);

export const finessByCategorieMetadata = (): QueryMetadata =>
  buildMetadata("lambert93_natif_finess", false);

export const rppsRadiusMetadata = (): QueryMetadata => buildMetadata("centroide_commune_ans", true);

export const rppsDeptMetadata = (): QueryMetadata => buildMetadata("centroide_commune_ans", false);

export const rppsEtablissementMetadata = (): QueryMetadata =>
  buildMetadata("structure_finess", false);

export const cdsRadiusMetadata = (): QueryMetadata => buildMetadata("centroide_commune_cds", true);

/**
 * Métadonnées pour `rpps_search_by_name` : recherche fuzzy par identité. La
 * géo précision reste celle d'ANS (centroïde commune) ; l'ajout sémantique est
 * la note de scoring trigram qui prévient le caller que les résultats sont
 * triés par pertinence et non par exactitude, et qu'un `match_score < 0.5`
 * indique souvent une homonymie partielle.
 */
export const rppsSearchByNameMetadata = (): QueryMetadata => {
  const md = buildMetadata("centroide_commune_ans", false);
  md.notes.push(
    "Résultats triés par similarité trigram (pg_trgm) sur nom + prénom. Le champ `match_score` (0..1) indique la pertinence — un score < 0.5 = homonymie partielle, à confirmer côté caller.",
  );
  return md;
};
