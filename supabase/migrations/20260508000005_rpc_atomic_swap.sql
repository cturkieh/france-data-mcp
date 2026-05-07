-- Atomic swap: rename <table>_staging → <table>, preserving previous as <table>_previous.
-- Caller is responsible for ensuring the staging table exists.
CREATE OR REPLACE FUNCTION ingest_atomic_swap(p_prod_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_staging  TEXT := p_prod_table || '_staging';
  v_previous TEXT := p_prod_table || '_previous';
  v_old_old  TEXT := p_prod_table || '_previous_OLD';
BEGIN
  -- Validate identifier (defense-in-depth against injection through RPC)
  IF p_prod_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', p_prod_table;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_old_old);

  -- Move current previous out of the way (if any)
  IF to_regclass(v_previous) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', v_previous, v_old_old);
  END IF;

  -- Move current prod → previous (if any)
  IF to_regclass(p_prod_table) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', p_prod_table, v_previous);
  END IF;

  -- Promote staging → prod
  EXECUTE format('ALTER TABLE %I RENAME TO %I', v_staging, p_prod_table);

  -- Drop the rotated-out previous to free space
  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_old_old);
END;
$$;

-- Only service_role should ever call this (RLS bypass implicit).
REVOKE EXECUTE ON FUNCTION ingest_atomic_swap FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_atomic_swap TO service_role;
