-- Audit trail of ingestion runs (one row per script execution)
CREATE TABLE ingest_log (
  id              BIGSERIAL PRIMARY KEY,
  source          VARCHAR(20)  NOT NULL,
  started_at      TIMESTAMPTZ  NOT NULL,
  finished_at     TIMESTAMPTZ,
  status          VARCHAR(20)  NOT NULL,  -- 'success' | 'partial' | 'failed'
  row_count       INTEGER,
  csv_size_bytes  BIGINT,
  csv_url         TEXT,
  error_phase     VARCHAR(20),            -- 'download' | 'pre_validate' | 'copy' | 'validate' | 'swap'
  error_message   TEXT,
  github_run_url  TEXT
);

CREATE INDEX ingest_log_source_started_idx ON ingest_log (source, started_at DESC);

-- Read-only access for anon (lets the public MCP server expose data freshness)
ALTER TABLE ingest_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon read ingest_log" ON ingest_log FOR SELECT TO anon USING (true);
-- service_role bypasses RLS naturally; no additional policy needed for ingestion writes.
