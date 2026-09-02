-- Identify MCP calls without retaining tool inputs or outputs. Existing rows are
-- backfilled from the canonical mcp__<server>__<tool> tool-name convention.
ALTER TABLE tool_call_facts
  ADD COLUMN IF NOT EXISTS tool_type text NOT NULL DEFAULT 'builtin',
  ADD COLUMN IF NOT EXISTS mcp_server_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS mcp_tool_name text NOT NULL DEFAULT '';

UPDATE tool_call_facts
SET tool_type = 'mcp',
    mcp_server_name = CASE
      WHEN position('__' in substring(tool_name from 6)) > 0
        THEN split_part(substring(tool_name from 6), '__', 1)
      ELSE 'unknown'
    END,
    mcp_tool_name = CASE
      WHEN position('__' in substring(tool_name from 6)) > 0
        THEN substring(
          substring(tool_name from 6)
          from position('__' in substring(tool_name from 6)) + 2
        )
      ELSE substring(tool_name from 6)
    END
WHERE tool_name LIKE 'mcp\_\_%' ESCAPE '\';

ALTER TABLE tool_call_facts
  DROP CONSTRAINT IF EXISTS tool_call_facts_tool_type_check;
ALTER TABLE tool_call_facts
  ADD CONSTRAINT tool_call_facts_tool_type_check
  CHECK (tool_type IN ('builtin', 'mcp'));

-- Old daemon instances can still write the 016 column set during a rolling
-- deployment. Derive dimensions in the database so those writes remain correct.
CREATE OR REPLACE FUNCTION set_tool_call_dimensions()
RETURNS trigger
LANGUAGE plpgsql
AS $tool_call_dimensions$
BEGIN
  IF NEW.tool_name LIKE 'mcp\_\_%' ESCAPE '\' THEN
    NEW.tool_type := 'mcp';
    IF position('__' in substring(NEW.tool_name from 6)) > 0 THEN
      NEW.mcp_server_name := split_part(substring(NEW.tool_name from 6), '__', 1);
      NEW.mcp_tool_name := substring(
        substring(NEW.tool_name from 6)
        from position('__' in substring(NEW.tool_name from 6)) + 2
      );
    ELSE
      NEW.mcp_server_name := 'unknown';
      NEW.mcp_tool_name := substring(NEW.tool_name from 6);
    END IF;
  ELSE
    NEW.tool_type := 'builtin';
    NEW.mcp_server_name := '';
    NEW.mcp_tool_name := '';
  END IF;
  RETURN NEW;
END;
$tool_call_dimensions$;

DROP TRIGGER IF EXISTS tool_call_dimensions_before_write ON tool_call_facts;
CREATE TRIGGER tool_call_dimensions_before_write
BEFORE INSERT OR UPDATE OF tool_name ON tool_call_facts
FOR EACH ROW EXECUTE FUNCTION set_tool_call_dimensions();

CREATE INDEX IF NOT EXISTS idx_tool_call_facts_dimensions_completed
  ON tool_call_facts (tool_type, mcp_server_name, mcp_tool_name, completed_at DESC);
