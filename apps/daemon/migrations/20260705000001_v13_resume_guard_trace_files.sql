-- 上游 v0.13.0 增量 schema:
-- 1) agent_sessions 三列 resume 身份守卫(model/cwd/last_message_id)——
--    会话仅在会话形态未变时安全续用,详见 src/agent-session-resume.ts。
-- 2) messages.trace_object_files_json —— 上游新增的 run 产物追踪列。
-- sqlite 侧上游走 migrate() 的 ALTER 探测;PG 模式 schema 由本目录 .sql 管理。
BEGIN;

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS cwd TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS last_message_id TEXT;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS trace_object_files_json TEXT;

COMMIT;
