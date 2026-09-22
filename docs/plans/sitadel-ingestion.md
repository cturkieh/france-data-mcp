# Sit@del en base — permis de construire lus en quelques millisecondes

> Plan + preuves. Instruit et mesuré le 2026-09-21. Source de vérité pour les
> migrations `20260921T230000_sitadel_logements.sql` et
> `20260922T000500_sitadel_canary_anon_read.sql`, le cron
> `ingest-sitadel.yml`, `scripts/ingest/sitadel.ts` et la lecture
> `src/immobilier/sitadel.ts`. Jumeau visuel : `sitadel-ingestion.html`.

## 0. En une phrase

`dynamique_immobiliere` passait ~42 de ses ~45 s à attendre l'API DiDo du SDES
(le guichet Sit@del). La donnée ne change qu'une fois par mois : on la recopie
une fois par mois dans une petite table, et l'outil la lit chez nous.

| | Avant | Après (mesuré) |
|---|---|---|
| Lecture des permis d'une commune | 35–37 s (live DiDo) | quelques ms (table) |
| `dynamique_immobiliere` Villejuif, bout en bout | ~45 s | **10,9 s** |
| Paris / Lyon / Marseille | « ok, **0 logement** » servi comme une donnée fiable (bug, §4) | chiffre de la ville entière, étiqueté `partiel`, jamais scoré |
| Deux utilisateurs simultanés | DiDo répond `429` (mesuré) | sans objet |

## 1. Mesures qui ont décidé l'architecture

| Mesure (2026-09-21) | Résultat |
|---|---|
| Fichier national complet | 29 049 155 lignes, ~1,3 Go — **écarté** |
| Filtré **côté serveur DiDo** (`TYPE_LGT=eq:Tous Logements`, `ANNEE=gte:2021`) | 2 342 479 lignes, 107 Mo, **97 s** |
| Agrégation commune × année | **1,7 s** → 209 725 lignes, 34 969 communes |
| Parité agrégat vs appel live (Villejuif, Bordeaux) | **identique**, année par année |
| Première ingestion réelle en prod | `success`, 209 725 lignes, **114 s**, canary vert |
| Seconde ingestion (code final, forcée, `ANNEE=gte:2020` = une année de marge) : 2e swap, rotation `_previous` | 2 762 227 lignes lues, 34 968 hors fenêtre écartées, `success`, 209 725 lignes stockées (100 % de la bande), 133 s, policy anon et PK conservées |
| Mois en double (communes fusionnées recodées sous un même INSEE, ex. 71042) | 504 lignes sur 2,34 M — **sommées**, comme le faisait le live |
| API DiDo interrogée en parallèle | `429` dès 2 appels concurrents |
| Années pleines : toutes les communes ont 12 mois distincts | 0 exception |
| Dernier mois publié | 2026-07 (le mois M paraît vers la fin de M+1) |
| Total national autorisés, années pleines | 336 671 (2024) à 488 672 (2022) |

Pistes écartées : télécharger le fichier complet (1,3 Go pour en jeter 92 %) ;
garder un repli live quand une commune manque (ramène les 37 s et recouple
l'outil à la disponibilité de DiDo — la table absente rend
`indisponible:no_data`, comme avant).

## 2. Architecture

```
cron le 10 du mois ─► DiDo (filtré serveur) ─► SHA256 identique ? ─► skip
                                             └► agrégation commune × année
                                                ─► gardes (§3) ─► staging
                                                ─► swap atomique ─► canary
                                                ─► ingest_log ─► vigies
dynamique_immobiliere ─► permitsForCommune ─► SELECT sitadel_logements (anon)
```

- **Table `sitadel_logements`** : `(code_insee TEXT, annee SMALLINT)` en clé
  primaire, `log_aut`, `log_com` (`INTEGER`), `mois_couverts`. `TEXT` et non
  `CHAR(5)` : évite le piège « colonne CHAR filtrée par un param TEXT → index
  inutilisable ». `INTEGER` et non `NUMERIC` : PostgREST rend des nombres, pas
  des chaînes (la lecture coerce quand même au boundary, testé en strings).
  Lecture publique `anon`, écriture `service_role`. Pas de matview → pas de
  bombe OID au swap.
