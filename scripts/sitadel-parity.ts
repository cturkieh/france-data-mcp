/**
 * Preuve de parité Sit@del : `permitsForCommune` (table `sitadel_logements`)
 * vs l'API DiDo interrogée EN DIRECT, commune par commune.
 *
 *   pnpm tsx scripts/sitadel-parity.ts [insee…]
 *
 * À rejouer après toute retouche de `scripts/ingest/sitadel.ts` ou de
 * `src/immobilier/sitadel.ts`. Lent par nature (~37 s par commune côté DiDo —
 * c'est précisément la raison d'être de la table). Exit 1 au moindre écart,
 * exit 2 si une preuve est nulle (rien à comparer).
 * Un écart juste après une publication SDES et AVANT le cron du 10 est
 * attendu (la table a un mois de retard) : relancer `pnpm ingest:sitadel`.
 */
import "./ingest/load-env.js";
import { parseCsv } from "../src/core/csv.js";
import { fetchText } from "../src/core/http.js";
import {
  MOIS_PAR_AN,
  type PermitsFenetre,
  SITADEL_DEFAULT_YEARS,
  SITADEL_TYPE_LGT_TOTAL,
  permitsForCommune,
} from "../src/immobilier/sitadel.js";
import { parentCommuneInsee } from "../src/territoire/commune-index.js";
import { DIDO_DATAFILE_URL } from "./ingest/sitadel.js";

// Dense, grande ville, Corse (alphanumérique), PLM (communes-mères), DROM,
// rural, et Fleury-devant-Douaumont (0 habitant : « ok à zéro » ≠ « no_data »).
const DEFAULT_COMMUNES = [
  "94076",
  "33063",
  "2A004",
  "75056",
  "69123",
  "13055",
  "97105",
  "01001",
  "55189",
  "59350",
  "31555",
  "44109",
];
const YEARS = SITADEL_DEFAULT_YEARS;

type ParAnnee = Record<string, { aut: number; com: number }>;
/** Mois distincts publiés par année : la preuve du SPLIT et de la complétude. */
type MoisParAnnee = Record<string, Set<number>>;

async function livePermits(
  insee: string,
  firstYear: number,
  lastYear: number,
): Promise<{ totaux: ParAnnee; mois: MoisParAnnee; futures: Set<number> }> {
  // `fetchText` porte la politique 429/Retry-After/5xx du projet : DiDo limite
  // le débit dès 2 appels rapprochés (mesuré 2026-09-21).
  const csv = await fetchText(`${DIDO_DATAFILE_URL}?withColumnName=true&CODE_INSEE=eq:${insee}`, {
    maxRetries: 6,
    headers: { Accept: "text/csv,*/*" },
  });
  const out: ParAnnee = {};
  const mois: MoisParAnnee = {};
  // Années publiées par le SDES mais ABSENTES de la table : la table est en
  // retard (bascule d'année avant le cron du 10) — un écart, pas du bruit.
  const futures = new Set<number>();
  for (const row of parseCsv(csv, { delimiter: ";" })) {
    if (row.TYPE_LGT !== SITADEL_TYPE_LGT_TOTAL) continue;
    // Même règle que l'ingestion : année hors fenêtre, mois hors 1-12 ou compte
    // non numérique (secret stat) = ligne REJETÉE, jamais un NaN qui
    // empoisonnerait l'année. L'anti-garbage (`ANNEE=2030` isolé) est borné
    // sur l'HORLOGE, pas sur la table — sinon une année manquante en table
    // serait filtrée avant comparaison et la parité passerait sur une table
    // en retard.
    const annee = Number(row.ANNEE);
    if (!Number.isInteger(annee) || annee < firstYear || annee > new Date().getUTCFullYear()) {
      continue;
    }
    if (annee > lastYear) {
      futures.add(annee);
      continue;
    }
    const moisRow = Number(row.MOIS);
    if (!Number.isInteger(moisRow) || moisRow < 1 || moisRow > MOIS_PAR_AN) continue;
    const aut = (row.LOG_AUT ?? "").trim();
    const com = (row.LOG_COM ?? "").trim();
    if (!/^[0-9]+$/.test(aut) || !/^[0-9]+$/.test(com)) continue;
    const entry = out[String(annee)] ?? { aut: 0, com: 0 };
    entry.aut += Number(aut);
    entry.com += Number(com);
    out[String(annee)] = entry;
    const moisAnnee = mois[String(annee)] ?? new Set<number>();
    moisAnnee.add(moisRow);
    mois[String(annee)] = moisAnnee;
  }
  return { totaux: out, mois, futures };
}

/**
 * Le split est-il celui du guichet ? Année en cours ⇔ la dernière année live
 * a moins de 12 mois, même année, même nombre de mois ; et chaque année de la
 * fenêtre porte le même nombre de mois des deux côtés. Un total juste avec un
 * split faux (année pleine servie « en cours », année amputée servie pleine)
 * est un ÉCART.
 */
