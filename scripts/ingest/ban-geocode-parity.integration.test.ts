import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeAddressKey } from "../../src/core/address-geocode.js";

// ─────────────────────────────────────────────────────────────────────────────
// HARD GATE — parité OCTET-À-OCTET JS↔SQL de `normalizeAddressKey`
// (Phase 2 RPPS BAN-geocoding, Task 8 + correctifs R1/R3/R4/R5).
//
// POURQUOI CE TEST EST UN HARD GATE :
// Le cache `geocoded_addresses` est indexé par la clé normalisée d'adresse. À
// l'ingestion, `ingest_apply_rpps_ban_geocoding_batch` joint `rpps_staging` au
// cache en RECALCULANT la même clé EN SQL via `rpps_normalize_address_key`. Si
// la clé SQL diverge de la clé JS (`src/core/address-geocode.ts`, forme 3-arg)
// d'UN SEUL octet, tout lookup rate, la jointure ne trouve rien, le pipeline
// géocode ZÉRO ligne EN RAPPORTANT un succès (panne TOTALE silencieuse). On
// compare, pour des adresses RPPS RÉELLES, la sortie JS et la sortie du jumeau
// SQL (via la sonde RPC) et on exige l'égalité STRICTE `toBe`. NE PAS affaiblir
// une assertion : divergence réelle → corriger le jumeau SQL ; si Postgres ne
// peut fondamentalement pas reproduire V8 pour un codepoint de données réelles
// → STOP + escalade (changer le contrat JS = décision d'archi).
//
// R5 — CI : ce fichier est `*.integration.test.ts` pour être collecté par
// `pnpm test:integration` (étape CI avec DB up + SUPABASE_SERVICE_ROLE_KEY).
// Le `.test.ts` précédent n'était JAMAIS exécuté en CI (test:unit tourne avant
// `supabase start` → skip ; test:integration ne globe que `*.integration*`).
//
// R5.2 — FAIL-LOUD : on ne SKIP que si la DB est GÉNUINEMENT injoignable (pas
// de clé service_role). Si la clé/DB est présente MAIS la sonde RPC est
// absente (migration T-format non appliquée — voir note CI ci-dessous), le
// test ÉCHOUE avec un message clair, il ne skippe PAS (sinon le garde-fou est
// inerte alors que la DB est là). NB CI : la CLI supabase SKIPPE les
// migrations `YYYYMMDDThhmmss_` ; `pnpm db:reset` en CI N'APPLIQUE donc PAS
// cette migration → la sonde sera absente et CE TEST ÉCHOUERA EN CI tant que
// l'application de la migration (Task 14 / fix infra) n'est pas faite. C'est
// VOULU : un garde-fou rouge-visible vaut mieux qu'un skip silencieux.
//
// CONTRAT DE FORME (C1/D3) : Task 9 appellera normalizeAddressKey(adresse,
// codePostal, codeInsee) SANS `ville` → clé à 3 segments. On teste donc
// EXCLUSIVEMENT la forme 3-arg face au jumeau SQL 3-arg.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "";

// SKIP UNIQUEMENT si la DB est génuinement injoignable (aucune clé). DB up +
// fonction absente = FAIL (R5.2), géré dans le test, pas ici.
const canRun = SERVICE_KEY !== "";

// Espaces Unicode non-ASCII (sous-ensemble du `\s` JS) injectés tels quels —
// le jumeau SQL DOIT les collapser comme JS le fait via `\s+`.
const NBSP = " "; // U+00A0 NO-BREAK SPACE (très fréquent données gouv FR)
const THIN = " "; // U+2009 THIN SPACE
const NNBSP = " "; // U+202F NARROW NO-BREAK SPACE (séparateur FR moderne)
// U+0085 NEL : JS `\s` ne le matche PAS → DOIT être PRÉSERVÉ des 2 côtés.
const NEL = "";
// Ligatures de présentation Unicode (V8 .toUpperCase() les EXPAND :
// ﬀ→FF ﬁ→FI ﬂ→FL ﬃ→FFI ﬄ→FFL ﬅ→ST ﬆ→ST ; glibc C.UTF-8 NE les expand PAS
// → divergence corrigée par le pré-replace R1 du jumeau SQL).
const LIGATURES = "ﬀﬁﬂﬃﬄﬅﬆ";

