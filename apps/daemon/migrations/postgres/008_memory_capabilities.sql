-- Principal-scoped history for Memory capabilities that used to live in
-- process-global ring buffers. JSONB preserves the public SQLite payload while
-- the relational keys make every read/mutation tenant and user safe.
CREATE TABLE IF NOT EXISTS memory_extractions (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('running', 'success', 'failed', 'skipped')),
  payload jsonb NOT NULL,
  started_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, user_id, id)
);
CREATE INDEX IF NOT EXISTS memory_extractions_principal_page_idx
  ON memory_extractions (tenant_id, user_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS memory_extractions_principal_phase_page_idx
  ON memory_extractions (tenant_id, user_id, phase, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS memory_verifications (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  id text NOT NULL,
  project_id text,
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'missing')),
  payload jsonb NOT NULL,
  occurred_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, user_id, id),
  CHECK (project_id IS NULL OR (
    char_length(project_id) BETWEEN 1 AND 128 AND project_id !~ '[[:cntrl:]]'
  ))
);
CREATE INDEX IF NOT EXISTS memory_verifications_principal_page_idx
  ON memory_verifications (tenant_id, user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS memory_verifications_principal_status_page_idx
  ON memory_verifications (tenant_id, user_id, status, occurred_at DESC, id DESC);
