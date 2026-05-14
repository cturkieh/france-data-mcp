/**
 * Endpoint `/healthz` — état de configuration du serveur MCP.
 *
 * Expose uniquement des booléens indiquant si chaque dépendance est configurée
 * (token présent / non vide). Aucune valeur d'env var n'est leakée dans le
 * body.
 *
 * Sémantique de `status` :
 *  - `"ok"` : toutes les dépendances *critiques* (Supabase, IP salt) sont
 *    configurées. Le serveur peut servir les tools.
 *  - `"degraded"` : une dépendance critique est manquante (Supabase down →
 *    tools santé tous KO ; IP salt manquant → RGPD non tenu). Le HTTP code
 *    reste 200 pour ne pas casser Smithery / registries, mais un monitor
 *    qui check `status === "ok"` doit alerter.
 *  - Les dépendances non-critiques (Axiom, Sentry, INSEE, ANS, Upstash)
 *    peuvent être absentes sans dégrader le statut — elles déclenchent
 *    leurs propres warns one-shot via `captureMcpConfigWarning`.
 *
 * Aucune auth, pas de rate limit : info publique, utilisée par Smithery,
 * Uptime Kuma, Better Stack, etc.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAxiomHost } from "./_lib/observability.js";
import { VERSION } from "../src/core/version.js";

/** `"ok"` quand toutes les dépendances critiques sont OK, `"degraded"` sinon. */
export type HealthStatus = "ok" | "degraded";

/**
 * Shape stable consommable par un monitor externe (Uptime Kuma, Better Stack,
 * Smithery). Chaque sous-objet expose des booléens — jamais la valeur d'env.
 * `axiom.host` est l'info publique utile (US vs EU) sans secret.
 */
export type HealthConfig = {
  axiom: { configured: boolean; host: string };
  ip_salt: { configured: boolean };
  sentry: { configured: boolean };
  supabase: { configured: boolean };
  insee_sirene: { configured: boolean };
  ans_fhir: { configured: boolean };
  upstash: { configured: boolean };
};

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildConfig(): HealthConfig {
  const env = process.env;
  return {
    axiom: {
      configured: isSet(env.AXIOM_TOKEN) && isSet(env.AXIOM_DATASET),
      host: getAxiomHost(),
    },
    ip_salt: { configured: isSet(env.FRANCE_DATA_IP_SALT) },
    sentry: { configured: isSet(env.SENTRY_DSN) },
    supabase: {
      configured: isSet(env.SUPABASE_URL) && isSet(env.SUPABASE_ANON_KEY),
    },
    insee_sirene: { configured: isSet(env.INSEE_SIRENE_API_KEY) },
    ans_fhir: { configured: isSet(env.ANS_FHIR_API_KEY) },
    upstash: {
      configured: isSet(env.UPSTASH_REDIS_REST_URL) && isSet(env.UPSTASH_REDIS_REST_TOKEN),
    },
  };
}

/**
 * Calcule le `status` global à partir du `config`. Dépendances critiques :
 *  - Supabase (URL + ANON_KEY) : sans ça, tous les tools santé sont KO
 *  - IP salt (`FRANCE_DATA_IP_SALT`) : sans ça, la promesse RGPD PRIVACY.md
 *    (hash IP non-rainbow-tableable) n'est pas tenue
 *
 * Les autres (Axiom/Sentry/INSEE/ANS/Upstash) dégradent l'observabilité ou
 * l'enrichissement mais n'empêchent pas le serveur de répondre. Elles ont
 * leurs propres warns one-shot via `captureMcpConfigWarning`.
 */
function computeStatus(config: HealthConfig): HealthStatus {
  if (!config.supabase.configured) return "degraded";
  if (!config.ip_salt.configured) return "degraded";
  return "ok";
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const config = buildConfig();
  res.status(200).json({
    status: computeStatus(config),
    version: VERSION,
    timestamp: new Date().toISOString(),
    config,
  });
}
