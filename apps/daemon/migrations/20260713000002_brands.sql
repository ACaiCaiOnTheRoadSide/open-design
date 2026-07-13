-- 品牌(brand kit)归属登记表:与 design_systems(20260713000001)同一套
-- 模式——文件本体仍在 BRANDS_DIR/<id>/ 目录,本表只管归属与生命周期,
-- 补齐品牌列表/详情/logo 的多租户隔离(此前 BRANDS_DIR 全局共享,任意
-- 租户可见/可删)。查询一律按 tenant_id(ALS)过滤;creator_id 仅归因;
-- 删除只软删(deleted_at 置位,行与磁盘文件保留)。
-- id 即品牌目录名(hostSlug-6hex);存量目录由启动 backfill 从
-- meta.projectId 的项目行回溯归属,无从考归 '__legacy__'。
BEGIN;

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '__legacy__',
  creator_id TEXT,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_brands_tenant
  ON brands(tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brands_creator
  ON brands(creator_id) WHERE creator_id IS NOT NULL;

COMMIT;
