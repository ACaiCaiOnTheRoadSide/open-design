CREATE TABLE IF NOT EXISTS run_queue (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
  owner_id text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  finished_at timestamptz,
  error_text text
);

CREATE INDEX IF NOT EXISTS run_queue_pending_fifo_idx
  ON run_queue (created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS run_queue_running_global_idx
  ON run_queue (status)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS run_queue_running_tenant_idx
  ON run_queue (tenant_id, status)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS run_queue_lease_idx
  ON run_queue (lease_expires_at)
  WHERE status IN ('pending', 'running');