- **Lignes à zéro conservées** : « commune connue, 0 logement » (`ok`) ≠
  « commune absente » (`indisponible:no_data`). Contrat `PermitsResult`
  **inchangé**, octet pour octet. Côté `dynamique_immobiliere`, deux ajouts que
  geo-intel doit connaître (§4) : le champ `meta.code_commune_permis` et deux
  nouvelles valeurs de `couverture.permis` (`indisponible:no_data`,
  `partiel:ville_entiere_plm`) là où il recevait un `ok` trompeur.
  > **Addendum post-implémentation (2026-09-22, décision produit)** — le
  > contrat a bougé depuis : l'année en cours est servie À PART
  > (`info.permis.annee_en_cours`), les totaux ne somment que 5 années
  > PLEINES (`info.permis.annees_pleines`), et `couverture.permis` connaît
  > trois valeurs `partiel:` de plus (`fenetre_courte`, `annees_incompletes`,
  > `lignes_illisibles`). `PermitsResult` est une union discriminée
  > (`PermitsFenetre | PermitsNoData`). Source de vérité : `CHANGELOG.md`.
- **Fenêtre ancrée sur la DONNÉE, pas sur l'horloge** : on stocke
  `[année du dernier mois publié − 5 ; cette année]` (6 étiquettes) ; la lecture
  sert les 5 dernières années **publiées** (tri décroissant + limite), pas
  `[horloge − 4 ; horloge]` qui ne rendrait que 4 années en janvier-février. Le SDES publie le mois M vers fin M+1 : en janvier et février
  l'année civile courante n'existe pas encore dans le flux. Une fenêtre calée sur
  l'horloge perdait une étiquette le 10 janvier (−17 % de lignes) → la garde de
  volume refusait le swap **deux crons de suite, chaque année** (trouvé en revue,
  test « décembre ≡ janvier »). On demande donc une année de plus à DiDo et on
  rogne après agrégation. Le « dernier mois publié » est le plus récent porté par
  au moins la moitié des lignes du mois le plus fourni — jamais un max sur une
  ligne isolée (un seul permis daté 2030 déplacerait tout).
- **Pattern d'ingestion = celui des 5 autres sources**, rien de nouveau :
  preflight des secrets, `ingest_log`, court-circuit SHA256 (+ `FORCE_REINGEST`),
  bande relative de volume, swap atomique, canary (3 communes réelles : 94076,
  33063, 2A004 **+ preuve que la lecture `anon` a survécu au swap**, §3bis →
  manquant = run `partial`), email + issue GitHub sur échec **ou
  run tué**, vigie « run vert mais donnée malade » avec fermeture automatique,
  `data_freshness` (`sitadel`, âge max attendu 45 j), nettoyage des `_previous`.

## 3. Gardes avant swap (pures, testées sur les chiffres mesurés)

