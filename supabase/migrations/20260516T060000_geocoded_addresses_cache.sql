-- Phase 2 (RPPS BAN-geocoding) — Task 8 : cache persistant `geocoded_addresses`
-- + jumeau SQL BYTE-EXACT de `normalizeAddressKey`
-- (`src/core/address-geocode.ts`, forme 3-arg) + RPC d'application au staging.
--
-- ┌─ POURQUOI C'EST LE POINT UNIQUE DE PANNE TOTALE SILENCIEUSE ──────────────┐
-- │ Le cache est indexé par la clé normalisée d'adresse. À l'ingestion, la    │
-- │ RPC joint `rpps_staging` au cache en RECALCULANT la MÊME clé EN SQL. Si   │
-- │ la clé SQL diverge de la clé JS d'UN SEUL octet, tout lookup rate, la     │
-- │ jointure ne trouve rien, le pipeline géocode ZÉRO ligne en rapportant     │
-- │ un succès. D'où le test de parité octet-à-octet JS↔SQL en HARD GATE       │
-- │ (`scripts/ingest/ban-geocode-parity.integration.test.ts`).                │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- CONTRAT DE FORME D'ARGUMENTS (C1/D3) — à honorer par Task 9 :
-- Le caller Phase 2 appelle `normalizeAddressKey(adresse, codePostal,
-- codeInsee)` SANS l'argument `ville` → clé À 3 SEGMENTS. Le jumeau SQL prend
-- donc EXACTEMENT 3 arguments et émet une clé à 3 segments
-- `array_to_string(ARRAY[a, cp, insee], '|')`. Les segments vides sont
-- PRÉSERVÉS (NULL adresse → `"|75001|75101"`), d'où `array_to_string` et
-- surtout PAS `concat_ws('|', …)` qui DROPPE les NULL/segments vides en queue.
--
-- Migration idempotente (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, GRANT idempotents, CHECK ajouté via DO guardé). Appliquée en PROD
-- par le mainteneur via le Supabase SQL Editor (`pnpm db:push` cassé ; la CLI
-- supabase SKIPPE les migrations au format `YYYYMMDDThhmmss_` — contrainte
-- projet connue, hors scope de ce ticket).

-- ───────────────────────────────────────────────────────────────────────────
-- (1) Table cache PERSISTANTE
-- ───────────────────────────────────────────────────────────────────────────
-- IMPORTANT : cette table vit HORS du swap atomique mensuel `rpps`. Elle n'est
-- JAMAIS droppée à `ingest_create_rpps_staging` / au rename de swap : c'est un
-- cache de géocodage BAN amorti sur plusieurs ingests (un appel BAN coûte ;
-- une adresse résolue ne doit pas être re-soumise chaque mois).
CREATE TABLE IF NOT EXISTS geocoded_addresses (
  address_key       TEXT PRIMARY KEY,
  lat               DOUBLE PRECISION,
  lon               DOUBLE PRECISION,
  result_score      DOUBLE PRECISION,
  result_type       TEXT,
  accepted          BOOLEAN     NOT NULL DEFAULT false,
  ban_attempt_count INT         NOT NULL DEFAULT 0,
  ban_last_status   TEXT,
  geocoded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- R4 (write-path guard) — un `accepted=true` avec lat/lon NULL ferait poser
-- geom=NULL + geom_source='ban_address' par la RPC (corruption SILENCIEUSE :
-- praticien exclu du re-traitement ET du fallback centroïde, compté en succès).
-- Le CHECK transforme un futur bug d'écriture Task 13 en erreur BRUYANTE.
-- Ajout idempotent via DO guardé (ADD CONSTRAINT IF NOT EXISTS n'existe pas en
-- PG ; pattern aligné sur les autres migrations du repo qui ajoutent un
-- contrainte conditionnellement).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'geocoded_addresses_accepted_has_coords'
      AND conrelid = 'geocoded_addresses'::regclass
  ) THEN
    ALTER TABLE geocoded_addresses
      ADD CONSTRAINT geocoded_addresses_accepted_has_coords
      CHECK (accepted = false OR (lat IS NOT NULL AND lon IS NOT NULL));
  END IF;
END$$;

