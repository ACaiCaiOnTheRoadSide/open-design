-- Recover only historical project owners for which durable token-usage facts
-- identify exactly one principal. Ambiguous or factless projects remain
-- quarantined; a current owner that is not an old synthetic placeholder is
-- never reassigned.
WITH unambiguous_project_principals AS (
  SELECT
    project_id,
    MIN(tenant_id) AS tenant_id,
    MIN(user_id) AS user_id
  FROM message_token_usage
  WHERE tenant_id NOT IN ('', '__legacy__', '__legacy_quarantine__')
    AND user_id NOT IN ('', '__legacy__', '__legacy_quarantine__')
  GROUP BY project_id
  HAVING COUNT(DISTINCT ROW(tenant_id, user_id)) = 1
)
UPDATE projects AS project
SET tenant_id = principal.tenant_id,
    creator_id = principal.user_id
FROM unambiguous_project_principals AS principal
WHERE project.id = principal.project_id
  AND (
    project.tenant_id IN ('__legacy__', '__legacy_quarantine__')
    OR project.creator_id IN ('__legacy__', '__legacy_quarantine__')
    OR project.creator_id = project.tenant_id
  );
