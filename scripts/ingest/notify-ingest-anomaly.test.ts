import { describe, expect, it } from "vitest";
import { INGEST_CADENCE, INGEST_SOURCES } from "../../src/storage/ingest-log.js";
import {
  type AnomalyLogRow,
  type HealthyDecision,
  INGEST_ANOMALY_LABEL,
  type NotifiableDecision,
  anomalyOutputs,
  composeAnomalyMessage,
  composeResolutionMessage,
  decideAnomalyNotification,
  headIsForeign,
  parseSourceArg,
} from "./notify-ingest-anomaly.js";
import { CANARY_RPC_ERROR } from "./shared.js";

const NOW = Date.parse("2026-09-06T05:00:00Z");
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

/** Ligne `ingest_log` réaliste : `finished_at` posé, `skip_reason` null par défaut. */
const row = (o: Partial<AnomalyLogRow> & { started_at: string }): AnomalyLogRow => ({
  finished_at: o.started_at,
  status: "success",
  skip_reason: null,
  ...o,
});
const kinds = (d: ReturnType<typeof decideAnomalyNotification>) => d.anomalies.map((a) => a.kind);
const detail = (d: ReturnType<typeof decideAnomalyNotification>, i = 0) =>
  d.anomalies[i]?.detail ?? "";
const notifiable = (d: ReturnType<typeof decideAnomalyNotification>): NotifiableDecision => {
  if (!d.shouldNotify) throw new Error("décision saine");
  return d;
};
const healthy = (d: ReturnType<typeof decideAnomalyNotification>): HealthyDecision => {
  if (!d.healthy) throw new Error("décision non prouvée saine");
  return d;
};

describe("decideAnomalyNotification — run sain", () => {
  it("dernière ingestion réelle dans la cadence → pas d'alerte", () => {
    const d = decideAnomalyNotification("ameli_ps", [row({ started_at: daysAgo(2) })], NOW);
    expect(d.shouldNotify).toBe(false);
    // PROUVÉ sain (une ligne lue, dans la cadence) → autorise la fermeture auto.
    expect(d.healthy).toBe(true);
    expect(d.anomalies).toEqual([]);
    expect(d.dataAgeDays).toBe(2);
    expect(d.expectedMaxAgeDays).toBe(INGEST_CADENCE.ameli_ps.maxAgeDays);
  });

  it("des skips same_checksum RÉCENTS restent normaux (Ameli : 1 semaine sans changement)", () => {
    const d = decideAnomalyNotification(
      "ameli_ps",
      [
        row({ started_at: daysAgo(0), skip_reason: "same_checksum" }),
        row({ started_at: daysAgo(7) }),
      ],
      NOW,
    );
    expect(d.shouldNotify).toBe(false);
    expect(d.skipsSinceLastRealIngest).toBe(1);
    expect(d.dataAgeDays).toBe(7);
  });

  it("aucune ligne → pas d'alerte ; ordre d'entrée indifférent (trié en interne)", () => {
    const empty = decideAnomalyNotification("rpps", [], NOW);
    expect(empty.shouldNotify).toBe(false);
    // Aucune preuve ≠ sain : une vigie aveugle ne doit JAMAIS fermer une issue ouverte.
    expect(empty.healthy).toBe(false);
    const rows = [row({ started_at: daysAgo(60) }), row({ started_at: daysAgo(1) })]; // croissant
    expect(decideAnomalyNotification("rpps", rows, NOW).dataAgeDays).toBe(1);
  });

  it("run failed en tête : saute la branche partial (step échec dédié) mais PAS la branche source tarie", () => {
    const fresh = decideAnomalyNotification(
      "rpps",
      [row({ started_at: daysAgo(0), status: "failed" }), row({ started_at: daysAgo(10) })],
      NOW,
    );
    expect(fresh.shouldNotify).toBe(false);
    const stale = decideAnomalyNotification(
      "rpps",
      [row({ started_at: daysAgo(0), status: "failed" }), row({ started_at: daysAgo(90) })],
      NOW,
    );
    expect(kinds(stale)).toEqual(["stale"]);
  });
});

