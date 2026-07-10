-- 墓碑也留下载计数:项目硬删后 projects.download_count 随行消失,后台项目
-- 列表(现存 UNION 墓碑)里已删项目的「下载次数」只能恒 0,生前被下载过多少
-- 次不可追溯。删除时把计数一并拷入墓碑(db.ts deleteProject),口径与统计的
-- "创建过"一致:删除是既成事实,但生前数据不缩水。
-- 本迁移之前删除的历史墓碑无从回补,保持 0。
BEGIN;
ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS download_count BIGINT NOT NULL DEFAULT 0;
COMMIT;
