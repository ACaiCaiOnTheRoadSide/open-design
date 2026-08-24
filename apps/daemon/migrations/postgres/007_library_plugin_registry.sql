-- SaaS ownership registry for SQLite-primary Library and user plugin state.
-- The daemon keeps rich metadata in SQLite/PVC; PostgreSQL is the durable,
-- fail-closed authority. Rows without a registry entry are quarantined.
-- Transaction ownership belongs to pg-migrations.ts: migration files must not
-- commit independently or they can split the schema change from its ledger row.
CREATE TABLE IF NOT EXISTS saas_resource_owners (
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'library_asset', 'library_task', 'library_token', 'library_embedding',
    'plugin', 'plugin_marketplace', 'plugin_snapshot'
  )),
  resource_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  management_domain TEXT NOT NULL DEFAULT 'user'
    CHECK (management_domain IN ('user', 'backend')),
  source_kind TEXT,
  retrieval_url TEXT,
  local_path TEXT,
  project_id TEXT,
  workspace_id TEXT,
  team_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  PRIMARY KEY (resource_kind, tenant_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_saas_resource_owner_visible
  ON saas_resource_owners (tenant_id, resource_kind, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_saas_resource_owner_project
  ON saas_resource_owners (tenant_id, project_id)
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saas_resource_owner_workspace
  ON saas_resource_owners (tenant_id, workspace_id)
  WHERE deleted_at IS NULL AND workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saas_resource_owner_team
  ON saas_resource_owners (tenant_id, team_id)
  WHERE deleted_at IS NULL AND team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_backend_managed_resource
  ON saas_resource_owners (resource_kind, resource_id)
  WHERE management_domain = 'backend' AND deleted_at IS NULL;

COMMENT ON TABLE saas_resource_owners IS
  'Durable owner/lifecycle authority. Missing rows are legacy quarantine, never globally visible.';
COMMENT ON COLUMN saas_resource_owners.local_path IS
  'PVC-dependent local/upload content; null for remotely retrievable github/http sources.';
COMMENT ON COLUMN saas_resource_owners.retrieval_url IS
  'Canonical re-fetch URL for github/http sources; local/upload sources must not rely on it.';
