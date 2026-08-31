-- Per-tool metadata for the application admin dashboard. Inputs and outputs are
-- deliberately excluded: they may contain prompts, credentials, or file data.
CREATE TABLE IF NOT EXISTS tool_call_facts (
  event_key text PRIMARY KEY,
  run_id text NOT NULL,
  user_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  conversation_id text NOT NULL,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'failed', 'unknown')),
  started_at bigint NOT NULL,
  completed_at bigint NOT NULL,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tool_call_facts_completed
  ON tool_call_facts (completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_call_facts_tool_completed
  ON tool_call_facts (tool_name, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_call_facts_tenant_completed
  ON tool_call_facts (tenant_id, completed_at DESC);
