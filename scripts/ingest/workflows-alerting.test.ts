import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { githubDir, ingestDir } from "./migration-sql.js";
import {
  MEASURE_UNAVAILABLE_LABEL,
  PENDING_GEOCODE_LABEL,
  SOURCES as PENDING_GEOCODE_SOURCES,
} from "./notify-pending-geocode.js";

// Garde-fous d'alerting des workflows GitHub Actions (`.github/`).
//
// Post-mortem 2026-09-05 (runs RPPS #30981501695 du 05/08 et #33954453629 du
// 05/09, prouvés prod) : un `timeout-minutes` atteint met le job en `cancelled`,
// PAS en `failure` → le step d'alerte gardé par `failure()` seul n'a produit NI
// issue NI email quand le run d'août a été tué en plein ban_join AVANT le swap
// (mois RPPS perdu, découvert 2 mois après). Le script tué en SIGTERM n'écrit
// pas non plus de ligne `ingest_log` : sans alerte workflow, l'incident est muet.
//
// DEUX lectures, chacune à son emploi :
//  - PARSE YAML (`yaml`, déjà en devDependency) pour la STRUCTURE : partition
//    réutilisable / appelants / workflows à steps, `permissions`, `with:` d'un
//    appelant. Un nom de fichier ne prouve rien, la structure si ;
//  - lecture TEXTE pour le CÂBLAGE fin (ordre des steps, conditions `if:`
//    pliées, corps d'un `script:`), que l'arbre YAML aplatit en chaînes.
// Dans les deux cas : itération sur TOUT `.github/` avec liste d'EXEMPTION
// explicite (tout nouveau workflow est PRÉSUMÉ devoir alerter — l'exempter est
// un acte revu), scalaires pliés `if: >-` APLATIS (sinon un `failure()` sur la
// 2e ligne échappe au filet = faux vert), bloc de step borné par l'INDENTATION
// capturée (workflows 6 espaces, composites 4) et ancré en début de ligne (un
// `# - name:` commenté ne compte pas).

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
/**
 * Scripts EXTERNES des composites (`.cjs` chargé par `actions/github-script`
 * via `require`) : ils portent de la logique d'alerting au même titre que le
 * YAML — les invariants « émetteur unique » doivent les scanner AUSSI, sinon
 * déplacer un appel API hors du YAML suffirait à échapper au filet.
 */
const actionScripts = new Map(
  actionDirs.flatMap((d) =>
    readdirSync(join(githubDir, "actions", d), { withFileTypes: true })
      .filter((f) => f.isFile() && /\.c?js$/.test(f.name))
      .map((f): [string, string] => [`${d}/${f.name}`, read(`actions/${d}/${f.name}`)]),
  ),
);

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

/**
 * Partition STRUCTURELLE (par parse YAML, pas par nom de fichier) depuis la
 * factorisation du drain BAN (2026-09-06) : un workflow est soit RÉUTILISABLE
 * (`on: workflow_call`, il porte les steps et l'alerte), soit APPELANT
 * (`jobs.*.uses`, il n'a AUCUN step à lui — lui exiger un checkout ou un step
 * d'alerte n'aurait pas de sens), soit un workflow à steps ordinaire.
 */
interface WorkflowDoc {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    { uses?: string; with?: Record<string, unknown>; secrets?: string; if?: string }
  >;
}
const docs = new Map<string, WorkflowDoc>(
  workflowFiles.map((f) => [f, parseYaml(mustGet(workflows, f)) as WorkflowDoc]),
);
const jobsOf = (f: string) => Object.values(docs.get(f)?.jobs ?? {});
const reusableFiles = workflowFiles.filter((f) => docs.get(f)?.on?.workflow_call !== undefined);
const callerFiles = workflowFiles.filter((f) => jobsOf(f).some((j) => typeof j?.uses === "string"));
/** Non exemptés = tout ce qui doit alerter, appelants COMPRIS (garde failure()/cancelled()). */
const nonExempt = workflowFiles.filter((f) => !NO_ALERT_BY_DESIGN.has(f));
/** Workflows à STEPS devant porter checkout + step d'alerte (le réutilisable en fait partie). */
const alerting = nonExempt.filter((f) => !callerFiles.includes(f));

