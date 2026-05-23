/**
 * Couche d'activités hébergées (Phase 2 chantier Complétude & lentilles).
 *
 * Expose pour chaque tool de comptage filtré par famille (labo/pharmacie/
 * imagerie) un SECOND compte juxtaposé des sites hébergeant l'activité
 * correspondante sous une autre catégorie FINESS. Doctrine : MCP juxtapose,
 * jamais d'addition silencieuse, le LLM décide.
 *
 * Source : matview `finess_hosted_activities` (jointure RPPS×FINESS, seuil
 * N≥3, calibré par mesure prod — cf. docs/plans/completude-lentilles-phase2-mesure.md).
 *
 * Les notes ci-dessous sont LUES PAR LE LLM CALLER et restituées au lecteur
 * final — elles doivent rester courtes, précises, et interdire explicitement
 * l'addition sans préciser la nature des deux comptes.
 */
import { getUntypedAnonClient } from "../storage/supabase.js";
import { assertValidDept } from "../territoire/dept-codes.js";
import { formatRpcError, validateCoords, validateRadiusKm } from "./db-helpers.js";
import type { FinessFamilleQuery } from "./finess-categories.js";

/** Activités hébergées exposables par la couche. */
export type HostedActivity = "biologie" | "pharmacie" | "imagerie";

/**
 * Mapping famille FINESS → activité hébergée pertinente. Les familles non
 * mappées (EHPAD, MCO, etc.) n'ont pas d'activité-secondaire à signaler →
 * `null`, et le champ `activite_hebergee` est absent de la réponse du tool.
 */
export function familleToHostedActivity(famille: FinessFamilleQuery): HostedActivity | null {
  switch (famille) {
    case "labo":
      return "biologie";
    case "pharmacie":
      return "pharmacie";
    case "imagerie":
      return "imagerie";
    default:
      return null;
  }
}

/** Libellé public + note à restituer au lecteur final via le LLM. */
export const HOSTED_ACTIVITY_NOTES: Record<
  HostedActivity,
  { activite_libelle: string; note: string }
> = {
  biologie: {
    activite_libelle: "biologie médicale",
    note:
      "Plateaux techniques de biologie hébergés dans des hôpitaux, CLCC ou " +
      "centres de transfusion sanguine (EFS) — activité analytique sans accès " +
      "patient ambulatoire (distincte des laboratoires autonomes du compte " +
      "principal). Ne pas additionner les deux comptes sans préciser leur nature.",
  },
  pharmacie: {
    activite_libelle: "pharmacie à usage intérieur",
    note:
      "Pharmacies hospitalières (PUI) desservant les patients hospitalisés en " +
      "interne — pas d'accès grand public (distinctes des officines du compte " +
      "principal). Ne pas additionner les deux comptes sans préciser leur nature.",
  },
  imagerie: {
    activite_libelle: "imagerie médicale",
    note:
      "Sites d'imagerie (radiologie, scanner, IRM) en cliniques ou hôpitaux, " +
      "accessibles au public en ambulatoire. La catégorie FINESS « cabinet " +
      "d'imagerie » étant peu peuplée en pratique, ce compte représente " +
      "l'essentiel de l'offre territoriale d'imagerie (distinct du compte " +
      "principal cabinet d'imagerie). Ne pas additionner les deux comptes " +
      "sans préciser leur nature.",
  },
};

/** Aperçu d'un site (sample borné). */
export interface HostedSiteSample {
  num_finess: string;
  raison_sociale: string;
  categorie_code: string | null;
  categorie_libelle: string | null;
}

/** Résultat juxtaposé — voyage dans la sortie des tools. */
export interface HostedActivityResult {
  activite: string;
  count: number;
  note: string;
  sites_apercu: HostedSiteSample[];
  truncated: boolean;
}

const DEFAULT_SAMPLE_LIMIT = 5;

interface RawRpcRow {
  total_count: number | string;
  num_finess: string | null;
  raison_sociale: string | null;
  categorie_code: string | null;
  categorie_libelle: string | null;
}

function buildResult(activite: HostedActivity, rows: RawRpcRow[]): HostedActivityResult {
  const { activite_libelle, note } = HOSTED_ACTIVITY_NOTES[activite];
  const head = rows[0];
  // `total_count` est constant sur toutes les rows d'un même appel (window
  // function côté RPC) → on lit la 1re row. Rows vides → count=0.
  let total = 0;
  if (head !== undefined) {
    const raw = head.total_count;
    total = typeof raw === "string" ? Number(raw) : (raw ?? 0);
  }
  const samples: HostedSiteSample[] = [];
  for (const r of rows) {
    if (samples.length >= DEFAULT_SAMPLE_LIMIT) break;
    if (r.num_finess === null) continue;
    samples.push({
      num_finess: r.num_finess,
      raison_sociale: r.raison_sociale ?? "",
      categorie_code: r.categorie_code,
      categorie_libelle: r.categorie_libelle,
    });
  }
  return {
    activite: activite_libelle,
    count: total,
    note,
    sites_apercu: samples,
    truncated: total > samples.length,
  };
}

export interface InRadiusInput {
  activite: HostedActivity;
  center: { lat: number; lon: number };
  radiusKm: number;
  sampleLimit?: number;
}

/**
 * Compte les sites hébergeant l'activité `activite` dans un rayon, avec un
 * sample borné. Untyped client : les RPCs `finess_hosted_activities_*` ne
 * sont pas encore propagées dans `src/storage/supabase-types.ts` (à
 * regénérer via `pnpm db:types` après prochaine apply prod). Pattern
 * aligné sur `countFiness` / `getFinessByCategorie` (cf. `finess-db.ts`).
 */
export async function getHostedActivitiesInRadius(
  input: InRadiusInput,
): Promise<HostedActivityResult> {
  validateCoords(input.center.lat, input.center.lon);
  validateRadiusKm(input.radiusKm);
  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;

  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("finess_hosted_activities_in_radius", {
    p_activite: input.activite,
    p_lat: input.center.lat,
    p_lon: input.center.lon,
    p_radius_meters: input.radiusKm * 1000,
    p_sample_limit: sampleLimit,
  });
  if (error) {
    throw new Error(formatRpcError("finess_hosted_activities_in_radius", error));
  }
  return buildResult(input.activite, (data as RawRpcRow[]) ?? []);
}

export interface InZoneInput {
  activite: HostedActivity;
  departement?: string;
  codeInsee?: string;
  sampleLimit?: number;
}

export async function getHostedActivitiesInZone(input: InZoneInput): Promise<HostedActivityResult> {
  if (input.departement === undefined && input.codeInsee === undefined) {
    throw new RangeError(
      "getHostedActivitiesInZone: `departement` OR `codeInsee` requis (au moins un).",
    );
  }
  if (input.departement !== undefined) assertValidDept(input.departement);

  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("finess_hosted_activities_in_zone", {
    p_activite: input.activite,
    p_departement: input.departement ?? null,
    p_code_insee: input.codeInsee ?? null,
    p_sample_limit: sampleLimit,
  });
  if (error) {
    throw new Error(formatRpcError("finess_hosted_activities_in_zone", error));
  }
  return buildResult(input.activite, (data as RawRpcRow[]) ?? []);
}
