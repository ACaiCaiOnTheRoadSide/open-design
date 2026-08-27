CREATE TABLE IF NOT EXISTS appstats_run_results (
  event_key text PRIMARY KEY,
  run_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  user_id text NOT NULL,
  tenant_id text NOT NULL,
  access_mode text NOT NULL CHECK (access_mode = 'online'),
  feature text NOT NULL CHECK (feature = 'agent.run'),
  result text NOT NULL CHECK (result IN ('success', 'failed')),
  completed_at bigint NOT NULL CHECK (completed_at >= 0),
  claimed_at bigint,
  claim_token text,
  reported_at bigint,
  last_error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CHECK (claimed_at IS NULL OR claimed_at >= 0),
  CHECK (reported_at IS NULL OR reported_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_appstats_run_results_pending
  ON appstats_run_results (completed_at, event_key)
  WHERE reported_at IS NULL;
