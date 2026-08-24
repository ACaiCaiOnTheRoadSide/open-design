-- Durable delete barriers for the SQLite memory-history outbox projection.
-- '*' is a principal/kind clear cutoff; other record_id values are per-record
-- tombstones. Keeping these in PostgreSQL makes replay after a hard crash safe.
CREATE TABLE IF NOT EXISTS memory_history_tombstones (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('extraction', 'verification')),
  record_id text NOT NULL,
  projection_version bigint NOT NULL CHECK (projection_version >= 0),
  PRIMARY KEY (tenant_id, user_id, kind, record_id)
);
