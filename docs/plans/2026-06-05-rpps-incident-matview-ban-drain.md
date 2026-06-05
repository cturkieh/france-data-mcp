# Incident cron RPPS 2026-06-05 — bombe OID matview + automatisation drain BAN

> Archive technique (post-mortem + design). Déclencheur : mail d'alerte « adresses RPPS à
> géocoder INDISPONIBLE » après le cron RPPS run #27003446829 (status `partial`).
> Livré en V0.25.0. Voir `CHANGELOG.md` pour le résumé, les migrations pour le détail SQL.

## 1. Ce que le mail cachait : 2 régressions silencieuses distinctes

Le mail signalait l'échec de la **mesure** BAN (best-effort). En creusant, le `status=partial`
réel venait d'**ailleurs** (`error_message` en base) :

### P1 — Bombe OID `finess_hosted_activities` (sévérité haute)
`ingest_rebuild_finess_hosted_activities` était la **seule** des 3 RPC de rebuild post-swap en
`SECURITY INVOKER` (jumelles RPPS/Ameli = `DEFINER`). Appelée via `service_role`, son
`CREATE MATERIALIZED VIEW` → `42501 permission denied for schema public` → rollback → la
matview restait collée à l'OID de `rpps_previous` (1er cron RPPS depuis le câblage Phase 2 :
défaut jamais exécuté avant). Conséquences : `activite_hebergee` périmée d'une génération +
destruction au prochain swap (`DROP CASCADE`). **Fix** : `SECURITY DEFINER` + `search_path` +
lockdown ; matview re-pointée sur `rpps` (vérifié `pg_depend`). Reproduit le chemin cron
(`SET ROLE service_role` → rebuild OK) avant de conclure. Garde-fou parité des 3 RPC.

### P2 — Mesure delta BAN pré-swap = 57014 systématique
`rpps_measure_ban_to_geocode` tournait pré-swap sur `rpps_staging` (~1,29 M éligibles, tout en
`commune_centroid` avant ban_join) → DISTINCT + anti-jointure > 55 s → `NULL` → alerte dégradée
à **chaque** cron (never-worked depuis la migration `20260520`). **Fix** : mesure **post-swap sur
`rpps`** (résidu = vraie file Phase 2, <1 s).

## 2. Le drain BAN RPPS : 2 dead-ends avant la solution robuste

Objectif : bouton GitHub pour géocoder le résidu (mesuré : **41 103** éligibles distinctes,
dont **7 881** pas en cache). L'énumération exige de calculer la clé d'adresse normalisée.

| Tentative | Pourquoi ça échoue (prouvé prod) |
|---|---|
| **Keyset sur la clé** (`rpps_distinct_eligible_keys`) | exige un index BAN sur `rpps` ; absent (orphelin au swap) ; le (re)construire via RPC PostgREST = **cap passerelle 60 s** (dead-end déjà documenté CLAUDE.md « BAN re-arm ») |
| **Passe unique** (`DISTINCT`/`DISTINCT ON`, même `MATERIALIZED`) | `rpps_address_key_for_index` (normalisation Unicode) coûte **~880 µs/appel** (mesuré) → ~147k évals en 1 requête ≈ 129 s > 55 s → 57014 |
| **✅ Keyset sur `id` (PK)** (`rpps_eligible_rows_after_id`) | la PK est toujours indexée → **aucun index BAN** ; chaque page borne le nb d'évals (**5000 lignes = 4,4 s**, coût constant) → étale les ~147k évals sur ~30 pages, chacune ≪ 55 s |

**Leçon transverse** : calculer une clé fonctionnelle coûteuse sur tout l'éligible en 1 requête
frôle TOUJOURS le budget ; **étaler via keyset-PK** est le patron robuste (≠ index lourd, ≠ passe
unique). Les 2 dead-ends étaient des inférences ; seule la prod les a tranchés (discipline projet).

## 3. Architecture du bouton (V0.25.0)

- **RPC** `rpps_eligible_rows_after_id(p_source_table, p_after_id, p_limit)` — keyset PK, retourne
  `(id, address_key, adresse, code_postal, code_insee)`, prédicat byte-identique aux sites BAN.
- **`ban-backfill.mjs`** — curseur d'énumération **générique** (`SOURCES[*].cursorParam/cursorField/
  cursorInit`) : RPPS keyset-`id`, Ameli keyset-clé (inchangé). `SOURCES` exporté (source de vérité
  unique testée). Garde structurelle fail-loud. Clés vides → skip+warn. Exit ≠ 0 si drain incomplet.
- **Workflow** `ban-backfill-rpps.yml` (`workflow_dispatch`) : preflight secrets, `concurrency:
  ingest-rpps` (jamais concurrent du swap), canari `max` puis complet. Remplit le cache ; le cron
  RPPS suivant pose via `ban_join`.

## 4. Cycle BAN (rappel, modèle mental validé)

`ban_join` (auto, chaque cron) pose le **cache** → `rpps`. Le nouveau fichier transporte des
adresses neuves + d'anciennes jamais résolues → le **backfill** (manuel, ce bouton) les géocode →
remplit le cache → le cron suivant les pose. Décalage d'un cron. Automatisation totale (géocodage
*dans* le cron) = étape ultérieure (l'ancien `runBanGeocodeStep` retiré car timeout structurel).

## 5. Dette / suivi

- Ameli garde le keyset-clé (index orphelin au swap, build manuel) → migrer vers id-keyset (même
  patron) = follow-up.
- `rpps_distinct_eligible_keys` (keyset-clé) reste en base (gardé par tests) mais plus appelé par le
  backfill RPPS.
