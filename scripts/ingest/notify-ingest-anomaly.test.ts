import { describe, expect, it } from "vitest";
import { INGEST_CADENCE, INGEST_SOURCES } from "../../src/storage/ingest-log.js";
import {
  type AnomalyLogRow,
  type NotifiableDecision,
  composeAnomalyMessage,
  decideAnomalyNotification,
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

describe("decideAnomalyNotification — run sain", () => {
  it("dernière ingestion réelle dans la cadence → pas d'alerte", () => {
    const d = decideAnomalyNotification("ameli_ps", [row({ started_at: daysAgo(2) })], NOW);
    expect(d.shouldNotify).toBe(false);
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
    expect(decideAnomalyNotification("rpps", [], NOW).shouldNotify).toBe(false);
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
