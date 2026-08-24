-- Business statistics are a projection only. SQLite remains the daemon's primary
-- business store; these narrow tables are the durable PostgreSQL fact source read
-- by backend. All timestamps are Unix milliseconds, matching backend SQL.
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  tenant_id text NOT NULL,
  creator_id text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  published_count bigint NOT NULL DEFAULT 0 CHECK (published_count >= 0)
);
-- Historical full-metadata releases already have projects but accumulated fact
-- columns over several migrations. Complete/backfill that real shape first.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS creator_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS download_count bigint DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_count bigint DEFAULT 0;
UPDATE projects SET name = COALESCE(name, ''),
  tenant_id = COALESCE(NULLIF(tenant_id, ''), '__legacy__'),
  creator_id = COALESCE(NULLIF(creator_id, ''), NULLIF(tenant_id, ''), '__legacy__'),
  created_at = COALESCE(created_at, 0), updated_at = COALESCE(updated_at, created_at, 0),
  download_count = COALESCE(download_count, 0), published_count = COALESCE(published_count, 0)
WHERE name IS NULL OR tenant_id IS NULL OR creator_id IS NULL OR created_at IS NULL
   OR updated_at IS NULL OR download_count IS NULL OR published_count IS NULL;
ALTER TABLE projects ALTER COLUMN name SET NOT NULL;
ALTER TABLE projects ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN creator_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE projects ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE projects ALTER COLUMN download_count SET DEFAULT 0;
ALTER TABLE projects ALTER COLUMN download_count SET NOT NULL;
ALTER TABLE projects ALTER COLUMN published_count SET DEFAULT 0;
ALTER TABLE projects ALTER COLUMN published_count SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_tenant_created ON projects (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_creator_created ON projects (creator_id, created_at);

CREATE TABLE IF NOT EXISTS business_stat_events (
  event_key text PRIMARY KEY,
  project_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('download', 'publish')),
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_stat_events_project ON business_stat_events (project_id, created_at);

CREATE TABLE IF NOT EXISTS deleted_projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  tenant_id text NOT NULL,
  creator_id text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint NOT NULL,
  download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  published_count bigint NOT NULL DEFAULT 0 CHECK (published_count >= 0)
);
-- Historical tombstones had nullable name/creator and no updated/published columns.
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS creator_id text;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS created_at bigint;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS updated_at bigint;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS deleted_at bigint;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS download_count bigint DEFAULT 0;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS published_count bigint DEFAULT 0;
UPDATE deleted_projects SET name = COALESCE(name, ''),
  tenant_id = COALESCE(NULLIF(tenant_id, ''), '__legacy__'),
  creator_id = COALESCE(NULLIF(creator_id, ''), NULLIF(tenant_id, ''), '__legacy__'),
  created_at = COALESCE(created_at, 0),
  updated_at = COALESCE(updated_at, deleted_at, created_at, 0),
  deleted_at = COALESCE(deleted_at, updated_at, created_at, 0),
  download_count = COALESCE(download_count, 0), published_count = COALESCE(published_count, 0)
WHERE name IS NULL OR tenant_id IS NULL OR creator_id IS NULL OR created_at IS NULL
   OR updated_at IS NULL OR deleted_at IS NULL OR download_count IS NULL OR published_count IS NULL;
ALTER TABLE deleted_projects ALTER COLUMN name SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN creator_id SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN deleted_at SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN download_count SET DEFAULT 0;
ALTER TABLE deleted_projects ALTER COLUMN download_count SET NOT NULL;
ALTER TABLE deleted_projects ALTER COLUMN published_count SET DEFAULT 0;
ALTER TABLE deleted_projects ALTER COLUMN published_count SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deleted_projects_tenant_created ON deleted_projects (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deleted_projects_creator_created ON deleted_projects (creator_id, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  project_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_status text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
-- Historical full messages have no updated_at. Add it before either index and
-- backfill from the newest timestamp column that actually exists.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS run_status text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at bigint;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at bigint;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'ended_at') THEN
    EXECUTE 'UPDATE messages SET updated_at = COALESCE(updated_at, ended_at, started_at, created_at, 0) WHERE updated_at IS NULL';
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'started_at') THEN
    EXECUTE 'UPDATE messages SET updated_at = COALESCE(updated_at, started_at, created_at, 0) WHERE updated_at IS NULL';
  ELSE
    UPDATE messages SET updated_at = COALESCE(updated_at, created_at, 0) WHERE updated_at IS NULL;
  END IF;
END;
$migration$;
ALTER TABLE messages ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_updated ON messages (conversation_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_active_updated ON messages (updated_at DESC) WHERE run_status IN ('queued', 'starting', 'running');

CREATE TABLE IF NOT EXISTS message_token_usage (
  event_key text PRIMARY KEY,
  user_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  created_at bigint NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT
);
-- Older multitenant deployments already have message_token_usage with a
-- BIGSERIAL id and no idempotency/total columns. Preserve those immutable rows
-- while upgrading the table in place; PostgreSQL unique indexes allow multiple
-- NULLs, so historical rows need no fabricated event key.
ALTER TABLE message_token_usage ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE message_token_usage ADD COLUMN IF NOT EXISTS total_tokens bigint NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_token_usage_event_key
  ON message_token_usage (event_key);

CREATE INDEX IF NOT EXISTS idx_message_token_usage_tenant_created ON message_token_usage (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_token_usage_user_created ON message_token_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_token_usage_project_created ON message_token_usage (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_token_usage_model_created ON message_token_usage (model, created_at);
