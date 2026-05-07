/**
 * Types partagés entre les modules territoire et sante.
 */

export type Coordinates = {
  lon: number;
  lat: number;
};

export type RateLimitOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  userAgent?: string;
};

export type DataSource =
  | "geo.api.gouv.fr"
  | "IGN-Geoplateforme"
  | "INSEE"
  | "FINESS"
  | "Annuaire-Sante-Ameli"
  | "DINUM-Recherche-Entreprises";

export type SourceAttribution = {
  source: DataSource;
  fetchedAt: string;
  notice: string;
};
