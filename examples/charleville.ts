/**
 * Exemple Charleville-Mézières — premier cas de référence pour valider la lib.
 *
 * Lance avec : pnpm tsx examples/charleville.ts
 *
 * Ce script fait de VRAIS appels aux API publiques (pas de mock).
 * Tu dois être connecté à internet et tomber sur des données récentes.
 */

import { geocode, reverseGeocode, searchCommunes } from "../src/territoire/index.js";

async function main() {
  console.log("=== Étape 1 — recherche de la commune ===");
  const villes = await searchCommunes({
    nom: "Charleville",
    boostPopulation: true,
    limit: 3,
  });
  console.log(`Trouvé ${villes.length} commune(s) :`);
  for (const v of villes) {
    console.log(
      `  - ${v.nom} (INSEE ${v.code}, ${v.codesPostaux.join("/")}, ${v.population ?? "?"} hab.)`,
    );
  }

  const charleville = villes[0];
  if (!charleville?.centre) {
    console.error("Pas de centre pour Charleville, on s'arrête.");
    return;
  }

  console.log("\n=== Étape 2 — géocodage d'une adresse précise ===");
  const adresse = "64 Cours Aristide Briand 08000 Charleville-Mézières";
  const point = await geocode(adresse);
  if (!point) {
    console.error("Adresse non géocodée");
    return;
  }
  console.log(
    `  ${adresse}\n  → lon=${point.point.lon.toFixed(5)} lat=${point.point.lat.toFixed(5)} score=${point.score.toFixed(2)} type=${point.type}`,
  );

  console.log("\n=== Étape 3 — géocodage inverse depuis ce point ===");
  const inverse = await reverseGeocode(point.point);
  console.log(`  ${inverse?.label ?? "(rien)"}`);

  console.log("\n✅ OK — la chaîne de base territoire fonctionne.");
}

main().catch((err) => {
  console.error("❌ Échec :", err);
  process.exitCode = 1;
});
