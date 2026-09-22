/**
 * Preuve de parité Sit@del : `permitsForCommune` (table `sitadel_logements`)
 * vs l'API DiDo interrogée EN DIRECT, commune par commune.
 *
 *   pnpm tsx scripts/sitadel-parity.ts [insee…]
 *
 * À rejouer après toute retouche de `scripts/ingest/sitadel.ts` ou de
 * `src/immobilier/sitadel.ts`. Lent par nature (~37 s par commune côté DiDo —
 * c'est précisément la raison d'être de la table). Exit 1 au moindre écart.
 * Un écart juste après une publication SDES et AVANT le cron du 10 est
 * attendu (la table a un mois de retard) : relancer `pnpm ingest:sitadel`.
 */
import "./ingest/load-env.js";
import { parseCsv } from "../src/core/csv.js";
import { fetchText } from "../src/core/http.js";
import { SITADEL_TYPE_LGT_TOTAL, permitsForCommune } from "../src/immobilier/sitadel.js";
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
const YEARS = 5;

type ParAnnee = Record<string, { aut: number; com: number }>;

async function livePermits(insee: string, firstYear: number): Promise<ParAnnee> {
  // `fetchText` porte la politique 429/Retry-After/5xx du projet : DiDo limite
  // le débit dès 2 appels rapprochés (mesuré 2026-09-21).
  const csv = await fetchText(`${DIDO_DATAFILE_URL}?withColumnName=true&CODE_INSEE=eq:${insee}`, {
    maxRetries: 6,
    headers: { Accept: "text/csv,*/*" },
  });
  const out: ParAnnee = {};
  for (const row of parseCsv(csv, { delimiter: ";" })) {
    if (row.TYPE_LGT !== SITADEL_TYPE_LGT_TOTAL) continue;
    const annee = Number(row.ANNEE);
    if (!Number.isFinite(annee) || annee < firstYear) continue;
    const entry = out[String(annee)] ?? { aut: 0, com: 0 };
    // Même règle que l'ingestion : un compte non numérique (secret stat) est
    // une ligne REJETÉE, pas un NaN qui empoisonnerait l'année.
    const aut = (row.LOG_AUT ?? "").trim();
    const com = (row.LOG_COM ?? "").trim();
    if (!/^[0-9]+$/.test(aut) || !/^[0-9]+$/.test(com)) continue;
    entry.aut += Number(aut);
    entry.com += Number(com);
    out[String(annee)] = entry;
  }
  return out;
}

const sortKeys = (o: ParAnnee): string =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

async function main(): Promise<void> {
  const communes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_COMMUNES;
  let mismatches = 0;

  // Séquentiel à dessein : DiDo répond 429 dès 2 appels concurrents.
  for (const insee of communes) {
    const t0 = Date.now();
    const db = await permitsForCommune(insee, { years: YEARS });
    const tDb = Date.now() - t0;
    const t1 = Date.now();
    // Même repli que la lecture : DiDo est vide sur un arrondissement.
    // La table sert les YEARS dernières années PUBLIÉES : le live est borné
    // à la plus ancienne d'entre elles (pas à l'horloge).
    const firstYear = Math.min(...db.annees.map(Number), new Date().getUTCFullYear());
    const live = await livePermits(parentCommuneInsee(insee), firstYear);
    const tLive = Date.now() - t1;
    // Deux côtés VIDES se ressemblent aussi : ce n'est pas une preuve (table
    // vide, RLS perdue, filtre DiDo cassé — exactement quand on lance ce script).
    const vide = Object.keys(live).length === 0 || db.couverture !== "ok";
    const same = !vide && sortKeys(db.par_annee) === sortKeys(live);
    if (!same) mismatches++;
    console.log(
      `${same ? "PARITÉ OK" : vide ? "PREUVE NULLE" : "ÉCART    "} ${insee}  table=${tDb} ms  live=${tLive} ms  couverture=${db.couverture}  aut=${db.logements_autorises_recent}`,
    );
    if (!same) console.log(`  table: ${sortKeys(db.par_annee)}\n  live : ${sortKeys(live)}`);
  }

  // Repli arrondissement → ville : DiDo est VIDE sur 75115 (pas de parité live
  // possible) ; la preuve est que la table sert la même chose que pour 75056.
  for (const [arr, ville] of [
    ["75115", "75056"],
    ["69383", "69123"],
    ["13208", "13055"],
  ] as const) {
    const [a, v] = await Promise.all([permitsForCommune(arr), permitsForCommune(ville)]);
    const same = a.couverture === "ok" && JSON.stringify(a) === JSON.stringify(v);
    if (!same) mismatches++;
    console.log(
      `${same ? "REPLI OK " : "ÉCART    "} ${arr} ≡ ${ville}  aut=${a.logements_autorises_recent}`,
    );
  }

  console.log(
    `\n${mismatches === 0 ? "Tout est à parité" : `${mismatches} écart(s)`} (${communes.length} communes + 3 replis).`,
  );
  if (mismatches > 0) process.exit(1);
}

await main();
