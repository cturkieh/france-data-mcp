import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubDir, ingestDir } from "./migration-sql.js";

// Garde-fous d'alerting des workflows GitHub Actions (`.github/`).
//
// Post-mortem 2026-09-05 (runs RPPS #30981501695 du 05/08 et #33954453629 du
// 05/09, prouvés prod) : un `timeout-minutes` atteint met le job en `cancelled`,
// PAS en `failure` → le step d'alerte gardé par `failure()` seul n'a produit NI
// issue NI email quand le run d'août a été tué en plein ban_join AVANT le swap
// (mois RPPS perdu, découvert 2 mois après). Le script tué en SIGTERM n'écrit
// pas non plus de ligne `ingest_log` : sans alerte workflow, l'incident est muet.
//
// Lecture TEXTE du YAML (patron du repo — aucun parseur YAML en dépendance, on
// n'en ajoute pas pour un test), mais :
//  - itération sur TOUT `.github/` avec liste d'EXEMPTION explicite (tout
//    nouveau workflow est PRÉSUMÉ devoir alerter — l'exempter est un acte revu),
//  - scalaires pliés `if: >-` APLATIS (sinon un `failure()` sur la 2e ligne
//    échappe au filet = faux vert),
//  - bloc de step borné par l'INDENTATION capturée (workflows 6 espaces,
//    composites 4) et ancré en début de ligne (un `# - name:` commenté ne
//    compte pas).

const read = (rel: string): string => readFileSync(join(githubDir, rel), "utf8");
const isYaml = (f: string): boolean => /\.ya?ml$/.test(f);
const workflowFiles = readdirSync(join(githubDir, "workflows"), { withFileTypes: true })
  .filter((d) => d.isFile() && isYaml(d.name))
  .map((d) => d.name)
  .sort();
const workflows = new Map(workflowFiles.map((f) => [f, read(`workflows/${f}`)]));
const actionDirs = readdirSync(join(githubDir, "actions"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const actions = new Map(actionDirs.map((d) => [d, read(`actions/${d}/action.yml`)]));

function mustGet(map: Map<string, string>, key: string): string {
  const v = map.get(key);
  if (v === undefined) throw new Error(`fichier .github attendu introuvable : ${key}`);
  return v;
}

/**
 * Workflows SANS alerte ops, PAR CONCEPTION : CI de PR (l'échec est visible sur
 * la PR), keep-warm (ping toutes les heures, bruit inutile), release (manuelle,
 * suivie en direct). Tout autre workflow DOIT passer par la composite.
 */
const NO_ALERT_BY_DESIGN = new Set(["ci.yml", "keep-warm.yml", "release.yml"]);
const alerting = workflowFiles.filter((f) => !NO_ALERT_BY_DESIGN.has(f));

const NOTIFY_FAILURE = "./.github/actions/notify-ingest-failure";
const SEND_EMAIL = "./.github/actions/send-ops-email";
const ALERT_STEP = "Alert on failure or cancelled run";

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Bloc texte d'un step : de sa ligne `- name: X` (ancrée début de ligne,
 * indentation capturée) jusqu'au prochain `- name:` / `- uses:` de MÊME
 * indentation (ou la fin du fichier).
 */
function stepBlock(src: string, stepName: string): string | null {
  const head = new RegExp(`^([ \\t]+)- name: ${escapeRegex(stepName)}[ \\t]*$`, "m").exec(src);
  if (!head) return null;
  const indent = head[1] ?? "";
  const bodyStart = head.index + head[0].length;
  const next = new RegExp(`^${indent}- (?:name|uses):`, "m").exec(src.slice(bodyStart));
  return src.slice(head.index, next ? bodyStart + next.index : undefined);
}

/** Toutes les conditions `if:` d'un texte YAML, scalaires pliés (`>`, `>-`, `|`) aplatis. */
function ifConditions(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]+)if:[ \t]*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    let value = (m[2] ?? "").trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim() === "") break;
        if (l.length - l.trimStart().length <= indent) break;
        parts.push(l.trim());
      }
      value = parts.join(" ");
    }
    out.push(value);
  }
  return out;
}

/** Condition `if:` d'un step repéré par son `name:` exact (`null` = step ou `if:` absent). */
function stepIfCondition(src: string, stepName: string): string | null {
  const block = stepBlock(src, stepName);
  return block === null ? null : (ifConditions(block)[0] ?? null);
}

/** Première ligne de chaque step d'un workflow (`- name: …` ou `- uses: …`), dans l'ordre. */
function stepHeads(src: string): string[] {
  return [...src.matchAll(/^[ \t]+- (?:name|uses): (.+)$/gm)].map((m) => (m[1] ?? "").trim());
}

