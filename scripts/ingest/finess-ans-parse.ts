/**
 * Mapping du flux FINESS « nouvelle génération » de l'ANS vers les lignes de
 * `finess_staging`.
 *
 * Contexte (2026-09-05) : la DREES a arrêté la génération des flux CSV FINESS
 * le 20 juillet 2026 (dernier millésime : 04/05/2026). L'ANS reprend la
 * diffusion en JSON quotidien (`finess-structures-journalier-AAAAMMJJ.json.gz`,
 * data.gouv.fr `finess-structures-1`). Le cron court-circuitait en
 * `same_checksum` depuis juin sans que rien ne le signale —
 * cf. `docs/plans/finess-migration-ans.md`.
 *
 * Ce module ne contient QUE des fonctions pures : aucun réseau, aucune DB.
 * C'est ce qui permet de prouver le mapping sur des fixtures réelles extraites
 * du flux (`__fixtures__/finess-ans-ege.json`), sans monter une ingestion.
 */

import { SIRET_PATTERN } from "../../src/sante/db-helpers.js";
import { SMT_CATEGORIE_LABELS } from "../../src/sante/finess-categories-labels.js";
import { type FinessGeomSource, GEOM_SOURCES } from "../../src/sante/finess-geom-source.js";
import { deptFromCodeInsee, isValidCodeInsee } from "../../src/territoire/dept-codes.js";

/**
 * Libellés officiels des catégories d'EGE (nomenclature TRE_R397 du serveur
 * multi-terminologies ANS), FIGÉS dans le repo par
 * `refresh-finess-categories.ts` — SOURCE UNIQUE partagée avec la lib
 * (`src/sante/finess-categories.ts`). Le flux ANS ne livre que le code ; le CSV
 * DREES livrait le libellé. Figé plutôt qu'appelé au run : une indisponibilité
 * du SMT ne doit jamais produire un swap avec des `categorie_libelle` NULL.
 * SMT NU, sans `HORS_NOMENCLATURE_LABELS` (lib-only, ex. 619 imagerie) : la
 * base ne porte que des libellés officiels — un tel code arriverait avec
 * `categorie_libelle` NULL, compté par `missingLabelCounts`.
 */
const CATEGORIE_LABELS: Readonly<Record<string, string>> = SMT_CATEGORIE_LABELS;

/**
 * `usageAdresse` de l'adresse à retenir : « Adresse géographique du lieu
 * d'exercice » (nomenclature TRE_R377).
 *
 * LOAD-BEARING — ne JAMAIS remplacer par `adresse[0]`. Un EGE porte 1 à 150
 * adresses (accueil `06`, annexe `04`, correspondance `02`) ; seule `03` est
 * l'adresse géographique, présente exactement une fois par EGE actif
 * (104 734/104 734 sur le flux du 2026-09-05). Sur 2 294 EGE actifs, `03`
 * n'est PAS en première position : `adresse[0]` les géolocaliserait sur leur
 * accueil ou leur annexe, en silence.
 */
const USAGE_ADRESSE_GEOGRAPHIQUE = "03";

/** `etatObjet` d'un EGE en service. L'autre valeur observée est "I" (inactif). */
const ETAT_ACTIF = "A";

/**
 * Numéro FINESS d'entité géographique : 9 caractères, département sur 2
 * (Corse `2A`/`2B` compris) + 7 chiffres — `2A0022596` existe. `num_finess`
 * est la clé primaire `CHAR(9)` : une valeur hors format ne peut ni être
 * nullée ni tronquée, l'EGE est écarté (`bad_finess_id`).
 */
const NUM_FINESS_EGE = /^(\d{2}|2[AB])\d{7}$/;

/**
 * Domaine WGS84 complet. Sert à RECONNAÎTRE laquelle des deux paires est en
 * degrés — voir `resolveCoordinates` — face à une paire projetée (≥ 100 000) :
 * un degré et un mètre Lambert sont séparés de quatre ordres de grandeur,
 * une emprise « France » n'apporte rien à la détection et exclurait le
 * Pacifique (Wallis-et-Futuna -176°, Polynésie -150°, Nouvelle-Calédonie
 * 166° — 986/987/988 sont des codes commune valides côté `isValidCodeInsee`).
 * Seule corruption gardée : le point exact (0, 0), « null island ».
 */
