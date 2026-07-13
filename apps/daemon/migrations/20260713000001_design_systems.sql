-- 用户设计体系登记表:文件本体仍在 USER_DESIGN_SYSTEMS_DIR/<id>/ 目录,
-- 本表只做归属与生命周期登记,补上多租户隔离(此前用户自建设计体系是
-- 全局共享文件夹,任意租户可见/可删)。口径与 projects 完全一致:
--   - 所有查询按 tenant_id(ALS currentTenantId)过滤,用户只看到自己租户的;
--   - creator_id 记发起创建的 X-OD-User-Id,仅归因统计,不参与判权;
--   - 删除一律软删:deleted_at 置位,行与磁盘文件都保留,列表/读取排除。
-- 内置设计体系(仓库 design-systems/ 目录)不入表,保持全租户共享。
-- id 即目录名(不含 'user:' 前缀);存量目录由启动 backfill 归 '__legacy__'。
BEGIN;

CREATE TABLE IF NOT EXISTS design_systems (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '__legacy__',
  creator_id TEXT,
  name TEXT NOT NULL,
  -- 来源:created(表单新建)/ import(github/shadcn/本地/压缩包导入)
  --      / brand(品牌提取注册)/ legacy(启动 backfill 补录,来源不可考)
  source TEXT NOT NULL DEFAULT 'created',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_design_systems_tenant
  ON design_systems(tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_design_systems_creator
  ON design_systems(creator_id) WHERE creator_id IS NOT NULL;

COMMIT;
