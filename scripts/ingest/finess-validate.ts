/**
 * Politique de validation de l'ingestion FINESS (flux ANS) — les décisions
 * qui autorisent ou refusent le swap en prod, sous forme de fonctions PURES.
 *
 * Pourquoi hors de `finess.ts` : ces seuils décident du swap d'une table de
 * santé en production ; ils étaient écrits en ligne droite dans `main()`,
 * sans aucun test, alors que le parseur avait été extrait précisément pour
 * être prouvable. Les tests (`finess-validate.test.ts`) rejouent les chiffres
 * réellement mesurés le 2026-09-05 (`docs/plans/finess-migration-ans.md` § 6).
 *
 * Deux temps, parce que `main()` a une RPC entre les deux :
 *   1. `assessParsedRows(stats)` — après le streaming, AVANT le repli geom et
 *      la diff (inutile d'appeler des RPC sur une staging déjà invalide) ;
 *   2. `assessStagingDiff(stats, diff)` — après le repli `previous_ingest`.
 *
 * Contrat : `fatal` = messages d'`IngestError("validate")` (le swap est
 * refusé), `warnings` → `console.warn`, `info` → `console.log`. Les libellés
 * sont stables : l'ops les grep dans les logs GitHub Actions.
 */

import { FINESS_CATEGORIE_LABELS_REFRESHED_AT } from "../../src/sante/finess-categories-labels.js";
import type { CoordLayout, OverflowField, SkipReason } from "./finess-ans-parse.js";

/** 104 734 EGE en service le 2026-09-05 (93 403 dans l'ancien CSV DREES). */
export const MIN_ROWS = 50_000;
export const MAX_ROWS = 200_000;

/**
 * Couverture géo minimale APRÈS repli `previous_ingest` ET pose BAN. Baseline
 * MESURÉE au premier run réel avec pose (2026-09-06, run #34023554047) :
 * **97,57 %** (102 185 / 104 734) — flux ANS seul 74,9 %, repli 21 222 points
 * de la prod, pose BAN 2 720. Les 2 549 sans point = 1 902 rejetés par la BAN
 * + 647 sans voie (jamais géocodables sans centroïde, refusé). Le seuil est la
 * baseline − 2,5 points : il attrape une chute des coordonnées ANS ET la perte
 * TOTALE de la pose BAN (retour à 94,97 %, sous 0,95) — à 0,93 cette perte
 * passait en `success` (revue du lot C). La NON-RÉGRESSION ligne à ligne reste
 * gardée par `LOST_GEOM_MAX_RATE` / `MOVED_MAX_RATE`. Historique : 0,8 (ère
 * CSV) → 0,93 (migration ANS, baseline 94,97 %) → 0,95 (pose BAN). Seuil sur
 * mesure après mesure, jamais par extrapolation.
 */
export const MIN_GEOM_COVERAGE = 0.95;

/**
 * Part des établissements géolocalisés en prod dont la staging n'a PAS de
 * point APRÈS le repli `previous_ingest`. ⚠️ Ce n'est PAS le garde de
 * non-régression qu'il semble être : le repli remplit exactement l'ensemble
 * que `lost_geom` compte (même prédicat `s.geom IS NULL AND f.geom IS NOT
 * NULL`), juste avant la diff — un 0 prouve que l'UPDATE a tourné, rien de
 * plus (revue 2026-09-05, silent-failure-hunter). Il garde le repli lui-même
 * (RPC muette, mauvaise table) ; la non-régression est portée par
 * `MOVED_MAX_RATE`.
 */
export const LOST_GEOM_MAX_RATE = 0.005;

/** Établissements sans voie ni point : 647 mesurés le 2026-09-06 ; au-delà de 2× = dérive amont (warn, jamais fatal). */
export const NO_VOIE_WARN_ABOVE = 1_300;

