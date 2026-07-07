-- 记录项目创建者身份:团队租户下 tenant_id 是 TeamID,无法追溯具体成员;
-- creator_id 记录发起创建请求的用户 user_id(X-OD-User-Id),用于统计归因。
-- 历史项目 creator_id 为 NULL;迁移后新建的项目才有值。
BEGIN;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS creator_id TEXT;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS creator_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_creator ON projects(creator_id) WHERE creator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deleted_projects_creator ON deleted_projects(creator_id) WHERE creator_id IS NOT NULL;
COMMIT;
