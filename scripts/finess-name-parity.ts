/**
 * Preuve rejouable de la recherche FINESS par nom (`searchFinessByName`,
 * RPC `finess_search_by_name`) contre la PROD : 25 noms tapés comme un humain,
 * chacun avec son attendu (commune prouvée / ambigu attendu / aucun connu).
 *
 *   pnpm tsx scripts/finess-name-parity.ts
 *
 * À rejouer après toute retouche du seuil (`FINESS_NAME_MATCH_THRESHOLD`), du
 * rang de famille ou de la normalisation SQL/TS. Un cas échoue aussi si le
 * premier candidat n'a pas de point ou si le résultat est `tronque`. Exit 1
 * au moindre écart avec l'attendu, exit 2 si un cas a levé une erreur (RPC
 * absente, timeout) — une erreur n'est pas une mesure. Les attendus sont des MESURES du 2026-09-22 (plan
 * docs/plans/finess-recherche-par-nom.md), pas des souhaits : un « aucun »
 * attendu (« Georges Pompidou », écrit « G POMPIDOU » chez l'ANS) documente
 * une limite connue, il ne la masque pas.
 */
import "./ingest/load-env.js";
import { searchFinessByName } from "../src/sante/finess-db.js";
import type { FinessNameStatut } from "../src/sante/finess-name-search.js";

type Attendu = {
  nom: string;
  code_insee?: string;
  departement?: string;
  statut: FinessNameStatut;
  /** Commune-mère attendue en preuve, `null` = divergence attendue. */
  commune: string | null;
  /** Le premier candidat doit contenir ce fragment (rang de famille). */
  premier?: RegExp;
};

const CAS: Attendu[] = [
  // L'exemple d'origine. Avec « Institut » dans le nom, le site de Chevilly
  // (« CLCC HOPITAL GUSTAVE ROUSSY… », sans « institut ») passe sous 0,8 :
  // seul Villejuif reste → commune prouvée. « Gustave Roussy » nu (dept 94)
  // ramène les deux communes → divergence.
  { nom: "Institut Gustave Roussy", statut: "ambigu", commune: "94076" },
  {
    nom: "Institut Gustave Roussy",
    code_insee: "94076",
    statut: "ambigu",
    commune: "94076",
    premier: /INSTITUT GUSTAVE ROUSSY/,
  },
  { nom: "Gustave Roussy", departement: "94", statut: "ambigu", commune: null },
  // Paris en ville entière : arrondissements repliés sur 75056.
  {
    nom: "Necker",
    code_insee: "75056",
    statut: "ambigu",
    commune: "75056",
    premier: /NECKER ENFANTS MALADES/,
  },
  {
    nom: "Pitié-Salpêtrière",
    statut: "ambigu",
    commune: "75056",
    premier: /GHU APHP SORBONNE UNIVERSITE SITE PITIE SALPETRIERE/,
  },
  { nom: "Institut Curie", statut: "ambigu", commune: null },
  { nom: "Institut Curie", code_insee: "75056", statut: "ambigu", commune: "75056" },
  {
    nom: "Pompidou",
    code_insee: "75056",
    statut: "ambigu",
    commune: "75056",
    premier: /G POMPIDOU/,
  },
  { nom: "Cochin", code_insee: "75056", statut: "ambigu", commune: "75056" },
  // Grandes villes hors Paris.
  { nom: "Timone", statut: "ambigu", commune: "13055", premier: /HOPITAL LA TIMONE/ },
  {
    nom: "Pellegrin",
    code_insee: "33063",
    statut: "ambigu",
    commune: "33063",
    premier: /PELLEGRIN - CHU/,
  },
  { nom: "CHU de Nantes", code_insee: "44109", statut: "ambigu", commune: "44109" },
  { nom: "CHU de Lille", statut: "ambigu", commune: "59350" },
  { nom: "Edouard Herriot", code_insee: "69123", statut: "ambigu", commune: "69123" },
  {
    nom: "Léon Bérard",
    code_insee: "69123",
    statut: "ambigu",
    commune: "69123",
    premier: /CENTRE LEON BERARD/,
  },
  { nom: "Paul Brousse", statut: "ambigu", commune: "94076" },
  { nom: "Hôpital Foch", statut: "ambigu", commune: "92073", premier: /^HOPITAL FOCH/ },
  {
    nom: "Hôpital privé d'Antony",
    statut: "ambigu",
    commune: "92002",
    premier: /^HOPITAL PRIVE D ANTONY/,
  },
  { nom: "Hôpital Américain", statut: "ambigu", commune: "92051" },
  { nom: "Centre hospitalier de Versailles", statut: "ambigu", commune: null },
  // Homonymes : sans commune, jamais un premier servi seul.
  { nom: "Clinique Pasteur", statut: "ambigu", commune: null },
  // 3 fiches à Toulouse (clinique + annexes) : ambigu, mais la commune est prouvée.
  { nom: "Clinique Pasteur", code_insee: "31555", statut: "ambigu", commune: "31555" },
  { nom: "Clinique du Parc", statut: "ambigu", commune: null },
  // Limites connues (mesurées) : abréviation ANS, nom absent de FINESS.
  { nom: "Georges Pompidou", code_insee: "75056", statut: "aucun", commune: null },
  { nom: "Centre hospitalier de Bretagne Sud", statut: "aucun", commune: null },
];

