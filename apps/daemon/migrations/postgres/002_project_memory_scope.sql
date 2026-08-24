ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS project_id TEXT;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'memory_entries'::regclass
      AND conname = 'memory_entries_project_id_check'
  ) THEN
    ALTER TABLE memory_entries
      ADD CONSTRAINT memory_entries_project_id_check
      CHECK (
        project_id IS NULL
        OR (
          char_length(project_id) BETWEEN 1 AND 128
          AND project_id !~ '[[:cntrl:]]'
        )
      );
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS memory_entries_principal_project_updated_idx
  ON memory_entries (tenant_id, user_id, project_id, updated_at DESC);
