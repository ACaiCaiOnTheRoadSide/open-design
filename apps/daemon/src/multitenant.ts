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
// Per-user BYOK provider/model config (JSON), injected per-request by the Go
// gateway (backend proxy.go) so the shared daemon uses the CALLER's model+key
// instead of a single container-level OD_OPENCODE_PROVIDER_CONFIG. It rides the
// same ALS store as the tenant id so it reaches the spawn deep inside the run.
export const PROVIDER_CONFIG_HEADER = 'x-od-provider-config';
// Global default media model (image/video), injected per-request by the Go
// gateway (backend proxy.go) from the admin-set value. The shared daemon
// ignores container env, so this header is how a whitelist admin's default
// reaches the spawn. Used to fill metadata.imageModel/videoModel when the
// project did not pin one, so the agent defaults to e.g. volcengine seedream
// instead of the contract's built-in gpt-image-2. Rides the same ALS store.
export const MEDIA_DEFAULTS_HEADER = 'x-od-media-defaults';

// Admin-set default media models. Both fields optional; an absent field means
// "no global default for that surface" and the contract's built-in fallback wins.
export interface MediaDefaults {
  imageModel?: string;
  videoModel?: string;
}

interface TenantStore {
  tenantId: string;
  // exactOptionalPropertyTypes: keep optional WITHOUT `| undefined`; callers
  // must omit the key (conditional spread) rather than assign undefined.
  providerConfig?: string;
  mediaDefaults?: MediaDefaults;
}

const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function runWithTenant<T>(
  tenantId: string,
  fn: () => T,
  providerConfig?: string,
  mediaDefaults?: MediaDefaults,
): T {
  return tenantStorage.run(
    {
      tenantId,
      ...(providerConfig !== undefined ? { providerConfig } : {}),
      ...(mediaDefaults !== undefined ? { mediaDefaults } : {}),
    },
    fn,
  );
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
  // Preserve any provider config / media defaults already bound for this
  // request so re-scoping the tenant (tool-token callback path) does not drop
  // the caller's BYOK or the admin's default media model.
  const store = tenantStorage.getStore();
  const providerConfig = store?.providerConfig;
  const mediaDefaults = store?.mediaDefaults;
  tenantStorage.enterWith({
    tenantId,
    ...(providerConfig !== undefined ? { providerConfig } : {}),
    ...(mediaDefaults !== undefined ? { mediaDefaults } : {}),
  });
}

/**
 * Returns the active tenant for the current async scope.
 * Falls back to LEGACY_TENANT for background tasks and pre-migration code.
 */
export function currentTenantId(): string {
  return tenantStorage.getStore()?.tenantId ?? LEGACY_TENANT;
}

/**
 * The per-request BYOK provider/model config (JSON) for the current async
 * scope, or undefined when the caller supplied none. The spawn path prefers
 * this over the container-level OD_OPENCODE_PROVIDER_CONFIG env.
 */
export function currentProviderConfig(): string | undefined {
  return tenantStorage.getStore()?.providerConfig;
}

/**
 * The admin-set default media models for the current async scope, or undefined
 * when the caller supplied none. The prompt composer uses these to fill
 * metadata.imageModel/videoModel that the project did not pin.
 */
export function currentMediaDefaults(): MediaDefaults | undefined {
  return tenantStorage.getStore()?.mediaDefaults;
}

/**
 * Parse the X-OD-Media-Defaults header (JSON `{imageModel?, videoModel?}`)
 * into a MediaDefaults, keeping only non-empty string fields. Returns
 * undefined for a missing/blank/malformed header or one with no usable field,
 * so a bad header degrades to "no default" rather than throwing per-request.
 */
function parseMediaDefaultsHeader(raw: string | undefined): MediaDefaults | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const pick = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  const imageModel = pick(record.imageModel);
  const videoModel = pick(record.videoModel);
  if (imageModel === undefined && videoModel === undefined) return undefined;
  return {
    ...(imageModel !== undefined ? { imageModel } : {}),
    ...(videoModel !== undefined ? { videoModel } : {}),
  };
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
  const rawProvider = req.header(PROVIDER_CONFIG_HEADER);
  const providerConfig =
    rawProvider && rawProvider.trim().length > 0 ? rawProvider.trim() : undefined;
  const mediaDefaults = parseMediaDefaultsHeader(req.header(MEDIA_DEFAULTS_HEADER));
  runWithTenant(tenantId, () => next(), providerConfig, mediaDefaults);
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
