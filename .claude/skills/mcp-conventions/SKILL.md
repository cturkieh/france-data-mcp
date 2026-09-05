---
name: mcp-conventions
description: "Conventions de code de france-data-mcp : lib src/ (LookupResult, RangeError, expectSingleRow, dédup identité, couches core/sante/territoire, reverseGeocode vs communeContainingPoint, resolver SIRET succession), endpoint api/ (Sentry, -32700, perimetre, activite_hebergee, applyCommuneResolver), boundary args. À charger avant de toucher src/, api/ ou un tool MCP."
---

# Conventions de code (lib, endpoint, boundary)

> Déplacé verbatim depuis `CLAUDE.md` le 2026-09-06 (budget). Source de vérité pour ce périmètre ; `CLAUDE.md` ne garde que les règles de tête.

**Lib (`src/`) — OSS publiable, pas de Sentry direct.**
- Catch jamais silencieux : `console.error` ou `console.warn` avec préfixe `[france-data-mcp]`.
- `RangeError` pour input invalide au boundary public (mappe JSON-RPC `-32602`).
- `LookupResult<T>` discriminé pour distinguer "pas trouvé" vs "erreur API".
- Tests `_resetXForTesting()` pour tout module avec état partagé.
- **Lookup PK qui peut retourner ≤ 1 row → `expectSingleRow(rpc, rows, identifier, hint)`** (`db-helpers.ts`). Source unique du pattern « warne LOUD si N > 1, ne throw pas, picke la première » utilisé par `finess_by_num_finess` + `centres_sante_by_finess`. Le `hint` voyage dans le warn pour préserver les patterns grep ops (PAS reformuler les call-sites).
- **Clé de déduplication d'identité = attributs de PERSONNE uniquement**, jamais d'attribut de SITE (`raison_sociale`, adresse). Un PS multi-sites partage une identité ; mettre un attribut de site dans la clé le scinde en faux doublons (régression P1). L'attribut de site voyage dans `adresse`/`sites[]`.
- **Primitives génériques (texte, maths) → `core/`**, jamais `sante/`. `sante/` importe déjà `territoire/` : une primitive dans `sante/` consommée par `territoire/` crée une inversion de couche / cycle. Ré-export depuis l'ancien emplacement pour ne pas casser les consommateurs.
- **Résolution point→commune : `reverseGeocode` (adresse) ≠ `communeContainingPoint` (frontières)** (V0.26.2, `territoire/communes.ts`). `reverseGeocode` cherche l'ADRESSE la plus proche → `null` sur un site sans adresse à proximité (industriel isolé / littoral, ex. Orano La Hague) ALORS que le point est DANS une commune. Tout dérivé d'une commune issu de `reverseGeocode` (permis Sit@del de `dynamique_immobiliere`, dept de `finess_sirene_coverage_in_radius`) DOIT fallback sur `communeContainingPoint(lat,lon)` (point-dans-polygone `geo.api.gouv.fr/communes?lat&lon`, frontières IGN AdminExpress). **Garde-fou load-bearing `length === 1`** : sur coords hors-bornes (lat>90…) l'API ignore SILENCIEUSEMENT le filtre géo et renvoie TOUTE la liste alphabétique (34 969 communes, `[0]="01001"` Ain — faux positif, prouvé prod) → n'exploiter QUE `length === 1` (un point ∈ 1 commune ; `0`=mer/hors-France, `>1`=filtre ignoré → `null`), JAMAIS `data[0]`. Fail-safe par contrat (catch→`null`+warn, jamais throw — n'est appelé que sur un chemin déjà dégradé) ; le throw de `reverseGeocode` (panne IGN réelle) continue de remonter. Seul un point réellement en mer reste sans commune → dégradation propre conservée. **Doctrine smoke/test corollaire** : gater sur le STATUS de section (`couverture.permis === "ok"`), JAMAIS sur une donnée métier volatile (`logements_autorises_recent > 0`) — `runSection` expose `ok` dès absence de throw, un `count` peut valoir 0 légitimement (Fleury-devant-Douaumont : `permis="ok"` + 0 logement) ; le compte voyage en INFO. `scripts/smoke-deploy.mjs` encode ces 2 doctrines (gate-sur-status + params boundary `{lat,lon,radius_km,naf}` jamais `{center,radiusKm}` = signature lib interne → `-32602`).
- **Resolver SIRET — le `best_match` privilégie l'établissement ACTIF co-localisé, JAMAIS le score d'adresse seul** (V0.16, fix succession M&A — `siret-resolver.ts`). `disambiguateFallbackCandidates` applique une étape « actif prime » AVANT le name filter : si ≥ 1 candidat actif est co-localisé avec le FINESS, le `best_match` est arbitré parmi les actifs ; les SIRET fermés du site restent dans `candidates[]` (timeline) mais ne sont plus best_match-éligibles. Co-localisation = distance haversine (`core/geo-distance.ts`) ≤ `COLOCATION_RADIUS_M` **100 m** (V0.16.1, recalibré prod 2026-05-29 — était 50 m), JAMAIS le Dice d'adresse (qui ne discrimine pas le numéro de voie — un voisin au n°48 d'une avenue score 0,90 vs le n°85 du FINESS, prouvé prod). **Pourquoi 100 et plus 50** : le géocodage DREES (Lambert93, grossier) décale le point FINESS de plusieurs dizaines de mètres du point BAN de l'adresse — décalage PARTAGÉ par tous les SIRET de cette adresse. Deux repreneurs M&A réels (Cerballiance Aulnay 52,1 m, EYLAU Courbevoie 96,6 m) ressortaient à la distance IDENTIQUE de leur ancien exploitant fermé (même adresse) mais juste au-dessus de 50 m → faux négatif `ferme`. 100 m couvre ces décalages, sous le voisin-piège testé ~110 m. **Garde-fou faux positif inverse au rayon élargi = bande RELATIVE `COLOCATION_SAME_SITE_TOLERANCE_M` (30 m)** : parmi les co-localisés, seuls ceux à `≤ min(distance) + 30 m` (« même bâtiment ») sont best_match-éligibles ; un voisin actif d'une AUTRE adresse, plus loin qu'un prédécesseur fermé co-localisé, ne bascule pas le verdict en `actif` (test garde-fou voisin 80 m / prédécesseur 30 m). NE PAS reverter à 50 m sans relire la preuve prod (les 2 repreneurs redeviendraient invisibles ; le site EYLAU légitime à 46,6 m reste co-localisé dans les deux calibrations). Le fallback géo est aussi armé quand le `best_match` RPPS est FERMÉ (L1 — sinon le repreneur d'un autre SIREN reste invisible). Champ `succession` exposé (fait brut — le tool ne dit jamais « rachat »). Garde-fous : `cross-source.test.ts` (Méca A chemin RPPS / Méca B fallback géo / faux positif inverse) + `geo-distance.test.ts`. Cadrage durable : `docs/plans/verifier-site-actif-succession-fix.md`.