function splitMatches(live: MoisParAnnee, db: PermitsFenetre): boolean {
  const anneesLive = Object.keys(live).map(Number);
  if (anneesLive.length === 0) return db.annee_en_cours === null;
  const derniere = Math.max(...anneesLive);
  const moisLive = live[String(derniere)]?.size ?? 0;
  const enCours = db.annee_en_cours;
  const enCoursOk =
    moisLive >= MOIS_PAR_AN
      ? enCours === null
      : enCours !== null && enCours.annee === derniere && enCours.mois_couverts === moisLive;
  const fenetreOk = Object.entries(db.par_annee).every(
    ([a, v]) => (live[a]?.size ?? -1) === v.mois_couverts,
  );
  return enCoursOk && fenetreOk;
}

const sortKeys = (o: ParAnnee): string =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/** `par_annee` sans `mois_couverts`, comparable au live qui ne le porte pas. */
const totauxSeuls = (o: PermitsFenetre["par_annee"]): ParAnnee =>
  Object.fromEntries(Object.entries(o).map(([a, v]) => [a, { aut: v.aut, com: v.com }]));

async function main(): Promise<void> {
  const communes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_COMMUNES;
  // « Je n'ai pas pu prouver » ≠ « j'ai prouvé une divergence » : deux compteurs.
  let mismatches = 0;
  let preuvesNulles = 0;

  // Séquentiel à dessein : DiDo répond 429 dès 2 appels concurrents.
  for (const insee of communes) {
    const t0 = Date.now();
    const db = await permitsForCommune(insee, { years: YEARS });
    const tDb = Date.now() - t0;
    // Sans fenêtre, rien à comparer : PREUVE NULLE, pas un écart.
    if (db.couverture === "indisponible:no_data") {
      preuvesNulles++;
      console.log(`PREUVE NULLE ${insee}  table=${tDb} ms  couverture=${db.couverture}`);
      continue;
    }
    const t1 = Date.now();
    // Même repli que la lecture : DiDo est vide sur un arrondissement. Le live
    // est borné sur la TABLE (plus ancienne année servie → dernière publiée),
    // pas sur l'horloge ni sur son propre max.
    const firstYear = Math.min(...db.annees.map(Number));
    const lastYear = Math.max(...db.annees.map(Number), db.annee_en_cours?.annee ?? firstYear);
    const {
      totaux: live,
      mois: moisLive,
      futures,
    } = await livePermits(parentCommuneInsee(insee), firstYear, lastYear);
    const tLive = Date.now() - t1;
    if (futures.size > 0) {
      mismatches++;
      console.log(
        `ÉCART    ${insee}  le guichet publie ${[...futures].sort().join(",")} absent(s) de la table — relancer pnpm ingest:sitadel`,
      );
      continue;
    }
    // Deux côtés VIDES se ressemblent aussi : ce n'est pas une preuve (RLS
    // perdue, filtre DiDo cassé — exactement quand on lance ce script).
    const vide = Object.keys(live).length === 0;
    // Le live ne distingue pas l'année en cours : on la recombine aux années
    // de la fenêtre pour comparer les mêmes séries.
    const table: ParAnnee = totauxSeuls(db.par_annee);
    if (db.annee_en_cours) {
      table[String(db.annee_en_cours.annee)] = {
        aut: db.annee_en_cours.logements_autorises,
        com: db.annee_en_cours.logements_commences,
      };
    }
    const sTable = sortKeys(table);
    const sLive = sortKeys(live);
    const splitOk = vide ? null : splitMatches(moisLive, db);
    const same = !vide && sTable === sLive && splitOk === true;
    if (vide) preuvesNulles++;
    else if (!same) mismatches++;
    const enCours = db.annee_en_cours
      ? `  en_cours=${db.annee_en_cours.annee}/${db.annee_en_cours.mois_couverts}m`
      : "";
    console.log(
      `${same ? "PARITÉ OK" : vide ? "PREUVE NULLE" : "ÉCART    "} ${insee}  table=${tDb} ms  live=${tLive} ms  couverture=${db.couverture}  aut=${db.logements_autorises_recent}${enCours}`,
    );
    if (!same) {
      const moisStr = Object.entries(moisLive)
        .map(([a, m]) => `${a}:${m.size}m`)
        .join(" ");
      const splitStr = splitOk === null ? "non mesuré (preuve nulle)" : splitOk ? "ok" : "FAUX";
      console.log(
        `  table: ${sTable}\n  live : ${sLive}\n  split ${splitStr} — mois live ${moisStr}`,
      );
    }
  }

  // Repli arrondissement → ville : DiDo est VIDE sur 75115 (pas de parité live
  // possible) ; la preuve est que la table sert la même chose que pour 75056.
  for (const [arr, ville] of [
    ["75115", "75056"],
    ["69383", "69123"],
    ["13208", "13055"],
  ] as const) {
    const [a, v] = await Promise.all([permitsForCommune(arr), permitsForCommune(ville)]);
    const same = a.couverture !== "indisponible:no_data" && JSON.stringify(a) === JSON.stringify(v);
    if (!same) mismatches++;
    const aut = a.couverture === "indisponible:no_data" ? "-" : a.logements_autorises_recent;
    console.log(`${same ? "REPLI OK " : "ÉCART    "} ${arr} ≡ ${ville}  aut=${aut}`);
  }

  console.log(
    `\n${mismatches === 0 ? "Aucun écart" : `${mismatches} écart(s)`}, ${preuvesNulles} preuve(s) nulle(s) (${communes.length} communes + 3 replis).`,
  );
  if (mismatches > 0) process.exit(1);
  if (preuvesNulles > 0) process.exit(2);
}

await main();
