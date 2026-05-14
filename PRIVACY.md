# Politique de confidentialité : france-data-mcp

> Dernière mise à jour : 14 mai 2026 (V0.8.3)
> Concerne uniquement l'**endpoint hébergé** `https://france-data-mcp.vercel.app/mcp`.
> Si tu auto-héberges ce code (license MIT), tu deviens data controller pour ton propre déploiement.

## TL;DR

- On loggue **qui appelle quel tool** (hash anonymisé d'IP + User-Agent + nom du tool + durée + statut).
- On **ne loggue PAS les paramètres** des tools (pas de SIRET, RPPS, nom de commune ou coordonnée).
- On **ne loggue PAS les réponses** des tools.
- Rétention : **30 jours** sur Axiom (si activé, cf. section sous-traitants) ; sinon limitée à la rétention runtime de Vercel (~1 h sur Hobby, ~24 h sur Pro).
- Tu peux demander la suppression de tes données à tout moment via [contact](#contact-droits-rgpd).

## Données collectées sur le endpoint public

À chaque requête HTTP sur `/mcp`, le serveur émet une ligne JSON structurée :

| Champ | Exemple | Pourquoi |
|---|---|---|
| `ts` | `2026-05-14T10:42:13.221Z` | Ordering temporel, debug |
| `method` | `tools/call` | Métrique d'usage (initialize vs list vs call) |
| `tool` | `etablissement_by_finess` | Métrique d'usage par fonctionnalité |
| `ip_hash` | `a4f2…` (16 hex chars) | Rate limiting + détection d'abus distribué |
| `user_agent` | `claude-ai/1.2.3` | Comprendre quels clients MCP utilisent l'API |
| `duration_ms` | `142` | Détection de régressions perfs |
| `status` | `200` / `429` / `500` | Monitoring santé du service |
| `outcome` | `success` / `rate_limited` / `not_found` / `bad_request` / `internal_error` | Idem |

### Hash IP : pourquoi et comment

Le hash IP utilise **SHA-256 salé** (`FRANCE_DATA_IP_SALT`, secret côté serveur, rotaté manuellement par l'opérateur), puis tronqué à 16 chars hex. Conséquences :

- **Impossible de remonter à l'IP source** sans le salt (qui n'est jamais exposé).
- **Impossible de corréler une IP entre deux rotations** du salt (rotation manuelle, objectif recommandé : mensuelle).
- Le hash reste stable entre deux rotations, ce qui permet le rate limiting (60 req/min/IP) sans jamais stocker d'IP en clair.
- Si le salt est absent en production, le code émet un `console.error` au boot (visible côté ops) pour signaler que l'anonymisation est dégradée.

### Ce qui n'est PAS collecté

- ❌ IP en clair (extraite en RAM le temps de calculer le hash, jamais persistée)
- ❌ Paramètres des tools (commune, SIRET, RPPS, coordonnées, etc.)
- ❌ Réponses des tools
- ❌ Cookies, identifiants de session, headers d'auth
- ❌ Géolocalisation, fingerprint navigateur
- ❌ Identifiant client persistant

### Erreurs (Sentry)

Si une erreur 500 survient, on capture en plus :

- La stack trace de l'exception
- Le nom de la méthode/tool en cours
- Le contexte technique (Node version, région Vercel)

Sentry est utilisé uniquement pour le **debugging des erreurs serveur**. Les requêtes en succès n'y sont pas envoyées.

## Sous-traitants (data processors)

| Prestataire | Rôle | Localisation données |
|---|---|---|
| **Vercel** (US) | Hébergement serverless du endpoint + logs runtime | Région européenne (Frankfurt `fra1`) |
| **Upstash** | Rate limit (compteurs glissants 60s) | Frankfurt `eu-central-1` |
| **Sentry** (US, org `command-center`) | Capture des erreurs 500 serveur uniquement | Europe (sentry.io DE) |
| **Axiom** *(si activé)* | Stockage des logs JSON structurés | Europe |
| **Supabase** | DB des référentiels publics (FINESS/Ameli/RPPS), **aucune donnée utilisateur** | `eu-west-1` (Dublin) |

Tous nos sous-traitants opèrent en région européenne et appliquent le RGPD.

## Durée de conservation

- **Logs détaillés (IP-hash + UA + tool)** : 30 jours glissants sur Axiom (si activé). Sans Axiom, rétention limitée à celle des Vercel Runtime Logs (~1 h Hobby, ~24 h Pro).
- **Compteurs rate-limit Upstash** : 60 secondes (sliding window).
- **Agrégats anonymes** (volume par tool par jour, sans IP-hash) : conservation illimitée pour métriques publiques.
- **Erreurs Sentry** : durée selon le plan Sentry en vigueur (30 jours sur le plan Developer).
- **Salt IP** : rotation manuelle par l'opérateur, objectif recommandé ≥ 1× par mois.

## Base légale (RGPD)

- **Intérêt légitime** (art. 6.1.f RGPD) pour les logs opérationnels : sécuriser le service (rate limit), debugger les pannes, mesurer l'usage agrégé.
- **Aucun consentement requis** car aucune donnée directement identifiante n'est collectée.

## Tes droits

Tu peux exercer, gratuitement et à tout moment :

- **Droit d'accès** : demander la liste des logs te concernant. En pratique, si Axiom est activé : tu m'envoies ton IP publique, je hashe avec le salt courant et cherche les lignes correspondantes (recherche limitée à la fenêtre de rétention 30j). Sans Axiom, je ne peux pas garantir la recherche au-delà de la fenêtre runtime Vercel.
- **Droit à l'effacement** : demander la suppression de tes logs (purge manuelle de la fenêtre Axiom).
- **Droit d'opposition** : demander à ne plus être logué. Solution réaliste : utiliser le code OSS (license MIT) pour auto-héberger l'endpoint, ou m'écrire pour un blocage côté serveur.
- **Droit à la portabilité** : recevoir tes logs au format JSON, sur demande manuelle.

⏱ Délai de réponse : ≤ 30 jours.

## Contact (droits RGPD)

**Data controller** : Cyril Turkieh (personne physique, pour l'instance hébergée).
**Email** : cturkieh@gmail.com
**Objet recommandé** : `[RGPD france-data-mcp]`

En cas de désaccord, tu peux saisir la CNIL : https://www.cnil.fr/fr/plaintes

## Code source

Le serveur est open source sous licence MIT : https://github.com/cturkieh/france-data-mcp

Tu peux donc auditer toi-même ce qui est loggué dans `api/_lib/observability.ts` et `api/_lib/rate-limit.ts`.

## Historique des modifications

- **2026-05-14** (V0.8.3) : ajout du salt sur le hash IP ; création de ce document.
- **2026-05-07** (V0.5.7) : ajout des logs JSON structurés (hash IP non salé à l'origine).
