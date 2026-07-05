-- library 租户隔离收尾:content_hash 去重从全局改为按租户。
-- 全局唯一会让 B 租户剪藏与 A 租户相同字节的素材时 INSERT 失败,
-- findLibraryAssetByHash 也已按 tenant_id 过滤,唯一键须与之同口径。
-- 表在生产尚未使用(library 功能未开放),约束替换安全。
BEGIN;

ALTER TABLE library_assets DROP CONSTRAINT IF EXISTS library_assets_content_hash_key;
ALTER TABLE library_assets ADD CONSTRAINT library_assets_tenant_content_hash_key
  UNIQUE (tenant_id, content_hash);

COMMIT;
