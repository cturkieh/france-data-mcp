// Géoplateforme IGN — base du service de géocodage, successeur officiel de l'API
// Adresse BAN (doc adresse.data.gouv.fr : « L'API Adresse BAN est dépréciée et
// intégrée dans le nouveau Service de géocodage de la Géoplateforme »). Module
// FEUILLE sans dépendance : consommé par le client bulk (`ban-bulk-client.ts`,
// `BAN_BULK_HOSTS[0]`) ET par le géocodage unitaire serve-time
// (`territoire/geocode.ts`) sans que l'un importe l'autre — un changement de
// chemin IGN se fait ICI, une fois.
export const GEOPF_GEOCODAGE_BASE_URL = "https://data.geopf.fr/geocodage";
