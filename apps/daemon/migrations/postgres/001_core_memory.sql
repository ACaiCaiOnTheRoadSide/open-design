CREATE TABLE IF NOT EXISTS memory_entries (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('profile', 'user', 'feedback', 'project', 'reference', 'rule')),
  source TEXT CHECK (source IS NULL OR source IN ('heuristic', 'llm', 'manual', 'connector', 'brand', 'annotation')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS memory_entries_principal_updated_idx
  ON memory_entries (tenant_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_settings (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  index_body TEXT,
  config JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id)
);
