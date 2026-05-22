/**
 * Test live V0.16 — prouve sur la prod (vraies APIs DINUM/INSEE + DB Supabase)
 * que le fix « succession M&A » de `verifier_site_actif` produit les verdicts
 * attendus, et que les edge cases (faux positif inverse) sont couverts.
 *
 * Usage : `pnpm exec tsx scripts/test-live-v016-succession.ts`
 *
 * Partie A — cas nommés avec verdict attendu :
 *   1. FINESS 920026770 (Neuilly Sablons, ex-BioÉpine) — Mécanisme A (chemin
 *      RPPS sur SIREN racheté) : attendu `actif` + succession détectée.
 *   2. FINESS 920026341 (Pont de Neuilly, ex-BioÉpine) — Mécanisme B (fallback
 *      géo) : attendu `actif` + succession détectée.
 *   3. FINESS 920028487 (EYLAU UNILABS Victor Hugo) — non-régression V0.13.1 :
 *      attendu `actif`.
 *   4. FINESS 920028685 (PMA Chérest) — GARDE-FOU faux positif inverse : un
 *      site fermé doit RESTER `ferme` (ne jamais basculer en `actif`).
 *   5. FINESS 920000643 (Hôpital Franco-Britannique) — non-régression : `actif`.
 *
 * Partie B — échantillon de FINESS « BioÉpine » : mesure du taux de bascule
 *   vers `actif` (sites repris par Biogroup). Reporting, pas d'assertion.
 *
 * Discipline projet : prouver-par-la-prod avant push (cf. memory
 * `prove-rootcause-by-prod` + CLAUDE.md "Recherche externe avant de coder").
 */

import "./ingest/load-env.js";

import { verifierSiteActif } from "../src/sante/cross-source.js";

interface Cas {
  numFiness: string;
  label: string;
  expectedVerdict: "actif" | "ferme" | "indetermine";
  /** `true`/`false` pour asserter `succession.detected` ; `undefined` = pas d'assertion. */
  expectSuccession?: boolean;
}

const CAS_A: Cas[] = [
  {
    numFiness: "920026770",
    label: "Neuilly Sablons (ex-BioÉpine) — Mécanisme A (chemin RPPS racheté)",
    expectedVerdict: "actif",
    expectSuccession: true,
  },
  {
    numFiness: "920026341",
    label: "Pont de Neuilly (ex-BioÉpine) — Mécanisme B (fallback géo)",
    expectedVerdict: "actif",
    expectSuccession: true,
  },
  {
    numFiness: "920028487",
    label: "EYLAU UNILABS Victor Hugo — non-régression V0.13.1",
    expectedVerdict: "actif",
  },
  {
    numFiness: "920028685",
    label: "PMA Chérest — GARDE-FOU faux positif inverse (doit rester ferme)",
    expectedVerdict: "ferme",
    expectSuccession: false,
  },
  {
    numFiness: "920000643",
    label: "Hôpital Franco-Britannique — non-régression",
    expectedVerdict: "actif",
  },
];

/** Échantillon de FINESS « BioÉpine » (zone Paris ouest) — reporting seul. */
const ECHANTILLON_BIOEPINE: Array<{ numFiness: string; label: string }> = [
  { numFiness: "920026572", label: "BPO-BIOEPINE SITE HUISSIERS" },
  { numFiness: "920026580", label: "BPO-BIOEPINE SITE MICHELIS" },
  { numFiness: "920033131", label: "BPO-BIOEPINE SITE INST RAPHAEL" },
  { numFiness: "920026663", label: "BPO-BIOEPINE SITE LECLERC" },
  { numFiness: "920026598", label: "BPO-BIOEPINE SITE HEROLD" },
  { numFiness: "750050791", label: "BPO-BIOEPINE SITE GRANDE ARMEE" },
  { numFiness: "750049496", label: "BPO-BIOEPINE SITE ST FERDINAND" },
  { numFiness: "920026606", label: "BPO-BIOEPINE SITE BEZON" },
  { numFiness: "920026739", label: "BPO-BIOEPINE SITE REPUBLIQUE" },
  { numFiness: "920026614", label: "BPO-BIOEPINE SITE ASNIERE" },
];

async function runPartieA(): Promise<number> {
  console.log("\n########## Partie A — cas nommés ##########");
  let failures = 0;
  for (const c of CAS_A) {
    console.log(`\n=== ${c.numFiness} — ${c.label}`);
    const t0 = Date.now();
    const result = await verifierSiteActif(c.numFiness);
    const ms = Date.now() - t0;
    if (!result.found) {
      console.error(`  ❌ not_found: ${result.message}`);
      failures += 1;
      continue;
    }
    const { verdict_site, verdict_groupe, best_match, method, disambiguation_status, succession } =
      result;
    const verdictOk = verdict_site === c.expectedVerdict;
    const succOk = c.expectSuccession === undefined || succession.detected === c.expectSuccession;
    console.log(
      `  verdict_site=${verdict_site} (expected ${c.expectedVerdict}) ${verdictOk ? "✅" : "❌"}`,
    );
    console.log(
      `  verdict_groupe=${verdict_groupe}  method=${method}  disamb=${disambiguation_status}`,
    );
    if (best_match) {
      console.log(
        `  best_match.siret=${best_match.siret} actif=${best_match.actif} ul="${best_match.raison_sociale_ul ?? "n/a"}" dist=${best_match.distance_finess_m?.toFixed(1) ?? "n/a"}m`,
      );
    } else {
      console.log("  best_match=null");
    }
    const succLabel = c.expectSuccession === undefined ? "(non asserté)" : succOk ? "✅" : "❌";
    console.log(
      `  succession.detected=${succession.detected} (${succession.exploitants_precedents.length} précédent·s) ${succLabel}`,
    );
    console.log(`  duration=${ms}ms`);
    if (!verdictOk || !succOk) {
      console.log("  --- candidates dump ---");
      for (const cand of result.candidates) {
        console.log(
          `    siret=${cand.siret} actif=${cand.actif} dist=${cand.distance_finess_m?.toFixed(1) ?? "n/a"}m score_adr=${cand.score_adresse?.toFixed(3) ?? "n/a"} ul="${cand.raison_sociale_ul ?? "n/a"}"`,
        );
      }
      failures += 1;
    }
  }
  return failures;
}

async function runPartieB(): Promise<void> {
  console.log("\n########## Partie B — échantillon BioÉpine (reporting) ##########");
  const tally = { actif: 0, ferme: 0, indetermine: 0, succession: 0 };
  for (const e of ECHANTILLON_BIOEPINE) {
    const result = await verifierSiteActif(e.numFiness);
    if (!result.found) {
      console.log(`  ${e.numFiness} ${e.label} → not_found`);
      continue;
    }
    tally[result.verdict_site] += 1;
    if (result.succession.detected) tally.succession += 1;
    console.log(
      `  ${e.numFiness} ${e.label} → ${result.verdict_site}` +
        ` (succession=${result.succession.detected}, method=${result.method})`,
    );
  }
  console.log(
    `\n  Bilan échantillon (${ECHANTILLON_BIOEPINE.length}) : ` +
      `actif=${tally.actif} · ferme=${tally.ferme} · indetermine=${tally.indetermine} · ` +
      `succession détectée=${tally.succession}`,
  );
}

async function main() {
  const failuresA = await runPartieA();
  await runPartieB();
  console.log(`\n=== Partie A : ${CAS_A.length - failuresA}/${CAS_A.length} cas OK`);
  if (failuresA > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[test-live-v016-succession] uncaught:", err);
  process.exitCode = 1;
});
