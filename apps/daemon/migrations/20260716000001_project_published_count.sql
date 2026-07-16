-- 项目发布计数:web 端用户确认「发布到案例墙」后经 POST /api/projects/:id/publish-events
-- 自增;后台统计(backend 跨 schema 直读)据此算发布率(published_count>0 的项目 / 创建过的项目)。
-- 口径是"发起过发布"而非"发布成功":发布委托 agent 异步执行,无可靠成功回执。
-- 墓碑同步加列,口径与 download_count 一致:删除不缩水生前数据。
BEGIN;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS published_count BIGINT NOT NULL DEFAULT 0;
COMMIT;