const NOTIFY_FAILURE = "./.github/actions/notify-ingest-failure";
const SEND_EMAIL = "./.github/actions/send-ops-email";
const UPSERT_ISSUE = "./.github/actions/upsert-ops-issue";
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

/**
 * Tête de chaque step d'un workflow (`name: …`, `uses: …`, `run: …`, `id: …`…),
 * dans l'ordre. Capture TOUTE forme de tête : un `- run:` inséré avant le
 * checkout doit faire échouer « checkout en 1er », pas être sauté.
 */
function stepHeads(src: string): string[] {
  // Borné à la section `steps:` du job : les listes AVANT (`- cron:` du
  // planning, `- name:` d'un input) ne sont pas des steps.
  const stepsIdx = src.search(/^[ \t]+steps:[ \t]*$/m);
  const body = stepsIdx < 0 ? src : src.slice(stepsIdx);
  return [...body.matchAll(/^[ \t]+- (\S.*)$/gm)].map((m) => (m[1] ?? "").trim());
}

describe("tout .github/**/*.yml PARSE (le garde-fou textuel ne voit pas un YAML mort)", () => {
  // Revue 2026-09-06 : une composite dont le `run: |` contenait une chaîne bash
  // multi-ligne en colonne 0 ne parsait plus — le runner aurait refusé de la
  // charger, `continue-on-error` aurait avalé l'échec, cron vert, zéro alerte.
  // Les assertions `toContain` sur le texte passaient toutes.
  for (const [file, src] of [...workflows, ...actions]) {
    it(`${file} : YAML valide`, () => {
      expect(() => parseYaml(src)).not.toThrow();
    });
  }
});