/**
 * Part des établissements présents des DEUX côtés dont le point bouge de plus
 * de 500 m — LE garde de non-régression de la géolocalisation. Baseline du
 * jour de migration : 5 395 / 87 284 (6,2 %) — géocodage DREES grossier
 * remplacé par des points BAN, médiane 1,3 km, max 98 km, aucun aberrant ;
 * runs suivants : 0. Au-delà de 20 %, ce n'est plus un recalage mais une
 * inversion lat/lon, un changement de datum ou de signe upstream — que RIEN
 * d'autre ne détecte : depuis que la détection WGS84 couvre le domaine
 * complet (Pacifique), une paire inversée (2.27, 48.88) est un point
 * « valide » au large de la Somalie, la couverture reste à 100 % et
 * `lost_geom` à 0.
 */
export const MOVED_MAX_RATE = 0.2;

/**
 * Anomalies structurelles (num_finess absent/malformé, pas d'adresse
 * géographique, commune absente/malformée) : au-delà de 1 %, changement de
 * format upstream. Même seuil pour les débordements de colonne par champ.
 */
export const STRUCTURAL_FAIL_THRESHOLD = 0.01;

/**
 * Coordonnées présentes mais inexploitables (aucune paire en WGS84
 * plausible) : warn > 2 %, throw > 5 %. Cf. `resolveCoordinates`.
 */
export const COORDS_UNUSABLE_WARN_RATE = 0.02;
export const COORDS_UNUSABLE_FAIL_RATE = 0.05;

/**
 * Part des établissements de la prod ABSENTS de la staging au-delà de
 * laquelle on refuse le swap. Un fichier ANS partiel (> MIN_ROWS mais
 * incomplet) ferait disparaître des établissements ouverts en silence.
 * Mesuré au premier run ANS : 6 119 / 93 403 = 6,6 %, tous fermés dans le
 * flux (échantillon 400/400).
 */
export const REMOVED_MAX_RATE = 0.1;

/**
 * Expected envelope for the "autre" famille. Catalogue covers ~92% of
 * FINESS volume by design; above 15%, ANS likely introduced a new code
 * at scale and FINESS_CATEGORIES needs extending. Warning, not blocker.
 */
export const AUTRE_FAMILY_DRIFT_THRESHOLD = 0.15;
/**
 * Plafond DUR sur la famille « autre » (revue 2026-09-05, silent-failure-hunter) :
 * un catalogue `FINESS_CATEGORIES` désynchronisé de la nomenclature ne doit
 * pas swapper 100 % des établissements hors famille en `success`.
 */
export const AUTRE_FAMILY_FAIL_RATE = 0.5;

export interface IngestStreamStats {
  inserted: number;
  pmej: number;
  /** Compteur par raison — `Record<SkipReason, …>` : une raison ajoutée sans compteur ne compile pas. */
  skipped: Record<SkipReason, number>;
  /** Quelle paire portait le WGS84 (diagnostic de format) ; `none` = inserted − les deux. */
  geomByLayout: Record<CoordLayout, number>;
  coordsUnusable: number;
  /**
   * Lignes INSÉRÉES sans `categorie_code` (colonne nullable — 32 en prod le
   * 2026-09-05, 0,03 %). Une encapsulation du code par l'ANS (tableau, `coding`,
   * comme `typeBudget` l'est déjà) mettrait 100 % des lignes ici : tous les
   * tools filtrés par famille rendraient 0, en `success` — d'où le seuil.
   */
  nullCategorieCode: number;
  /** Lignes insérées avec `raison_sociale` vide (colonne NOT NULL, `""` posé) — 0 en prod. */
  emptyRaisonSociale: number;
  /** Points ANS refusés car centroïde commune (clé BAN sans `_`) — 186 en prod le 2026-09-05. */
  municipalityRejected: number;
  /** Codes catégorie tombés en famille "autre" (catalogue FINESS_CATEGORIES à étendre). */
  unknownCategorieCounts: Map<string, number>;
  /** Codes catégorie sans libellé dans la nomenclature figée. */
  missingLabelCounts: Map<string, number>;
  /** Champs mis à null car ils violaient leur colonne (`COLUMN_RULES`), par champ. */
  overflowCounts: Map<OverflowField, number>;
}