async function main(): Promise<void> {
  let ecarts = 0;
  let erreurs = 0;
  for (const cas of CAS) {
    const t0 = Date.now();
    let r: Awaited<ReturnType<typeof searchFinessByName>>;
    try {
      r = await searchFinessByName({
        nom: cas.nom,
        ...(cas.code_insee ? { code_insee: cas.code_insee } : {}),
        ...(cas.departement ? { departement: cas.departement } : {}),
      });
    } catch (err) {
      // Une erreur (RPC absente, timeout) n'est PAS un écart de mesure : on
      // la compte à part et on joue les autres cas.
      erreurs++;
      console.log(`ERREUR ${cas.nom}  ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const ms = Date.now() - t0;
    const commune = r.commune_prouvee?.code_insee ?? null;
    const [premierCandidat] = r.candidats;
    const premier = premierCandidat?.raison_sociale ?? "";
    const okStatut = r.statut === cas.statut;
    const okCommune = commune === cas.commune;
    const okPremier = cas.premier ? cas.premier.test(premier) : true;
    // Le premier candidat doit porter un point (c'est LUI que geo-intel ancre) ;
    // un « aucun » attendu doit venir d'un score sous le seuil, pas d'une RPC
    // muette (index perdu au swap → 0 ligne → « aucun » identique).
    const okPoint = premierCandidat ? premierCandidat.coords !== null : true;
    const okAucun = cas.statut === "aucun" ? r.meilleure_similarite !== null : true;
    const ok = okStatut && okCommune && okPremier && okPoint && okAucun && !r.tronque;
    if (!ok) ecarts++;
    const hint = cas.code_insee
      ? ` @${cas.code_insee}`
      : cas.departement
        ? ` @dept ${cas.departement}`
        : "";
    console.log(
      `${ok ? "OK   " : "ÉCART"} ${cas.nom}${hint}  ${ms} ms  statut=${r.statut} commune=${commune ?? "-"} candidats=${r.candidats.length}${r.tronque ? " TRONQUÉ" : ""} best=${r.meilleure_similarite ?? "-"}  1er=« ${premier} »${premierCandidat && premierCandidat.coords === null ? " SANS POINT" : ""}`,
    );
    if (!ok) {
      console.log(
        `  attendu statut=${cas.statut} commune=${cas.commune ?? "-"}${cas.premier ? ` premier~${cas.premier}` : ""} ; communes=${r.communes_candidates.join(",")}`,
      );
    }
  }
  console.log(
    `\n${ecarts === 0 ? "Aucun écart" : `${ecarts} écart(s)`}, ${erreurs} erreur(s) (${CAS.length} cas).`,
  );
  if (ecarts > 0) process.exit(1);
  if (erreurs > 0) process.exit(2);
}

await main();
