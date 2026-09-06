import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEASURE_UNAVAILABLE_LABEL,
  PENDING_GEOCODE_LABEL,
  composePendingMessage,
  decidePendingNotification,
  parseSourceArg,
} from "./notify-pending-geocode.js";

describe("decidePendingNotification", () => {
  it("alerte sur une vraie ingestion avec des adresses en attente", () => {
    const d = decidePendingNotification({
      status: "success",
      skip_reason: null,
      ban_to_geocode_distinct: 1234,
    });
    expect(d.shouldNotify).toBe(true);
    expect(d.pending).toBe(1234);
  });

  it("réalisme PostgREST : BIGINT sérialisé en STRING est coercé, pas concaténé", () => {
    // PostgREST renvoie les BIGINT en string (gotcha projet). La prod donne
    // "1234", pas 1234 — un mock qui n'injecte qu'un number masquerait le bug.
    const d = decidePendingNotification({
      status: "success",
      skip_reason: null,
      ban_to_geocode_distinct: "1234",
    });
    expect(d.shouldNotify).toBe(true);
    expect(d.pending).toBe(1234);
    expect(typeof d.pending).toBe("number");
  });

  it("anti-spam : court-circuit même fichier (same_checksum) → pas d'alerte malgré pending>0", () => {
    const d = decidePendingNotification({
      status: "success",
      skip_reason: "same_checksum",
      ban_to_geocode_distinct: "5000",
    });
    expect(d.shouldNotify).toBe(false);
    expect(d.pending).toBe(5000);
    expect(d.reason).toContain("court-circuit");
  });

  it("aucune adresse en attente (0) → pas d'alerte", () => {
    const d = decidePendingNotification({
      status: "success",
      skip_reason: null,
      ban_to_geocode_distinct: "0",
    });
    expect(d.shouldNotify).toBe(false);
    expect(d.pending).toBe(0);
  });

  it("run failed → pas d'alerte (couverte par le step échec dédié)", () => {
    const d = decidePendingNotification({
      status: "failed",
      skip_reason: null,
      ban_to_geocode_distinct: "999",
    });
    expect(d.shouldNotify).toBe(false);
    expect(d.reason).toContain("failed");
  });

  it("C1 : mesure absente (null) sur un run RÉUSSI → alerte DÉGRADÉE, jamais un faux 'tout va bien'", () => {
    // Régression silent-failure-hunter : null = RPC de mesure échouée en amont,
    // PAS un vrai 0. Le blanchir en 0 masquerait une mesure cassée durablement.
    const d = decidePendingNotification({
      status: "success",
      skip_reason: null,
      ban_to_geocode_distinct: null,
    });
    expect(d.shouldNotify).toBe(true);
    expect(d.measurementUnavailable).toBe(true);
    expect(d.pending).toBe(0);
    expect(d.reason).toContain("indisponible");
  });

  it("C1 : valeur corrompue non numérique sur un run réussi → alerte dégradée", () => {
    const d = decidePendingNotification({
      status: "success",
      skip_reason: null,
      ban_to_geocode_distinct: "N/A",
    });
    expect(d.shouldNotify).toBe(true);
    expect(d.measurementUnavailable).toBe(true);
    expect(d.pending).toBe(0);
    expect(d.reason).toContain("indisponible");
  });

  it("anti-spam prime sur mesure absente : null + same_checksum → pas d'alerte", () => {
    // Un court-circuit ne pose aucune adresse : pas d'alerte même si la mesure
    // est null (pas une anomalie actionnable sur un run sans ingestion).
    const d = decidePendingNotification({
      status: "success",
      skip_reason: "same_checksum",
      ban_to_geocode_distinct: null,
    });
    expect(d.shouldNotify).toBe(false);
    expect(d.measurementUnavailable).toBeUndefined();
  });

  it("aucune ligne ingest_log → pas d'alerte", () => {
    const d = decidePendingNotification(null);
    expect(d.shouldNotify).toBe(false);
    expect(d.reason).toContain("aucune ligne");
  });
});

describe("parseSourceArg", () => {
  it("accepte rpps et ameli", () => {
    expect(parseSourceArg(["node", "script", "rpps"])).toBe("rpps");
    expect(parseSourceArg(["node", "script", "ameli"])).toBe("ameli");
  });

  it("rejette une source inconnue ou absente", () => {
    expect(() => parseSourceArg(["node", "script", "finess"])).toThrow(/usage/);
    expect(() => parseSourceArg(["node", "script"])).toThrow(/usage/);
  });
});