| Garde | Seuil | Verdict | Ce qu'elle attrape |
|---|---|---|---|
| Lignes d'un autre `TYPE_LGT` | 0 toléré | refus | syntaxe de filtre DiDo changée (volume ×12) |
| Lignes illisibles | ≤ 0,1 % | refus ; > 0 → tracé dans `ingest_log`, > 100 → `partial` | colonne renommée, secret statistique introduit |
| Mois en double | ≤ 5 000 (mesuré 504) | refus | **série republiée en double** : seul témoin, tout le reste resterait vert (336 K × 2 = 673 K < 900 K) |
| Communes | [33 000 ; 37 000] | refus | fichier amputé, maille changée |
| Total national, années **pleines** seulement | [150 K ; 900 K] | refus | colonne décalée, double-comptage des sous-types |
| Années pleines sans leurs 12 mois | ≤ 1 % des lignes (mesuré 0) | refus | mois manquants en milieu de série = sous-comptage silencieux (raison d'être de `mois_couverts`) |
| Volume vs dernière ingestion réelle | [0,9 ; 1,3] | refus | troncature |
| Retard du dernier mois publié | ≤ 4 mois | **`partial`, swap fait** | **source tarie** |

La garde « source tarie » est la leçon FINESS/DREES (quatre mois de
`same_checksum` en `success`) appliquée dès le premier jour, en deux étages :
le SHA identique ne rafraîchit pas `data_age_days` (vigie à 45 j), et un fichier
*différent* mais sans mois nouveau marque le run `partial`. `partial` et non
`failed` : le fichier peut porter des révisions des mois passés (on les publie),
et la vigie `notify-ingest-anomaly` ouvre UNE issue idempotente qui se ferme
seule — un `failed` mensuel rouvrirait une issue et un email à chaque cron.

### 3bis. Le canary prouve aussi la lecture publique

`check_ingest_canary` tourne sous `service_role`, qui contourne la RLS : il voit
les lignes quoi qu'il arrive côté `anon`, seul chemin du tool. Or une table sans
policy rend `[]` **sans erreur** : l'outil dirait « pas de donnée » pour toute la
France, cron vert, `data_freshness` fraîche. La branche `sitadel` du canary
vérifie donc le droit `SELECT` d'`anon` et la présence de la policy →
`anon_read_perdue` → `partial` → vigie. Prouvé dans les deux sens en prod
(policy retirée dans une transaction annulée → `{anon_read_perdue}` ; en place →
`{}`). Cette preuve a attrapé un bug du canary lui-même (`text[] || 'x'` = 22P02,
uniquement dans la branche rouge) — d'où deux entrées d'historique côté prod.
Côté repo, `staging-parity.test.ts` garde colonnes, CHECK, PK, index et policy
entre la table et la DERNIÈRE def de la staging-create.

## 4. Bug fermé au passage : Paris, Lyon, Marseille — et sa vraie cause

Le géocodage inverse rend un code **arrondissement** (75115, 69383, 13208 —
vérifié). Sit@del ne connaît que les communes entières (75056, 69123, 13055 :
0 ligne pour tout arrondissement — vérifié dans le fichier). La brique rendait
donc `indisponible:no_data`… mais le composite **ignorait ce verdict** :
`runSection` pose `ok` dès l'absence de throw. Résultat servi : `permis: "ok"`,
0 logement — « Paris n'a rien autorisé en 5 ans », donnée présentée comme fiable.
La fixture de test simulait Paris avec `75056`, ce qui masquait le tout.

Deux corrections, à deux étages :

1. **Composite** (`permisStatus`, jumeau de `flagTruncation`) : le verdict de la
   brique prime. Commune absente → `couverture.permis = "indisponible:no_data"`,
   pour toute commune, pas seulement PLM.
2. **Brique** : repli arrondissement → commune (`parentCommuneInsee`), car la
   maille est une propriété de la source. Mais le chiffre est celui de la **ville
   entière** : il est exposé (`meta.code_commune_permis = "75056"`), étiqueté
   `couverture.permis = "partiel:ville_entiere_plm"`, et **jamais scoré** — les
   seuils du `signal` sont calibrés à la commune, Paris entier (10 247) rendrait
   « fort » pour n'importe quel point de Paris.

## 5. Preuves rejouables

| Preuve | Commande |
|---|---|
| Unitaires (agrégation, gardes, lecture, strings PostgREST, repli PLM) | `pnpm test:unit` |
| Parité table ↔ live, 12 communes (dense, Corse, PLM, DROM, rural, commune à 0 habitant) + 3 replis d'arrondissement ; « deux côtés vides » = PREUVE NULLE, jamais vert | `pnpm tsx scripts/sitadel-parity.ts` (séquentiel : DiDo limite le débit) — **12/12 à parité**, ~150 ms en table vs ~35 s en live |
| Tests rouges sans le correctif (composite P1/P2, garde-fou staging dégradée, canary sans policy) | prouvé pendant la revue |
| Garde-fous repo (alerting, vigie, fraîcheur) | `workflows-alerting.test.ts`, `ingest-log.test.ts` |

## 6. Ordre de mise en service

1. Migrations appliquées en prod (additives : table neuve + branche canary, 5 canaris existants vérifiés intacts) — **fait**.
2. Deux ingestions réelles (dont une avec le code final) — **fait**, la table est pleine avant que le code ne la lise.
3. Merge de la PR (validation Cyril) → l'endpoint lit la table.
4. Post-deploy : `/healthz`, smoke `dynamique_immobiliere`, Sentry.
5. Côté geo-intel, **après** mesure en prod : timeout `preloadRealEstate` 75 s → 30 s.