describe("decideAnomalyNotification — source tarie (post-mortem DREES 2026)", () => {
  it("FINESS : quatre mois de skips verts après la mort du CSV → alerte stale avec âge et compte de skips", () => {
    // Reconstitution : dernière vraie ingestion le 2026-05-15, puis 7 crons
    // bimensuels court-circuités en `success` — le cas exact resté muet.
    const rows = [
      ...[0, 15, 30, 46, 61, 77, 92].map((d) =>
        row({ started_at: daysAgo(d), skip_reason: "same_checksum" }),
      ),
      row({ started_at: daysAgo(114) }),
    ];
    const d = decideAnomalyNotification("finess", rows, NOW);
    expect(kinds(d)).toEqual(["stale"]);
    expect(d.healthy).toBe(false); // à notifier ⇒ jamais « prouvé sain » (pas de fermeture)
    expect(d.dataAgeDays).toBe(114);
    expect(d.skipsSinceLastRealIngest).toBe(7);
    expect(detail(d)).toMatch(/114 jours/);
    expect(detail(d)).toMatch(/au-delà des 30 jours attendus/);
    expect(detail(d)).toMatch(/7 run\(s\) court-circuité\(s\)/);
  });

  it("le seuil est INGEST_CADENCE.maxAgeDays, strictement dépassé (= même constante que data_freshness)", () => {
    for (const source of INGEST_SOURCES) {
      const max = INGEST_CADENCE[source].maxAgeDays;
      const at = decideAnomalyNotification(
        source,
        [
          row({ started_at: daysAgo(0), skip_reason: "same_checksum" }),
          row({ started_at: daysAgo(max) }),
        ],
        NOW,
      );
      expect(at.shouldNotify, `${source} : âge = max ne doit PAS alerter`).toBe(false);
      const over = decideAnomalyNotification(
        source,
        [
          row({ started_at: daysAgo(0), skip_reason: "same_checksum" }),
          row({ started_at: daysAgo(max + 1) }),
        ],
        NOW,
      );
      expect(kinds(over), `${source} : âge = max + 1 doit alerter`).toEqual(["stale"]);
    }
  });

  it("un run `partial` réel compte comme changement de donnée (aligné data_freshness)", () => {
    const d = decideAnomalyNotification(
      "cds",
      [
        row({ started_at: daysAgo(1), skip_reason: "same_checksum" }),
        row({ started_at: daysAgo(8), status: "partial", canary_failures: ["x"] }),
      ],
      NOW,
    );
    expect(d.shouldNotify).toBe(false);
    expect(d.dataAgeDays).toBe(8);
  });

  it("aucune ingestion réelle dans la fenêtre lue → stale (pas un faux « tout va bien »)", () => {
    const rows = [0, 7, 14].map((d) =>
      row({ started_at: daysAgo(d), skip_reason: "same_checksum" }),
    );
    const d = decideAnomalyNotification("ameli_ps", rows, NOW);
    expect(kinds(d)).toEqual(["stale"]);
    expect(detail(d)).toMatch(/aucune ingestion RÉELLE sur les 3 derniers runs \(3 court-circuits/);
  });

  it("horodatage illisible OU dans le futur sur la dernière ingestion réelle → stale, âge inconnu", () => {
    const bad = decideAnomalyNotification(
      "rpps",
      [row({ started_at: "pas-une-date", finished_at: null })],
      NOW,
    );
    expect(kinds(bad)).toEqual(["stale"]);
    expect(bad.dataAgeDays).toBeNull();
    expect(detail(bad)).toMatch(/Horodatage illisible/);
    const future = decideAnomalyNotification("rpps", [row({ started_at: daysAgo(-3) })], NOW);
    expect(kinds(future)).toEqual(["stale"]);
    expect(detail(future)).toMatch(/dans le futur/);
  });
});

describe("decideAnomalyNotification — run partial", () => {
  it("canary manquant → alerte partial listant les clés (éléments NULL du TEXT[] ignorés)", () => {
    const d = decideAnomalyNotification(
      "finess",
      [row({ started_at: daysAgo(0), status: "partial", canary_failures: ["130786049", null] })],
      NOW,
    );
    expect(kinds(d)).toEqual(["partial"]);
    expect(detail(d)).toMatch(/canary manquant après le swap : 130786049\)/);
  });

  it("sentinelle CANARY_RPC_ERROR → « vérification canary indisponible », pas une clé manquante", () => {
    const d = decideAnomalyNotification(
      "iris",
      [row({ started_at: daysAgo(0), status: "partial", canary_failures: [CANARY_RPC_ERROR] })],
      NOW,
    );
    expect(detail(d)).toMatch(/vérification canary indisponible/);
    expect(detail(d)).not.toMatch(/canary manquant/);
  });

  it("canary_failures non tableau (contrat changé) → signalé dans le détail, jamais un TypeError avalé", () => {
    const d = decideAnomalyNotification(
      "iris",
      [row({ started_at: daysAgo(0), status: "partial", canary_failures: { oops: 1 } as never })],
      NOW,
    );
    expect(kinds(d)).toEqual(["partial"]);
    expect(detail(d)).toMatch(/canary_failures illisible \(\{"oops":1\}\)/);
  });

  it("partial sans canary → error_message (matview) ; ni l'un ni l'autre → renvoi vers ingest_log", () => {
    const withMsg = decideAnomalyNotification(
      "rpps",
      [row({ started_at: daysAgo(0), status: "partial", error_message: "rebuild matview 57014" })],
      NOW,
    );
    expect(detail(withMsg)).toMatch(/rebuild matview 57014/);
    const bare = decideAnomalyNotification(
      "rpps",
      [row({ started_at: daysAgo(0), status: "partial" })],
      NOW,
    );
    expect(detail(bare)).toMatch(/détail absent — lire la ligne ingest_log/);
  });

  it("partial ET source tarie → deux anomalies appariées (type + wording) dans une seule décision", () => {
    // Un partial court-circuité est impossible par construction
    // (`shortCircuitIfSameChecksum` pose `success`) ; on force le cas via
    // status partial + skip_reason pour prouver l'accumulation.
    const d = decideAnomalyNotification(
      "finess",
      [
        row({
          started_at: daysAgo(0),
          status: "partial",
          skip_reason: "same_checksum",
          canary_failures: ["k"],
        }),
        row({ started_at: daysAgo(40) }),
      ],
      NOW,
    );
    expect(kinds(d)).toEqual(["partial", "stale"]);
    expect(d.anomalies.map((a) => a.detail.slice(0, 11))).toEqual(["Run PARTIAL", "Source tari"]);
  });
});

