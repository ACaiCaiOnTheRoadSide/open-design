-- Restore project dimensions consumed by the backend project inventory.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS skill_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_system_id text;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS skill_id text;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS design_system_id text;

-- Optional provider/runtime facts: old rows remain NULL instead of becoming
-- misleading zeroes. Producers only set values that were actually reported.
ALTER TABLE message_token_usage ADD COLUMN IF NOT EXISTS cost_usd double precision;
ALTER TABLE message_token_usage ADD COLUMN IF NOT EXISTS duration_ms bigint;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'message_token_usage'::regclass
      AND conname = 'message_token_usage_cost_usd_check') THEN
    ALTER TABLE message_token_usage ADD CONSTRAINT message_token_usage_cost_usd_check
      CHECK (cost_usd IS NULL OR cost_usd >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'message_token_usage'::regclass
      AND conname = 'message_token_usage_duration_ms_check') THEN
    ALTER TABLE message_token_usage ADD CONSTRAINT message_token_usage_duration_ms_check
      CHECK (duration_ms IS NULL OR duration_ms >= 0);
  END IF;
END;
$migration$;
