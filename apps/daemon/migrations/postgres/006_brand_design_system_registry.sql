-- Tenant ownership registry for filesystem-backed brands and user design systems.
-- SQLite remains the primary business store and the PVC keeps the working files;
-- PostgreSQL owns only the authoritative SaaS ownership/lifecycle facts.
CREATE TABLE IF NOT EXISTS brand_design_system_registry (
  resource_type text NOT NULL CHECK (resource_type IN ('brand', 'design_system')),
  resource_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL DEFAULT '',
  tenant_id text NOT NULL,
  creator_id text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  quarantine_reason text,
  PRIMARY KEY (resource_type, resource_id),
  CHECK ((tenant_id = '__legacy_quarantine__') = (quarantine_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_design_system_registry_tenant_slug
  ON brand_design_system_registry (resource_type, tenant_id, slug)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brand_design_system_registry_tenant_updated
  ON brand_design_system_registry (tenant_id, resource_type, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brand_design_system_registry_deleted
  ON brand_design_system_registry (deleted_at)
  WHERE deleted_at IS NOT NULL;
