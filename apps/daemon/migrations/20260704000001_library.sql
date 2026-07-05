-- OD Library(全局素材库)PG schema —— 上游 v0.12.0 引入,
-- 从 src/library-store.ts 的 migrateLibrary()(sqlite DDL)翻译而来。
-- PG 模式下 migrateLibrary 不会被调用,library 各表由本文件建。
-- 方言映射: INTEGER→BIGINT, REAL→DOUBLE PRECISION, BLOB→BYTEA;TEXT PK 原样保留。
-- 多租户: 每张业务表加 tenant_id TEXT NOT NULL DEFAULT '__legacy__'(与 0001 一致),
-- 常用查询键补含 tenant_id 的索引;租户过滤/唯一键语义由专门的 tenant pass 处理
-- (注意 library_assets 的 UNIQUE(content_hash) 目前仍是全局唯一,跨租户去重语义待该 pass 定夺)。
BEGIN;

CREATE TABLE IF NOT EXISTS library_assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      storage TEXT NOT NULL DEFAULT 'owned',
      source_url TEXT,
      source_title TEXT,
      source_domain TEXT,
      captured_at BIGINT NOT NULL,
      archived_date TEXT NOT NULL,
      file_path TEXT,
      origin_project_id TEXT,
      rel_path TEXT,
      mime TEXT,
      width BIGINT,
      height BIGINT,
      size BIGINT,
      content_hash TEXT NOT NULL,
      caption TEXT,
      ocr_text TEXT,
      palette_json TEXT,
      tags_json TEXT,
      metadata_json TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      UNIQUE(content_hash)
    );

CREATE INDEX IF NOT EXISTS idx_library_assets_archived
      ON library_assets(archived_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_assets_kind
      ON library_assets(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_assets_domain
      ON library_assets(source_domain);
CREATE INDEX IF NOT EXISTS idx_library_assets_origin
      ON library_assets(origin_project_id);
CREATE INDEX IF NOT EXISTS idx_library_assets_tenant
      ON library_assets(tenant_id, archived_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_assets_tenant_hash
      ON library_assets(tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_library_assets_tenant_origin
      ON library_assets(tenant_id, origin_project_id, rel_path);

CREATE TABLE IF NOT EXISTS library_asset_sources (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      project_id TEXT,
      conversation_id TEXT,
      run_id TEXT,
      design_system_id TEXT,
      rel_path TEXT,
      created_at BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(asset_id) REFERENCES library_assets(id) ON DELETE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_library_sources_asset
      ON library_asset_sources(asset_id);
CREATE INDEX IF NOT EXISTS idx_library_sources_project
      ON library_asset_sources(project_id);
CREATE INDEX IF NOT EXISTS idx_library_sources_ds
      ON library_asset_sources(design_system_id);
CREATE INDEX IF NOT EXISTS idx_library_sources_tenant
      ON library_asset_sources(tenant_id, asset_id, created_at);
CREATE INDEX IF NOT EXISTS idx_library_sources_tenant_ds
      ON library_asset_sources(tenant_id, design_system_id, source_kind);

CREATE TABLE IF NOT EXISTS library_embeddings (
      asset_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim BIGINT NOT NULL,
      vector BYTEA NOT NULL,
      indexed_text TEXT,
      created_at BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(asset_id) REFERENCES library_assets(id) ON DELETE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_library_embeddings_tenant
      ON library_embeddings(tenant_id);

CREATE TABLE IF NOT EXISTS library_tasks (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(asset_id) REFERENCES library_assets(id) ON DELETE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_library_tasks_asset
      ON library_tasks(asset_id);
CREATE INDEX IF NOT EXISTS idx_library_tasks_tenant
      ON library_tasks(tenant_id, asset_id);

CREATE TABLE IF NOT EXISTS library_tokens (
      token_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      extension_origin TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__'
    );

CREATE INDEX IF NOT EXISTS idx_library_tokens_tenant
      ON library_tokens(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS library_digests (
      date TEXT PRIMARY KEY,
      project_id TEXT,
      artifact_path TEXT,
      summary TEXT,
      created_at BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__'
    );

CREATE INDEX IF NOT EXISTS idx_library_digests_tenant
      ON library_digests(tenant_id, date DESC);

COMMIT;