const WGS84_LON = [-180, 180] as const;
const WGS84_LAT = [-90, 90] as const;
/** Emprise Lambert 93 (EPSG:2154), métropole uniquement. */
const L93_X = [100_000, 1_300_000] as const;
const L93_Y = [6_000_000, 7_200_000] as const;

/**
 * Contraintes des colonnes de `finess_staging` (migration 20260509000001)
 * qu'une valeur ANS peut violer. Un champ qui ne les respecte pas passe à
 * `null` et son nom est remonté dans `overflows` pour être compté et logué —
 * JAMAIS tronqué. Le premier dry-run (2026-09-05) a échoué en 22001 sur UN
 * téléphone de 21 caractères : Postgres ne tronque pas, nous non plus.
 */
export const COLUMN_RULES = {
  /** VARCHAR(4). */
  categorie_code: (v: string) => v.length <= 4,
  /** VARCHAR(10). */
  num_voie: (v: string) => v.length <= 10,
  /** VARCHAR(50). */
  type_voie: (v: string) => v.length <= 50,
  /** VARCHAR(20). */
  telephone: (v: string) => v.length <= 20,
  /** CHAR(5) : un code plus court serait paddé en silence, un plus long rejeté. */
  code_postal: (v: string) => v.length === 5,
} as const satisfies Partial<Record<keyof FinessStagingRow, (v: string) => boolean>>;
export type OverflowField = keyof typeof COLUMN_RULES;

interface AnsCoordonnees {
  coordonneeX?: string | null;
  coordonneeY?: string | null;
  directionLatitude?: string | null;
  directionLongitude?: string | null;
  cleInInteropBAN?: string | null;
  scoreBAN?: string | null;
}

interface AnsAdresse {
  usageAdresse?: string | null;
  numeroVoie?: string | null;
  typeVoie?: string | null;
  libelleVoie?: string | null;
  cogCommune?: string | null;
  ligneAcheminement?: string | null;
  codePostal?: string | null;
  coordonneesGeographique?: AnsCoordonnees | null;
}

interface AnsTelecom {
  telephone?: string | null;
  courriel?: string | null;
}

interface AnsContact {
  telecom?: AnsTelecom | null;
}

interface AnsInfosEge {
  numFinessEge?: string | null;
  nomEgeLong?: string | null;
  nomEgeCourt?: string | null;
  dateOuverture?: string | null;
  dateFermeture?: string | null;
  siret?: string | null;
}

export interface AnsEge {
  informationsGeneralesEGE?: AnsInfosEge | null;
  categorieentiteGeographiqueExercice?: string | null;
  /** Chaîne sur tout le flux observé ; tableau toléré par défense (`readEtat`). */
  etatObjet?: string | string[] | null;
  dateDerniereMaj?: string | null;
  adresse?: AnsAdresse[] | null;
  contact?: AnsContact[] | null;
}

/** Un élément du tableau `pmej` : la personne morale et ses EGE. */
export interface AnsPmej {
  ege?: AnsEge[] | null;
}

interface FinessStagingBase {
  num_finess: string;
  raison_sociale: string;
  categorie_code: string | null;
  categorie_libelle: string | null;
  num_voie: string | null;
  type_voie: string | null;
  voie: string | null;
  code_postal: string | null;
  code_departement: string;
  code_insee: string;
  ville: string | null;
  telephone: string | null;
  email: string | null;
  date_ouverture: string | null;
  date_maj: string | null;
  /** SIRET natif ANS (`informationsGeneralesEGE.siret`), 14 chiffres ou `null`. */
  siret: string | null;
  /** Clé d'interopérabilité BAN fournie par l'ANS (`cleInInteropBAN`), telle quelle. */
  cle_ban: string | null;
  /** Score BAN fourni par l'ANS (`scoreBAN`), nombre fini ou `null`. */
  score_ban: number | null;
}

