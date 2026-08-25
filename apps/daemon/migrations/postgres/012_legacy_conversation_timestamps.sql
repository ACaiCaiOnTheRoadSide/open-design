-- The compact business-facts conversations table only requires id/project_id,
-- but older multitenant schemas retain mandatory BIGINT timestamp columns.
-- Keep those historical columns populated without making every fact writer
-- depend on fields that do not exist in fresh schemas.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'conversations'
       AND column_name = 'created_at'
  ) THEN
    ALTER TABLE conversations
      ALTER COLUMN created_at SET DEFAULT ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'conversations'
       AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE conversations
      ALTER COLUMN updated_at SET DEFAULT ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint);
  END IF;
END;
$migration$;