describe("decideAnomalyNotification — `healthy` est une PREUVE positive, pas l'absence d'alerte (revue altitude 2026-09-07)", () => {
  it("partial au dernier run RÉEL + skip same_checksum en tête → pas d'alerte (rien re-testé) mais PAS sain : l'issue partial reste ouverte", () => {
    // Un court-circuit écrit `success` + skip_reason sans re-vérifier swap,
    // matview ni canary : fermer l'issue `partial` sur ce run serait un
    // « ✅ résolu » mensonger — la classe de bug que la vigie existe pour tuer.
    const d = decideAnomalyNotification(
      "ameli_ps",
      [
        row({ started_at: daysAgo(0), skip_reason: "same_checksum" }),
        row({ started_at: daysAgo(7), status: "partial", canary_failures: ["130786049"] }),
      ],
      NOW,
    );
    expect(d.shouldNotify).toBe(false);
    expect(d.healthy).toBe(false);
    expect(d.reason).toMatch(/non prouvé sain/i);
  });

  it("failed en tête sur une donnée fraîche → pas d'alerte (step d'échec dédié) mais PAS sain", () => {
    const d = decideAnomalyNotification(
      "rpps",
      [row({ started_at: daysAgo(0), status: "failed" }), row({ started_at: daysAgo(3) })],
      NOW,
    );
    expect(d.shouldNotify).toBe(false);
    expect(d.healthy).toBe(false);
  });

  it("run FORCÉ (FORCE_REINGEST) sur un fichier amont IDENTIQUE → compte comme ingestion réelle (règle data_freshness) mais PAS sain : l'issue stale reste ouverte", () => {
    // `shortCircuitIfSameChecksum(force=true)` ré-ingère le même fichier avec
    // skip_reason NULL : l'âge retombe à 0 sans que la source ait rien publié.
    const d = decideAnomalyNotification(
      "finess",
      [
        row({ started_at: daysAgo(0), forced: true, csv_sha256: "abc" }),
        ...[16, 31].map((n) => row({ started_at: daysAgo(n), skip_reason: "same_checksum" })),
        row({ started_at: daysAgo(46), csv_sha256: "abc" }),
      ],
      NOW,
    );
    expect(d.shouldNotify).toBe(false);
    expect(d.healthy).toBe(false);
    expect(d.reason).toMatch(/forcée.*identique/i);
  });

  it("run FORCÉ sur un fichier identique mais fraîchement republié (3 forçages FINESS du 2026-09-06) → prouvé sain, pas de bruit", () => {
    const d = decideAnomalyNotification(
      "finess",
      [
        row({ started_at: daysAgo(0), forced: true, csv_sha256: "29e2" }),
        row({ started_at: daysAgo(0), forced: true, csv_sha256: "29e2" }),
        row({ started_at: daysAgo(1), forced: true, csv_sha256: "4ed9" }),
      ],
      NOW,
    );
    expect(d.healthy).toBe(true);
  });

  it("run FORCÉ sur un fichier amont DIFFÉRENT (republication) → prouvé sain", () => {
    const d = decideAnomalyNotification(
      "finess",
      [
        row({ started_at: daysAgo(0), forced: true, csv_sha256: "new" }),
        row({ started_at: daysAgo(46), csv_sha256: "abc" }),
      ],
      NOW,
    );
    expect(d.healthy).toBe(true);
  });

  it("ligne de tête venue d'un AUTRE run (audit de ce run perdu) → la preuve n'est pas la nôtre : pas de fermeture", () => {
    const rows = [row({ started_at: daysAgo(0), github_run_url: "https://run/prev" })];
    expect(headIsForeign(rows, "https://run/prev")).toBe(false);
    expect(headIsForeign(rows, "https://run/mine")).toBe(true);
    // Hors Actions (pas d'URL) ou ligne sans URL : indécidable → pas étranger.
    expect(headIsForeign(rows, undefined)).toBe(false);
    expect(headIsForeign([row({ started_at: daysAgo(0) })], "https://run/mine")).toBe(false);
    expect(headIsForeign([], "https://run/mine")).toBe(false);
  });

  it("ingestion réelle fraîche en tête après un partial ancien → prouvé sain : la fermeture est légitime", () => {
    const d = decideAnomalyNotification(
      "ameli_ps",
      [row({ started_at: daysAgo(0) }), row({ started_at: daysAgo(7), status: "partial" })],
      NOW,
    );
    expect(d.shouldNotify).toBe(false);
    expect(d.healthy).toBe(true);
  });
});