/**
 * Le point et sa provenance vont ENSEMBLE — invariant de la contrainte SQL
 * `geom ⇔ geom_source` (migration 20260906T160000), porté par le type comme
 * `ResolvedCoordinates` porte `layout ⟺ point` : `{ geom: null, geom_source:
 * "ans" }` ne compile pas, il n'attend pas 2 h du matin pour échouer en
 * COPY. Le Lambert 93 suit le point (jamais posé sans lui).
 */
export type FinessGeomFields =
  | {
      /** EWKT — PostGIS caste vers `geometry(Point, 4326)` à l'insert. */
      geom: string;
      /** `ans` au parseur ; `previous_ingest` / `ban_address` sont posés par les RPC du cron. */
      geom_source: FinessGeomSource;
      coordx_lambert93: number | null;
      coordy_lambert93: number | null;
    }
  | { geom: null; geom_source: null; coordx_lambert93: null; coordy_lambert93: null };

export type FinessStagingRow = FinessStagingBase & FinessGeomFields;

// Vocabulaire des provenances : SOURCE UNIQUE dans la lib (`src/sante/
// finess-geom-source.ts`, la lib en dépend pour `geo_precision`). Ré-exporté
// ici pour les tests de parité du dossier ingestion.
export { GEOM_SOURCES, type FinessGeomSource } from "../../src/sante/finess-geom-source.js";

/**
 * Quelle paire portait le WGS84 — détail de parsing (statistiques, diagnostic
 * d'une dérive de format), PAS une provenance : le point posé est toujours du
 * WGS84 natif ANS, quelle que soit la paire qui le portait.
 */
export type CoordLayout = "wgs84_first" | "lambert_first";

export type SkipReason =
  | "no_finess_id"
  | "bad_finess_id"
  | "ferme"
  | "inactif"
  | "no_adresse_geographique"
  | "no_commune"
  | "bad_commune";

/** EGE retenu : la ligne de staging et ses signaux de diagnostic. */
export interface ParsedEgeKept {
  kind: "row";
  row: FinessStagingRow;
  /** `null` = aucun point posé (coordonnées absentes, inexploitables, ou centroïde refusé). */
  coordLayout: CoordLayout | null;
  /** Point ANS refusé parce que sa clé BAN désigne une COMMUNE (centroïde). */
  municipalityCentroidRejected: boolean;
  /**
   * `informationsGeneralesEGE.siret` présent mais pas 14 chiffres → colonne
   * `siret` à `null` ; porte la VALEUR rejetée (un warning « 2 000 lignes
   * hors format » sans un seul exemple du nouveau format ne dirait rien),
   * `null` sinon. 0 sur 104 734 le 2026-09-06.
   */
  siretMalformed: string | null;
  /**
   * `scoreBAN` présent mais non numérique (virgule décimale, texte) → colonne
   * `score_ban` à `null`. Compté comme `siretMalformed` : un changement de
   * format amont viderait la colonne en silence sinon. 0 mesuré.
   */
  scoreBanUnparsable: boolean;
  /** Champs mis à `null` parce qu'ils violaient leur colonne (cf. `COLUMN_RULES`). */
  overflows: readonly OverflowField[];
  /**
   * Signal de dérive : des coordonnées sont présentes mais AUCUNE des deux
   * paires n'est un WGS84 plausible. Un changement de format upstream
   * (nouveau système, colonnes inversées autrement) se verrait ici avant
   * de se traduire par des `geom` NULL en masse.
   */
  coordsPresentButUnusable: boolean;
}

/** EGE écarté, avec la raison comptée par `finess.ts`. */
export interface ParsedEgeSkipped {
  kind: "skip";
  skipReason: SkipReason;
}

/**
 * Discriminant explicite (`kind`), même convention que `LookupResult`
 * (`found`) : une union par simple présence de `row` n'est pas exclusive
 * (un objet portant les deux clés y est assignable via une variable) et ne
 * se prête pas à un `switch` exhaustif.
 */
