-- Older deployments reused the full local messages table for PostgreSQL facts.
-- Status projections do not contain transcript fields, so remove only the
-- legacy constraints that would reject otherwise valid projection rows.
DO $migration$
DECLARE
  legacy_column text;
BEGIN
  FOR legacy_column IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'messages'
       AND column_name IN ('role', 'content', 'position')
       AND is_nullable = 'NO'
  LOOP
    EXECUTE format(
      'ALTER TABLE messages ALTER COLUMN %I DROP NOT NULL',
      legacy_column
    );
  END LOOP;
END;
$migration$;