/** Résultat de `ingest_finess_staging_diff()` (migration 20260905T213000). */
export interface StagingDiff {
  staging_rows: number;
  prod_rows: number;
  prod_with_geom: number;
  added: number;
  removed: number;
  /** Géolocalisés en prod dont la staging n'a pas de point — doit rester ≈ 0. */
  lost_geom: number;
  moved_gt_500m: number;
  staging_geom_null: number;
  /** Sans point ET sans voie : JAMAIS géocodable (pas de centroïde) — 647 mesurés le 2026-09-06. */
  staging_no_voie: number;
  staging_geom_source: Record<string, number>;
}

export interface Assessment {
  /** Refus du swap — messages d'`IngestError("validate")`. */
  fatal: string[];
  warnings: string[];
  info: string[];
}

export const fmt = (n: number): string => `${(n * 100).toFixed(2)}%`;

const topCounts = (m: Map<string, number>, limit = Number.POSITIVE_INFINITY): string =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

/**
 * Décisions prises sur le seul résultat du parsing (avant toute RPC).
 * Un volume hors bornes court-circuite le reste : les taux n'ont pas de sens.
 */
/**
 * Âge (jours) de la nomenclature TRE_R397 figée dans le repo. Post-mortem DREES
 * transposé : une nomenclature que personne ne rafraîchit vieillit en silence —
 * `missingLabelCounts` voit les codes AJOUTÉS par l'ANS, jamais les codes
 * RELIBELLÉS (les 32 divergences de 2026 ont tenu des mois sans signal).
 * Exposé à chaque run (info) et warn au-delà de `NOMENCLATURE_MAX_AGE_DAYS` ;
 * jamais fatal (une nomenclature vieille n'est pas une raison de refuser un swap).
 */
export const NOMENCLATURE_MAX_AGE_DAYS = 180;
export function nomenclatureAgeDays(now: number = Date.now()): number {
  return Math.floor((now - Date.parse(FINESS_CATEGORIE_LABELS_REFRESHED_AT)) / 86_400_000);
}

