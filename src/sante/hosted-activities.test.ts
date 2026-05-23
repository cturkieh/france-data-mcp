import { describe, expect, it, vi } from "vitest";

import * as supabaseModule from "../storage/supabase.js";
import {
  HOSTED_ACTIVITY_NOTES,
  type HostedActivity,
  familleToHostedActivity,
  getHostedActivitiesInRadius,
  getHostedActivitiesInZone,
} from "./hosted-activities.js";

describe("familleToHostedActivity", () => {
  it("mappe labo → biologie", () => {
    expect(familleToHostedActivity("labo")).toBe("biologie");
  });
  it("mappe pharmacie → pharmacie", () => {
    expect(familleToHostedActivity("pharmacie")).toBe("pharmacie");
  });
  it("mappe imagerie → imagerie", () => {
    expect(familleToHostedActivity("imagerie")).toBe("imagerie");
  });
  it("retourne null pour les familles sans activité hébergée pertinente", () => {
    expect(familleToHostedActivity("ehpad")).toBeNull();
    expect(familleToHostedActivity("mco")).toBeNull();
    expect(familleToHostedActivity("ssr")).toBeNull();
  });
});

describe("HOSTED_ACTIVITY_NOTES", () => {
  it("expose un libellé d'activité + une note pour chaque activité", () => {
    const activites: HostedActivity[] = ["biologie", "pharmacie", "imagerie"];
    for (const a of activites) {
      const entry = HOSTED_ACTIVITY_NOTES[a];
      expect(entry.activite_libelle.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(50);
      expect(entry.note).toMatch(/[Nn]e pas additionner|distinct/i);
    }
  });
  it("biologie mentionne EFS et l'absence d'accès ambulatoire", () => {
    expect(HOSTED_ACTIVITY_NOTES.biologie.note).toMatch(/EFS|transfusion/);
    expect(HOSTED_ACTIVITY_NOTES.biologie.note).toMatch(/ambulatoire/);
  });
  it("pharmacie mentionne PUI et l'absence d'accès grand public", () => {
    expect(HOSTED_ACTIVITY_NOTES.pharmacie.note).toMatch(/PUI/);
    expect(HOSTED_ACTIVITY_NOTES.pharmacie.note).toMatch(/grand public/);
  });
  it("imagerie mentionne l'accès ambulatoire et la catégorie 619 peu peuplée", () => {
    expect(HOSTED_ACTIVITY_NOTES.imagerie.note).toMatch(/ambulatoire/);
    expect(HOSTED_ACTIVITY_NOTES.imagerie.note).toMatch(/peu peuplée|cabinet d.imagerie/);
  });
});

// Le module utilise `getUntypedAnonClient` (pattern aligné sur `countFiness` :
// les RPCs `finess_hosted_activities_*` viennent d'être créées et ne sont pas
// encore dans `src/storage/supabase-types.ts`).
describe("getHostedActivitiesInRadius", () => {
  it("retourne count + sample borné + truncated true quand sample < count", async () => {
    vi.spyOn(supabaseModule, "getUntypedAnonClient").mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            total_count: 12,
            num_finess: "590048468",
            raison_sociale: "CENTRE DE BIOLOGIE PATHOLOGIE",
            categorie_code: "101",
            categorie_libelle: "C.H.R.",
          },
          {
            total_count: 12,
            num_finess: "590000105",
            raison_sociale: "CHR LILLE",
            categorie_code: "101",
            categorie_libelle: "C.H.R.",
          },
        ],
        error: null,
      }),
    } as unknown as ReturnType<typeof supabaseModule.getUntypedAnonClient>);
    const r = await getHostedActivitiesInRadius({
      activite: "biologie",
      center: { lat: 50.63, lon: 3.06 },
      radiusKm: 5,
    });
    expect(r.activite).toBe("biologie médicale");
    expect(r.count).toBe(12);
    expect(r.truncated).toBe(true);
    expect(r.sites_apercu.length).toBeLessThanOrEqual(5);
    expect(r.note).toMatch(/Plateaux techniques/);
  });

  it("count=0 → sites_apercu vide, truncated false", async () => {
    vi.spyOn(supabaseModule, "getUntypedAnonClient").mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as ReturnType<typeof supabaseModule.getUntypedAnonClient>);
    const r = await getHostedActivitiesInRadius({
      activite: "biologie",
      center: { lat: 48.85, lon: 2.35 },
      radiusKm: 5,
    });
    expect(r.count).toBe(0);
    expect(r.sites_apercu).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});

describe("getHostedActivitiesInZone", () => {
  it("throw si ni departement ni codeInsee", async () => {
    await expect(getHostedActivitiesInZone({ activite: "biologie" })).rejects.toThrow(/requis/);
  });
});
