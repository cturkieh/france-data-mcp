import { describe, expect, it } from "vitest";
import { decidePendingNotification, parseSourceArg } from "./notify-pending-geocode.js";

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
