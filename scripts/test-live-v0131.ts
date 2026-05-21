/**
 * Test live V0.13.1 — prouve sur la prod (vraies APIs DINUM/INSEE + DB Supabase)
 * que les 3 cas du brief Cyril produisent les verdicts attendus.
 *
 * Usage : `pnpm exec tsx scripts/test-live-v0131.ts`
 *
 * Cas couverts (du brief de session V0.13.1) :
 *   1. FINESS 920028487 (LBM EYLAU UNILABS Victor Hugo) — fallback géo :
 *      attendu `verdict_site: "actif"` + `disambiguation_status: "by_active_succession"`
 *      ou `"by_name_score"` + best_match = SIRET actif EYLAU UNILABS
 *   2. FINESS 920028685 (PMA Chérest) — chemin RPPS direct, non-régression :
 *      attendu `verdict_site: "ferme"` (préservation comportement V0.13.0)
 *   3. FINESS 920000643 (Hôpital Franco-Britannique) — chemin RPPS direct,
 *      non-régression : attendu `verdict_site: "actif"`
 *
 * Pattern aligné sur `scripts/test-live-fix4-fix5.ts` (V0.13.0, supprimé après
 * merge). Discipline projet : prouver-par-la-prod avant push (cf. memory
 * `prove-rootcause-by-prod` + CLAUDE.md "Recherche externe avant de coder").
 */

import "./ingest/load-env.js";

import { verifierSiteActif } from "../src/sante/cross-source.js";

interface Cas {
  numFiness: string;
  label: string;
  expectedVerdict: "actif" | "ferme" | "indetermine";
  acceptedDisambiguations: string[];
}

const CAS: Cas[] = [
  {
    numFiness: "920028487",
    label: "LBM EYLAU UNILABS Victor Hugo (fallback géo, Raff #2+#3)",
    expectedVerdict: "actif",
    acceptedDisambiguations: ["by_active_succession", "by_name_score", "single_after_gate"],
  },
  {
    numFiness: "920028685",
    label: "PMA Chérest (chemin RPPS direct, non-régression V0.13.0)",
    expectedVerdict: "ferme",
    acceptedDisambiguations: ["not_applicable"],
  },
  {
    numFiness: "920000643",
    label: "Hôpital Franco-Britannique (chemin RPPS direct, non-régression V0.13.0)",
    expectedVerdict: "actif",
    acceptedDisambiguations: ["not_applicable"],
  },
];

async function main() {
  let failures = 0;
  for (const c of CAS) {
    console.log(`\n=== ${c.numFiness} — ${c.label}`);
    const t0 = Date.now();
    const result = await verifierSiteActif(c.numFiness);
    const ms = Date.now() - t0;
    if (!result.found) {
      console.error(`  ❌ not_found: ${result.message}`);
      failures += 1;
      continue;
    }
    const { verdict_site, verdict_groupe, best_match, method, disambiguation_status } = result;
    const verdictOk = verdict_site === c.expectedVerdict;
    const disambOk = c.acceptedDisambiguations.includes(disambiguation_status);
    console.log(
      `  verdict_site=${verdict_site} (expected ${c.expectedVerdict}) ${verdictOk ? "✅" : "❌"}`,
    );
    console.log(`  verdict_groupe=${verdict_groupe}`);
    console.log(
      `  method=${method} disambiguation_status=${disambiguation_status} ${disambOk ? "✅" : "❌"}`,
    );
    if (best_match) {
      console.log(`  best_match.siret=${best_match.siret} actif=${best_match.actif}`);
      console.log(
        `  best_match.score_adresse=${best_match.score_adresse} score_nom=${best_match.score_nom}`,
      );
      console.log(`  best_match.raison_sociale_ul=${best_match.raison_sociale_ul}`);
    } else {
      console.log("  best_match=null");
    }
    console.log(
      `  candidates.length=${result.candidates.length} dinum_errors=${result.dinum_errors.length}`,
    );
    console.log(`  duration=${ms}ms`);
    if (!verdictOk || !disambOk) {
      // Debug : dump des candidats pour comprendre pourquoi la désambiguïsation
      // n'a pas tranché (prouver la cause-racine par la prod).
      console.log("  --- candidates dump ---");
      for (const cand of result.candidates) {
        const scoreA = cand.score_adresse?.toFixed(3) ?? "n/a";
        const scoreN = cand.score_nom?.toFixed(3) ?? "n/a";
        console.log(
          `    siret=${cand.siret} actif=${cand.actif} score_adresse=${scoreA} score_nom=${scoreN} ul="${cand.raison_sociale_ul ?? "n/a"}" adresse="${cand.adresse_libelle ?? "n/a"}"`,
        );
      }
      failures += 1;
    }
  }
  console.log(`\n=== Résultat : ${CAS.length - failures}/${CAS.length} cas OK`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[test-live-v0131] uncaught:", err);
  process.exitCode = 1;
});
