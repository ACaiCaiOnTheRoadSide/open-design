CREATE TABLE plugin_install_intents (
  plugin_id text PRIMARY KEY,
  desired_state text NOT NULL CHECK (desired_state IN ('installed', 'absent')),
  source text,
  source_kind text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (desired_state = 'installed' AND source IS NOT NULL AND source_kind IN ('github', 'https'))
    OR (desired_state = 'absent' AND source IS NULL AND source_kind IS NULL)
  )
);

