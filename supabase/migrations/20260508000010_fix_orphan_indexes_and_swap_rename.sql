-- Fix the orphan-index naming gotcha exposed by the V0.2 first prod ingestion.
--
-- Problem: Postgres `ALTER TABLE x RENAME TO y` renames the relation but NOT
-- its indexes. After the first successful swap (finess_staging → finess), the
-- prod `finess` table kept its staging-named indexes (`finess_staging_geom_gist`,
-- etc.), and the rotated-out `finess_previous` kept the canonical names
-- (`finess_geom_gist`, etc.). The next ingestion's `CREATE INDEX
-- finess_staging_geom_gist` then fails with "relation already exists".
--
-- Two-part fix:
--   (1) one-shot cleanup of the current prod state
--   (2) update `ingest_atomic_swap` to rename indexes alongside their table

-- ──────────────────────────────────────────────────────────────────────────
-- (1) One-shot cleanup
-- ──────────────────────────────────────────────────────────────────────────

-- Drop the rotated-out previous; its indexes hold the canonical names we
-- need to free up. We accept losing the 1-generation rollback for this
-- transition — the next ingestion will rebuild the chain cleanly.
DROP TABLE IF EXISTS finess_previous CASCADE;

-- Rename current prod's indexes from staging-prefixed back to canonical.
ALTER INDEX IF EXISTS finess_staging_geom_gist     RENAME TO finess_geom_gist;
ALTER INDEX IF EXISTS finess_staging_categorie_idx RENAME TO finess_categorie_idx;
ALTER INDEX IF EXISTS finess_staging_dept_idx      RENAME TO finess_dept_idx;

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Update ingest_atomic_swap to rename indexes alongside the table.
-- ──────────────────────────────────────────────────────────────────────────
-- Generic over p_prod_table — works for finess today, ameli/iris later.

CREATE OR REPLACE FUNCTION ingest_atomic_swap(p_prod_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_staging       TEXT := p_prod_table || '_staging';
  v_previous      TEXT := p_prod_table || '_previous';
  v_old_old       TEXT := p_prod_table || '_previous_OLD';
  v_idx_old       TEXT;
  v_idx_new       TEXT;
BEGIN
  IF p_prod_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', p_prod_table;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_old_old);

  IF to_regclass(v_previous) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', v_previous, v_old_old);
    -- Rename "<prod>_<rest>" indexes on the rotated-out table to "<old_old>_<rest>".
    FOR v_idx_old, v_idx_new IN
      SELECT indexname,
             p_prod_table || '_previous_OLD' || substring(indexname FROM length(p_prod_table) + 1)
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = v_old_old
        AND indexname LIKE p_prod_table || '_%'
    LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I', v_idx_old, v_idx_new);
    END LOOP;
  END IF;

  IF to_regclass(p_prod_table) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', p_prod_table, v_previous);
    -- Rename "<prod>_<rest>" indexes to "<previous>_<rest>" so the staging
    -- promotion below doesn't collide.
    FOR v_idx_old, v_idx_new IN
      SELECT indexname,
             p_prod_table || '_previous' || substring(indexname FROM length(p_prod_table) + 1)
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = v_previous
        AND indexname LIKE p_prod_table || '_%'
        AND indexname NOT LIKE p_prod_table || '_previous%'
    LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I', v_idx_old, v_idx_new);
    END LOOP;
  END IF;

  EXECUTE format('ALTER TABLE %I RENAME TO %I', v_staging, p_prod_table);
  -- Rename "<prod>_staging_<rest>" indexes to "<prod>_<rest>" on the new prod.
  FOR v_idx_old, v_idx_new IN
    SELECT indexname,
           p_prod_table || substring(indexname FROM length(v_staging) + 1)
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = p_prod_table
      AND indexname LIKE v_staging || '_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', v_idx_old, v_idx_new);
  END LOOP;

  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_old_old);
END;
$$;
