-- 项目产物下载计数:web 端下载/导出成功后经 POST /api/projects/:id/download-events
-- 自增;后台项目管理列表(backend 跨 schema 直读 projects 表)按项目展示。
-- 只计总次数,不建明细表——需要 distinct 用户/按格式等口径时再落明细。
BEGIN;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS download_count BIGINT NOT NULL DEFAULT 0;
COMMIT;