export function assessParsedRows(stats: IngestStreamStats, now: number = Date.now()): Assessment {
  const a: Assessment = { fatal: [], warnings: [], info: [] };

  if (stats.inserted < MIN_ROWS) {
    a.fatal.push(`Row count ${stats.inserted} below minimum ${MIN_ROWS} — suspected partial parse`);
    return a;
  }
  if (stats.inserted > MAX_ROWS) {
    a.fatal.push(`Row count ${stats.inserted} above maximum ${MAX_ROWS} — suspected format change`);
    return a;
  }
  // `stats.inserted ≥ MIN_ROWS` : aucune division ci-dessous n'a besoin d'une garde « > 0 ».
  const nomenclatureAge = nomenclatureAgeDays(now);
  a.info.push(
    `[finess] nomenclature TRE_R397 figée depuis ${nomenclatureAge} j (${FINESS_CATEGORIE_LABELS_REFRESHED_AT.slice(0, 10)})`,
  );
  if (nomenclatureAge > NOMENCLATURE_MAX_AGE_DAYS) {
    a.warnings.push(
      `[finess] ⚠️ nomenclature TRE_R397 vieille de ${nomenclatureAge} j (> ${NOMENCLATURE_MAX_AGE_DAYS}) — relancer pnpm finess:refresh-categories (les codes relibellés par l'ANS sont invisibles de missingLabelCounts)`,
    );
  }

  // Anomalies structurelles — `ferme`/`inactif` sont le périmètre attendu
  // (≈ 70 K EGE), PAS des anomalies ; les cinq autres le sont. Les lignes
  // écartées ne sont PAS dans `inserted` → part du total lu.
  const s = stats.skipped;
  const structural =
    s.no_finess_id + s.bad_finess_id + s.no_adresse_geographique + s.no_commune + s.bad_commune;
  const structuralRate = structural / (stats.inserted + structural);
  if (structural > 0) {
    a.warnings.push(
      `[finess] structural parsing anomalies (${fmt(structuralRate)} of inserted): ${s.no_finess_id} missing numFinessEge, ${s.bad_finess_id} malformed numFinessEge, ${s.no_adresse_geographique} without adresse 03, ${s.no_commune} missing cogCommune, ${s.bad_commune} malformed cogCommune`,
    );
    if (structuralRate > STRUCTURAL_FAIL_THRESHOLD) {
      a.fatal.push(
        `Structural parsing anomaly rate ${fmt(structuralRate)} above ${fmt(STRUCTURAL_FAIL_THRESHOLD)} — likely ANS schema change (schema-structures-v1.json)`,
      );
    }
  }

  // Anomalies de CONTENU sur des lignes insérées (la ligne vaut d'être gardée :
  // nom, adresse, point) — même seuil que les structurelles, part de `inserted`.
  const content = stats.nullCategorieCode + stats.emptyRaisonSociale;
  if (content > 0) {
    const contentRate = content / stats.inserted;
    a.warnings.push(
      `[finess] content anomalies (${fmt(contentRate)} of inserted): ${stats.nullCategorieCode} without categorie_code, ${stats.emptyRaisonSociale} with empty raison_sociale`,
    );
    if (contentRate > STRUCTURAL_FAIL_THRESHOLD) {
      a.fatal.push(
        `Content anomaly rate ${fmt(contentRate)} above ${fmt(STRUCTURAL_FAIL_THRESHOLD)} — categorie/raison_sociale no longer parsed (ANS wrapped the field ?), refusing to swap`,
      );
    }
  }

  // Coordonnées présentes mais inexploitables — dérive de format. Ces lignes
  // SONT insérées (geom NULL) → part de `inserted`.
  const unusableRate = stats.coordsUnusable / stats.inserted;
  if (stats.coordsUnusable > 0 && unusableRate > COORDS_UNUSABLE_WARN_RATE) {
    a.warnings.push(
      `[finess] coordonnées présentes mais aucune paire WGS84 plausible : ${stats.coordsUnusable} rows (${fmt(unusableRate)}) — nouveau système de coordonnées upstream ?`,
    );
    if (unusableRate > COORDS_UNUSABLE_FAIL_RATE) {
      a.fatal.push(
        `Unusable-coordinates rate ${fmt(unusableRate)} above ${fmt(COORDS_UNUSABLE_FAIL_RATE)} — refusing to swap a mis-projected ingestion`,
      );
    }
  }
  // Disposition des paires (diagnostic de format), PAS une provenance : le
  // point posé est du WGS84 ANS dans les deux cas (`raw.geom_source = "ans"`).
  const geomNone =
    stats.inserted - stats.geomByLayout.wgs84_first - stats.geomByLayout.lambert_first;
  a.info.push(
    `[finess] geom à l'insert : wgs84_first=${stats.geomByLayout.wgs84_first} lambert_first=${stats.geomByLayout.lambert_first} none=${geomNone} (dont centroïdes commune BAN refusés : ${stats.municipalityRejected})`,
  );

  // Nomenclature — codes tombés en famille "autre" (catalogue à étendre) et
  // codes sans libellé (relancer refresh-finess-categories.mjs).
  if (stats.unknownCategorieCounts.size > 0) {
    const totalAutre = [...stats.unknownCategorieCounts.values()].reduce((x, y) => x + y, 0);
    const autreRate = totalAutre / stats.inserted;
    a.info.push(
      `[finess] ${stats.unknownCategorieCounts.size} codes catégorie en famille "autre" (${fmt(autreRate)} du volume). Top: ${topCounts(stats.unknownCategorieCounts, 5)}`,
    );
    if (autreRate > AUTRE_FAMILY_DRIFT_THRESHOLD) {
      a.warnings.push(
        `[finess] ⚠️ "autre" rate ${fmt(autreRate)} above ${fmt(AUTRE_FAMILY_DRIFT_THRESHOLD)} expected envelope — nomenclature drift suspect, consider extending FINESS_CATEGORIES`,
      );
    }
    if (autreRate > AUTRE_FAMILY_FAIL_RATE) {
      a.fatal.push(
        `"autre" rate ${fmt(autreRate)} above ${fmt(AUTRE_FAMILY_FAIL_RATE)} — FINESS_CATEGORIES no longer matches the nomenclature, refusing to swap`,
      );
    }
  }
  if (stats.missingLabelCounts.size > 0) {
    const totalMissing = [...stats.missingLabelCounts.values()].reduce((x, y) => x + y, 0);
    const missingRate = totalMissing / stats.inserted;
    a.warnings.push(
      `[finess] ⚠️ ${stats.missingLabelCounts.size} codes catégorie SANS libellé dans src/sante/finess-categories-labels.ts (${topCounts(stats.missingLabelCounts)}) — relancer pnpm finess:refresh-categories ; si le code figure dans HORS_NOMENCLATURE_LABELS (lib), c'est un code hors SMT : décision produit, pas un refresh`,
    );
    // Une nomenclature figée vidée ou tronquée (SMT partiel) servirait des
    // dizaines de milliers de `categorie_libelle` NULL contre un warn.
    if (missingRate > STRUCTURAL_FAIL_THRESHOLD) {
      a.fatal.push(
        `${totalMissing} rows (${fmt(missingRate)}) without categorie_libelle — finess-categories-labels.ts incomplete, refusing to swap`,
      );
    }
  }

  // Débordements de colonne — champs mis à null par le parseur plutôt que
  // tronqués (le premier dry-run a échoué en 22001 sur UN téléphone).
  // Attendu : ~0. Au-delà de 1 % sur un champ, ce n'est plus une valeur sale
  // mais un changement de format upstream → on refuse le swap.
  if (stats.overflowCounts.size > 0) {
    a.warnings.push(
      `[finess] ⚠️ champs mis à null car au-delà de leur colonne : ${topCounts(stats.overflowCounts)}`,
    );
    for (const [field, count] of stats.overflowCounts) {
      const rate = count / stats.inserted;
      if (rate > STRUCTURAL_FAIL_THRESHOLD) {
        a.fatal.push(
          `Column overflow on ${field}: ${count} rows (${fmt(rate)} > ${fmt(STRUCTURAL_FAIL_THRESHOLD)}) — upstream format change, refusing to swap`,
        );
      }
    }
  }

  return a;
}

