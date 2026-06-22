// Multitenancy support for the daemon (baizhi SaaS fork).
//
// Strategy:
//   - tenant_id is a column on every business table (added by migrateTenantId)
//   - The HTTP gateway (Go SaaS backend) injects X-Tenant-Id on every request
//   - tenantMiddleware reads it and stores it in an AsyncLocalStorage scope
//   - Tenant-aware db functions read currentTenantId() and add WHERE/INSERT clauses
//
// Why AsyncLocalStorage instead of threading tenantId through call sites:
//   - 95+ db.* call sites would otherwise need a mechanical edit
//   - The public daemon API surface stays identical (= "复刻所有接口")
//   - Background tasks (cron routines, watchers) default to LEGACY_TENANT
//     so existing single-tenant data stays accessible during rollout
//
// What this file owns:
//   - migrateTenantId(db): additive ALTER TABLE for all 21 tables
//   - tenantMiddleware: express middleware reading X-Tenant-Id
//   - currentTenantId() / runWithTenant(): ALS context helpers
//   - LEGACY_TENANT: default for pre-migration rows / non-HTTP code paths

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type Database from 'better-sqlite3';

export const LEGACY_TENANT = '__legacy__';
export const TENANT_HEADER = 'x-tenant-id';

interface TenantStore {
  tenantId: string;
}

const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}

/**
 * Re-scope the CURRENT async execution (and its descendants) to a tenant,
 * without wrapping a callback. Used by the tool-token validation path:
 * agent callbacks present a token but no X-Tenant-Id header, so after
 * validating the token we restore the run's tenant from grant.tenantId
 * for the remainder of the request handler. Each HTTP request is its own
 * async chain, so this stays isolated per-request.
 */
export function enterTenant(tenantId: string): void {
  if (!tenantId) return;
  tenantStorage.enterWith({ tenantId });
}

/**
 * Returns the active tenant for the current async scope.
 * Falls back to LEGACY_TENANT for background tasks and pre-migration code.
 */
export function currentTenantId(): string {
  return tenantStorage.getStore()?.tenantId ?? LEGACY_TENANT;
}

/**
 * Express middleware that reads X-Tenant-Id and runs the rest of the
 * request chain inside an ALS scope. Mount this BEFORE all routes.
 *
 * Trust model: the Go SaaS gateway is the only ingress; it sets this
 * header after verifying the user's identity. Daemon does NOT re-validate.
 * For local dev / direct daemon access, missing header falls back to
 * LEGACY_TENANT so existing single-tenant flows keep working.
 */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header(TENANT_HEADER);
  const tenantId = raw && raw.trim().length > 0 ? raw.trim() : LEGACY_TENANT;
  runWithTenant(tenantId, () => next());
}

/**
 * Adds a tenant_id column (NOT NULL DEFAULT LEGACY_TENANT) to every
 * business table, plus complementary composite indexes for the hot
 * lookup keys. Safe to re-run: only adds the column if missing.
 *
 * Run this AFTER the upstream migrate() so all tables exist.
 */
export function migrateTenantId(db: Database.Database): void {
  const tablesNeedingTenant: Array<{ table: string; indexCols?: string }> = [
    // db.ts
    { table: 'projects',                  indexCols: 'tenant_id, updated_at DESC' },
    { table: 'templates',                 indexCols: 'tenant_id, created_at DESC' },
    { table: 'conversations',             indexCols: 'tenant_id, project_id, updated_at DESC' },
    { table: 'agent_sessions',            indexCols: 'tenant_id, conversation_id' },
    { table: 'messages',                  indexCols: 'tenant_id, conversation_id, position' },
    { table: 'preview_comments',          indexCols: 'tenant_id, project_id, conversation_id, updated_at DESC' },
    { table: 'tabs',                      indexCols: 'tenant_id, project_id, position' },
    { table: 'tabs_state',                indexCols: 'tenant_id, project_id' },
    { table: 'deployments',               indexCols: 'tenant_id, project_id, updated_at DESC' },
    { table: 'routines',                  indexCols: 'tenant_id, updated_at DESC' },
    { table: 'routine_runs',              indexCols: 'tenant_id, routine_id, started_at DESC' },
    { table: 'routine_schedule_claims',   indexCols: 'tenant_id, routine_id' },
    // media-tasks.ts
    { table: 'media_tasks',               indexCols: 'tenant_id, project_id, updated_at DESC' },
    // critique/persistence.ts
    { table: 'critique_runs',             indexCols: 'tenant_id' },
    // plugins/persistence.ts
    { table: 'installed_plugins',         indexCols: 'tenant_id' },
    { table: 'plugin_marketplaces',       indexCols: 'tenant_id' },
    { table: 'applied_plugin_snapshots',  indexCols: 'tenant_id' },
    { table: 'run_devloop_iterations',    indexCols: 'tenant_id' },
    { table: 'genui_surfaces',            indexCols: 'tenant_id' },
    { table: 'skill_plugin_candidates',   indexCols: 'tenant_id' },
    // registry/database-backend.ts
    { table: 'registry_entries',          indexCols: 'tenant_id' },
  ];

  for (const { table, indexCols } of tablesNeedingTenant) {
    // SQLite has no IF NOT EXISTS for ALTER, so PRAGMA-check first.
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
    if (!exists) continue;  // table not created yet (e.g., critique runs on demand); skip silently
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'tenant_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT}'`);
    }
    if (indexCols) {
      const idxName = `idx_${table}_tenant`;
      db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table}(${indexCols})`);
    }
  }
}