describe("anomalyOutputs — contrat $GITHUB_OUTPUT lu par la composite (côté PRODUCTEUR)", () => {
  const RUN = "https://run/9";
  const stale = decideAnomalyNotification("cds", [row({ started_at: daysAgo(21) })], NOW);
  const sane = decideAnomalyNotification("cds", [row({ started_at: daysAgo(2) })], NOW);
  const blind = decideAnomalyNotification("cds", [], NOW);
  const unproven = decideAnomalyNotification(
    "cds",
    [
      row({ started_at: daysAgo(0), skip_reason: "same_checksum" }),
      row({ started_at: daysAgo(7), status: "partial" }),
    ],
    NOW,
  );

  it("les trois classes de décision → trois formes ; should_notify et should_close JAMAIS vrais ensemble", () => {
    for (const d of [stale, sane, blind, unproven]) {
      // Le type rend déjà le double `true` non représentable (TS2367 si comparé
      // directement) ; on le re-vérifie au runtime, hors typage, par précaution.
      const o: Record<string, string> = anomalyOutputs("cds", d, RUN);
      expect(o.should_notify === "true" && o.should_close === "true").toBe(false);
    }
    expect(anomalyOutputs("cds", stale, RUN)).toMatchObject({
      should_notify: "true",
      should_close: "false",
    });
    expect(anomalyOutputs("cds", sane, RUN)).toMatchObject({
      should_notify: "false",
      should_close: "true",
    });
    expect(anomalyOutputs("cds", blind, RUN)).toEqual({
      should_notify: "false",
      should_close: "false",
    });
    expect(anomalyOutputs("cds", unproven, RUN)).toEqual({
      should_notify: "false",
      should_close: "false",
    });
    // Preuve ÉTRANGÈRE : alerter oui, fermer jamais.
    expect(anomalyOutputs("cds", sane, RUN, true)).toEqual({
      should_notify: "false",
      should_close: "false",
    });
    expect(anomalyOutputs("cds", stale, RUN, true)).toMatchObject({ should_notify: "true" });
  });

  it("clés écrites = clés lues par la composite (un renommage côté TS rendrait la fermeture muette)", () => {
    const notify = anomalyOutputs("cds", stale, RUN);
    const close = anomalyOutputs("cds", sane, RUN);
    expect(Object.keys(notify).sort()).toEqual([
      "issue_body",
      "issue_labels",
      "issue_title",
      "should_close",
      "should_notify",
      "subject",
      "text",
    ]);
    expect(Object.keys(close).sort()).toEqual([
      "close_comment",
      "close_labels",
      "should_close",
      "should_notify",
    ]);
    if (close.should_close !== "true") throw new Error("attendu should_close");
    expect(close.close_labels).toBe(`${INGEST_ANOMALY_LABEL},cds`);
    expect(close.close_comment).toContain(RUN);
  });
});