/**
 * Décisions prises sur la diff staging ↔ prod, APRÈS le repli `previous_ingest`
 * (le geom est posé à l'insert : plus d'UPDATE de masse à mesurer).
 * `prod_rows = 0` / `prod_with_geom = 0` = première ingestion (base vide) :
 * pas de référence, les gardes relatives à la prod sont sans objet.
 */
export function assessStagingDiff(stats: IngestStreamStats, diff: StagingDiff): Assessment {
  const a: Assessment = { fatal: [], warnings: [], info: [] };

  // Numérateur compté par la base, dénominateur par le script : ils DOIVENT
  // parler de la même table (staging polluée par un run précédent, insert
  // partiellement avalé → ratio faux en silence).
  if (diff.staging_rows !== stats.inserted) {
    a.fatal.push(
      `finess_staging holds ${diff.staging_rows} rows but ${stats.inserted} were inserted this run — staging polluted or inserts lost, refusing to swap`,
    );
    return a;
  }

  const withGeom = diff.staging_rows - diff.staging_geom_null;
  const coverage = stats.inserted > 0 ? withGeom / stats.inserted : 0;
  a.info.push(`[finess] couverture géo : ${withGeom}/${stats.inserted} (${fmt(coverage)})`);
  // Provenance greppable (le `JSON.stringify` de la diff ne l'est pas) : c'est
  // la seule trace par run de ce que chaque source a apporté.
  a.info.push(
    `[finess] provenance du point : ${Object.entries(diff.staging_geom_source)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  if (coverage < MIN_GEOM_COVERAGE) {
    a.fatal.push(
      `Only ${withGeom}/${stats.inserted} rows have a geom (${fmt(coverage)} < ${fmt(MIN_GEOM_COVERAGE)}) — ANS coordinates + previous_ingest fallback + BAN cache insufficient, refusing to swap`,
    );
  }
  // Le résiduel sans point se lit en DEUX parts : ce que le drain BAN peut
  // encore récupérer (voie présente) et ce qui ne sera JAMAIS géocodé sans
  // centroïde commune (refusé : contaminerait le RPPS en `finess_join`).
  const banRecoverable = diff.staging_geom_null - diff.staging_no_voie;
  a.info.push(
    `[finess] sans point : ${diff.staging_geom_null} dont ${banRecoverable} géocodables par BAN (voie présente) et ${diff.staging_no_voie} JAMAIS géocodables (aucune voie) — baseline 2026-09-06 : 2 549 / 647 après pose`,
  );
  if (diff.staging_no_voie > NO_VOIE_WARN_ABOVE) {
    a.warnings.push(
      `[finess] ⚠️ ${diff.staging_no_voie} établissements sans voie ni point (> ${NO_VOIE_WARN_ABOVE}, soit 2× la baseline de 647) — l'ANS omet-il la voie en masse ?`,
    );
  }
  // Pose BAN muette : 0 `ban_address` alors qu'il reste des lignes géocodables
  // = dérive de clé ou cache wipé (jumeau de la sentinelle de `finess.ts`, ici
  // sur la DIFF — le pendant exact de la tautologie `lost_geom`).
  if (banRecoverable > 0 && (diff.staging_geom_source.ban_address ?? 0) === 0) {
    a.warnings.push(
      `[finess] ⚠️ aucun point ban_address posé alors que ${banRecoverable} lignes sans point ont une voie — pose BAN muette (parité de clé ? cache geocoded_addresses vide ?)`,
    );
  }
  if (diff.prod_rows > 0) {
    const removedRate = diff.removed / diff.prod_rows;
    if (removedRate > REMOVED_MAX_RATE) {
      a.fatal.push(
        `${diff.removed}/${diff.prod_rows} établissements en prod absents de la staging (${fmt(removedRate)} > ${fmt(REMOVED_MAX_RATE)}) — fichier ANS partiel ? Refusing to swap`,
      );
    }
  }
  if (diff.prod_with_geom > 0) {
    const lostRate = diff.lost_geom / diff.prod_with_geom;
    if (lostRate > LOST_GEOM_MAX_RATE) {
      a.fatal.push(
        `${diff.lost_geom}/${diff.prod_with_geom} établissements géolocalisés en prod sans point après le repli (${fmt(lostRate)} > ${fmt(LOST_GEOM_MAX_RATE)}) — repli previous_ingest inopérant ?, refusing to swap`,
      );
    }
  }
  // Établissements communs (présents des deux côtés) dont le point a bougé de
  // plus de 500 m — cf. MOVED_MAX_RATE : le seul signal d'une inversion
  // lat/lon ou d'un changement de datum, invisibles ligne à ligne.
  const matched = diff.staging_rows - diff.added;
  if (matched > 0) {
    const movedRate = diff.moved_gt_500m / matched;
    a.info.push(
      `[finess] points déplacés > 500 m : ${diff.moved_gt_500m}/${matched} communs (${fmt(movedRate)})`,
    );
    if (movedRate > MOVED_MAX_RATE) {
      a.fatal.push(
        `${diff.moved_gt_500m}/${matched} établissements communs déplacés de plus de 500 m (${fmt(movedRate)} > ${fmt(MOVED_MAX_RATE)}) — inversion lat/lon ou changement de datum upstream ?, refusing to swap`,
      );
    }
  }
  return a;
}