describe("workflows d'alerte + composites — aucun `failure()` sans `cancelled()` (timeout GitHub = cancelled)", () => {
  const files: Array<[string, string]> = [
    ...nonExempt.map((f): [string, string] => [f, mustGet(workflows, f)]),
    ...actions,
    ...actionScripts,
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
  // Compte EXPLICITE depuis la factorisation du drain BAN : un `>= 8` implicite
  // restait vert si un workflow perdait son alerte en changeant de catégorie.
  // Ajouter un workflow oblige à trancher ICI dans quelle case il tombe.
  const EXPECTED_REUSABLE = ["ban-backfill.yml"];
  const EXPECTED_CALLERS = [
    "ban-backfill-ameli.yml",
    "ban-backfill-finess.yml",
    "ban-backfill-rpps.yml",
  ];
  const EXPECTED_ALERTING = [
    "ban-backfill.yml",
    "cleanup-stale-previous.yml",
    "ingest-ameli.yml",
    "ingest-cds.yml",
    "ingest-finess.yml",
    "ingest-iris.yml",
    "ingest-rpps.yml",
  ];

  it("partition EXPLICITE : 1 réutilisable + 3 appelants + 7 workflows à steps + 3 exemptés", () => {
    expect(reusableFiles).toEqual(EXPECTED_REUSABLE);
    expect(callerFiles).toEqual(EXPECTED_CALLERS);
    expect(alerting).toEqual(EXPECTED_ALERTING);
    // Exhaustivité : tout fichier de `workflows/` tombe dans EXACTEMENT une case
    // (le réutilisable est compté dans `alerting`, il porte les steps).
    expect([...alerting, ...callerFiles, ...NO_ALERT_BY_DESIGN].sort()).toEqual(workflowFiles);
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
      ).toMatch(/^uses: actions\/checkout@/);
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

describe("drain BAN — un corps réutilisable + trois appelants (backlog FINESS phase 2, item 9)", () => {
  // Trois fichiers de 121-132 lignes dont SIX valeurs variaient : toute
  // correction (le `cancelled()` de septembre) devait être recopiée 3 fois. Le
  // corps vit désormais dans `ban-backfill.yml` (`workflow_call` — seul véhicule
  // qui lit `job.status` et accepte `secrets: inherit`, contrairement à une
  // composite, cf. run #33960886473).
  const REUSABLE_PATH = "./.github/workflows/ban-backfill.yml";
  const DRAIN_SOURCES = ["rpps", "ameli", "finess"];
  const REUSABLE_FILE = "ban-backfill.yml";
  const reusable = mustGet(workflows, REUSABLE_FILE);
  const CLOSE_STEP = "Close pending-geocode issue";

  it("le réutilisable expose EXACTEMENT les valeurs qui divergeaient entre les 3 copies", () => {
    const call = docs.get(REUSABLE_FILE)?.on?.workflow_call as
      | { inputs?: Record<string, unknown> }
      | undefined;
    expect(Object.keys(call?.inputs ?? {}).sort()).toEqual([
      "failure-modes",
      "issue-labels",
      "killed-hint",
      "max",
      "source",
      "source-label",
      "tolerate-canary-backlog",
    ]);
    expect(docs.get(REUSABLE_FILE)?.permissions?.issues).toBe("write");
  });

  for (const file of callerFiles) {
    const source = /^ban-backfill-(.+)\.ya?ml$/.exec(file)?.[1];

    it(`${file} : délègue au réutilisable, source cohérente avec le nom, secrets hérités, permissions redéclarées`, () => {
      const job = jobsOf(file)[0];
      expect(job?.uses).toBe(REUSABLE_PATH);
      // Sans `secrets: inherit`, AUCUN secret ne traverse un workflow_call :
      // le preflight du corps appelé échouerait à chaque run.
      expect(job?.secrets).toBe("inherit");
      // GitHub calcule les permissions chez l'APPELANT (l'appelé ne peut qu'en
      // avoir moins) : les omettre rendrait issue et fermeture muettes.
      expect(docs.get(file)?.permissions?.issues).toBe("write");
      expect(DRAIN_SOURCES, `${file} : source de drain inconnue`).toContain(source);
      // Cohérence nom de fichier ↔ `with.source` : un copier-coller qui draine
      // Ameli depuis le bouton RPPS serait invisible autrement.
      expect(job?.with?.source).toBe(source);
      expect(job?.with?.["issue-labels"]).toBe(`backfill-failure,${source}`);
      // Garde AUTO : jamais de drain après une ingestion ÉCHOUÉE.
      expect(job?.if ?? "").toContain("github.event.workflow_run.conclusion == 'success'");
    });

    it(`${file} : le cron surveillé (workflow_run) porte le nom EXACT d'un ingest-*.yml existant`, () => {
      const watched =
        (docs.get(file)?.on?.workflow_run as { workflows?: string[] } | undefined)?.workflows ?? [];
      expect(watched.length, `${file} : aucun workflow_run surveillé`).toBeGreaterThan(0);
      const ingestNames = workflowFiles
        .filter((f) => /^ingest-.*\.ya?ml$/.test(f))
        .map((f) => docs.get(f)?.name);
      for (const w of watched) {
        expect(
          ingestNames,
          `${file} : « ${w} » ne correspond à AUCUN name: de ingest-*.yml — le drain auto ne se déclencherait JAMAIS (silence total)`,
        ).toContain(w);
      }
    });
  }

  it(`le réutilisable ferme l'issue pending-geocode (file VRAIMENT vidée), jamais sur un canari`, () => {
    const block = stepBlock(reusable, CLOSE_STEP);
    expect(block, "step de fermeture introuvable").not.toBeNull();
    expect(block).toContain(`uses: ${UPSERT_ISSUE}`);
    expect(block).toContain("action: close");
    // Même clé d'idempotence que l'ouverture (`notify-pending-geocode`), et
    // label PRIMAIRE du registre INFORMATIF seulement.
    expect(block).toContain(`labels: ${PENDING_GEOCODE_LABEL},\${{ inputs.source }}`);
    // Best-effort : une API issues en panne ne re-rougit pas un drain réussi.
    expect(block).toMatch(/^\s+continue-on-error: true$/m);
    const cond = stepIfCondition(reusable, CLOSE_STEP) ?? "";
    expect(cond).toContain("success()");
    // Un canari (`max`) ne prétend jamais avoir vidé la file.
    expect(cond).toContain("inputs.max == ''");
    // ⚠️ `remaining` ne mesure QUE la troncature `--max` : garder dessus
    // laisserait un drain qui REJETTE tout fermer la vigie sur un « ✅ file
    // vidée » mensonger. `still_pending` mesure la même grandeur que la RPC
    // qui a OUVERT l'issue (revue 2026-09-06).
    expect(cond).toContain("steps.drain.outputs.still_pending == '0'");
    expect(cond).not.toContain("steps.drain.outputs.remaining");
  });

  it("un échec de la fermeture (composite non chargée comprise) est ANNONCÉ, jamais muet", () => {
    // `continue-on-error` maintient le job vert : le step d'alerte final ne se
    // déclenche donc pas. Sans ce contrôle aval, une action locale non résolue
    // (la panne du run #33960886473) rendrait la fermeture TOTALEMENT muette.
    const block = stepBlock(reusable, "Warn if issue closure did not happen");
    expect(block, "step de contrôle de la fermeture introuvable").not.toBeNull();
    expect(stepIfCondition(reusable, "Warn if issue closure did not happen")).toContain(
      "steps.close.conclusion != 'skipped'",
    );
    expect(block).toContain("steps.close.outputs.outcome");
    expect(block).toContain("::warning::");
    // L'issue de fermeture est lue via un `id:` — sans lui, aucun output.
    expect(stepBlock(reusable, CLOSE_STEP)).toMatch(/^\s+id: close$/m);
  });

  it("chaque source de notify-pending-geocode a un drain qui la REFERME (issue jamais orpheline)", () => {
    // #56 et #63 sont restées ouvertes jusqu'à une fermeture manuelle le
    // 2026-09-06 : ouvrir sans jamais fermer est un canal qui se décrédibilise.
    for (const source of PENDING_GEOCODE_SOURCES) {
      const file = `ban-backfill-${source}.yml`;
      expect(
        callerFiles,
        `source ${source} signalée par notify-pending-geocode sans drain qui la referme`,
      ).toContain(file);
      // Et le drain doit viser CETTE source : le réutilisable compose ses
      // labels de fermeture avec `inputs.source`.
      expect(jobsOf(file)[0]?.with?.source).toBe(source);
    }
  });

  it("le registre DÉGRADÉ (mesure indisponible) échappe au filtre de fermeture", () => {
    // Le filtre `labels` de l'API GitHub est un ET : si les deux registres
    // partageaient leur label primaire, un drain réussi — qui ne dit RIEN de
    // l'état de la RPC de mesure — fermerait la seule alerte actionnable.
    expect(MEASURE_UNAVAILABLE_LABEL).not.toBe(PENDING_GEOCODE_LABEL);
    expect(
      MEASURE_UNAVAILABLE_LABEL.split(",")[0],
      "le label dégradé ne doit pas contenir le label informatif comme label à part entière",
    ).not.toBe(PENDING_GEOCODE_LABEL);
    const block = stepBlock(reusable, CLOSE_STEP) ?? "";
    expect(block).not.toContain(MEASURE_UNAVAILABLE_LABEL);
  });

  it("les compteurs du drain sont publiés par le script ET consommés par le step de fermeture", () => {
    const script = readFileSync(join(ingestDir, "..", "ban-backfill.mjs"), "utf8");
    // Le step lit les outputs du step `drain` : sans l'id, tout `steps.drain.*`
    // vaudrait la chaîne vide → fermeture jamais déclenchée (silence).
    expect(
      stepBlock(
        reusable,
        "Drain BAN ${{ inputs.source-label }} (géocode le résidu → remplit le cache)",
      ),
    ).toContain("id: drain");
    for (const key of ["processed", "accepted", "still_pending", "finished_at"]) {
      expect(script, `output ${key} non produit par ban-backfill.mjs`).toMatch(
        new RegExp(`^\\s+${key}: `, "m"),
      );
      expect(reusable, `output ${key} non consommé par le workflow`).toContain(
        `steps.drain.outputs.${key}`,
      );
    }
    // Écriture APRÈS le run, AVANT le code de sortie (un exit 2 canari doit
    // publier remaining > 0 — c'est ce qui interdit la fermeture).
    expect(script).toContain("writeGithubOutput(banBackfillOutputs(r))");
  });

  // Le corps bash du step est EXÉCUTÉ tel qu'il est écrit dans le YAML (extrait
  // par le parseur, jamais retapé), l'invocation du script étant remplacée par
  // un code de sortie choisi — `bash -e` comme le runner. Assertion textuelle
  // impossible ici : ce qui compte est le CODE DE SORTIE final, et la tolérance
  // du canari FINESS ne doit surtout pas avaler un exit 3 (apiFailures) ou 1
  // (fatal), qui rendraient un drain cassé VERT.
  const drainRun = (
    (docs.get(REUSABLE_FILE)?.jobs?.backfill as { steps?: Array<{ id?: string; run?: string }> })
      ?.steps ?? []
  ).find((s) => s.id === "drain")?.run;

  it.each([
    { code: 2, tolerate: "true", expected: 0, why: "canari FINESS : backlog restant = nominal" },
    { code: 2, tolerate: "false", expected: 2, why: "canari sans tolérance : exit 2 remonte" },
    { code: 3, tolerate: "true", expected: 3, why: "apiFailures : JAMAIS avalé" },
    { code: 1, tolerate: "true", expected: 1, why: "fatal : JAMAIS avalé" },
    { code: 0, tolerate: "true", expected: 0, why: "canari complet" },
  ])("drain canari : script exit $code + tolerate=$tolerate → step exit $expected ($why)", (c) => {
    expect(drainRun, "corps du step `drain` introuvable").toBeDefined();
    const file = join(mkdtempSync(join(tmpdir(), "drain-step-")), "step.sh");
    writeFileSync(
      file,
      (drainRun ?? "").replaceAll(
        "pnpm exec tsx scripts/ban-backfill.mjs",
        `bash -c "exit ${c.code}"`,
      ),
    );
    let status = 0;
    try {
      execFileSync("bash", ["-e", file], {
        env: { ...process.env, MAX: "5", SOURCE: "finess", TOLERATE_CANARY_BACKLOG: c.tolerate },
        stdio: "pipe",
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    }
    expect(status).toBe(c.expected);
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

describe("vigie « run vert mais donnée malade » — notify-ingest-anomaly sur chaque cron d'ingestion", () => {
  // Backlog FINESS phase 2 item 8 : un run `partial` (canary/matview) ou une
  // source TARIE (skips same_checksum au-delà de la cadence) sort en code 0 →
  // invisible du step d'échec. Chaque `ingest-*.yml` DOIT porter la vigie,
  // gardée par success() (jamais « anomalie » sur un run tué) et
  // continue-on-error (jamais re-rouger un cron réussi).
  const NOTIFY_ANOMALY = "./.github/actions/notify-ingest-anomaly";
  const ANOMALY_STEP = "Notify ingest anomaly";
  const ingestWorkflows = workflowFiles.filter((f) => /^ingest-.*\.ya?ml$/.test(f));
  const EXPECTED_SOURCE: Record<string, string> = {
    "ingest-finess.yml": "finess",
    "ingest-ameli.yml": "ameli_ps",
    "ingest-rpps.yml": "rpps",
    "ingest-cds.yml": "cds",
    "ingest-iris.yml": "iris",
  };

  it("les 5 crons d'ingestion sont couverts", () => {
    expect(ingestWorkflows).toEqual(Object.keys(EXPECTED_SOURCE).sort());
  });

  for (const file of ingestWorkflows) {
    it(`${file} : step « ${ANOMALY_STEP} » → composite, if: success(), continue-on-error, source = valeur ingest_log`, () => {
      const src = mustGet(workflows, file);
      const block = stepBlock(src, ANOMALY_STEP);
      expect(block, `${file} : step de vigie introuvable`).not.toBeNull();
      expect(block).toContain(`uses: ${NOTIFY_ANOMALY}`);
      expect(stepIfCondition(src, ANOMALY_STEP)).toBe("success()");
      expect(block).toMatch(/^\s+continue-on-error: true$/m);
      // ⚠️ Ameli logue `ameli_ps` : un slug `ameli` ne matcherait aucune ligne
      // → vigie muette à vie (faux négatif silencieux).
      expect(block).toMatch(new RegExp(`^\\s+source: ${EXPECTED_SOURCE[file]}$`, "m"));
    });
  }

  it("composite : issue d'abord (émetteur unique), email sous always() sauf sur simple COMMENTAIRE (anti fatigue, jamais muet)", () => {
    const action = mustGet(actions, "notify-ingest-anomaly");
    expect(action).toContain(`uses: ${UPSERT_ISSUE}`);
    expect(action).toContain(`uses: ${SEND_EMAIL}`);
    expect(stepIfCondition(action, "Issue — anomalie d'ingestion")).toBe(
      "steps.anomaly.outputs.should_notify == 'true'",
    );
    // `!= 'commented'` et PAS `== 'created'` : une issue en échec (API en panne,
    // step mort → output vide) doit laisser l'email prendre le relais — sinon
    // les deux canaux tombent ensemble.
    const emailIf = stepIfCondition(action, "Email — anomalie d'ingestion");
    expect(emailIf).toMatch(/^always\(\) &&/);
    expect(emailIf).toContain("steps.issue.outputs.outcome != 'commented'");
    expect(emailIf).not.toContain("== 'created'");
    // Le wording ET la clé d'idempotence viennent du script (TS testé).
    for (const key of [
      "should_notify",
      "subject",
      "text",
      "issue_title",
      "issue_body",
      "issue_labels",
    ]) {
      expect(action, `output ${key} non consommé`).toContain(`steps.anomaly.outputs.${key}`);
    }
    expect(action).not.toContain("<<__OPS_EOF__");
    // Crash HORS du script (tsx, OOM) → annotation, pas un step rouge avalé.
    expect(action).toMatch(/run: pnpm notify:ingest-anomaly "\$SOURCE" \|\| echo "::error::/);
  });

  it("package.json expose notify:ingest-anomaly, consommé par la composite", () => {
    const pkg = JSON.parse(readFileSync(join(githubDir, "../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["notify:ingest-anomaly"]).toBe(
      "tsx scripts/ingest/notify-ingest-anomaly.ts",
    );
    expect(mustGet(actions, "notify-ingest-anomaly")).toContain(
      'run: pnpm notify:ingest-anomaly "$SOURCE"',
    );
  });
});

describe("composite upsert-ops-issue — émetteur UNIQUE d'issue idempotente (ouverture ET fermeture)", () => {
  const upsert = mustGet(actions, "upsert-ops-issue");
  const closeScript = mustGet(actionScripts, "upsert-ops-issue/close-ops-issue.cjs");

  it("est le SEUL endroit de .github/ qui liste/commente/ferme une issue (idempotence en un point)", () => {
    expect(upsert).toContain("github.rest.issues.listForRepo");
    expect(upsert).toContain("github.rest.issues.createComment");
    // La fermeture vit dans le .cjs de CETTE MÊME action : l'invariant
    // « un seul fichier de .github/ touche l'API issues en idempotent » tient.
    expect(closeScript).toContain("github.rest.issues.listForRepo");
    for (const [file, src] of [...workflows, ...actions, ...actionScripts]) {
      if (file === "upsert-ops-issue" || file.startsWith("upsert-ops-issue/")) continue;
      expect(
        src,
        `${file} : idempotence d'issue inline — passer par ${UPSERT_ISSUE}`,
      ).not.toContain("listForRepo");
      expect(
        src,
        `${file} : fermeture d'issue inline — passer par ${UPSERT_ISSUE} (action: close)`,
      ).not.toContain("state: 'closed'");
    }
  });

  it("branche `close` : logique dans un .cjs TESTÉ, câblée par un chemin ABSOLU, action inconnue = refus", () => {
    // Le YAML ne fait que router : la logique (filtre labels, PR écartées,
    // commentaire puis fermeture, best-effort) est couverte par
    // `close-ops-issue.test.ts` — un canal d'alerte ne doit pas n'être
    // vérifiable que par assertion textuelle sur du YAML.
    expect(upsert).toMatch(/action:\s*\n\s+description:/);
    expect(upsert).toContain("ACTION_PATH: ${{ github.action_path }}");
    expect(upsert).toContain("require(`${process.env.ACTION_PATH}/close-ops-issue.cjs`)");
    // Fail-loud : une action inconnue ne retombe JAMAIS sur `open` (elle
    // créerait une issue à contretemps), et un require cassé est ::error::.
    expect(upsert).toMatch(/action !== 'open' && action !== 'close'[\s\S]*?core\.error\(/);
    expect(upsert).toMatch(/catch \(err\) \{[\s\S]*?INCHARGEABLE/);
    // Le filtre de labels est la SEULE chose qui empêche de fermer tout le
    // dépôt — et il porte sur les labels NETTOYÉS (`[""]` produirait un filtre
    // vide, cf. `close-ops-issue.test.ts`).
    expect(closeScript).toMatch(/clean\.length === 0[\s\S]*?core\.error\(/);
    expect(closeScript).toMatch(/state: "closed",\n\s+state_reason: "completed"/);
    expect(closeScript).toMatch(/catch \(err\)[\s\S]*core\.warning/);
  });

  it("outcome pessimiste : `failed` par défaut AVANT le try, `commented` / `created` dans les branches", () => {
    expect(upsert).toMatch(/outputs:\s+outcome:/);
    expect(upsert.indexOf("core.setOutput('outcome', 'failed')")).toBeLessThan(
      upsert.indexOf("try {"),
    );
    expect(upsert).toMatch(
      /createComment\(\{[\s\S]*?\}\);\s+core\.setOutput\('outcome', 'commented'\)/,
    );
    expect(upsert).toMatch(
      /issues\.create\(\{[\s\S]*?\}\);\s+core\.setOutput\('outcome', 'created'\)/,
    );
    expect(upsert).toMatch(/catch \(err\)[\s\S]*core\.warning/);
  });

  it("appelant fautif (titre/labels vides) → ::error:: + issue de REPLI, jamais un abandon (doctrine send-ops-email)", () => {
    expect(upsert).toMatch(/if \(labels\.length === 0 \|\| !title\) \{[\s\S]*?core\.error\(/);
    expect(upsert).toContain("labels = ['ops-alert']");
    expect(upsert).toMatch(/title = title \|\| `\[ops\] alerte sans titre/);
    expect(upsert).not.toMatch(/aucune issue créée/);
  });

  it("notify-pending-geocode le consomme aussi : issue sous always() &&, outputs du script (aucun texte composé en YAML)", () => {
    const pending = mustGet(actions, "notify-pending-geocode");
    expect(pending).toContain(`uses: ${UPSERT_ISSUE}`);
    expect(stepIfCondition(pending, "Issue — adresses à géocoder")).toMatch(/^always\(\) &&/);
    expect(stepBlock(pending, "Compose email — adresses à géocoder")).toBeNull();
    for (const key of ["subject", "text", "issue_title", "issue_body", "issue_comment"]) {
      expect(pending).toContain(`steps.pending_geocode.outputs.${key}`);
    }
    expect(pending).not.toContain("<<__OPS_EOF__");
    expect(pending).toMatch(/run: pnpm notify:pending-geocode "\$SOURCE" \|\| echo "::error::/);
  });
});

describe("composites — aucune expression sur un contexte indisponible (job, secrets)", () => {
  // PROUVÉ PROD (run #33960886473, 2026-09-05) : le runner évalue `${{ }}`
  // PARTOUT dans action.yml — `description` d'un input et `script` compris —
  // et le contexte `job` n'existe pas dans une composite → « Unrecognized
  // named-value: 'job' » au CHARGEMENT de l'action → step d'alerte en failure,
  // 0 issue, 0 email. La prose documentaire « passer ${{ job.status }} »
  // suffisait à tuer l'alerte. Même classe pour `secrets` (indisponible aussi).
  for (const [dir, src] of actions) {
    it(`${dir}/action.yml : aucun \$\{\{ job.* \}\} ni \$\{\{ secrets.* \}\}, même en prose`, () => {
      // Scan de l'INTÉRIEUR de chaque expression (pas seulement sa tête) :
      // `${{ inputs.x || job.status }}` casserait le chargement tout pareil.
      for (const [, expr] of src.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
        expect(expr, `${dir} : contexte job/secrets indisponible dans une composite`).not.toMatch(
          /\b(?:job|secrets)\./,
        );
      }
    });
  }
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
    for (const [file, src] of [...workflows, ...actions, ...actionScripts]) {
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

  it("notify-pending-geocode consomme l'émetteur unique email, issue sous always()", () => {
    const pending = mustGet(actions, "notify-pending-geocode");
    expect(pending).toContain(`uses: ${SEND_EMAIL}`);
    expect(pending).toContain("steps.pending_geocode.outputs.subject");
    expect(stepIfCondition(pending, "Issue — adresses à géocoder")).toMatch(/^always\(\) &&/);
  });
});
