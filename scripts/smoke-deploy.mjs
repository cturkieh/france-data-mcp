#!/usr/bin/env node
/**
 * Smoke post-deploy HTTP de france-data-mcp (prod par défaut).
 *
 * Usage :
 *   node scripts/smoke-deploy.mjs [baseUrl] [expectedVersion]
 *   defaults : https://france-data-mcp.vercel.app   0.27.0
 *
 * Sort en code 1 si un GATE échoue (CI-friendly). Les valeurs INFO ne gatent jamais.
 *
 * Gates (cible V0.27.0 — commune résolue par frontières sur site isolé) :
 *   1. /healthz .version === expectedVersion
 *   2. IMMO La Hague (site isolé/littoral) : couverture.permis === "ok"
 *      ∧ meta.code_commune === "50041" ∧ meta.commune === "La Hague"
 *   3. SANTÉ coverage La Hague : HTTP 200 SANS erreur -32602 (département dérivable)
 *   4. Garde-fou anti-régression MER (point réellement en mer, pas de commune) :
 *      IMMO → couverture.permis commence par "indisponible:" (200, jamais throw)
 *      SANTÉ → erreur JSON-RPC -32602 (RangeError "déduire le département" attendu)
 *
 * Pourquoi le gate IMMO est `couverture.permis === "ok"` et NON `logements > 0` :
 *   `runSection` (panorama-implantation.ts) expose "ok" dès que Sit@del répond
 *   sans throw ; `permitsForCommune` ne throw JAMAIS sur 0 logement. Le compte
 *   peut donc valoir 0 LÉGITIMEMENT avec permis="ok" — prouvé sur DiDo :
 *   Fleury-devant-Douaumont (55189) a des lignes Sit@del mais 0 logement autorisé
 *   sur 5 ans. Coupler le gate au compte = faux négatif sur une fenêtre creuse.
 *   Le compte (148 pour La Hague aujourd'hui) voyage donc en INFO, jamais en gate.
 *
 * Pourquoi les params santé sont `{lat, lon, radius_km, naf}` et NON
 * `{center:{…}, radiusKm}` : le boundary MCP (api/tools.ts) expose
 *   {lon, lat, radius_km, naf} (required: lon, lat, naf) ; `{center, radiusKm}`
 *   est la signature de la LIB interne (CoverageInput) → -32602 "lon (number)
 *   requis", indiscernable du bug testé. Prouvé prod 2026-06-07.
 */

const BASE = process.argv[2] ?? "https://france-data-mcp.vercel.app";
const EXPECTED_VERSION = process.argv[3] ?? "0.27.0";

// Point du smoke : usine Orano / commune de La Hague (50041), sans adresse proche.
const LA_HAGUE = { lat: 49.6546, lon: -1.8214 };
// Point réellement en mer (au nord des îles anglo-normandes) : aucune commune.
const EN_MER = { lat: 49.9, lon: -2.2 };

let failures = 0;
const gate = (ok, label, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const info = (label, detail) => console.log(`   ℹ️  ${label}: ${detail}`);

/** Appel JSON-RPC tools/call. Retourne { error?, result? } (result déjà JSON-parsé). */
async function mcpCall(name, args) {
  const resp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await resp.text();
  // Tolère SSE (event:/data:) ou JSON pur.
  const jsonText = raw.includes("data:")
    ? raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
    : raw;
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return {
      httpStatus: resp.status,
      error: { code: 0, message: `réponse non-JSON: ${raw.slice(0, 120)}` },
    };
  }
  if (payload.error) return { httpStatus: resp.status, error: payload.error };
  const text = payload.result?.content?.[0]?.text;
  return { httpStatus: resp.status, result: text ? JSON.parse(text) : payload.result };
}

console.log(
  `=== Smoke post-deploy france-data-mcp ===\nbase=${BASE}  attendu=v${EXPECTED_VERSION}\n`,
);

// --- Gate 1 : version déployée ---
try {
  const hz = await (await fetch(`${BASE}/healthz`)).json();
  gate(
    hz.version === EXPECTED_VERSION,
    "version déployée",
    `attendu=${EXPECTED_VERSION} obtenu=${hz.version}`,
  );
} catch (e) {
  gate(false, "version déployée", `/healthz inatteignable: ${e.message}`);
}

// --- Gate 2 : IMMO permis récupérés sur site isolé (La Hague) ---
console.log("\n--- IMMO dynamique_immobiliere (La Hague, site isolé) ---");
{
  const r = await mcpCall("dynamique_immobiliere", { ...LA_HAGUE, rayon_km: 5 });
  if (r.error) {
    gate(false, "immo La Hague", `erreur JSON-RPC ${r.error.code} "${r.error.message}"`);
  } else {
    const permis = r.result?.couverture?.permis;
    const cc = r.result?.meta?.code_commune;
    const com = r.result?.meta?.commune;
    gate(permis === "ok", "permis Sit@del servis", `couverture.permis="${permis}"`);
    gate(
      cc === "50041" && com === "La Hague",
      "commune résolue par frontières",
      `code=${cc} nom="${com}"`,
    );
    info(
      "logements_autorises_recent (INFO, non gaté)",
      String(r.result?.note?.logements_autorises_recent),
    );
  }
}

// --- Gate 3 : SANTÉ coverage ne plante plus (La Hague) ---
console.log("\n--- SANTÉ finess_sirene_coverage_in_radius (La Hague) ---");
{
  const r = await mcpCall("finess_sirene_coverage_in_radius", {
    ...LA_HAGUE,
    radius_km: 5,
    naf: "8690B",
  });
  const isDeptError =
    r.error?.code === -32602 && /déduire le département/i.test(r.error?.message ?? "");
  gate(
    !r.error,
    "coverage 200 sans RangeError",
    r.error ? `erreur ${r.error.code} "${r.error.message}"` : `HTTP ${r.httpStatus}`,
  );
  if (isDeptError) info("→ département non dérivé (fix non déployé ?)", r.error.message);
  if (!r.error)
    info(
      "finess_sites / sirene_sirets (INFO)",
      `${r.result?.finess_sites} / ${r.result?.sirene_sirets}`,
    );
}

// --- Gate 4 : garde-fou anti-régression MER (le filet ne doit pas sauter) ---
console.log("\n--- GARDE-FOU MER (49.90,-2.20 — doit TOUJOURS dégrader proprement) ---");
{
  const immo = await mcpCall("dynamique_immobiliere", { ...EN_MER, rayon_km: 5 });
  const permisMer = immo.result?.couverture?.permis;
  gate(
    !immo.error && typeof permisMer === "string" && permisMer.startsWith("indisponible:"),
    "immo mer → permis dégradé (200, pas de throw)",
    immo.error ? `erreur ${immo.error.code}` : `permis="${permisMer}"`,
  );
  const cov = await mcpCall("finess_sirene_coverage_in_radius", {
    ...EN_MER,
    radius_km: 5,
    naf: "8690B",
  });
  gate(
    cov.error?.code === -32602,
    "santé mer → -32602 attendu (RangeError mappé)",
    cov.error ? `code=${cov.error.code}` : "PAS d'erreur (régression !)",
  );
}

console.log(`\n=== ${failures === 0 ? "✅ SMOKE OK" : `❌ ${failures} GATE(S) EN ÉCHEC`} ===`);
process.exit(failures === 0 ? 0 : 1);