**Endpoint (`api/`) — Sentry + observabilité.**
- `captureMcpError` / `captureMcpConfigWarning` avec fingerprint stable (`api/_lib/sentry.ts`).
- Logs JSON 1 ligne/req via `logMcpEvent`. Rate limit Upstash 60/min/IP.
- Anti-spoofing IP : dernier segment XFF (Vercel append en queue).
- **JSON malformé caller → `-32700 Parse error` classé AU SITE de l'accès `req.body`, JAMAIS par CLASSE d'exception dans le catch root** (fix `FRANCE-DATA-MCP-1`, prouvé prod 2026-07-25 — **SUPERSEDE la règle V0.12.2 `err instanceof SyntaxError`, qui était une inférence fausse**). Le runtime Vercel (`/opt/rust/nodejs.js`) throw un **`Error` NU de message `"Invalid JSON"`** depuis le getter lazy `IncomingMessage.get [as body]` — pas un `SyntaxError` : la discrimination ne matchait jamais → faute caller capturée en `captureMcpError`/`outcome=internal_error` (dilue l'invariant « 100 % des 500 capturés ») + **400 à corps VIDE** rendu au client (le runtime convertit sa propre erreur ; le re-throw ne donne donc même pas un 500 diagnostique). Fix : `try { rawBody = req.body } catch` dédié → `console.warn` + `emit(bad_request)` + `-32700` ; le catch root ne discrimine plus rien (un `instanceof SyntaxError` À CE NIVEAU masquerait un vrai bug `JSON.parse` serveur). `rawBody` est re-lié en `const body` — le narrowing par alias (`isBatch = Array.isArray(body)`) n'opère PAS sur un `let` (TS2322). Reproduction : `curl -X POST …/mcp -H 'Content-Type: application/json' -d 'pas-du-json'` → corps JSON-RPC attendu, jamais vide. Garde-fous `api/mcp-handler-parse-error.test.ts` (3 cas ; celui « exception hors body → Sentry » DOIT utiliser un véhicule hors getter `body`, ex. `headers`, sinon il asserte l'inverse de la règle). Leçon transverse : le comportement d'un runtime tiers se **vérifie** (repro prod), il ne s'infère pas.
- **Champ `perimetre` sur les tools de comptage** : tout tool qui compte/agrège
  par famille ou spécialité DOIT exposer un `perimetre` (`src/sante/perimetre.ts`)
  injecté via `withPerimetre` au boundary `api/tools.ts` (jumeau de
  `withFreshness`). La couche lib reste pure. `withFreshness` étant `async`,
  toujours `await` son résultat AVANT de le passer à `withPerimetre` (sinon
  spread d'une Promise = données perdues). Un comptage filtré sans lentille
  déclarée = undercount silencieux (cf. `docs/plans/completude-lentilles-sources.md`).
- **Champ `activite_hebergee` sur les tools de comptage FINESS filtrés par
  famille mappable** (Phase 2) : tout tool FINESS filtré par `labo` / `pharmacie` /
  `imagerie` DOIT exposer un compte juxtaposé via `withHostedActivity` (jumeau de
  `withPerimetre`, type durci `T & { then?: never }` anti-Promise-spread). Source =
  matview `finess_hosted_activities` (jointure RPPS×FINESS, seuil N≥3) via les
  RPCs lookup `finess_hosted_activities_in_{radius,zone}`. Le rebuild post-swap
  pattern OID est chaîné dans les crons RPPS ET FINESS (la matview joint les deux
  tables swappées — un swap de l'une suffit à la désynchroniser silencieusement).
  La `note` du champ INTERDIT explicitement l'addition avec le `count` principal —
  doctrine MCP-juxtapose-jamais-additionne. Cf. `docs/plans/completude-lentilles-phase2-plan.md`.
- **Résolution `nom_commune` → `code_insee` au boundary via `applyCommuneResolver`**
  (V0.19) : tout tool MCP qui accepte un scope commune DOIT utiliser
  `api/_lib/apply-commune-resolver.ts` (qui consomme `resolve-commune.ts`) plutôt
  que de réinventer la résolution. Source `geo.api.gouv.fr` (DINUM, même que
  `autocomplete_commune`) + filtre exact case-insensitive + accents normalisés
  (NFD + `\p{M}`, aligné avec `text-match.ts` / `commune-index.ts`). Sémantique
  load-bearing : `nom_commune + departement` → `departement` est un **hint
  resolver** (filtre côté API), JAMAIS un scope de calcul ; le tool reçoit
  uniquement `{ codeInsee }`. Pour `densite_professionnels_sante`, `code_dept`
  a donc une **sémantique conditionnelle** (seul = scope dept entier ; combiné
  avec `nom_commune` = hint resolver) — documentée explicitement dans la
  `description` du tool (LLM-facing doc) car contre-intuitive sinon. Les
  erreurs (4 kinds : `ambiguous_commune`, `commune_not_in_department`,
  `unknown_commune`, `redundant_commune_params`) voyagent via
  `RangeError(msg, { cause })` jusqu'à `error.data` JSON-RPC (patch
  `api/mcp.ts:384-393` propage `err.cause` au 4ème arg de `error()` — test
  garde-fou `api/mcp-handler-error-cause.test.ts`). **Régression Phase 2
  fermée** : panorama passait `codeInsee` brut (variable d'entrée) à
  `getHostedActivitiesInZone` au lieu de `resolved.codeInsee`, masqué par
  `safeHostedFetch` couche secondaire → `activites_hebergees_par_famille`
  systématiquement absent dès qu'on passait `nom_commune`. Garde-fou
  `tools-v019.test.ts` "C1 régression" mocke `getHostedActivitiesInZone` +
  assert `firstCall?.codeInsee === resolved.codeInsee` (pas undefined).
  Source de vérité du contrat : `docs/plans/nom-commune-resolver-v019.md`.

**Boundary (`api/_lib/args.ts`).**
- Validators `requireXxxId` avec 3 branches (clé absente, type wrong, format wrong) via factor `requireIdPattern`.
- Regex partagés lib ↔ boundary : `NUM_FINESS_PATTERN`, `RPPS_ID_PATTERN`, `SIRET_PATTERN` exportés depuis `src/sante/db-helpers.ts`.