describe("wording de l'alerte (reframe : drain BAN automatisé) — composé en TS, plus dans le YAML", () => {
  // Garde-fou de CONTENU sur le texte rendu. Depuis l'auto-trigger `workflow_run`
  // (PR #53/#54), le re-géocodage tourne tout seul : l'alerte ne doit PLUS
  // réclamer une action manuelle — ce serait une consigne fausse. Re-introduire
  // ce wording rallume le bruit trompeur fermé ici (cf. issue #52).
  const normal = composePendingMessage(
    "ameli",
    { shouldNotify: true, pending: 1234, reason: "x" },
    "https://run/1",
  );
  const degraded = composePendingMessage(
    "rpps",
    { shouldNotify: true, pending: 0, measurementUnavailable: true, reason: "x" },
    "https://run/2",
  );
  const all = [normal, degraded].flatMap((m) => Object.values(m)).join("\n");
  const actionYml = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../.github/actions/notify-pending-geocode/action.yml",
    ),
    "utf8",
  );

  it("n'instruit PLUS de lancer le backfill à la main (texte rendu ET YAML)", () => {
    for (const src of [all, actionYml]) {
      expect(src).not.toContain("lancer manuellement");
      expect(src).not.toContain("node scripts/ban-backfill.mjs");
      expect(src).not.toContain("En attendant l'automatisation");
      expect(src).not.toContain("backlog P1");
      expect(src).not.toContain("à géocoder manuellement");
    }
  });

  it("cadre le résidu normal comme géocodé automatiquement (drain workflow_run), libellé source lisible", () => {
    expect(normal.subject).toBe(
      "[france-data-mcp] Ameli : 1234 adresses en attente de géocodage auto",
    );
    expect(normal.text.toLowerCase()).toContain("automatiquement");
    expect(normal.text).toContain("Aucune action");
    expect(normal.issueBody).toContain("workflow_run");
    expect(normal.issueBody).toContain("ban-backfill-ameli.yml");
    expect(normal.issueComment).toContain("**1234**");
    expect(normal.issueTitle).toBe(
      "[pending-geocode] Ameli : adresses en attente de géocodage automatique",
    );
  });

  it("mesure indisponible : message DÉGRADÉ, jamais « 0 adresses »", () => {
    expect(degraded.subject).toContain("⚠️ mesure des adresses à géocoder indisponible");
    expect(degraded.text).toContain("Comptage INCONNU");
    expect(degraded.text).not.toContain("0 adresses");
    expect(degraded.issueComment).toContain("INDISPONIBLE");
  });

  it("le YAML ne compose plus aucun texte NI les labels : il transporte les outputs du script", () => {
    expect(actionYml).not.toContain("<<__OPS_EOF__");
    for (const key of [
      "subject",
      "text",
      "issue_title",
      "issue_body",
      "issue_comment",
      "issue_labels",
    ]) {
      expect(actionYml).toContain(`steps.pending_geocode.outputs.${key}`);
    }
    // Les labels ne doivent PLUS être écrits en dur dans le YAML : c'est la
    // décision (informatif vs dégradé) qui choisit le registre.
    expect(actionYml).not.toContain("labels: pending-geocode,${{ inputs.source }}");
  });

  it("DEUX registres de labels : le drain BAN ne peut refermer QUE l'informatif", () => {
    // Un drain réussi ne dit RIEN de l'état de la RPC de mesure : fermer
    // l'alerte dégradée sur ce signal, c'est perdre la seule alerte
    // actionnable du canal (revue 2026-09-06). Le filtre `labels` de l'API
    // étant un ET, il ne suffit PAS d'ajouter un label au registre dégradé :
    // son label PRIMAIRE doit différer.
    expect(normal.issueLabels).toEqual([PENDING_GEOCODE_LABEL, "ameli"]);
    expect(degraded.issueLabels).toEqual([MEASURE_UNAVAILABLE_LABEL, "rpps"]);
    expect(MEASURE_UNAVAILABLE_LABEL).not.toBe(PENDING_GEOCODE_LABEL);
    // Le filtre de fermeture du drain (`pending-geocode,<source>`) ne doit
    // matcher AUCUN label du registre dégradé.
    expect(degraded.issueLabels).not.toContain(PENDING_GEOCODE_LABEL);
  });
});
