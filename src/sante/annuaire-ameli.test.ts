import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfessionnels, streamProfessionnels } from "./annuaire-ameli.js";

const FIXTURE_HEADER = [
  "ps_activite_nom",
  "ps_activite_prenom",
  "ps_activite_civilite",
  "specialite_code",
  "specialite_libelle",
  "type_ps_code",
  "type_ps_libelle",
  "coordonnees_voie",
  "coordonnees_code_postal",
  "coordonnees_ville",
  "secteur_conventionnel_code",
  "secteur_conventionnel_libelle",
  "nature_exercice_libelle",
].join(";");

function fixtureCsv(): string {
  const lines = [
    FIXTURE_HEADER,
    "DUPONT;Jean;Dr;1000;Médecin généraliste;1;Médecin;10 Rue Foch;08000;Charleville-Mézières;1;Secteur 1;Libéral",
    "MARTIN;Sophie;Dr;1010;Cardiologue;1;Médecin;5 Avenue de Paris;08000;Charleville-Mézières;2;Secteur 2;Libéral",
    "PETIT;Lucie;Mme;5000;Infirmière;5;IDE;3 Rue Bayard;51100;Reims;NC;Non conventionné;Libéral",
    "LEFEVRE;Paul;Dr;1000;Médecin généraliste;1;Médecin;1 Place du Marché;75001;Paris;1;Secteur 1;Libéral",
  ];
  return lines.join("\n");
}

async function makeFixture(): Promise<string> {
  const tmpFile = join(tmpdir(), `ameli-test-${Date.now()}-${Math.random()}.csv`);
  await writeFile(tmpFile, fixtureCsv(), "utf-8");
  return tmpFile;
}

describe("streamProfessionnels", () => {
  it("yield tous les PS du fixture", async () => {
    const csvPath = await makeFixture();
    const all: string[] = [];
    for await (const ps of streamProfessionnels({ csvPath })) {
      all.push(`${ps.nom} ${ps.prenom}`);
    }
    expect(all).toEqual(["DUPONT Jean", "MARTIN Sophie", "PETIT Lucie", "LEFEVRE Paul"]);
  });

  it("filtre par préfixe code postal (département 08)", async () => {
    const csvPath = await makeFixture();
    const result = await loadProfessionnels({ csvPath, codePostalPrefix: "08" });
    expect(result.map((p) => p.nom)).toEqual(["DUPONT", "MARTIN"]);
  });

  it("filtre par spécialité (insensible à la casse, contient)", async () => {
    const csvPath = await makeFixture();
    const result = await loadProfessionnels({ csvPath, specialite: "généraliste" });
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.specialiteLibelle === "Médecin généraliste")).toBe(true);
  });

  it("filtre par secteur conventionnel exact", async () => {
    const csvPath = await makeFixture();
    const result = await loadProfessionnels({ csvPath, secteurConventionnel: "1" });
    expect(result.map((p) => p.nom).sort()).toEqual(["DUPONT", "LEFEVRE"]);
  });

  it("respecte la limite et arrête le stream", async () => {
    const csvPath = await makeFixture();
    const result = await loadProfessionnels({ csvPath, limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("combine plusieurs filtres", async () => {
    const csvPath = await makeFixture();
    const result = await loadProfessionnels({
      csvPath,
      codePostalPrefix: "08",
      specialite: "cardiologue",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.nom).toBe("MARTIN");
  });
});