describe("composeResolutionMessage — fermeture automatique au premier run sain (#82/#83, 2026-09-07)", () => {
  it("clé de fermeture = ingest-anomaly,<slug> SANS type : un run sain résout stale, partial et l'escalade partial+stale", () => {
    const d = healthy(
      decideAnomalyNotification("ameli_ps", [row({ started_at: daysAgo(2) })], NOW),
    );
    const done = composeResolutionMessage("ameli_ps", d, "https://run/1");
    expect(done.closeLabels).toBe(`${INGEST_ANOMALY_LABEL},ameli`);
    // Sous-ensemble strict des labels posés à l'ouverture (sémantique ET de l'API GitHub).
    const opened = composeAnomalyMessage(
      "ameli_ps",
      notifiable(decideAnomalyNotification("ameli_ps", [row({ started_at: daysAgo(30) })], NOW)),
      "https://run/0",
    );
    for (const l of done.closeLabels.split(",")) expect(opened.issueLabels.split(",")).toContain(l);
    // Pour TOUTES les sources : un slug hors [a-z0-9-] (espace, virgule) ferait un
    // filtre qui ne matche rien → `absent` nominal → issue ouverte à vie en silence.
    for (const source of INGEST_SOURCES) {
      const labels = composeResolutionMessage(source, d, "https://run/1").closeLabels.split(",");
      expect(labels).toHaveLength(2);
      for (const l of labels) expect(l).toMatch(/^[a-z0-9-]+$/);
    }
    expect(done.closeComment).toContain("ameli_ps");
    expect(done.closeComment).toContain("run sain");
    expect(done.closeComment).toContain("https://run/1");
  });
});

describe("composeAnomalyMessage — wording unique email + issue, décision À NOTIFIER seulement", () => {
  const stale = notifiable(
    decideAnomalyNotification(
      "finess",
      [
        ...[0, 15, 30].map((d) => row({ started_at: daysAgo(d), skip_reason: "same_checksum" })),
        row({ started_at: daysAgo(45) }),
      ],
      NOW,
    ),
  );
  const msg = composeAnomalyMessage("finess", stale, "https://run/1");

  it("sujet, corps, issue et labels nomment la source, le type et le run", () => {
    expect(msg.subject).toBe("[france-data-mcp] FINESS : ⏳ source TARIE");
    expect(msg.issueTitle).toBe("[ingest-anomaly] FINESS : ⏳ source TARIE");
    expect(msg.text).toContain("ingest_log.source='finess'");
    expect(msg.text).toContain("https://run/1");
    expect(msg.issueBody).toContain("idempotente");
    expect(msg.issueBody).toContain(stale.anomalies[0].detail);
    // Clé d'idempotence : slug minuscule (même vocabulaire que les labels
    // `ingestion-failure,ameli` / `pending-geocode,ameli`) + type d'anomalie.
    expect(msg.issueLabels).toBe("ingest-anomaly,finess,stale");
  });

  it("partial + stale → les deux drapeaux dans le sujet et les deux types dans les labels (escalade = nouvelle issue)", () => {
    const both = notifiable(
      decideAnomalyNotification(
        "ameli_ps",
        [
          row({
            started_at: daysAgo(0),
            status: "partial",
            skip_reason: "same_checksum",
            canary_failures: ["k"],
          }),
          row({ started_at: daysAgo(40) }),
        ],
        NOW,
      ),
    );
    const m = composeAnomalyMessage("ameli_ps", both, "https://run/2");
    expect(m.subject).toBe("[france-data-mcp] Ameli : ⚠️ run PARTIAL + ⏳ source TARIE");
    expect(m.issueLabels).toBe("ingest-anomaly,ameli,partial,stale");
    expect(m.issueBody.match(/^- /gm)).toHaveLength(2);
  });
});

describe("parseSourceArg — valeurs RÉELLES de ingest_log.source", () => {
  it("accepte les 5 sources d'INGEST_SOURCES (ameli_ps, pas ameli)", () => {
    for (const s of INGEST_SOURCES) expect(parseSourceArg(["node", "x", s])).toBe(s);
  });
  it("rejette une source inconnue ou absente (ameli = faux négatif silencieux sinon)", () => {
    expect(() => parseSourceArg(["node", "x", "ameli"])).toThrow(/usage/);
    expect(() => parseSourceArg(["node", "x"])).toThrow(/usage/);
  });
});