describe("workflows d'alerte + composites — aucun `failure()` sans `cancelled()` (timeout GitHub = cancelled)", () => {
  const files: Array<[string, string]> = [
    ...alerting.map((f): [string, string] => [f, mustGet(workflows, f)]),
    ...actions,
  ];
  for (const [file, src] of files) {
    it(`${file} : chaque condition à failure() porte aussi cancelled() (plié inclus)`, () => {
      for (const cond of ifConditions(src).filter((c) => /\bfailure\(\)/.test(c))) {
        expect(
          cond,
          `${file} : un run tué (timeout-minutes, annulation, quota) est \`cancelled\`, pas \`failure\` — sans cancelled(), aucune alerte (août 2026 muet)`,
        ).toMatch(/\bcancelled\(\)/);
      }
    });
  }
});

describe("tout workflow non exempté alerte via notify-ingest-failure", () => {
  it("le filet couvre les 8 workflows attendus (nouveau cron = présumé alertant, exemption = acte revu)", () => {
    expect(alerting.length).toBeGreaterThanOrEqual(8);
    for (const f of NO_ALERT_BY_DESIGN) {
      expect(
        workflowFiles,
        `exemption ${f} orpheline (fichier disparu) — nettoyer la liste`,
      ).toContain(f);
    }
  });

  for (const file of alerting) {
    const src = mustGet(workflows, file);

    it(`${file} : step « ${ALERT_STEP} » → composite, failure() || cancelled(), job.status, issues: write`, () => {
      const block = stepBlock(src, ALERT_STEP);
      expect(block, `${file} : step d'alerte introuvable`).not.toBeNull();
      expect(block).toContain(`uses: ${NOTIFY_FAILURE}`);
      const cond = stepIfCondition(src, ALERT_STEP);
      expect(cond, `${file} : le step d'alerte doit porter un if:`).not.toBeNull();
      expect(cond).toMatch(/\bfailure\(\)/);
      expect(cond).toMatch(/\bcancelled\(\)/);
      // `job.status` n'est pas lisible depuis une composite : le call-site le passe.
      expect(block).toMatch(/job-status:\s*\$\{\{\s*job\.status\s*\}\}/);
      // L'issue exige la permission (les backfills ne l'avaient pas).
      expect(src, `${file} : permissions.issues: write manquante`).toMatch(/^\s+issues:\s*write/m);
    });

    it(`${file} : actions/checkout est le PREMIER step (l'alerte est une action LOCALE)`, () => {
      // Post-revue 2026-09-05 : preflight secrets AVANT checkout → si les secrets
      // manquent, `uses: ./.github/actions/…` ne résout pas (workspace vide) →
      // alerte MUETTE sur la panne même qu'elle doit rapporter.
      const heads = stepHeads(src);
      expect(heads.length).toBeGreaterThan(1);
      expect(
        heads[0],
        `${file} : le 1er step doit être actions/checkout (trouvé « ${heads[0]} ») — sinon un échec avant checkout rend l'alerte locale introuvable`,
      ).toMatch(/^actions\/checkout@/);
    });
  }

  it("aucun bloc `… run failed (run #…)` inline ne subsiste (copies divergentes)", () => {
    for (const [file, src] of workflows) {
      expect(src, `${file} : issue d'échec inline — passer par ${NOTIFY_FAILURE}`).not.toContain(
        "run failed (run #${context.runId})",
      );
    }
  });
});

describe("ingest-rpps.yml — budget de temps (post-mortem 2026-08/09)", () => {
  const rpps = mustGet(workflows, "ingest-rpps.yml");
  const timeoutMatches = [...rpps.matchAll(/^\s+timeout-minutes:\s*(\d+)\s*$/gm)];

  it("timeout-minutes ≥ 120 (60 tuait le run en plein ban_join : mois perdu)", () => {
    expect(timeoutMatches, "timeout-minutes introuvable dans ingest-rpps.yml").toHaveLength(1);
    expect(
      Number(timeoutMatches[0]?.[1]),
      "durée réelle 54→60 min (05/2026→09/2026), +15 K lignes/mois : le budget doit laisser ×2",
    ).toBeGreaterThanOrEqual(120);
  });

  it("parité avec RPPS_JOB_BUDGET_MINUTES (rpps.ts) — le préavis de dérive mesure contre le VRAI budget", () => {
    const rppsSrc = readFileSync(`${ingestDir}/rpps.ts`, "utf8");
    const mirror = rppsSrc.match(/^const RPPS_JOB_BUDGET_MINUTES = (\d+);$/m)?.[1];
    expect(mirror, "RPPS_JOB_BUDGET_MINUTES introuvable dans rpps.ts").toBeDefined();
    expect(Number(mirror)).toBe(Number(timeoutMatches[0]?.[1]));
    // Le préavis existe et est LOUD (annotation GitHub + warn grep-able).
    expect(rppsSrc).toContain("DÉRIVE DE DURÉE");
    expect(rppsSrc).toMatch(/console\.log\(`::warning::\$\{drift\}`\)/);
  });

  it("la notif BAN reste gardée par success() sur RPPS et Ameli (jamais « cron RÉUSSI » sur un run tué)", () => {
    for (const file of ["ingest-rpps.yml", "ingest-ameli.yml"]) {
      expect(
        stepIfCondition(mustGet(workflows, file), "Notify pending BAN geocoding"),
        `${file} : la notif BAN doit rester if: success()`,
      ).toBe("success()");
    }
  });
});