ALTER TABLE geocoded_addresses ENABLE ROW LEVEL SECURITY;
-- Aucune policy anon : table interne d'ingestion. `service_role` bypass RLS,
-- mais on GRANT explicitement les DML qu'il exerce (insert/select/update du
-- cache au fil du pipeline BAN).
GRANT SELECT, INSERT, UPDATE ON geocoded_addresses TO service_role;

COMMENT ON TABLE geocoded_addresses IS
  'Phase 2 RPPS BAN — cache PERSISTANT de géocodage adresse, indexé par la clé normalisée (rpps_normalize_address_key = jumeau SQL byte-exact de src/core/address-geocode.ts normalizeAddressKey, forme 3-arg adresse|code_postal|code_insee). Vit HORS du swap atomique mensuel rpps (jamais droppée). accepted=true = résultat figé (BAN ne sera JAMAIS re-soumis) ; CHECK garantit lat/lon non NULL si accepted (R4). accepted=false = retenté à chaque ingest jusqu''au cap ban_attempt_count. RLS ON, aucune policy anon (table interne ; service_role bypass + GRANT explicite SELECT/INSERT/UPDATE).';

-- ───────────────────────────────────────────────────────────────────────────
-- (2) JUMEAU SQL BYTE-EXACT de normalizeAddressKey (forme 3-arg)
-- ───────────────────────────────────────────────────────────────────────────
-- Contrat JS (src/core/address-geocode.ts, vérifié) :
--   norm(s) = (s ?? "").replace(/\bCEDEX\s*\d*/gi, " ")
--                      .replace(/\s+/g, " ").trim().toUpperCase()
--   clé    = [norm(adresse), norm(codePostal), norm(codeInsee)].join("|")
--
-- ORDRE SQL EXACT (corrigé R3) — appliqué UNE fois dans rpps_norm_field :
--   coalesce → uspace→ASCII → CEDEX(\y) → collapse \s+ → btrim
--            → R1 pré-replace de casse → upper
--
--  • `coalesce(x,'')`           ⇔ JS `(s ?? "")`.
--
--  • R3 — pré-replace espaces Unicode AVANT le CEDEX (CORRIGÉ) :
--    JS `CEDEX_RE = /\bCEDEX\s*\d*/gi` : son `\s*` matche U+00A0/U+202F, donc
--    `"CEDEX<NBSP>08"` est INTÉGRALEMENT retiré côté JS. Lancer le
--    regexp_replace CEDEX AVANT la normalisation des espaces laisserait
--    `<NBSP>08` (le `\s*` Postgres ne couvre pas U+00A0) → DIVERGENCE. On
--    déplace donc le pré-replace `uspace`→espace ASCII EN PREMIER : le `\s*`
--    du motif CEDEX opère alors sur des espaces ASCII, comme le `\s*` JS opère
--    sur des espaces que SON `\s` reconnaît. `uspace` = sur-ensemble d'espaces
--    Unicode du `\s` JS NON garanti par le `\s` Postgres ; classe chr()
--    (encodage-robuste). U+0085 (NEL) EXCLU de `uspace` (JS `\s` ne le matche
--    PAS) → préservé des 2 côtés (verrouillé en test de régression).
--
--  • CEDEX : `regexp_replace(x, '\yCEDEX\s*\d*', ' ', 'gi')`
--    ⇔ JS `.replace(/\bCEDEX\s*\d*/gi, " ")`. D2 : Postgres `\b` ≠ frontière
--    de mot → `\y`. Vérifié : `"75116CEDEX"` (pas de séparateur) NON retiré
--    (digit→lettre n'est pas une frontière `\y`, comme JS `\b`) ; `"CEDEX"`,
--    `"CEDEX 8"`, `"CEDEX<NBSP>08"` (→ post-uspace `"CEDEX 08"`) retirés = JS.
--
--  • collapse `\s+` → ' ' : tous les espaces sont ASCII à ce stade (Postgres
--    `\s` couvre l'ASCII [ \t\n\r\f\v], tous ⊂ `\s` JS) → byte-égal JS.
--
--  • `btrim(...)`               ⇔ JS `.trim()` (que des espaces ASCII en bord).
--
--  • R1 — pré-replace de casse AVANT upper (CRITIQUE, CORRIGÉ) :
--    FAUX en v1 : « collation en_US.UTF-8 prod-équivalent ». `upper()` est
--    régi par LC_CTYPE, PAS LC_COLLATE. Supabase PROD initdb =
--    `lc_ctype = C.UTF-8` (glibc). glibc `towupper()` est MONO-caractère :
--    AUCUNE expansion multi-char. PROUVÉ localement via `COLLATE "C.utf8"`
--    (= prod-équivalent, collation présente localement) :
--      upper('ß' C.utf8)='ß'  INCHANGÉ  ≠ V8 'ß'.toUpperCase()='SS'
--      upper('ﬀ'..'ﬆ')        INCHANGÉS ≠ V8 'FF'..'ST'
--      upper('ŉ')='ŉ'         INCHANGÉ  ≠ V8 'ʼN' (U+02BC N)
--      upper('ǰ')='ǰ'         INCHANGÉ  ≠ V8 'J̌'  (J U+030C)
--      upper('ſ')='S'         1:1 OK    = V8 'S'                        ✓
--      É À Ç Ô Û Ü Î Â Ï Ÿ Œ Æ : 1:1 corrects sous C.utf8 = V8          ✓
--    → sans correctif, toute adresse RPPS contenant `ß` (rues d'origine
--    allemande en Alsace-Moselle : « STRAßE ») produit en PROD une clé qui ne
--    matche JAMAIS la clé JS → géocodage-zéro SILENCIEUX sur ces lignes.
--    Fix SQL-only (miroir du trick chr() de R3) : AVANT `upper()`, pré-remplacer
--    le sous-ensemble FINI de codepoints où glibc C.UTF-8 diverge de la pleine
--    table de casse Unicode V8, chacun par la forme MINUSCULE de la sortie V8
--    — ainsi le `upper()` suivant produit exactement la sortie V8. Pré-remplacés
--    (et UNIQUEMENT ceux-là ; les précomposés accentués mappent 1:1 sous
--    C.UTF-8, on n'y touche pas — la sonde prod Task 14 les reconfirme) :
--      ß  U+00DF → 'ss'                 (upper → 'SS'  = V8)
--      ﬀ U+FB00 → 'ff'   ﬁ U+FB01 → 'fi'   ﬂ U+FB02 → 'fl'
--      ﬃ U+FB03 → 'ffi'  ﬄ U+FB04 → 'ffl'
--      ﬅ U+FB05 → 'st'   ﬆ U+FB06 → 'st'
--      ŉ  U+0149 → U+02BC||'n'          (upper → U+02BC 'N' = V8 'ʼN')
--      ǰ  U+01F0 → 'j'||U+030C          (upper → 'J' U+030C = V8 'J̌')
--    `ſ` U+017F N'EST PAS pré-remplacé (glibc C.UTF-8 fait déjà ſ→S 1:1 = V8).
--    Tous ces codepoints + `ſ` + U+0085 sont VÉRIFIÉS dans le HARD GATE — une
--    divergence réelle ne peut pas se cacher. AUCUN unaccent (Task 6 préserve).
--
--  • `upper(...)`               ⇔ JS `.toUpperCase()` (post pré-replace R1).
--
--  • arité (D3) : `array_to_string(ARRAY[a,cp,insee],'|')` TOUJOURS 3 éléments
--    ⇔ JS `.join("|")`. PAS `concat_ws` (DROPPE NULL/vides en queue). Vides
--    (coalesce→'') conservés par ARRAY[].
--
-- rpps_norm_field FACTORISE la normalisation d'UN champ : la logique était
-- triplée à l'identique ; un fix R1/R3 sur une seule des 3 copies aurait
-- recréé la divergence silencieuse. IMMUTABLE (pure : regex+replace+upper).
CREATE OR REPLACE FUNCTION rpps_norm_field(p_in TEXT, p_uspace TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(
    -- R1 — pré-replace de casse (codepoints glibc C.UTF-8 ≠ V8) en MINUSCULE
    -- de la sortie V8, AVANT upper. regexp_replace chaînés (literal chr()).
    regexp_replace(
     regexp_replace(
      regexp_replace(
       regexp_replace(
        regexp_replace(
         regexp_replace(
          regexp_replace(
           regexp_replace(
            regexp_replace(
              btrim(
                regexp_replace(
                  -- CEDEX (\y, D2) APRÈS la normalisation des espaces (R3).
                  -- R5-bis : classe d'espaces EXPLICITE [ \t\n\x0B\f\r] et NON
                  -- `\s` Postgres. `\s` Postgres matche U+0085 (NEL) ; JS `\s`
                  -- (et donc le `\s*` de CEDEX_RE) NE le matche PAS → U+0085
                  -- doit être PRÉSERVÉ. La classe explicite = exactement
                  -- l'ASCII-whitespace de JS `\s` (le sur-ensemble Unicode est
                  -- déjà ramené à un espace ASCII par le pré-replace uspace
                  -- R3 qui précède). btrim() opère ensuite sur ces espaces.
                  regexp_replace(
                    -- R3 : uspace → espace ASCII EN PREMIER
                    regexp_replace(coalesce(p_in, ''), p_uspace, ' ', 'g'),
                    '\yCEDEX[ \t\n\x0B\f\r]*\d*', ' ', 'gi'),
                  '[ \t\n\x0B\f\r]+', ' ', 'g')
              ),
              chr(223),  'ss',  'g'),                       -- ß  U+00DF
            chr(64256), 'ff',  'g'),                        -- ﬀ U+FB00
           chr(64257), 'fi',  'g'),                         -- ﬁ U+FB01
          chr(64258), 'fl',  'g'),                          -- ﬂ U+FB02
         chr(64259), 'ffi', 'g'),                           -- ﬃ U+FB03
        chr(64260), 'ffl', 'g'),                            -- ﬄ U+FB04
       '[' || chr(64261) || chr(64262) || ']', 'st', 'g'),  -- ﬅ ﬆ U+FB05/06
      chr(329), chr(700) || 'n', 'g'),                      -- ŉ  U+0149
     chr(496), 'j' || chr(780), 'g')                        -- ǰ  U+01F0
  );
$$;

COMMENT ON FUNCTION rpps_norm_field(TEXT, TEXT) IS
  'Phase 2 RPPS BAN — helper IMMUTABLE : normalise UN champ pour rpps_normalize_address_key (factorisé pour éviter la triplication = divergence silencieuse). Ordre R3 : coalesce → uspace→ASCII → CEDEX(\y) → collapse \s+ → btrim → R1 pré-replace casse (glibc C.UTF-8 ≠ V8 : ß/ligatures/ŉ/ǰ) → upper.';

-- LANGUAGE sql IMMUTABLE : fonction pure → IMMUTABLE légitime (et requis :
-- utilisée dans la jointure de la RPC d'ingestion).
CREATE OR REPLACE FUNCTION rpps_normalize_address_key(
  p_adresse     TEXT,
  p_code_postal TEXT,
  p_code_insee  TEXT
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  WITH cfg AS (
    -- uspace : sur-ensemble d'espaces Unicode du `\s` JS NON garanti par le
    -- `\s` Postgres. EXCLUT U+0085 (JS `\s` ne le matche pas). chr()-robuste.
    SELECT (
      '['
      || chr(160)                 -- U+00A0 NBSP
      || chr(5760)                -- U+1680 OGHAM SPACE MARK
      || chr(8192) || '-' || chr(8202)  -- U+2000..U+200A
      || chr(8232)                -- U+2028 LINE SEPARATOR
      || chr(8233)                -- U+2029 PARAGRAPH SEPARATOR
      || chr(8239)                -- U+202F NARROW NO-BREAK SPACE
      || chr(8287)                -- U+205F MEDIUM MATHEMATICAL SPACE
      || chr(12288)               -- U+3000 IDEOGRAPHIC SPACE
      || chr(65279)               -- U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
      || ']'
    ) AS uspace
  )
  SELECT array_to_string(
    ARRAY[
      rpps_norm_field(p_adresse,     cfg.uspace),
      rpps_norm_field(p_code_postal, cfg.uspace),
      rpps_norm_field(p_code_insee,  cfg.uspace)
    ], '|')
  FROM cfg;
$$;

COMMENT ON FUNCTION rpps_normalize_address_key(TEXT, TEXT, TEXT) IS
  'Phase 2 RPPS BAN — JUMEAU SQL BYTE-EXACT de src/core/address-geocode.ts normalizeAddressKey (FORME 3-ARG : adresse|code_postal|code_insee, SANS ville — contrat C1/D3 honoré par Task 9). UNIQUE source de vérité côté SQL (jointure RPC + sonde test). Ordre R3 via rpps_norm_field : coalesce → uspace→ASCII → CEDEX(\y, D2) → collapse \s+ → btrim → R1 pré-replace casse (prod LC_CTYPE=C.UTF-8 : ß→ss, ligatures, ŉ, ǰ) → upper. array_to_string de 3 éléments, JAMAIS concat_ws (D3). Toute divergence d''un octet casse la jointure cache → 0 ligne géocodée silencieusement. Garde-fou : scripts/ingest/ban-geocode-parity.integration.test.ts.';

-- Sonde STABLE appelable par le test de parité via supabase-js (service client)
-- — délègue strictement au jumeau (même source de vérité, zéro logique en
-- plus). STABLE (et non IMMUTABLE) car simple wrapper exposé en RPC PostgREST.
CREATE OR REPLACE FUNCTION rpps_normalize_address_key_probe(
  p_adresse     TEXT,
  p_code_postal TEXT,
  p_code_insee  TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT rpps_normalize_address_key(p_adresse, p_code_postal, p_code_insee);
$$;

REVOKE EXECUTE ON FUNCTION rpps_normalize_address_key_probe(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpps_normalize_address_key_probe(TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION rpps_normalize_address_key_probe(TEXT, TEXT, TEXT) IS
  'Phase 2 RPPS BAN — sonde RPC du jumeau SQL rpps_normalize_address_key, appelée par le HARD GATE de parité JS↔SQL (scripts/ingest/ban-geocode-parity.integration.test.ts) via supabase-js service client. Délègue strictement (aucune logique propre).';

-- Sonde CHAR(5) ROUND-TRIP — mime EXACTEMENT le chemin PRODUCTION : la RPC
-- d'ingestion joint sur rpps_normalize_address_key(s.adresse, s.code_postal,
-- s.code_insee) où s.code_postal / s.code_insee sont des colonnes CHAR(5)
-- (bpchar, BLANK-PADDÉES à 5). Un code court ("751", "750") y est stocké
-- "751  " / "750  " (espaces de queue). La sonde TEXT ci-dessus ne teste PAS
-- ce padding ; celle-ci caste les codes en CHAR(5) PUIS retour TEXT (le
-- read d'une colonne bpchar) AVANT de déléguer au jumeau. L'INVARIANT testé :
-- JS `.trim()` et SQL `btrim` (dans rpps_norm_field) neutralisent
-- SYMÉTRIQUEMENT ce blank-pad → clé identique. Une régression future qui
-- perturberait ce round-trip (ex. retrait du btrim) ferait DIVERGER cette
-- sonde de la clé JS = panne totale silencieuse de la jointure cache.
-- p_adresse reste TEXT (la colonne rpps_staging.adresse est TEXT, pas bpchar).
CREATE OR REPLACE FUNCTION rpps_normalize_address_key_probe_char5(
  p_adresse     TEXT,
  p_code_postal TEXT,
  p_code_insee  TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  -- ::CHAR(5)::TEXT = blank-pad à 5 puis relecture TEXT (= lecture d'une
  -- colonne bpchar). NULL reste NULL (cast NULL→CHAR(5)→TEXT = NULL).
  SELECT rpps_normalize_address_key(
    p_adresse,
    p_code_postal::CHAR(5)::TEXT,
    p_code_insee::CHAR(5)::TEXT
  );
$$;

REVOKE EXECUTE ON FUNCTION rpps_normalize_address_key_probe_char5(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpps_normalize_address_key_probe_char5(TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION rpps_normalize_address_key_probe_char5(TEXT, TEXT, TEXT) IS
  'Phase 2 RPPS BAN — sonde RPC qui mime le chemin PRODUCTION : code_postal/code_insee castés ::CHAR(5)::TEXT (blank-pad bpchar puis relecture) AVANT le jumeau. Prouve EXÉCUTABLEMENT que le round-trip CHAR(5) ne perturbe PAS la clé (JS .trim() ↔ SQL btrim symétriques). Co-appelée avec rpps_normalize_address_key_probe par le HARD GATE de parité (assertion JS == probe TEXT == probe CHAR5).';

-- ───────────────────────────────────────────────────────────────────────────
-- (3) RPC d'application : cache accepté → rpps_staging (batch id-ordonné)
-- ───────────────────────────────────────────────────────────────────────────
-- Jointure via rpps_normalize_address_key(s.adresse, s.code_postal,
-- s.code_insee) — LA MÊME fonction que le test de parité (source unique).
--
-- Éligibilité EXACTE (spec §4.3 — priorité finess_join JAMAIS touchée) :
--   g.accepted = true
--   AND g.lat IS NOT NULL AND g.lon IS NOT NULL          -- R4 (read-path)
--   AND ( s.geom_source = 'commune_centroid'
--         OR (s.geom IS NULL AND s.adresse IS NOT NULL) )
--   AND s.geom_source IS DISTINCT FROM 'ban_address'
--   AND s.geom_source IS DISTINCT FROM 'finess_join'
-- R4 : `g.lat/g.lon IS NOT NULL` garde le READ path (le CHECK garde le WRITE
-- path) — défense en profondeur : sans lui, un accepted à coords NULL ferait
-- ST_MakePoint(NULL,NULL) → geom=NULL + geom_source='ban_address' (corruption
-- silencieuse : ligne exclue du re-traitement ET du fallback centroïde,
-- comptée en succès dans ROW_COUNT).
-- `IS DISTINCT FROM` garantit que `finess_join` (et un `ban_address` déjà
-- posé) ne sont JAMAIS écrasés, même si geom_source est NULL.
--
-- Batch déterministe ORDER BY s.id LIMIT p_limit : loopable par
-- `runBatchedRpc` (retourne le nb de lignes mises à jour INT, converge vers 0
-- car chaque ligne traitée passe geom_source='ban_address' → exclue au tour
-- suivant par le `IS DISTINCT FROM 'ban_address'`).
--
-- geog est GENERATED ALWAYS … STORED → se régénère seule à l'UPDATE de geom :
-- NE PAS écrire geog (erreur 428C9 sinon).
CREATE OR REPLACE FUNCTION ingest_apply_rpps_ban_geocoding_batch(p_limit INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH eligible AS (
    SELECT s.id, g.lat, g.lon
    FROM rpps_staging s
    JOIN geocoded_addresses g
      ON g.address_key = rpps_normalize_address_key(
           s.adresse, s.code_postal, s.code_insee)
    WHERE g.accepted = true
      AND g.lat IS NOT NULL
      AND g.lon IS NOT NULL
      AND (
        s.geom_source = 'commune_centroid'
        OR (s.geom IS NULL AND s.adresse IS NOT NULL)
      )
      AND s.geom_source IS DISTINCT FROM 'ban_address'
      AND s.geom_source IS DISTINCT FROM 'finess_join'
    ORDER BY s.id
    LIMIT p_limit
  )
  UPDATE rpps_staging s
  SET geom        = ST_SetSRID(ST_MakePoint(e.lon, e.lat), 4326),
      geom_source = 'ban_address'
  FROM eligible e
  WHERE s.id = e.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_ban_geocoding_batch(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_apply_rpps_ban_geocoding_batch(INT) TO service_role;

COMMENT ON FUNCTION ingest_apply_rpps_ban_geocoding_batch(INT) IS
  'Phase 2 RPPS BAN — applique le cache accepté (geocoded_addresses.accepted=true ET lat/lon non NULL, R4) à rpps_staging par batch id-ordonné (ORDER BY id LIMIT p_limit), jointure via rpps_normalize_address_key (source unique). Éligibilité §4.3 : centroïde commune OU (geom NULL ET adresse non NULL), JAMAIS ban_address déjà posé NI finess_join (IS DISTINCT FROM). UPDATE geom + geom_source=ban_address (geog GENERATED se régénère seule). Retourne ROW_COUNT (INT) → loopable runBatchedRpc, converge vers 0. SECURITY DEFINER, EXECUTE service_role only.';
