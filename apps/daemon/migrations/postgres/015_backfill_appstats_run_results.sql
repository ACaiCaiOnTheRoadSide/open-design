-- Best-effort backfill for runs that reached a durable terminal state before
-- appstats_run_results was introduced. A run already represented by any live
-- appstats fact is excluded to avoid double counting. Historical queue rows do
-- not retain every retry attempt, so this intentionally emits one final fact
-- per otherwise-unreported run.
INSERT INTO appstats_run_results (
  event_key,
  run_id,
  attempt,
  tenant_id,
  user_id,
  access_mode,
  feature,
  result,
  completed_at
)
SELECT
  'agent-run-backfill:' || q.run_id,
  q.run_id,
  1,
  q.tenant_id,
  q.user_id,
  'online',
  'agent.run',
  CASE WHEN q.status = 'completed' THEN 'success' ELSE 'failed' END,
  (EXTRACT(EPOCH FROM q.finished_at) * 1000)::BIGINT
FROM run_queue q
WHERE q.status IN ('completed', 'failed', 'canceled')
  AND q.finished_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM appstats_run_results r
    WHERE r.run_id = q.run_id
  )
ON CONFLICT (event_key) DO NOTHING;
