# Audit des sources : fraîcheur et format

**Date :** 2026-11-06. **Statut :** terminé. Les sources ingérées chaque semaine ou chaque mois sont à jour. DVF demande un chantier avant fin novembre.

## Question

Nos données sont-elles à jour par rapport aux fournisseurs, et leurs formats correspondent-ils toujours à ce que le code attend ?

## Protocole

Lecture seule, un agent. Côté serveur : `data_freshness`, `ingest_log` et le code. Côté fournisseur : pages officielles, API data.gouv et début réel des fichiers. Les fichiers n'ont pas été téléchargés en entier. La session a revérifié elle-même DVF, Paris-Lyon-Marseille et FHIR ; le reste vient du rapport de l'agent.

## Coût

13 appels Firecrawl, 68 crédits, dont 51 pour un PDF inutile. Aucune écriture permanente ; les appels à `cout_foncier` ont pu ajouter des communes au cache DVF, comme ceux de n'importe quel utilisateur.

## Résultats

| Source | Chez nous | Fournisseur | Format | Verdict |
|---|---|---|---|---|
| FINESS (flux ANS) | 11-01 | quotidien | inchangé (12 Mo lus) | OK |
| Ameli PS | 11-02 | 11-02 | inchangé | OK |
| CDS | 11-02 | 11-02 | inchangé | OK |
| RPPS | 11-05 | quotidien | inchangé, 28 colonnes sur 28 | OK |
| Sit@del | 10-10, jusqu'à août | 10-28, jusqu'au 30/09 | inchangé | OK, cron du 11-10 |
| IRIS contours | édition 2024 | éditions 2025 et 2026 | ancien fichier inchangé (taille seule) | à surveiller |
| IRIS population et familles | RP 2022 | RP 2023 du 2026-10-15 | changé pour 2023 | à surveiller |
| IRIS revenu | FILOSOFI 2021 | 2021, dernier trouvé | inchangé | OK (fraîcheur déduite) |
| DVF | 184 communes, jusqu'au 2025-12-31 | 1er semestre 2026 | fichiers par commune archivés | **problème** |
| BAN | 11-05 | direct | inchangé | à surveiller (hôte de repli) |
| Recherche-entreprises, Sirene | direct | direct | inchangé | à surveiller (NAF 2025) |
| FHIR ANS v2 | direct | direct | non vérifié | **problème** |
| geo.api.gouv.fr, IGN, Apicarto, Melodi, TRE_R397 | direct ou figé | à jour | inchangé | OK |

### DVF : suppression annoncée

Sur data.gouv, la ressource que lit notre code (`src/immobilier/dvf.ts:74`) s'appelle `[ARCHIVE] Données au format CSV - livraison avril - suppression au 31/11/2026`. La livraison du 20 octobre n'existe plus qu'en fichiers nationaux. `2026/communes/44/44109.csv` répond 404, `2025/communes/44/44109.csv` répond 200.

D'après le code, non exécuté : après la suppression, un 404 donne une liste vide sans erreur (`dvf.ts:162-186`), et `ensureCommuneCached` enregistre 0 vente pour 180 jours. Les communes hors du cache n'auraient plus aucune donnée, sans alerte. Même effet au 1er janvier 2027, même sans suppression : le code essaie 2027 puis 2026, deux années absentes de l'archive.

### DVF : Paris, Lyon et Marseille

Bug actif, sans lien avec le fournisseur. `cout_foncier` à 1 km : Paris 15e et Marseille 6e rendent `indisponible:no_data`, Lyon 3e 3 ventes, Nantes 259. Le cache porte `75056`, `69123` et `13055` à 0 ligne depuis juillet 2026, et aucun arrondissement : les fichiers sont par arrondissement.

### FHIR ANS

`professionnel_by_rpps` en prod, avec 2 identifiants fictifs : `ans_fhir_status: api_error` (HTTP 400 lu par l'agent). Le code envoie `identifier=<système>|<id>` (`src/sante/ans-fhir.ts:161`) ; la documentation v2 montre `identifier=<id>`. Cause non prouvée : aucun test direct, faute de clé autorisée depuis ce poste. Conséquence : un professionnel absent de notre base n'a plus de recours, et la réponse mélange « absent » et « erreur ».

### Échéances à venir

- **IRIS :** RP 2023 uniquement au format long harmonisé, en géographie 2025. `P22_*` et `C22_*` sont codés en dur (`scripts/ingest/iris.ts:56-65`) : il faut réécrire le parseur. Rien ne casse aujourd'hui.
- **NAF 2025 :** bascule annoncée par l'INSEE les 5 et 6 janvier 2027. 27 codes santé à vérifier (`src/sante/naf-codes.ts`). Table de passage non lue.
- **FHIR v1 :** fin annoncée en janvier 2027. Notre code est déjà en v2.

## Limites

- FHIR et Sirene ne sont pas testés en direct, faute de clé.
- FINESS : 12 premiers Mo seulement. Contours IRIS : `.7z` non ouvert.
- DVF : le comportement après suppression est déduit du code et du titre de la ressource, sans avis détaillé du producteur.
- Volume national DVF non mesuré : environ 4 M de lignes par an d'après une discussion data.gouv.

## Décision

- Sources à jour : rien à faire.
- DVF : chantier à lancer avant fin novembre, sur décision de Cyril.
- FHIR, IRIS, NAF 2025 : suivis dans le backlog.