/**
 * Tuples d'adresses RPPS-STYLE RÉELLES (forme/typo conformes aux extractions
 * ANS : voie en majuscules abrégées, CEDEX, accents préservés, code postal 5
 * chiffres, code INSEE commune). PAS de fixtures inventées (leçon projet P9 :
 * fixtures fabriquées = faux vert). Chaque entrée cible un risque documenté.
 */
const CASES: Array<{
  label: string;
  adresse: string | null;
  codePostal: string | null;
  codeInsee: string | null;
}> = [
  {
    label: "adresse numéro de voie simple",
    adresse: "12 RUE DE LA REPUBLIQUE",
    codePostal: "75001",
    codeInsee: "75101",
  },
  {
    label: "D2 — CEDEX avec numéro de traîne",
    adresse: "1 PLACE DE L HOTEL DE VILLE 75004 PARIS CEDEX 04",
    codePostal: "75004",
    codeInsee: "75104",
  },
  {
    label: "D2 — CEDEX sans numéro",
    adresse: "AVENUE DU GENERAL DE GAULLE CEDEX",
    codePostal: "92100",
    codeInsee: "92012",
  },
  {
    label: "D2 — CEDEX SANS séparateur (75116CEDEX) — NON retiré des 2 côtés",
    adresse: "8 RUE 75116CEDEX BIS",
    codePostal: "75116",
    codeInsee: "75116",
  },
  {
    // R3 — JS CEDEX_RE `\s*` matche le NBSP donc "CEDEX<NBSP>08" est
    // INTÉGRALEMENT retiré ; le jumeau SQL doit normaliser l'espace AVANT le
    // strip CEDEX pour produire la même chose.
    label: "R3 — CEDEX<NBSP>08 (NBSP entre CEDEX et numéro) intégralement retiré",
    adresse: `RUE DE LA GARE 67000 STRASBOURG CEDEX${NBSP}08`,
    codePostal: "67000",
    codeInsee: "67482",
  },
  {
    label: "D1 — œ (U+0153) + accents français courants",
    adresse: "3 RUE DU CŒUR DE VILLE",
    codePostal: "06400",
    codeInsee: "06029",
  },
  {
    label: "D1 — accents é è à ç ô û préservés (pas d'unaccent)",
    adresse: "RÉSIDENCE LE PRÉ FLEURI ÉTAGE 2 CHÂTEAU ô-bourg çà-et-là FÛT",
    codePostal: "69003",
    codeInsee: "69383",
  },
  {
    label: "D1 — æ (U+00E6)",
    adresse: "CLINIQUE SAINT VÆAST",
    codePostal: "62000",
    codeInsee: "62041",
  },
  {
    // R1 — le cas critique : prod LC_CTYPE=C.UTF-8, glibc upper('ß')='ß'
    // (inchangé) ≠ V8 'SS'. Doit PASSER par construction grâce au pré-replace.
    label: "R1 — ß (U+00DF) rue d'origine allemande Alsace-Moselle (V8 → SS)",
    adresse: "STRAßE 5 STRASBOURG",
    codePostal: "67000",
    codeInsee: "67482",
  },
  {
    // R1 — long-s : V8 ſ→S ; glibc C.UTF-8 fait DÉJÀ ſ→S (1:1, pas de
    // pré-replace) — verrouille qu'on ne casse pas ce cas en sur-corrigeant.
    label: "R1 — ſ (U+017F long-s) — glibc fait déjà ſ→S 1:1 = V8",
    adresse: "RUE DU CONſEIL",
    codePostal: "75001",
    codeInsee: "75101",
  },
  {
    // R1 — ligatures de présentation : V8 les EXPAND, glibc C.UTF-8 non.
    label: "R1 — ligatures ﬀﬁﬂﬃﬄﬅﬆ (V8 expand → FF FI FL FFI FFL ST ST)",
    adresse: `OFFICE ${LIGATURES} STRASBOURG`,
    codePostal: "67000",
    codeInsee: "67482",
  },
  {
    // R1 — ŉ U+0149 (LATIN SMALL LETTER N PRECEDED BY APOSTROPHE) : V8
    // `'ŉ'.toUpperCase()` === 'ʼN' (U+02BC U+004E) ; glibc C.UTF-8
    // upper('ŉ')='ŉ' (inchangé) → DIVERGENCE corrigée par le pré-replace
    // ŉ→U+02BC+'n' (upper → U+02BC 'N'). Fixture brute (U+0149 littéral) pour
    // VERROUILLER cette ligne du jumeau SQL (un mauvais chr() la casserait).
    label: "R1 — ŉ (U+0149) brut → V8 'ʼN' (verrou gate, pas seulement analytique)",
    adresse: "RUE DE LŉINSTITUT",
    codePostal: "75005",
    codeInsee: "75105",
  },
  {
    // R1 — ǰ U+01F0 (LATIN SMALL LETTER J WITH CARON) : V8
    // `'ǰ'.toUpperCase()` === 'J̌' (U+004A U+030C combining caron) ; glibc
    // C.UTF-8 upper('ǰ')='ǰ' (inchangé) → DIVERGENCE corrigée par le
    // pré-replace ǰ→'j'+U+030C (upper → 'J' U+030C). Fixture brute (U+01F0
    // littéral) pour VERROUILLER cette ligne du jumeau SQL.
    label: "R1 — ǰ (U+01F0) brut → V8 'J̌' (verrou gate, pas seulement analytique)",
    adresse: "PLACE DE LA RÉSOLUTION ǰ",
    codePostal: "38000",
    codeInsee: "38185",
  },
  {
    // U+0085 NEL : JS `\s` ne le matche pas → PRÉSERVÉ des 2 côtés. Verrou de
    // régression (si on l'ajoutait par erreur à `uspace`, ce test casse).
    label: "U+0085 (NEL) — JS \\s ne le matche pas → préservé identique",
    adresse: `RUE${NEL}DU TEST NEL`,
    codePostal: "75001",
    codeInsee: "75101",
  },
  {
    label: "D4 — NBSP (U+00A0) + THIN (U+2009) + NNBSP (U+202F)",
    adresse: `10${NBSP}RUE${THIN}DE${NNBSP}STRASBOURG`,
    codePostal: "67000",
    codeInsee: "67482",
  },
  {
    label: "D4 — espaces multiples + tab + retour ligne intercalés",
    adresse: "5\t\tRUE   DES\nLILAS",
    codePostal: "59000",
    codeInsee: "59350",
  },
  {
    label: "espaces de bord (leading/trailing) à trimmer",
    adresse: "   2 BIS BD VOLTAIRE   ",
    codePostal: " 75011 ",
    codeInsee: " 75111 ",
  },
  {
    // Adresse composée UNIQUEMENT d'espaces Unicode → collapse puis trim → "".
    label: "uniquement des espaces Unicode → collapse+trim → segment vide",
    adresse: `${NBSP}${THIN}${NNBSP}\t \n`,
    codePostal: "75001",
    codeInsee: "75101",
  },
  {
    label: "D3 — adresse NULL → segment vide (clé '|cp|insee')",
    adresse: null,
    codePostal: "13001",
    codeInsee: "13201",
  },
  {
    label: "D3 — code_postal NULL → segment vide intercalé",
    adresse: "4 RUE NEUVE",
    codePostal: null,
    codeInsee: "31555",
  },
  {
    label: "D3 — les 3 NULL → clé '||' (3 segments vides préservés)",
    adresse: null,
    codePostal: null,
    codeInsee: null,
  },
  {
    label: "déterminisme — entrée minuscule normalisée en MAJUSCULES",
    adresse: "7 impasse des Lilas cedex 3",
    codePostal: "44000",
    codeInsee: "44109",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CHAR(5) ROUND-TRIP — chemin PRODUCTION (L1 /review Passe 1).
// La RPC d'ingestion joint sur rpps_normalize_address_key(s.adresse,
// s.code_postal, s.code_insee) où s.code_postal / s.code_insee sont des
// colonnes CHAR(5) (bpchar, BLANK-PADDÉES à 5). Le HARD GATE TEXT ci-dessus ne
// teste JAMAIS ce padding. Sonde dédiée rpps_normalize_address_key_probe_char5
// (même migration) : cast ::CHAR(5)::TEXT AVANT le jumeau = lecture d'une
// colonne bpchar. INVARIANT prouvé EXÉCUTABLEMENT : JS `.trim()` ↔ SQL `btrim`
// neutralisent SYMÉTRIQUEMENT le blank-pad → clé identique.
//
// CONTRAINTE : `::CHAR(5)` TRONQUE au-delà de 5 chars. Les codes RPPS RÉELS
// (code postal / code INSEE) tiennent en 5. On n'exerce le round-trip QUE sur
// des fixtures où code_postal ET code_insee ont ≤5 chars (pas d'espaces de
// bord qui débordent — sinon la troncature CHAR(5) diverge LÉGITIMEMENT du JS,
// ce qui ne reflète AUCUN code réel). Inclut explicitement des codes COURTS
// (<5 chars → padding actif) pour PROUVER la neutralisation symétrique.
// ─────────────────────────────────────────────────────────────────────────────
const CHAR5_CASES: Array<{
  label: string;
  adresse: string | null;
  codePostal: string | null;
  codeInsee: string | null;
}> = [
  {
    // Code COURT (3 chars) → CHAR(5) le pad en "751  " / "750  " : c'est
    // EXACTEMENT le cas qui prouve que btrim (SQL) == .trim() (JS).
    label: "CHAR5 — codes COURTS 751/750 (padding bpchar 2 espaces, btrim↔trim)",
    adresse: "12 RUE DE LA REPUBLIQUE",
    codePostal: "751",
    codeInsee: "750",
  },
  {
    label: "CHAR5 — code 4 chars 7500/7510 (1 espace de pad)",
    adresse: "8 AVENUE DES TERNES",
    codePostal: "7500",
    codeInsee: "7510",
  },
  {
    label: "CHAR5 — codes 5 chars exacts (aucun pad : round-trip neutre)",
    adresse: "1 PLACE DE L HOTEL DE VILLE",
    codePostal: "75004",
    codeInsee: "75104",
  },
  {
    label: "CHAR5 — adresse avec œ + codes 5 chars (round-trip + pré-replace)",
    adresse: "3 RUE DU CŒUR DE VILLE CEDEX 04",
    codePostal: "06400",
    codeInsee: "06029",
  },
  {
    label: "CHAR5 — code_postal NULL → CHAR(5) NULL → segment vide (intercalé)",
    adresse: "4 RUE NEUVE",
    codePostal: null,
    codeInsee: "31555",
  },
  {
    label: "CHAR5 — les 3 NULL → clé '||' (NULL::CHAR(5)::TEXT = NULL)",
    adresse: null,
    codePostal: null,
    codeInsee: null,
  },
];

describe.skipIf(!canRun)("parité JS↔SQL normalizeAddressKey (HARD GATE, DB locale)", () => {
  // Client créé en beforeAll (PAS au corps du describe) : `createClient("","")`
  // throw `supabaseKey is required` à la COLLECTE. beforeAll n'est exécuté que
  // si la suite n'est pas skippée. Pattern repris de rpps-in-radius-hybrid.
  let svc: SupabaseClient;
  beforeAll(async () => {
    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // R5.2 FAIL-LOUD : DB joignable mais sonde absente (migration non
    // appliquée) → on veut un ÉCHEC explicite, pas un skip silencieux. On
    // sonde une fois ; un message d'erreur clair guide vers l'application de
    // la migration (T-format non auto-appliquée par la CLI — voir en-tête).
    const { error } = await svc.rpc("rpps_normalize_address_key_probe", {
      p_adresse: "PROBE",
      p_code_postal: "00000",
      p_code_insee: "00000",
    });
    if (error) {
      throw new Error(
        `[france-data-mcp] HARD GATE INERTE : la DB est joignable mais la sonde rpps_normalize_address_key_probe est absente — la migration 20260516T060000_geocoded_addresses_cache.sql n'a pas été appliquée (la CLI supabase SKIPPE les migrations T-format ; appliquer via psql en local / SQL Editor en prod). Erreur RPC : ${error.message}`,
      );
    }
  });

  for (const c of CASES) {
    it(`parité octet-à-octet : ${c.label}`, async () => {
      // Côté JS : LE contrat (forme 3-arg, sans `ville`).
      const jsResult = normalizeAddressKey(c.adresse, c.codePostal, c.codeInsee);

      // Côté SQL : le jumeau, via la sonde RPC (exactement la fonction utilisée
      // par la jointure d'ingestion — source unique de vérité).
      const { data: sqlResult, error } = await svc.rpc("rpps_normalize_address_key_probe", {
        p_adresse: c.adresse,
        p_code_postal: c.codePostal,
        p_code_insee: c.codeInsee,
      });

      expect(error, `RPC rpps_normalize_address_key_probe a échoué: ${error?.message}`).toBeNull();

      // Égalité STRICTE octet-à-octet. Si ça diverge, la porte joue son rôle :
      // corriger le jumeau SQL (NE PAS affaiblir cette assertion).
      expect(sqlResult).toBe(jsResult);
    });
  }
});

describe.skipIf(!canRun)("parité JS↔SQL CHAR(5) round-trip (chemin PRODUCTION, HARD GATE)", () => {
  // Même pattern fail-loud que la suite TEXT : on n'exécute que si DB
  // joignable ; sonde absente (migration non appliquée) = ÉCHEC explicite,
  // PAS skip silencieux (sinon le garde-fou est inerte).
  let svc: SupabaseClient;
  beforeAll(async () => {
    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await svc.rpc("rpps_normalize_address_key_probe_char5", {
      p_adresse: "PROBE",
      p_code_postal: "00000",
      p_code_insee: "00000",
    });
    if (error) {
      throw new Error(
        `[france-data-mcp] HARD GATE INERTE : la DB est joignable mais la sonde rpps_normalize_address_key_probe_char5 est absente — la migration 20260516T060000_geocoded_addresses_cache.sql n'a pas été (ré)appliquée (la CLI supabase SKIPPE les migrations T-format ; appliquer via psql en local / SQL Editor en prod). Erreur RPC : ${error.message}`,
      );
    }
  });

  for (const c of CHAR5_CASES) {
    it(`JS == sonde TEXT == sonde CHAR(5) : ${c.label}`, async () => {
      // Côté JS : LE contrat (forme 3-arg, sans `ville`). Le JS reçoit la
      // valeur BRUTE (pas de pad : il n'a pas connaissance de CHAR(5)).
      const jsResult = normalizeAddressKey(c.adresse, c.codePostal, c.codeInsee);

      // Sonde TEXT (chemin "logique" — pas de pad bpchar).
      const { data: textResult, error: textErr } = await svc.rpc(
        "rpps_normalize_address_key_probe",
        { p_adresse: c.adresse, p_code_postal: c.codePostal, p_code_insee: c.codeInsee },
      );
      expect(
        textErr,
        `RPC rpps_normalize_address_key_probe a échoué: ${textErr?.message}`,
      ).toBeNull();

      // Sonde CHAR(5) (chemin PRODUCTION — code_postal/code_insee castés
      // ::CHAR(5)::TEXT = blank-pad bpchar puis relecture, exactement ce que
      // la jointure d'ingestion lit depuis rpps_staging).
      const { data: char5Result, error: char5Err } = await svc.rpc(
        "rpps_normalize_address_key_probe_char5",
        { p_adresse: c.adresse, p_code_postal: c.codePostal, p_code_insee: c.codeInsee },
      );
      expect(
        char5Err,
        `RPC rpps_normalize_address_key_probe_char5 a échoué: ${char5Err?.message}`,
      ).toBeNull();

      // INVARIANT : le blank-pad CHAR(5) (codes courts → "751  ") DOIT être
      // neutralisé symétriquement par btrim (SQL) comme .trim() (JS). Cette
      // assertion ÉCHOUERAIT si le padding perturbait jamais la clé. NE PAS
      // affaiblir : divergence = panne TOTALE silencieuse de la jointure.
      expect(char5Result).toBe(jsResult);
      // Cohérence transitive : la sonde TEXT et la sonde CHAR(5) doivent
      // converger sur la MÊME clé que JS (codes RPPS réels ≤5 chars).
      expect(textResult).toBe(jsResult);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — `accepted=true` + lat/lon NULL ne doit JAMAIS corrompre le staging.
// Défense en profondeur, deux gardes :
//  (1) WRITE-path : CHECK `accepted=false OR (lat IS NOT NULL AND lon IS NOT
//      NULL)` → testé ICI via supabase-js (insert rejeté). C'est la garantie
//      forte : un futur bug d'écriture Task 13 devient une erreur BRUYANTE.
//  (2) READ-path : la RPC filtre `g.lat IS NOT NULL AND g.lon IS NOT NULL`.
//      Ce chemin NE PEUT PAS être testé via supabase-js sans contourner le
//      CHECK (qui rend justement la précondition impossible) et le repo n'a
//      pas de client `pg` pour du DDL/raw-SQL en test. Il est PROUVÉ par SQL
//      direct (psql, tx rollback) au moment de l'application de la migration
//      et reporté dans le rapport de tâche (rpc_rows_updated=0, staging
//      geom_source NON flippé). Ne PAS simuler ici un chemin malhonnête.
//
// Le CHECK rendant accepted+NULL impossible EST le résultat le plus fort
// demandé par la spec (« turns a future writer bug into a loud error »).
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!canRun)("R4 — write-path : CHECK rejette accepted=true + coords NULL", () => {
  let svc: SupabaseClient;
  const KEY = "ZZR4PARITY|67000|67482"; // clé de test dédiée (teardown ciblé)

  beforeAll(async () => {
    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const probe = await svc.rpc("rpps_normalize_address_key_probe", {
      p_adresse: "PROBE",
      p_code_postal: "00000",
      p_code_insee: "00000",
    });
    if (probe.error) {
      throw new Error(
        `[france-data-mcp] R4 : migration non appliquée (probe absente) : ${probe.error.message}`,
      );
    }
    await svc.from("geocoded_addresses").delete().eq("address_key", KEY);
  });

  afterAll(async () => {
    if (!canRun || !svc) return;
    await svc.from("geocoded_addresses").delete().eq("address_key", KEY);
  });

  it("le CHECK write-path REJETTE un insert accepted=true avec lat/lon NULL", async () => {
    const { error } = await svc.from("geocoded_addresses").insert({
      address_key: KEY,
      lat: null,
      lon: null,
      accepted: true,
    });
    // L'insert DOIT échouer (write-path guard) — surtout PAS être accepté
    // silencieusement (sinon corruption geom à l'ingestion via la RPC).
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(
      /geocoded_addresses_accepted_has_coords|check constraint/i,
    );
  });

  it("un insert accepted=false avec coords NULL reste AUTORISÉ (état pending légitime)", async () => {
    // Contre-épreuve : le CHECK ne doit pas sur-bloquer l'état « pending »
    // normal (adresse pas encore résolue : accepted=false, coords NULL).
    const { error } = await svc.from("geocoded_addresses").insert({
      address_key: KEY,
      lat: null,
      lon: null,
      accepted: false,
    });
    expect(error).toBeNull();
    await svc.from("geocoded_addresses").delete().eq("address_key", KEY);
  });
});