describe("composite notify-ingest-failure — message actionnable, best-effort", () => {
  const action = mustGet(actions, "notify-ingest-failure");

  it("discrimine run tué vs échec via l'input job-status, et le valide (required non appliqué sur une composite)", () => {
    expect(action).toContain("process.env.JOB_STATUS === 'cancelled'");
    expect(action).toContain("['failure', 'cancelled'].includes(process.env.JOB_STATUS)");
    expect(action).toMatch(/run TUÉ/);
    // Backticks échappés dans le template literal du script (`\`ingest_log\``).
    expect(action).toMatch(/aucune ligne \\`ingest_log\\`/);
    // Le hint par défaut ne doit PAS affirmer « swap non fait » : septembre a
    // swappé PUIS a été tué.
    expect(action).toMatch(/PEUT-ÊTRE eu lieu/);
    expect(action).not.toMatch(/n'a probablement PAS eu lieu/);
  });

  it("email sous always() avec repli, délégué à l'émetteur unique ; issue en try/catch", () => {
    const email = stepBlock(action, "Email — run échoué ou tué");
    expect(email, "step email introuvable").not.toBeNull();
    expect(ifConditions(email ?? "")[0]).toBe("always()");
    expect(email).toContain(`uses: ${SEND_EMAIL}`);
    expect(email).toMatch(/subject: "\$\{\{ steps\.issue\.outputs\.subject \|\| format\(/);
    expect(email).toMatch(/text: "\$\{\{ steps\.issue\.outputs\.text \|\| format\(/);
    expect(action).toMatch(/catch \(err\)[\s\S]*core\.warning/);
    // `core.setOutput` AVANT le try : sur panne de l'API issues, l'email garde le bon contenu.
    expect(action.indexOf("core.setOutput('subject'")).toBeLessThan(action.indexOf("try {"));
  });
});

describe("composite send-ops-email — émetteur Resend UNIQUE et best-effort", () => {
  const sender = mustGet(actions, "send-ops-email");

  it("est le SEUL endroit de .github/ qui appelle api.resend.com", () => {
    expect(sender).toContain("https://api.resend.com/emails");
    for (const [file, src] of [...workflows, ...actions]) {
      if (file === "send-ops-email") continue;
      expect(src, `${file} : appel Resend inline — passer par ${SEND_EMAIL}`).not.toContain(
        "api.resend.com",
      );
    }
  });

  it("clé absente → warning + exit 0 ; sujet vide → error + repli ; jamais d'échec de step", () => {
    expect(sender).toMatch(/if \[ -z "\$RESEND_API_KEY" \]; then[\s\S]*::warning::[\s\S]*exit 0/);
    expect(sender).toMatch(/if \[ -z "\$SUBJECT" \]; then[\s\S]*::error::/);
    expect(sender).not.toMatch(/^\s+continue-on-error:/m);
    expect(sender).not.toMatch(/^\s+exit 1/m);
  });

  it("curl borné (--max-time) et 401/403 classés SYSTÉMIQUES (::error::), le reste transitoire (::warning::)", () => {
    expect(sender).toMatch(/curl [^\n]*--max-time \d+/);
    expect(sender).toMatch(/401\|403\)[^\n]*::error::/);
    expect(sender).toMatch(/\*\)[^\n]*::warning::/);
  });

  it("notify-pending-geocode consomme l'émetteur unique, outputs en heredoc, issue sous always()", () => {
    const pending = mustGet(actions, "notify-pending-geocode");
    expect(pending).toContain(`uses: ${SEND_EMAIL}`);
    expect(pending).toContain("steps.compose.outputs.subject");
    expect(pending).toMatch(/echo "subject<<__OPS_EOF__"/);
    expect(stepIfCondition(pending, "Issue — adresses à géocoder")).toMatch(/^always\(\) &&/);
  });
});
