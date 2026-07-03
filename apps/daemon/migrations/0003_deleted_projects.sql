-- 项目删除墓碑表:projects 行是硬删(FK 级联清子表 + 产物目录 rm),行删掉后
-- "这个租户创建过多少项目"不可追溯,后台统计只能数"现存"、随删除缩水。
-- 删除时把项目行的身份字段拷入本表,统计口径恢复为"创建过"。
--
-- 设计取舍(与 message_token_usage 同理):
--   - insert-only、无外键 —— 删除是既成事实,墓碑不随任何级联消失。
--   - 只拷统计要用的身份字段(id/tenant/name/created_at),不留 metadata,
--     避免变成第二份项目表。
--   - 创建失败的回滚删除不写墓碑(db.ts deleteProject 的 tombstone:false),
--     那种项目用户从未真正拥有过。
BEGIN;

CREATE TABLE IF NOT EXISTS deleted_projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      name TEXT,
      created_at BIGINT NOT NULL,
      deleted_at BIGINT NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_deleted_projects_tenant
      ON deleted_projects(tenant_id, created_at DESC);

COMMIT;
