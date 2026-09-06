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
 * - `centroide_commune_ameli` : @deprecated Chantier C — coords Ameli au
 *   centroïde commune (~3 km). Remplacé par `centroide_commune_ameli_mixte`
 *   depuis le 2026-05-21 (77 % des PS Ameli en `geom_source='ban_address'`
 *   post-cron, donc précision MIXTE par-résultat). Conservé pour rétrocompat
 *   de tout client qui aurait caché la string `geo_precision` côté
 *   query_metadata (Claude.ai, Cursor, agents loggant). Ne plus produire
 *   dans un nouveau call site.
 */
export type GeoPrecision =
  | "lambert93_natif_finess"
  | "centroide_commune_ameli"
  /**
   * Chantier C 2026-05-21 — étiquette par défaut Ameli post-géocodage BAN.
   * Précision MIXTE par-résultat (lire `geo_precision` PAR PS) : ~77 % en
   * `adresse` BAN (rue/bâtiment, distance exacte), ~23 % en `centroide_commune`
   * (~3 km, repli pour adresses non géocodables — DROM, CEDEX, Monaco, etc.).
   * Symétrique de `centroide_commune_ans_mixte` côté RPPS V0.12.0.
   */
  | "centroide_commune_ameli_mixte"
  /**
   * Chantier C 2026-05-21 — variante effective de `centroide_commune_ameli_mixte`
   * quand TOUS les résultats retournés sont en précision adresse (`ban_address`).
   * Évite que le caller LLM lise une étiquette "mixte" pessimiste quand un
   * heureux hasard de distribution produit 100 % de précis.
   */
  | "centroide_commune_ameli_precis_uniquement"
  /**
   * Chantier C 2026-05-21 — variante effective quand TOUS les résultats sont
   * au centroïde commune. Indique au caller que `distance_km` n'est pas
   * discriminant intra-commune sur CETTE réponse spécifique (≠ étiquette
   * mixte qui suggère qu'une part est précise).
   */
  | "centroide_commune_ameli_centroide_uniquement"
  | "centroide_commune_ans"
  | "centroide_commune_ans_mixte"
  /**
   * V0.13.0 — variante effective de `centroide_commune_ans_mixte` quand TOUS
   * les résultats retournés sont en précision exacte (`adresse` BAN ou
   * `etablissement_finess`). Évite que le caller LLM lise une étiquette
   * globale "mixte" pessimiste quand le filtre `precise_only=true` (ou un
   * heureux hasard de distribution) a produit 100 % de précis. Source : ANS.
   */
  | "centroide_commune_ans_precis_uniquement"
  /**
   * V0.13.0 — variante effective quand TOUS les résultats sont au centroïde
   * commune. Indique au caller que `distance_km` n'est pas discriminant
   * intra-commune sur CETTE réponse spécifique (≠ étiquette globale mixte
   * qui suggère qu'une part est précise). Source : ANS.
   */
  | "centroide_commune_ans_centroide_uniquement"
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
 * - `etablissement_finess` : point du site FINESS joint via `num_finess` —
 *   point ANS quand l'ANS en fournit un, sinon point BAN de l'adresse du site
 *   (bâtiment, rue ou lieu-dit) ou point hérité du run précédent, jamais un
 *   centroïde commune. `distance_km` exacte au site. Issu de
 *   `geom_source='finess_join'` en base.
 * - `centroide_commune` : centroïde commune (~3 km moyenne) — `distance_km`
 *   IDENTIQUE pour tous les PS d'une même commune, NON discriminante pour
 *   classer/choisir un PS individuel (utiliser uniquement comme filtre de
 *   zone). Issu de `geom_source='commune_centroid'` en base.
 *
 * RPPS expose les 3 valeurs depuis V0.12.0 (post-PR #23 FINESS join + ban_join
 * keyset). Ameli expose `adresse` + `centroide_commune` depuis le Chantier C
 * V0.14.0 (géocodage BAN — pas de FINESS join côté Ameli, donc jamais
 * `etablissement_finess`). Le détail source reste dans `query_metadata.geo_precision`.
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
  /** @deprecated Chantier C 2026-05-21 — Plus aucune RPC Ameli ne produit cet alias ; toutes ont migré vers `centroide_commune_ameli_mixte` (précision hybride par-résultat post-géocodage BAN). Conservé pour rétrocompat de tout client qui aurait caché la string. Ne pas réintroduire dans un nouveau call site. */
  centroide_commune_ameli:
    "Coordonnées Ameli = centroïde commune (~3 km moyenne). Adapté à l'analyse de densité médicale, pas au géocodage adresse.",
  centroide_commune_ameli_mixte:
    'Coordonnées Ameli HYBRIDES (Chantier C 2026-05-21) : la précision est MIXTE par résultat — lire `geo_precision` PAR PS. ~77 % sont précis (`"adresse"` BAN rue/bâtiment) avec `distance_km` exacte au m près ; ~23 % restent au centroïde commune (`"centroide_commune"`, ~3 km, `distance_km` non discriminante intra-commune — adresses non géocodables BAN : DROM, Monaco, CEDEX, lieux-dits obscurs). Source : Annuaire santé Ameli, Assurance Maladie (mention obligatoire L.1461-2 CSP).',
  centroide_commune_ameli_precis_uniquement:
    "Coordonnées Ameli — variante effective Chantier C 2026-05-21 : TOUS les résultats retournés sur cette requête sont en précision adresse (`ban_address`). `distance_km` est exacte au m près pour chaque PS, classement individuel fiable. Source : Annuaire santé Ameli, Assurance Maladie (mention obligatoire L.1461-2 CSP). NB : la donnée source reste hybride — d'autres PS au centroïde commune existent peut-être dans la zone mais étaient hors rayon ou filtrés.",
  centroide_commune_ameli_centroide_uniquement:
    "Coordonnées Ameli — variante effective Chantier C 2026-05-21 : TOUS les résultats retournés sur cette requête sont au centroïde commune (~3 km). `distance_km` n'est PAS discriminante intra-commune (tous les PS d'une même commune ont la même distance au centre du rayon). Source : Annuaire santé Ameli, Assurance Maladie (mention obligatoire L.1461-2 CSP). Pour un classement fiable, élargir radius_km ≥ ~3 km pour capter aussi les PS en précision adresse (~77 % du référentiel post-géocodage BAN).",
  lambert93_natif_finess:
    "FINESS DREES (sync bimestrielle) — référentiel peut avoir 1-2 mois de retard sur le terrain pour les structures émergentes (CPTS récentes, MSP en agrément). Cross-check ARS / Service Public si nécessaire.",
  /** @deprecated V0.12.0 — Plus aucune RPC RPPS ne produit cet alias ; toutes ont migré vers `centroide_commune_ans_mixte` (précision hybride par-résultat). Conservé pour rétrocompat de tout client qui aurait caché la string `geo_precision` côté query_metadata (Claude.ai, Cursor, agents loggant). Ne pas réintroduire dans un nouveau call site. */
  centroide_commune_ans:
    "Coordonnées RPPS/ANS = centroïde commune (~3 km moyenne). Source : Annuaire Santé ANS — Licence Ouverte v2.0. Pour une précision adresse, croiser num_finess avec etablissement_by_finess.",
  centroide_commune_ans_mixte:
    'Coordonnées RPPS HYBRIDES (V0.12.0) : la précision est MIXTE par résultat — lire `geo_precision` PAR PS. ~68,5 % sont précis (`"adresse"` BAN rue/bâtiment ou `"etablissement_finess"` site FINESS joint via num_finess) avec `distance_km` exacte ; ~31,5 % restent au centroïde commune (`"centroide_commune"`, ~3 km, `distance_km` non discriminante intra-commune). Source : Annuaire Santé ANS — Licence Ouverte v2.0. Pour FORCER 100 % de résultats précis (rayons courts <3 km, classement individuel), passer `precise_only: true` côté tool radius.',
  centroide_commune_ans_precis_uniquement:
    "Coordonnées RPPS — variante effective V0.13.0 : TOUS les résultats retournés sur cette requête sont en précision exacte (`adresse` BAN ou `etablissement_finess`). `distance_km` est exacte au mètre près pour chaque PS retourné, classement individuel fiable. Source : Annuaire Santé ANS — Licence Ouverte v2.0. NB : la donnée source reste hybride (mixte) — d'autres PS au centroïde commune existent peut-être dans la zone mais étaient hors rayon ou filtrés par `precise_only: true`.",
  centroide_commune_ans_centroide_uniquement:
    "Coordonnées RPPS — variante effective V0.13.0 : TOUS les résultats retournés sur cette requête sont au centroïde commune (~3 km). `distance_km` n'est PAS discriminante intra-commune (tous les PS d'une même commune ont la même distance au centre du rayon). Source : Annuaire Santé ANS — Licence Ouverte v2.0. Pour un classement fiable, pivoter via FINESS (etablissement_by_finess) ou élargir radius_km au-delà de ~3 km pour capter aussi les PS précis.",
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
 *
 * **V0.13.0 — exhaustivité compile-time** : converti en `Record<GeoPrecision, boolean>`
 * pour que TypeScript fail à tout ajout futur de `GeoPrecision` non classé
 * explicitement (même garde-fou que `SOURCE_NOTE`). Avant, c'était un `Set`
 * qui acceptait silencieusement n'importe quelle nouvelle valeur sans
 * décision (piège dormant identifié /review Passe 1 silent-failure-hunter
 * sur les 2 valeurs V0.13 `_precis_uniquement` / `_centroide_uniquement`).
 *
 * Discrimination par valeur (commentaire load-bearing) :
 * - `centroide_commune_ans_mixte` = `false` (mode hybride : branche précise
 *   garde des distances exactes même à radius_km < 3 km, donc la note
 *   générique `subCommuneRadiusNote` serait FAUSSE et ferait pivoter à tort
 *   le caller vers FINESS). Une note dédiée nuancée est injectée par
 *   `rppsRadiusMetadata` si applicable.
 * - `centroide_commune_ans_precis_uniquement` = `false` (V0.13 — 100 %
 *   précis effectif, aucune note centroïde nécessaire).
 * - `centroide_commune_ans_centroide_uniquement` = **`true`** (V0.13 — 100 %
 *   centroïde effectif, exactement le cas où le warning sub-commune
 *   s'applique aggravé : aucun précis à élarger via `precise_only=true`).
 * - `centroide_commune_ans` reste `true` pour rétrocompat (deprecated, plus produit).
 * - `lambert93_natif_finess` / `structure_finess` = `false` (précision adresse,
 *   pas de piège centroïde).
 */
const CENTROID_PRECISIONS = {
  lambert93_natif_finess: false,
  centroide_commune_ameli: true, // deprecated Chantier C, plus produit (cf. SOURCE_NOTE)
  // Chantier C 2026-05-21 : précision MIXTE (~77 % adresse, ~23 % centroïde)
  // → la branche précise reste fiable, note générique sub-commune trompeuse
  // (cf. discrimination par-valeur ci-dessus, jumeau RPPS V0.13).
  centroide_commune_ameli_mixte: false,
  // Chantier C : 100 % précis effectif, aucune note centroïde nécessaire.
  centroide_commune_ameli_precis_uniquement: false,
  // Chantier C : 100 % centroïde effectif, note sub-commune s'applique
  // aggravée (aucun précis pour élargir).
  centroide_commune_ameli_centroide_uniquement: true,
  centroide_commune_ans: true, // deprecated, plus produit (cf. SOURCE_NOTE)
  centroide_commune_ans_mixte: false,
  centroide_commune_ans_precis_uniquement: false,
  centroide_commune_ans_centroide_uniquement: true,
  centroide_commune_cds: true,
  structure_finess: false,
} as const satisfies Record<GeoPrecision, boolean>;

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
  return isShortRadius(radiusKm) && CENTROID_PRECISIONS[precision];
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

/**
 * Métadonnées pour `ameli_in_radius` : depuis Chantier C 2026-05-21 la précision
 * est MIXTE par-résultat (~77 % `adresse` BAN, ~23 % `centroide_commune` repli).
 * Étiquette globale = `centroide_commune_ameli_mixte` (initiale, raffinée
 * post-RPC par `refineAmeliGeoPrecisionLabel` selon la distribution effective).
 *
 * À radius_km < CENTROIDE_COMMUNE_RESOLUTION_KM, on ne déclenche PAS la note
 * générique (la branche précise reste fiable) — on injecte une note nuancée
 * spécifique au mode hybride Ameli (jumeau de `rppsRadiusMetadata`).
 */
export const ameliRadiusMetadata = (radiusKm?: number): QueryMetadata => {
  const md = buildMetadata("centroide_commune_ameli_mixte", true, radiusKm);
  if (isShortRadius(radiusKm)) {
    md.notes.push(
      `radius_km=${radiusKm} < ${CENTROIDE_COMMUNE_RESOLUTION_KM} km : la branche centroïde commune résiduelle (~23 % des PS Ameli) reste imprécise (TOUS les PS d'une commune passent ou non en bloc, distance_km non discriminante intra-commune). La branche précise (~77 %, geo_precision='adresse') reste fiable. Pour un mix hybride exploitable à ce rayon, garder cet appel ; pour un fallback densité de zone, élargir radius_km ≥ ${CENTROIDE_COMMUNE_RESOLUTION_KM}.`,
    );
  }
  return md;
};

export const ameliDeptMetadata = (): QueryMetadata =>
  buildMetadata("centroide_commune_ameli_mixte", false);

/**
 * Shape minimal qu'un row doit exposer pour être inspecté par les helpers
 * `refine{Rpps,Ameli}GeoPrecisionLabel`. Type unique partagé — les 2 sources
 * exposent la MÊME `PerResultGeoPrecision` sur leurs résultats, donc une
 * shape unique est sémantiquement correcte (simplify M-1 /simplify quality
 * post-Chantier C). Co-localisé avec les helpers pour documenter le couplage
 * explicite avec `RppsResult` / `AmeliResult` sans dépendance circulaire
 * core/ → sante/.
 */
export type GeoPrecisionRow = { geo_precision?: PerResultGeoPrecision | null };

/** @deprecated Utiliser `GeoPrecisionRow` (simplify M-1). Alias rétrocompat. */
export type AmeliGeoPrecisionRow = GeoPrecisionRow;

/**
 * Flags 1-shot module-level pour les warns de `refineAmeliGeoPrecisionLabel`
 * (simplify H-2 quality). Évitent le spam log quand un caller boucle sur
 * 1000+ datasets driftés. Pattern aligné sur `_ameliGeoPrecisionMissingWarned`
 * dans `sante/ameli-db.ts` + convention CLAUDE.md « Tests `_resetXForTesting()`
 * pour tout module avec état partagé ».
 */
let _refineAmeliDriftWarned = false;
let _refineAmeliFinessUnexpectedWarned = false;

/** Test-only — reset les flags 1-shot des warns de raffinage Ameli. */
export function _resetRefineAmeliWarnings(): void {
  _refineAmeliDriftWarned = false;
  _refineAmeliFinessUnexpectedWarned = false;
}

/**
 * Chantier C 2026-05-21 — raffine l'étiquette globale `geo_precision` Ameli
 * selon la distribution réelle des `geo_precision` par-résultat. La metadata
 * initiale (construite par `ameliRadiusMetadata`/`ameliDeptMetadata` avant
 * exécution RPC) déclare le **contrat** de la requête (`centroide_commune_ameli_mixte`
 * = "potentiellement mixte"). Une fois les résultats matérialisés, on connaît
 * la distribution EFFECTIVE et on peut affiner l'étiquette globale pour ne pas
 * mentir au caller LLM.
 *
 * Jumeau STRICT de `refineRppsGeoPrecisionLabel` (V0.13.0 Fix #4). Trois cas :
 *   - 100 % des rows en `adresse` → `centroide_commune_ameli_precis_uniquement`
 *   - 100 % des rows en `centroide_commune` → `centroide_commune_ameli_centroide_uniquement`
 *   - mixte ou 0 row → étiquette initiale inchangée (`mixte`)
 *
 * **Factory pure** : retourne un nouveau `QueryMetadata` si raffinage applicable,
 * sinon `baseMeta` tel quel. Le caller DOIT réassigner.
 *
 * **Branche `etablissement_finess`** : ne survient PAS côté Ameli (pas de
 * FINESS join). Si la RPC en émet un (drift de contrat), comptée en précis par
 * défense (symétrie RPPS) ET warn loud 1-shot pour audit prod (simplify H-1
 * quality : aligne code → doc, discipline anti-silencieux).
 */
export function refineAmeliGeoPrecisionLabel(
  rows: ReadonlyArray<GeoPrecisionRow>,
  baseMeta: QueryMetadata,
): QueryMetadata {
  // Ne raffine QUE si la metadata initiale est l'étiquette mixte canonique
  // Chantier C — sinon le caller utilise déjà une étiquette spécialisée et on
  // ne doit pas la surcharger silencieusement.
  if (baseMeta.geo_precision !== "centroide_commune_ameli_mixte") return baseMeta;
  if (rows.length === 0) return baseMeta;
  let precisCount = 0;
  let centroideCount = 0;
  let countedRows = 0;
  for (const row of rows) {
    const p = row.geo_precision;
    if (p === undefined || p === null) {
      // Row LÉGITIME sans coords : `toAmeliResult` OMET `geo_precision` quand
      // `coords=null` (contrat documenté `AmeliResult.geo_precision?`). Ce
      // n'est PAS un drift RPC — skip silencieux. Le type
      // `GeoPrecisionRow.geo_precision?: ... | null` autorise les 2 formes
      // (omission OU null explicite) ; on les traite à l'identique.
      // Fix Passe 1+2 silent-failure-hunter H-1 — bug pré-existant côté RPPS
      // Fix #4 V0.13.0, fixé en parallèle ici.
      continue;
    }
    if (p === "adresse") {
      precisCount++;
      countedRows++;
    } else if (p === "etablissement_finess") {
      // Drift contract Ameli : la RPC ne devrait JAMAIS émettre cette valeur
      // (pas de FINESS join côté Ameli). Compté en précis par symétrie RPPS,
      // warn loud 1-shot pour audit prod (simplify H-1 quality).
      precisCount++;
      countedRows++;
      if (!_refineAmeliFinessUnexpectedWarned) {
        _refineAmeliFinessUnexpectedWarned = true;
        console.warn(
          `[france-data-mcp] refineAmeliGeoPrecisionLabel: row.geo_precision="etablissement_finess" inattendu côté Ameli (pas de FINESS join — drift contract RPC suspectée). Compté en précis par défense, audit la RPC ameli_in_radius / ameli_by_specialite_dept.`,
        );
      }
    } else if (p === "centroide_commune") {
      centroideCount++;
      countedRows++;
    } else {
      // Valeur typée NON canonique (e.g. "iris", "foo") : VRAI drift contract.
      // Warn loud 1-shot module-level (simplify H-2 quality : anti-spam si
      // caller boucle). On garde l'étiquette mixte par sécurité.
      if (!_refineAmeliDriftWarned) {
        _refineAmeliDriftWarned = true;
        console.warn(
          `[france-data-mcp] refineAmeliGeoPrecisionLabel: row.geo_precision avec valeur non-canonique (=${JSON.stringify(p)}) — étiquette mixte préservée par sécurité, drift contract RPC suspectée.`,
        );
      }
      return baseMeta;
    }
  }
  // Tous skippés (toutes les rows sans coords/sans geo_precision) → mixte initial.
  if (countedRows === 0) return baseMeta;
  if (precisCount !== countedRows && centroideCount !== countedRows) {
    // Mixte effectif (precisCount > 0 ET centroideCount > 0 sur les rows
    // countées). Early return AVANT l'allocation `notes.slice(1)`.
    return baseMeta;
  }
  const refinedPrecision: GeoPrecision =
    precisCount === countedRows
      ? "centroide_commune_ameli_precis_uniquement"
      : "centroide_commune_ameli_centroide_uniquement";
  // Drop la note short-radius nuancée Ameli quand on refine vers
  // `_centroide_uniquement` (la note affirme "branche précise ~77 % fiable"
  // alors qu'il n'y a AUCUN précis dans le résultat refine — mensonger).
  // Symétrique du fix RPPS Passe 1 silent-failure-hunter. `const` ternaire
  // pour immutabilité claire (simplify M-3 quality).
  const initialTrailing = baseMeta.notes.slice(1);
  const trailingNotes =
    refinedPrecision === "centroide_commune_ameli_centroide_uniquement"
      ? initialTrailing.filter((n) => !n.includes("La branche précise"))
      : initialTrailing;
  return {
    ...baseMeta,
    geo_precision: refinedPrecision,
    notes: [SOURCE_NOTE[refinedPrecision], ...trailingNotes],
  };
}

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
/** @deprecated Utiliser `GeoPrecisionRow` (simplify M-1 Chantier C). Alias rétrocompat. */
export type RppsGeoPrecisionRow = GeoPrecisionRow;

/**
 * **V0.13.0 Fix #4** — raffine l'étiquette globale `geo_precision` selon la
 * distribution réelle des `geo_precision` par-résultat. La métadata initiale
 * (construite par `rppsRadiusMetadata` avant exécution RPC) déclare le
 * **contrat** de la requête (`centroide_commune_ans_mixte` = "potentiellement
 * mixte"). Une fois les résultats matérialisés, on connaît la distribution
 * EFFECTIVE et on peut affiner l'étiquette globale pour ne pas mentir au
 * caller LLM (qui prend des décisions basées sur cette étiquette).
 *
 * Trois cas après inspection :
 *   - 100 % des rows en `adresse` ou `etablissement_finess` →
 *     `"centroide_commune_ans_precis_uniquement"` (sub-cas précis-only de mixte)
 *   - 100 % des rows en `centroide_commune` →
 *     `"centroide_commune_ans_centroide_uniquement"` (sub-cas centroïde-only)
 *   - mixte ou 0 row → étiquette initiale inchangée (`mixte`)
 *
 * **Factory pure** (V0.13 /simplify quality fix) : retourne un NOUVEAU
 * `QueryMetadata` quand un raffinage est applicable, sinon retourne `baseMeta`
 * tel quel (même référence). Le caller DOIT réassigner le retour pour profiter
 * du raffinage. Aligné sur le pattern des autres helpers du module
 * (`rppsRadiusMetadata` etc. = factories pures).
 *
 * **Contrat avec `buildMetadata`** : la SOURCE_NOTE de l'étiquette est
 * conventionnellement en `notes[0]` (cf. `buildMetadata`). Le raffinage
 * remplace cette première note par la nouvelle SOURCE_NOTE, et préserve les
 * notes additionnelles en queue (Haversine, short-radius warning…). Si un
 * jour `buildMetadata` insère une autre note prioritaire en tête, ce contrat
 * doit être mis à jour ici aussi. Un test garde-fou verrouille l'invariant.
 *
 * **Pourquoi pas dans `buildListQueryResult`** : la signature générique de ce
 * builder ne connaît rien au shape `RppsResult.geo_precision`. Ce helper est
 * dédié au domaine RPPS (consommé par `rpps-db.ts` `getRppsInRadius`).
 */
export function refineRppsGeoPrecisionLabel(
  rows: ReadonlyArray<RppsGeoPrecisionRow>,
  baseMeta: QueryMetadata,
): QueryMetadata {
  // Ne raffine QUE si la metadata initiale est l'étiquette mixte canonique
  // V0.12.0 — sinon le caller utilise déjà une étiquette spécialisée et on
  // ne doit pas la surcharger silencieusement.
  if (baseMeta.geo_precision !== "centroide_commune_ans_mixte") return baseMeta;
  if (rows.length === 0) return baseMeta;
  let precisCount = 0;
  let centroideCount = 0;
  let countedRows = 0;
  for (const row of rows) {
    const p = row.geo_precision;
    if (p === undefined || p === null) {
      // Row LÉGITIME sans coords : `toRppsResult` OMET `geo_precision` quand
      // `coords=null` (contrat documenté `RppsResult.geo_precision?`). Le
      // type `GeoPrecisionRow.geo_precision?: ... | null` autorise les 2
      // formes (omission OU null explicite) ; on les traite à l'identique.
      // Fix Passe 1+2 silent-failure-hunter H-1 du chantier C suivi : bug
      // pré-existant Fix #4 V0.13.0 qui confondait null-geom légitime avec
      // drift contract → warn loud mensonger sur rows à coords NULL en prod.
      continue;
    }
    if (p === "adresse" || p === "etablissement_finess") {
      precisCount++;
      countedRows++;
    } else if (p === "centroide_commune") {
      centroideCount++;
      countedRows++;
    } else {
      // Valeur typée NON canonique (e.g. "iris", "foo") : VRAI drift contract
      // → warn LOUD pour audit prod (ne PAS confondre avec le cas légitime
      // null-geom skippé plus haut).
      console.warn(
        `[france-data-mcp] refineRppsGeoPrecisionLabel: row.geo_precision avec valeur non-canonique (=${JSON.stringify(p)}) — étiquette mixte préservée par sécurité, drift contract RPC suspectée.`,
      );
      return baseMeta;
    }
  }
  // Tous skippés (toutes les rows sans coords) → mixte initial.
  if (countedRows === 0) return baseMeta;
  let refinedPrecision: GeoPrecision;
  if (precisCount === countedRows) {
    refinedPrecision = "centroide_commune_ans_precis_uniquement";
  } else if (centroideCount === countedRows) {
    refinedPrecision = "centroide_commune_ans_centroide_uniquement";
  } else {
    // Mixte effectif (precisCount > 0 ET centroideCount > 0 sur countedRows)
    // → étiquette initiale conservée (déjà correcte).
    return baseMeta;
  }
  // Fix P1 /review Passe 1 silent-failure-hunter : si on refine vers
  // `_centroide_uniquement`, la note `shortRadiusMixedNote` (appendée par
  // `rppsRadiusMetadata` quand radius_km < 3 km) devient MENSONGÈRE — elle
  // affirme "la branche précise (~68,5 %) reste fiable, passer
  // `precise_only: true`" alors qu'il n'y a AUCUN précis dans le résultat
  // refine. Drop cette note (détection par signature "La branche précise" —
  // unique dans la note, cf. `rppsRadiusMetadata` ligne ci-dessous : la
  // signature est load-bearing pour ce filtre).
  let trailingNotes = baseMeta.notes.slice(1);
  if (refinedPrecision === "centroide_commune_ans_centroide_uniquement") {
    trailingNotes = trailingNotes.filter((n) => !n.includes("La branche précise"));
  }
  return {
    ...baseMeta,
    geo_precision: refinedPrecision,
    notes: [SOURCE_NOTE[refinedPrecision], ...trailingNotes],
  };
}

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