export type ParsedEge = ParsedEgeKept | ParsedEgeSkipped;

/** Réduit les suites d'espaces à un espace simple, puis trim. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * `null` pour toute valeur vide/blanche — le flux ANS utilise `null` ET "".
 * Même convention que `getNonEmpty` (`shared.ts`) : les caractères de contrôle
 * `\x00-\x1f` sont retirés — un `` restitué par `JSON.parse` dans une
 * raison sociale casse un client JSON strict (« Invalid control character »),
 * la raison même du strip côté CSV en 2026-05.
 */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip volontaire de \x00-\x1f (résidus upstream)
  const trimmed = collapseWhitespace(value.replace(/[\x00-\x1f]+/g, " "));
  return trimmed === "" ? null : trimmed;
}

/**
 * `etatObjet` est une chaîne sur les 174 681 EGE du flux observé, mais le
 * schéma JSON le déclare avec un `coding` de type tableau ailleurs : on
 * normalise les deux formes plutôt que de parier sur la stabilité upstream.
 */
export function readEtat(etat: string | string[] | null | undefined): string | null {
  if (Array.isArray(etat)) return nonEmpty(etat[0]);
  return nonEmpty(etat);
}

function toNumber(value: string | null | undefined): number | null {
  const raw = nonEmpty(value);
  if (raw === null) return null;
  // Regex stricte : `Number("12 RUE")` → NaN est filtré par isFinite, mais
  // `Number("")`/`Number(" ")` → 0 ne le serait pas ; nonEmpty l'exclut déjà.
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface Pair {
  x: number | null;
  y: number | null;
}

function inRange(v: number, [min, max]: readonly [number, number]): boolean {
  return v >= min && v <= max;
}

function isWgs84(p: Pair): p is { x: number; y: number } {
  return (
    p.x !== null &&
    p.y !== null &&
    inRange(p.x, WGS84_LON) &&
    inRange(p.y, WGS84_LAT) &&
    !(p.x === 0 && p.y === 0)
  );
}

function isLambert93(p: Pair): p is { x: number; y: number } {
  return p.x !== null && p.y !== null && inRange(p.x, L93_X) && inRange(p.y, L93_Y);
}

export interface Wgs84Point {
  lon: number;
  lat: number;
}
export interface Lambert93Point {
  x: number;
  y: number;
}

/**
 * Invariants exprimés par le type : un point implique une disposition
 * (`layout`) et des coordonnées présentes ; sans point, ni disposition ni
 * Lambert. `finess.ts` compte `geomByLayout` sur `layout` et en déduit les
 * lignes sans point — ce n'est juste que parce que `layout ⟺ point`, et le
 * type l'impose désormais au lieu d'une coïncidence.
 */
export type ResolvedCoordinates =
  | { point: Wgs84Point; layout: CoordLayout; lambert93: Lambert93Point | null; present: true }
  | { point: null; layout: null; lambert93: null; present: boolean };

/**
 * Résout les coordonnées d'une adresse ANS. Le flux porte DEUX paires :
 * `(coordonneeX, coordonneeY)` et `(directionLongitude, directionLatitude)`.
 * L'une est en WGS84 (lon, lat), l'autre en Lambert 93 (X, Y) — mais
 * **laquelle est laquelle varie d'un enregistrement à l'autre** :
 *
 *   - 57 930 EGE actifs : `coordonneeX = 5.254203` (WGS84), `direction* = Lambert` ;
 *   - 20 499 EGE actifs : `coordonneeX = 824475.06` (Lambert), `direction* = WGS84`.
 *
 * (mesuré sur le flux du 2026-09-05 ; les 26 305 restants n'ont aucune paire).
 * Un mapping positionnel aurait donc posé `geom = NULL` sur 20 % des points
 * géolocalisés, sans erreur — le garde-fou `MIN_GEOM_COVERAGE` l'aurait
 * bloqué, mais sans expliquer pourquoi. La détection se fait par PLAGE DE
 * VALEURS : les emprises WGS84 France et Lambert 93 sont disjointes de
 * plusieurs ordres de grandeur, aucune ambiguïté possible.
 *
 * Le Lambert n'est conservé que s'il est dans l'emprise EPSG:2154 : un DOM
 * en mode « projeté » porterait de l'UTM, qu'on ne doit pas stocker comme
 * du Lambert 93.
 */
export function resolveCoordinates(coords: AnsCoordonnees | null | undefined): ResolvedCoordinates {
  const c = coords ?? {};
  const a: Pair = { x: toNumber(c.coordonneeX), y: toNumber(c.coordonneeY) };
  const b: Pair = { x: toNumber(c.directionLongitude), y: toNumber(c.directionLatitude) };
  // `present` se juge sur les CHAÎNES BRUTES, pas sur les valeurs parsées :
  // un passage de l'ANS à la virgule décimale (`"46,267633"`) ou au `+`
  // ferait échouer `toNumber` sur les 4 champs — jugé sur les nombres, ce
  // serait « absent » (silence) au lieu d'« inexploitable » (signal de
  // dérive seuillé). Revue 2026-09-05, code-reviewer.
  const present = [c.coordonneeX, c.coordonneeY, c.directionLongitude, c.directionLatitude].some(
    (v) => nonEmpty(v) !== null,
  );

  const hit = isWgs84(a)
    ? ({ wgs: a, other: b, layout: "wgs84_first" } as const)
    : isWgs84(b)
      ? ({ wgs: b, other: a, layout: "lambert_first" } as const)
      : null;
  if (hit === null) return { point: null, layout: null, lambert93: null, present };
  return {
    point: { lon: hit.wgs.x, lat: hit.wgs.y },
    layout: hit.layout,
    lambert93: isLambert93(hit.other) ? { x: hit.other.x, y: hit.other.y } : null,
    present: true,
  };
}

/**
 * Un seul numéro, sans séparateurs. Le flux ANS met parfois deux numéros dans
 * le champ (« 0690291988/0590895757 », 1 cas sur 104 734 le 2026-09-05) →
 * 21 caractères pour une colonne de 20. On garde le premier ; le second n'a
 * pas de colonne. Espaces, points, tirets et parenthèses sont retirés.
 */
export function normalizeTelephone(value: string | null | undefined): string | null {
  const raw = nonEmpty(value);
  if (raw === null) return null;
  const first = raw.split(/[/;,]/)[0] ?? "";
  const compact = first.replace(/[\s.\-()]/g, "");
  return compact === "" ? null : compact;
}

/** Adresse géographique du lieu d'exercice, ou `null` si absente. */
export function pickGeographicAddress(ege: AnsEge): AnsAdresse | null {
  const adresses = ege.adresse;
  if (!Array.isArray(adresses)) return null;
  return adresses.find((a) => a?.usageAdresse === USAGE_ADRESSE_GEOGRAPHIQUE) ?? null;
}

/** Premier téléphone / courriel renseigné parmi les contacts de l'EGE. */
function pickContact(ege: AnsEge): { telephone: string | null; email: string | null } {
  const contacts = Array.isArray(ege.contact) ? ege.contact : [];
  let telephone: string | null = null;
  let email: string | null = null;
  for (const c of contacts) {
    telephone ??= nonEmpty(c?.telecom?.telephone);
    email ??= nonEmpty(c?.telecom?.courriel);
    if (telephone !== null && email !== null) break;
  }
  return { telephone, email };
}

/**
 * Mappe un EGE du flux ANS vers une ligne de staging, ou explique pourquoi il
 * est écarté. Périmètre retenu = établissements EN SERVICE : `etatObjet`
 * actif ET `dateFermeture` nulle. Le flux ANS publie aussi les EGE fermés
 * (174 681 au total, 104 734 en service), absents du CSV DREES historique —
 * les ingérer doublerait la table et ferait remonter des établissements
 * fermés depuis 1992 dans les recherches par rayon.
 */
export function mapEgeToRow(ege: AnsEge): ParsedEge {
  const infos = ege.informationsGeneralesEGE ?? {};

  // PÉRIMÈTRE d'abord (fermé/inactif), IDENTITÉ ensuite : les anomalies
  // d'identité sont seuillées sur les EGE EN SERVICE (`finess-validate.ts`) ;
  // comptées sur les 174 K EGE du flux, 1 500 archivés sans identifiant
  // refuseraient un swap dont le périmètre servi est sain.
  if (nonEmpty(infos.dateFermeture) !== null) return { kind: "skip", skipReason: "ferme" };
  if (readEtat(ege.etatObjet) !== ETAT_ACTIF) return { kind: "skip", skipReason: "inactif" };

  const numFiness = nonEmpty(infos.numFinessEge);
  if (numFiness === null) return { kind: "skip", skipReason: "no_finess_id" };
  if (!NUM_FINESS_EGE.test(numFiness)) return { kind: "skip", skipReason: "bad_finess_id" };

  const adresse = pickGeographicAddress(ege);
  if (adresse === null) return { kind: "skip", skipReason: "no_adresse_geographique" };

  const codeInsee = nonEmpty(adresse.cogCommune);
  if (codeInsee === null) return { kind: "skip", skipReason: "no_commune" };
  // Validateur partagé (`territoire/dept-codes.ts`) : forme CHAR(5) ET plages
  // INSEE réelles (rejette `00000`, `20000`, `96xxx`, `99xxx`) — un code hors
  // plage est une régression de format upstream, pas une ligne à insérer.
  // DOM/COM compris : le CSV DREES les skippait (`dom_unsupported`, V0.3),
  // le schéma (`CHAR(3)`/`CHAR(5)`) les accepte depuis longtemps.
  if (!isValidCodeInsee(codeInsee)) return { kind: "skip", skipReason: "bad_commune" };
  const codeDepartement = deptFromCodeInsee(codeInsee);
  if (codeDepartement === undefined) return { kind: "skip", skipReason: "bad_commune" };

  const overflows: OverflowField[] = [];
  /** `null` + signalement si la valeur viole la contrainte de sa colonne (cf. `COLUMN_RULES`). */
  const keep = (field: OverflowField, value: string | null): string | null => {
    if (value !== null && !COLUMN_RULES[field](value)) {
      overflows.push(field);
      return null;
    }
    return value;
  };

  const numVoie = nonEmpty(adresse.numeroVoie);
  const typeVoie = nonEmpty(adresse.typeVoie);
  const libelleVoie = nonEmpty(adresse.libelleVoie);
  // `voie` (TEXT) garde le numéro même si `num_voie` (VARCHAR(10)) déborde :
  // l'adresse complète reste lisible, seule la colonne typée passe à null.
  const voieFull = [numVoie, typeVoie, libelleVoie].filter(Boolean).join(" ");

  const coords = adresse.coordonneesGeographique ?? {};
  const resolved = resolveCoordinates(coords);
  const cleBan = nonEmpty(coords.cleInInteropBAN);
  // Clé d'interopérabilité BAN : `01053_1950_00062` = numéro, `01053_1950` =
  // rue, `01053` (sans `_`) = COMMUNE, c'est-à-dire un centroïde communal —
  // avec un `scoreBAN` ≈ 0,94 qu'un gate par score ne verrait pas (doctrine
  // `ban-acceptance-precision-tier` : la précision, jamais le score). Un
  // centroïde ne doit JAMAIS entrer dans `finess.geom` : le cron RPPS le
  // recopie en `finess_join`, tier PRÉCIS du GiST partiel. Prouvé en prod le
  // 2026-09-05 : 186 lignes. Point refusé → le repli `previous_ingest`
  // reprend la main pour les établissements déjà connus, NULL sinon.
  const municipalityCentroid = cleBan !== null && !cleBan.includes("_");
  const point = municipalityCentroid ? null : resolved.point;

  const contact = pickContact(ege);
  const raisonSociale = nonEmpty(infos.nomEgeLong) ?? nonEmpty(infos.nomEgeCourt) ?? "";
  const categorieCode = nonEmpty(ege.categorieentiteGeographiqueExercice);

  // SIRET natif ANS : 14 chiffres ou rien. Même regex que le boundary MCP
  // (`SIRET_PATTERN`, db-helpers) — un SIRET qui n'y passerait pas ne pourrait
  // de toute façon pas être servi ni résolu ; il est compté (`siretMalformed`),
  // jamais tronqué. C'est LA garde de la colonne `siret CHAR(14)` : la borne
  // DDL est impliquée par la regex (`finess-column-rules-parity.test.ts`,
  // `VALIDATED_ELSEWHERE`), pas de règle `COLUMN_RULES` doublon.
  // Présent mais pas une chaîne (nombre, tableau, objet : `nonEmpty` rend null)
  // = malformé AUSSI — sinon un changement de TYPE côté ANS viderait la colonne
  // sans compteur (le plancher `MIN_SIRET_FILL` reste le filet contre la
  // disparition pure et simple de la clé).
  const siretPresent = infos.siret !== undefined && infos.siret !== null;
  const siretRaw = nonEmpty(infos.siret);
  const siretMalformed =
    siretPresent && (siretRaw === null || !SIRET_PATTERN.test(siretRaw))
      ? String(siretRaw ?? JSON.stringify(infos.siret))
      : null;
  const siret = siretMalformed === null ? siretRaw : null;
  const scoreBanRaw = nonEmpty(coords.scoreBAN);
  const scoreBan = toNumber(scoreBanRaw);
  // `geom ⇔ geom_source` : une seule branche, typée (cf. `FinessGeomFields`).
  const geomFields: FinessGeomFields =
    point !== null
      ? {
          geom: `SRID=4326;POINT(${point.lon} ${point.lat})`,
          geom_source: GEOM_SOURCES.ANS,
          // Lambert 93 conservé pour rétro-compatibilité des consommateurs
          // existants — la géolocalisation vient désormais du WGS84 natif,
          // plus d'une reprojection server-side.
          coordx_lambert93: resolved.lambert93?.x ?? null,
          coordy_lambert93: resolved.lambert93?.y ?? null,
        }
      : { geom: null, geom_source: null, coordx_lambert93: null, coordy_lambert93: null };
  const categorieCodeKept = keep("categorie_code", categorieCode);

  return {
    kind: "row",
    row: {
      num_finess: numFiness,
      raison_sociale: raisonSociale,
      categorie_code: categorieCodeKept,
      // Dérivé de la valeur RETENUE : un code refusé par sa colonne ne doit
      // pas laisser un libellé orphelin.
      categorie_libelle:
        categorieCodeKept !== null ? (CATEGORIE_LABELS[categorieCodeKept] ?? null) : null,
      num_voie: keep("num_voie", numVoie),
      type_voie: keep("type_voie", typeVoie),
      voie: voieFull === "" ? null : voieFull,
      code_postal: keep("code_postal", nonEmpty(adresse.codePostal)),
      code_departement: codeDepartement,
      code_insee: codeInsee,
      ville: nonEmpty(adresse.ligneAcheminement),
      telephone: keep("telephone", normalizeTelephone(contact.telephone)),
      email: contact.email,
      date_ouverture: nonEmpty(infos.dateOuverture),
      date_maj: nonEmpty(ege.dateDerniereMaj),
      siret,
      cle_ban: cleBan,
      score_ban: scoreBan,
      ...geomFields,
    },
    // `layout ⟺ point` reste vrai après le refus d'un centroïde.
    coordLayout: point !== null ? resolved.layout : null,
    municipalityCentroidRejected: municipalityCentroid && resolved.point !== null,
    siretMalformed,
    scoreBanUnparsable: scoreBanRaw !== null && scoreBan === null,
    overflows,
    coordsPresentButUnusable: resolved.point === null && resolved.present,
  };
}
