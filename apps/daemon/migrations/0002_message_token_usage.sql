-- Token 消耗计量表:每收到一条 usage agent 事件写一行(server.ts
-- persistRunEventToAssistantMessage)。与 messages.events_json 里的 usage
-- 事件同源,但拍平成可直接 SUM()/GROUP BY 的列,供后台按 用户/项目 聚合。
--
-- 设计取舍:
--   - insert-only、无外键 —— 消耗是既成事实,行要在消息重写、run 重试、
--     项目删除(projects 级联)之后仍然存在,否则统计口径倒退。
--   - tenant_id 沿用全库租户模型(团队优先,X-Tenant-Id);user_id 单独记
--     (X-OD-User-Id),因为团队租户下 tenant_id 区分不了具体成员。
--   - model 可空:个别 runtime 不上报模型且请求未指定时保持 NULL。
BEGIN;

CREATE TABLE IF NOT EXISTS message_token_usage (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      user_id TEXT,
      project_id TEXT,
      conversation_id TEXT,
      message_id TEXT NOT NULL,
      run_id TEXT,
      agent_id TEXT,
      model TEXT,
      input_tokens BIGINT,
      output_tokens BIGINT,
      reasoning_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_write_tokens BIGINT,
      cost_usd DOUBLE PRECISION,
      duration_ms BIGINT,
      created_at BIGINT NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_message_token_usage_tenant
      ON message_token_usage(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_token_usage_tenant_user
      ON message_token_usage(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_token_usage_tenant_project
      ON message_token_usage(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_token_usage_message
      ON message_token_usage(message_id);

COMMIT;
