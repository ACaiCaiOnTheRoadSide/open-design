// SQLite-backed persistence for projects, conversations, messages, and the
// per-project set of open workspace tabs. The on-disk project folder under
// .od/projects/<id>/ is still the single owner of the user's actual files
// (HTML artifacts, sketches, uploads); this database tracks the metadata
// that used to live in localStorage.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ProjectBrowserWorkspaceTab, ProjectTabsState } from '@open-design/contracts';
import { fileURLToPath } from 'node:url';
// sqlite 时代的 migrate*() 入口已废弃:PG 模式下 schema 全部由 runPgMigrations
// 应用 migrations/*.sql 管理(上游新表 —— 如 library —— 也走 .sql 迁移接入)。
import { currentTenantId, currentUserId } from './multitenant.js';
import { resolveDaemonDbConfig } from './storage/daemon-db.js';
import { openPgAsync, type AsyncDb } from './storage/pg-async.js';

type SqliteDb = AsyncDb;
type DbRow = Record<string, any>;
type JsonObject = Record<string, unknown>;
type ChatSessionMode = 'design' | 'chat';

let dbInstance: SqliteDb | null = null;
let dbFile: string | null = null;

// When the daemon is backed by Postgres (OD_DAEMON_DB=postgres) the data layer
// runs unchanged against a sync adapter (storage/pg-sync.ts). A few queries use
// SQLite-only SQL (json_extract/json_each, rowid); they branch on this flag.
let pgMode = false;
export function isPgMode(): boolean { return pgMode; }

function row(value: unknown): DbRow | null {
  return value && typeof value === 'object' ? value as DbRow : null;
}

function rows(value: unknown[]): DbRow[] {
  return value.map((item) => row(item) ?? {});
}

export async function openDatabase(projectRoot: string, { dataDir }: { dataDir?: string } = {}): Promise<SqliteDb> {
  const dbcfg = resolveDaemonDbConfig();
  if (dbInstance && pgMode) return dbInstance;
  if (dbInstance) await closeDatabase();
  pgMode = true;
  const adapter = openPgAsync(dbcfg, process.env.OD_PG_PASSWORD ?? '');
  await runPgMigrations(adapter);
  dbInstance = adapter;
  dbFile = `pg://${dbcfg.postgres!.host}/${dbcfg.postgres!.database}`;
  return dbInstance;
}

// Applies migrations/*.sql through the async adapter (PG mode). Tracked in
// schema_migrations to run each once.
//
// 并发守卫:vitest 多 worker、k8s 多副本首启会同时走到这里,裸跑会竞态
// (双方都看到未应用 → 双双执行 DDL,schema_migrations 主键冲突 / PG 的
// IF NOT EXISTS 在真并发下也可能撞 pg_class 唯一键)。每个文件在
// pg_advisory_xact_lock 串行的事务里「复查 + 应用 + 记账」;文件自带的
// BEGIN/COMMIT 在外层事务内剥掉,整个文件成为一个原子单元,事务结束自动放锁。
const PG_MIGRATION_LOCK_KEY = 881230042;
async function runPgMigrations(adapter: AsyncDb): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../migrations');
  await adapter.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await adapter.prepare(`SELECT 1 FROM schema_migrations WHERE filename = ?`).get(f);
    if (done) continue;
    await adapter.transaction(async () => {
      await adapter.exec(`SELECT pg_advisory_xact_lock(${PG_MIGRATION_LOCK_KEY})`);
      const applied = await adapter.prepare(`SELECT 1 FROM schema_migrations WHERE filename = ?`).get(f);
      if (applied) return;
      const sql = fs
        .readFileSync(path.join(dir, f), 'utf8')
        .replace(/^\s*BEGIN;\s*/i, '')
        .replace(/\bCOMMIT;\s*$/i, '');
      await adapter.exec(sql);
      await adapter.prepare(`INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)`).run(f, Date.now());
    })();
  }
}

export async function closeDatabase() {
  if (!dbInstance) return;
  await dbInstance.close();
  dbInstance = null;
  dbFile = null;
}

// ---------- deployments ----------

const DEPLOYMENT_COLS = `id, project_id AS projectId, file_name AS fileName,
  provider_id AS providerId, url, deployment_id AS deploymentId,
  deployment_count AS deploymentCount, target, status,
  status_message AS statusMessage, reachable_at AS reachableAt,
  provider_metadata_json AS providerMetadataJson,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function listDeployments(db: SqliteDb, projectId: string) {
  const tenantId = currentTenantId();
  return ((await db
    .prepare(
      `SELECT ${DEPLOYMENT_COLS}
         FROM deployments
        WHERE project_id = ? AND tenant_id = ?
        ORDER BY updated_at DESC`,
    )
    .all(projectId, tenantId)) as DbRow[])
    .map(normalizeDeployment);
}

export async function getDeployment(db: SqliteDb, projectId: string, fileName: string, providerId: string) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT ${DEPLOYMENT_COLS}
         FROM deployments
        WHERE project_id = ? AND file_name = ? AND provider_id = ? AND tenant_id = ?`,
    )
    .get(projectId, fileName, providerId, tenantId) as DbRow | undefined;
  return row ? normalizeDeployment(row) : null;
}

export async function getDeploymentById(db: SqliteDb, projectId: string, id: string) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT ${DEPLOYMENT_COLS}
         FROM deployments
        WHERE project_id = ? AND id = ? AND tenant_id = ?`,
    )
    .get(projectId, id, tenantId) as DbRow | undefined;
  return row ? normalizeDeployment(row) : null;
}

export async function upsertDeployment(db: SqliteDb, deployment: DbRow) {
  const existing = await getDeployment(
    db,
    deployment.projectId,
    deployment.fileName,
    deployment.providerId,
  );
  const now = Date.now();
  const inputProviderMetadata =
    deployment.providerMetadata === undefined
      ? existing?.providerMetadata
      : deployment.providerMetadata;
  const providerMetadata =
    deployment.cloudflarePages && typeof deployment.cloudflarePages === 'object'
      ? {
          ...(inputProviderMetadata && typeof inputProviderMetadata === 'object' && !Array.isArray(inputProviderMetadata)
            ? inputProviderMetadata
            : {}),
          cloudflarePages: deployment.cloudflarePages,
        }
      : inputProviderMetadata;
  const next = {
    id: existing?.id ?? deployment.id,
    projectId: deployment.projectId,
    fileName: deployment.fileName,
    providerId: deployment.providerId,
    url: deployment.url,
    deploymentId: deployment.deploymentId ?? null,
    deploymentCount:
      typeof deployment.deploymentCount === 'number'
        ? deployment.deploymentCount
        : (existing?.deploymentCount ?? 0) + 1,
    target: deployment.target ?? 'preview',
    status: deployment.status ?? existing?.status ?? 'ready',
    statusMessage: deployment.statusMessage ?? null,
    reachableAt: deployment.reachableAt ?? null,
    providerMetadata,
    createdAt: existing?.createdAt ?? deployment.createdAt ?? now,
    updatedAt: deployment.updatedAt ?? now,
  };
  const providerMetadataJson = stringifyJsonObjectOrNull(next.providerMetadata);
  const tenantId = currentTenantId();
  await db.prepare(
    `INSERT INTO deployments
       (id, project_id, file_name, provider_id, url, deployment_id,
        deployment_count, target, status, status_message, reachable_at,
        provider_metadata_json, created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, file_name, provider_id) DO UPDATE SET
       url = excluded.url,
       deployment_id = excluded.deployment_id,
       deployment_count = excluded.deployment_count,
       target = excluded.target,
       status = excluded.status,
       status_message = excluded.status_message,
       reachable_at = excluded.reachable_at,
       provider_metadata_json = excluded.provider_metadata_json,
       updated_at = excluded.updated_at,
       tenant_id = excluded.tenant_id`,
  ).run(
    next.id,
    next.projectId,
    next.fileName,
    next.providerId,
    next.url,
    next.deploymentId,
    next.deploymentCount,
    next.target,
    next.status,
    next.statusMessage,
    next.reachableAt,
    providerMetadataJson,
    next.createdAt,
    next.updatedAt,
    tenantId,
  );
  return getDeployment(db, next.projectId, next.fileName, next.providerId);
}

function normalizeDeployment(row: DbRow) {
  const providerMetadata = parseJsonOrUndef(row.providerMetadataJson);
  const normalizedProviderMetadata =
    providerMetadata && typeof providerMetadata === 'object' && !Array.isArray(providerMetadata)
      ? providerMetadata
      : undefined;
  return {
    id: row.id,
    projectId: row.projectId,
    fileName: row.fileName,
    providerId: row.providerId,
    url: row.url,
    deploymentId: row.deploymentId ?? undefined,
    deploymentCount: Number(row.deploymentCount ?? 1),
    target: 'preview',
    status: row.status || 'ready',
    statusMessage: row.statusMessage ?? undefined,
    reachableAt: row.reachableAt == null ? undefined : Number(row.reachableAt),
    cloudflarePages:
      normalizedProviderMetadata?.cloudflarePages &&
      typeof normalizedProviderMetadata.cloudflarePages === 'object' &&
      !Array.isArray(normalizedProviderMetadata.cloudflarePages)
        ? normalizedProviderMetadata.cloudflarePages
        : undefined,
    providerMetadata: normalizedProviderMetadata,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function stringifyJsonObjectOrNull(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).length > 0 ? JSON.stringify(value) : null;
}

// ---------- projects ----------

const PROJECT_COLS = `id, name, skill_id AS skillId,
  design_system_id AS designSystemId,
  pending_prompt AS pendingPrompt,
  metadata_json AS metadataJson,
  applied_plugin_snapshot_id AS appliedPluginSnapshotId,
  custom_instructions AS customInstructions,
  created_at AS createdAt,
  updated_at AS updatedAt`;

export async function listProjects(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT ${PROJECT_COLS}
         FROM projects
        WHERE tenant_id = ?
        ORDER BY updated_at DESC`,
    )
    .all(tenantId) as DbRow[];
  return rows.map(normalizeProject);
}

export async function listLatestProjectRunStatuses(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT c.project_id AS projectId,
              m.run_id AS runId,
              m.run_status AS status,
              COALESCE(m.ended_at, m.started_at, m.created_at) AS updatedAt
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.run_status IS NOT NULL
          AND c.tenant_id = ?
        ORDER BY updatedAt DESC`,
    )
    .all(tenantId) as DbRow[];
  const latestByProject = new Map<string, DbRow>();
  for (const row of rows) {
    if (!latestByProject.has(row.projectId)) {
      latestByProject.set(row.projectId, {
        value: normalizeProjectRunStatus(row.status),
        updatedAt: Number(row.updatedAt),
        runId: row.runId ?? undefined,
      });
    }
  }
  return latestByProject;
}

export async function listLatestConversationRunStatuses(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT m.conversation_id AS conversationId,
              m.run_id AS runId,
              m.run_status AS status,
              COALESCE(m.ended_at, m.started_at, m.created_at) AS updatedAt,
              m.position AS position
         FROM messages m
        WHERE m.run_status IS NOT NULL
          AND m.tenant_id = ?
        ORDER BY updatedAt DESC, m.position DESC`,
    )
    .all(tenantId) as DbRow[];
  const latestByConversation = new Map<string, DbRow>();
  for (const row of rows) {
    if (!latestByConversation.has(row.conversationId)) {
      latestByConversation.set(row.conversationId, {
        value: normalizeProjectRunStatus(row.status),
        updatedAt: Number(row.updatedAt),
        runId: row.runId ?? undefined,
      });
    }
  }
  return latestByConversation;
}

export async function listFirstConversationRunStatuses(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT m.conversation_id AS conversationId,
              m.run_id AS runId,
              m.run_status AS status,
              COALESCE(m.ended_at, m.started_at, m.created_at) AS updatedAt,
              m.position AS position
         FROM messages m
        WHERE m.run_status IS NOT NULL
          AND m.run_id IS NOT NULL
          AND m.tenant_id = ?
        ORDER BY m.position ASC`,
    )
    .all(tenantId) as DbRow[];
  const firstByConversation = new Map<string, DbRow>();
  for (const row of rows) {
    if (!firstByConversation.has(row.conversationId)) {
      firstByConversation.set(row.conversationId, {
        value: normalizeProjectRunStatus(row.status),
        updatedAt: Number(row.updatedAt),
        runId: row.runId ?? undefined,
      });
    }
  }
  return firstByConversation;
}

export async function listLatestRunStatuses(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT m.run_id AS runId,
              m.run_status AS status,
              COALESCE(m.ended_at, m.started_at, m.created_at) AS updatedAt,
              m.position AS position
         FROM messages m
        WHERE m.run_status IS NOT NULL
          AND m.run_id IS NOT NULL
          AND m.tenant_id = ?
        ORDER BY updatedAt DESC, m.position DESC`,
    )
    .all(tenantId) as DbRow[];
  const latestByRun = new Map<string, DbRow>();
  for (const row of rows) {
    if (!latestByRun.has(row.runId)) {
      latestByRun.set(row.runId, {
        value: normalizeProjectRunStatus(row.status),
        updatedAt: Number(row.updatedAt),
        runId: row.runId ?? undefined,
      });
    }
  }
  return latestByRun;
}

export async function listProjectsAwaitingInput(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT latest.projectId
         FROM (
           SELECT c.project_id AS projectId,
                  m.conversation_id AS conversationId,
                  m.created_at AS createdAt,
                  m.position AS position,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.project_id
                    ORDER BY m.created_at DESC, m.position DESC
                  ) AS rowNum
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE m.role = 'assistant'
              AND c.tenant_id = ?
              -- ask-question is an accepted alias for question-form (UI parser
              -- + daemon open-tag matcher), so an alias-form turn must also
              -- count as awaiting input.
              AND (
                LOWER(m.content) LIKE '%<question-form%'
                OR LOWER(m.content) LIKE '%<ask-question%'
              )
         ) latest
        WHERE latest.rowNum = 1
          AND NOT EXISTS (
            SELECT 1
              FROM messages reply
             WHERE reply.conversation_id = latest.conversationId
               AND reply.role = 'user'
               AND (
                 reply.created_at > latest.createdAt
                 OR (reply.created_at = latest.createdAt AND reply.position > latest.position)
               )
          )`,
    )
    .all(tenantId) as DbRow[];
  return new Set((rows as DbRow[]).map((row: DbRow) => row.projectId));
}

export async function listConversationsAwaitingInput(db: SqliteDb) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT latest.conversationId
         FROM (
           SELECT m.conversation_id AS conversationId,
                  m.created_at AS createdAt,
                  m.position AS position,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.conversation_id
                    ORDER BY m.created_at DESC, m.position DESC
                  ) AS rowNum
             FROM messages m
            WHERE m.role = 'assistant'
              AND m.tenant_id = ?
              AND (
                LOWER(m.content) LIKE '%<question-form%'
                OR LOWER(m.content) LIKE '%<ask-question%'
              )
         ) latest
        WHERE latest.rowNum = 1
          AND NOT EXISTS (
            SELECT 1
              FROM messages reply
             WHERE reply.conversation_id = latest.conversationId
               AND reply.role = 'user'
               AND (
                 reply.created_at > latest.createdAt
                 OR (reply.created_at = latest.createdAt AND reply.position > latest.position)
               )
          )`,
    )
    .all(tenantId) as DbRow[];
  return new Set((rows as DbRow[]).map((row: DbRow) => row.conversationId));
}

export async function getProject(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ? AND tenant_id = ?`)
    .get(id, tenantId) as DbRow | undefined;
  return row ? normalizeProject(row) : null;
}

export async function insertProject(db: SqliteDb, p: DbRow) {
  const tenantId = currentTenantId();
  await db.prepare(
    `INSERT INTO projects
       (id, name, skill_id, design_system_id, pending_prompt,
        metadata_json, custom_instructions, created_at, updated_at, tenant_id, creator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.name,
    p.skillId ?? null,
    p.designSystemId ?? null,
    p.pendingPrompt ?? null,
    p.metadata ? JSON.stringify(p.metadata) : null,
    p.customInstructions ?? null,
    p.createdAt,
    p.updatedAt,
    tenantId,
    currentUserId() ?? null,
  );
  return getProject(db, p.id);
}

export async function updateProject(db: SqliteDb, id: string, patch: DbRow) {
  const tenantId = currentTenantId();
  const existing = await getProject(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  await db.prepare(
    `UPDATE projects
        SET name = ?,
            skill_id = ?,
            design_system_id = ?,
            pending_prompt = ?,
            metadata_json = ?,
            custom_instructions = ?,
            updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
  ).run(
    merged.name,
    merged.skillId ?? null,
    merged.designSystemId ?? null,
    merged.pendingPrompt ?? null,
    merged.metadata ? JSON.stringify(merged.metadata) : null,
    merged.customInstructions ?? null,
    merged.updatedAt,
    id,
    tenantId,
  );
  return getProject(db, id);
}

/** 项目产物下载计数自增(download_count 列由 20260710000001 迁移引入)。
 *  web 端下载/导出成功后经 beacon 上报,后台项目管理列表跨 schema 直读展示。
 *  不动 updated_at:下载是消费行为,不该把项目顶到"最近更新"。 */
export async function incrementProjectDownloadCount(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  await db.prepare(
    `UPDATE projects SET download_count = download_count + 1 WHERE id = ? AND tenant_id = ?`,
  ).run(id, tenantId);
}

/** 项目发布计数自增(published_count 列由 20260716000001 迁移引入)。
 *  用户确认「发布到案例墙」时 web 端 beacon 上报;口径是"发起过发布"而非
 *  "发布成功"——发布委托 agent 异步执行,无可靠成功回执。同 download_count
 *  不动 updated_at。 */
export async function incrementProjectPublishCount(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  await db.prepare(
    `UPDATE projects SET published_count = published_count + 1 WHERE id = ? AND tenant_id = ?`,
  ).run(id, tenantId);
}

// tombstone:false 仅供"创建失败回滚"路径使用:那种项目用户从未真正拥有过,
// 不应计入"创建过的项目"统计。用户主动删除一律走默认路径写墓碑,
// 后台的项目数统计(现存 projects + deleted_projects)才不随删除缩水。
export async function deleteProject(db: SqliteDb, id: string, opts?: { tombstone?: boolean }) {
  const tenantId = currentTenantId();
  if (opts?.tombstone !== false) {
    await db
      .prepare(
        `INSERT INTO deleted_projects (id, tenant_id, name, created_at, deleted_at, creator_id, download_count, published_count)
           SELECT id, tenant_id, name, created_at, ?, creator_id, download_count, published_count FROM projects WHERE id = ? AND tenant_id = ?
           ON CONFLICT (id) DO NOTHING`,
      )
      .run(Date.now(), id, tenantId);
  }
  await db.prepare(`DELETE FROM projects WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

function normalizeProject(row: DbRow) {
  let metadata;
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson);
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    name: row.name,
    skillId: row.skillId,
    designSystemId: row.designSystemId,
    pendingPrompt: row.pendingPrompt ?? undefined,
    metadata,
    appliedPluginSnapshotId: row.appliedPluginSnapshotId ?? undefined,
    customInstructions: row.customInstructions ?? undefined,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function normalizeProjectRunStatus(status: unknown) {
  if (status === 'starting') return 'running';
  if (status === 'cancelled') return 'canceled';
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled'
  ) {
    return status;
  }
  return 'not_started';
}

// ---------- design systems ----------
// 用户自建设计体系的归属登记(文件本体在 USER_DESIGN_SYSTEMS_DIR,见
// 20260713000001 迁移头注释)。隔离口径与 projects 一致:全部按 ALS 租户
// 过滤;删除只软删(deleted_at 置位),列表/读取排除已删行。

const DESIGN_SYSTEM_COLS = `id, tenant_id AS tenantId, creator_id AS creatorId,
  name, source, created_at AS createdAt, updated_at AS updatedAt,
  deleted_at AS deletedAt`;

export interface DesignSystemRow {
  id: string;
  tenantId: string;
  creatorId: string | null;
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function normalizeDesignSystemRow(row: DbRow): DesignSystemRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    creatorId: row.creatorId ?? null,
    name: row.name,
    source: row.source,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

export async function insertDesignSystem(
  db: SqliteDb,
  entry: { id: string; name: string; source: string; createdAt?: number },
): Promise<DesignSystemRow | null> {
  const now = Date.now();
  const createdAt = entry.createdAt ?? now;
  // ON CONFLICT DO UPDATE(限同租户)复活软删行:同一 id 被重新登记(品牌
  // 重新 finalize 复用 designSystemId、或删后再建)时清掉 deleted_at 并刷新
  // name/source/updated_at,否则 DO NOTHING 会让 deleted_at 永远留着、重生的
  // 体系永不可见。WHERE 限定同租户——冲突行属别的租户时不动它(跨租户占用
  // 由 slug 分配的 designSystemIdExistsUnscoped 提前挡掉,这里是纵深防御)。
  await db.prepare(
    `INSERT INTO design_systems (id, tenant_id, creator_id, name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       deleted_at = NULL,
       name = excluded.name,
       source = excluded.source,
       updated_at = excluded.updated_at,
       creator_id = COALESCE(design_systems.creator_id, excluded.creator_id)
     WHERE design_systems.tenant_id = excluded.tenant_id`,
  ).run(entry.id, currentTenantId(), currentUserId() ?? null, entry.name, entry.source, createdAt, now);
  return getDesignSystemRow(db, entry.id);
}

export async function listDesignSystemRows(db: SqliteDb): Promise<DesignSystemRow[]> {
  const tenantId = currentTenantId();
  const items = (await db
    .prepare(
      `SELECT ${DESIGN_SYSTEM_COLS} FROM design_systems
        WHERE tenant_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC`,
    )
    .all(tenantId)) as DbRow[];
  return items.map(normalizeDesignSystemRow);
}

export async function getDesignSystemRow(db: SqliteDb, id: string): Promise<DesignSystemRow | null> {
  const tenantId = currentTenantId();
  const item = (await db
    .prepare(
      `SELECT ${DESIGN_SYSTEM_COLS} FROM design_systems
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    )
    .get(id, tenantId)) as DbRow | undefined;
  return item ? normalizeDesignSystemRow(item) : null;
}

export async function touchDesignSystem(
  db: SqliteDb,
  id: string,
  patch?: { name?: string },
): Promise<void> {
  const tenantId = currentTenantId();
  if (patch?.name !== undefined) {
    await db.prepare(
      `UPDATE design_systems SET name = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    ).run(patch.name, Date.now(), id, tenantId);
    return;
  }
  await db.prepare(
    `UPDATE design_systems SET updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), id, tenantId);
}

/** 软删:deleted_at 置位,行与磁盘文件保留。返回是否真的删到了行
 *  (跨租户/已删/不存在都返回 false,路由据此回 404)。 */
export async function softDeleteDesignSystem(db: SqliteDb, id: string): Promise<boolean> {
  const tenantId = currentTenantId();
  const result = await db.prepare(
    `UPDATE design_systems SET deleted_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), id, tenantId);
  return result.changes > 0;
}

/** 不带租户过滤的全量 id 集。默认含已软删(backfill 场景:已删目录仍在盘上,
 *  不能再补一行"活的");aliveOnly 供启动 OSS 回灌用——只拉存活体系的目录。 */
export async function listAllDesignSystemIds(
  db: SqliteDb,
  opts?: { aliveOnly?: boolean },
): Promise<Set<string>> {
  const sql = opts?.aliveOnly
    ? `SELECT id FROM design_systems WHERE deleted_at IS NULL`
    : `SELECT id FROM design_systems`;
  const items = (await db.prepare(sql).all()) as DbRow[];
  return new Set(items.map((r) => String(r.id)));
}

/** 全局(跨租户、含已软删)判某设计体系 dir id 是否已被占用。slug 分配用:
 *  盘是缓存、OSS 才是真相,空盘时不能只 stat 本地就发号,否则两个租户会拿到
 *  同一 id 撞进同一 OSS 键。含软删——软删目录/blob 可能还在,复用会污染。 */
export async function designSystemIdExistsUnscoped(db: SqliteDb, id: string): Promise<boolean> {
  const item = await db.prepare(`SELECT 1 FROM design_systems WHERE id = ?`).get(id);
  return Boolean(item);
}

/** 启动 backfill 专用:显式传租户/创建者(从关联 workspace 项目回溯到的
 *  归属),不走 ALS——启动上下文只有 LEGACY_TENANT。幂等(ON CONFLICT 忽略)。 */
export async function backfillDesignSystemRow(
  db: SqliteDb,
  entry: {
    id: string;
    name: string;
    tenantId: string;
    creatorId: string | null;
    createdAt: number;
    updatedAt: number;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO design_systems (id, tenant_id, creator_id, name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'legacy', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(entry.id, entry.tenantId, entry.creatorId, entry.name, entry.createdAt, entry.updatedAt);
}

/** 按项目 id 反查归属,不带租户过滤。两个用途:
 *  1. 启动 backfill:跨租户回溯存量设计体系挂过的 workspace 项目属于谁。
 *  2. insertProject 前的查重:projects 的主键只有 id、不含 tenant_id,而
 *     getProject 带租户过滤——别的租户(尤其无租户上下文的调用方,落在
 *     LEGACY_TENANT)占着这个 id 时 getProject 返回 null,随后的 INSERT 却会
 *     撞 projects_pkey。查重要用它,不能用 getProject。 */
export async function getProjectOwnerUnscoped(
  db: SqliteDb,
  id: string,
): Promise<{ tenantId: string; creatorId: string | null } | null> {
  const item = (await db
    .prepare(`SELECT tenant_id AS tenantId, creator_id AS creatorId FROM projects WHERE id = ?`)
    .get(id)) as DbRow | undefined;
  if (!item) return null;
  return { tenantId: String(item.tenantId), creatorId: item.creatorId ?? null };
}

// ---------- brands ----------
// 品牌归属登记(文件本体在 BRANDS_DIR,见 20260713000002 迁移头注释)。
// 与 design_systems 同一套语义:按 ALS 租户过滤、软删、creator 仅归因。

export async function insertBrandRow(
  db: SqliteDb,
  entry: { id: string; name: string; createdAt?: number },
): Promise<void> {
  const now = Date.now();
  // 同 design_systems:ON CONFLICT DO UPDATE(限同租户)复活软删行,避免重新
  // 登记同 id 时 deleted_at 残留导致品牌永不可见。跨租户冲突行不动。
  await db.prepare(
    `INSERT INTO brands (id, tenant_id, creator_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       deleted_at = NULL,
       name = excluded.name,
       updated_at = excluded.updated_at,
       creator_id = COALESCE(brands.creator_id, excluded.creator_id)
     WHERE brands.tenant_id = excluded.tenant_id`,
  ).run(entry.id, currentTenantId(), currentUserId() ?? null, entry.name, entry.createdAt ?? now, now);
}

/** 当前租户存活品牌 id 集(列表过滤用)。 */
export async function listBrandRowIds(db: SqliteDb): Promise<Set<string>> {
  const tenantId = currentTenantId();
  const items = (await db
    .prepare(`SELECT id FROM brands WHERE tenant_id = ? AND deleted_at IS NULL`)
    .all(tenantId)) as DbRow[];
  return new Set(items.map((r) => String(r.id)));
}

/** 品牌是否属于当前租户且未删(详情/logo/finalize/删除的归属闸)。 */
export async function isBrandRowOwned(db: SqliteDb, id: string): Promise<boolean> {
  const tenantId = currentTenantId();
  const item = await db
    .prepare(`SELECT 1 FROM brands WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`)
    .get(id, tenantId);
  return Boolean(item);
}

export async function touchBrandRow(db: SqliteDb, id: string, patch?: { name?: string }): Promise<void> {
  const tenantId = currentTenantId();
  if (patch?.name !== undefined) {
    await db.prepare(
      `UPDATE brands SET name = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    ).run(patch.name, Date.now(), id, tenantId);
    return;
  }
  await db.prepare(
    `UPDATE brands SET updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), id, tenantId);
}

/** 软删:行与磁盘文件保留。返回是否删到了行(跨租户/已删/不存在 = false → 404)。 */
export async function softDeleteBrandRow(db: SqliteDb, id: string): Promise<boolean> {
  const tenantId = currentTenantId();
  const result = await db.prepare(
    `UPDATE brands SET deleted_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), id, tenantId);
  return result.changes > 0;
}

/** 不带租户过滤的全量品牌 id 集;aliveOnly 供启动 OSS 回灌。 */
export async function listAllBrandRowIds(
  db: SqliteDb,
  opts?: { aliveOnly?: boolean },
): Promise<Set<string>> {
  const sql = opts?.aliveOnly
    ? `SELECT id FROM brands WHERE deleted_at IS NULL`
    : `SELECT id FROM brands`;
  const items = (await db.prepare(sql).all()) as DbRow[];
  return new Set(items.map((r) => String(r.id)));
}

/** 启动 backfill 专用:显式租户/创建者,不走 ALS。幂等。 */
export async function backfillBrandRow(
  db: SqliteDb,
  entry: {
    id: string;
    name: string;
    tenantId: string;
    creatorId: string | null;
    createdAt: number;
    updatedAt: number;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO brands (id, tenant_id, creator_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(entry.id, entry.tenantId, entry.creatorId, entry.name, entry.createdAt, entry.updatedAt);
}

// ---------- templates ----------

export async function listTemplates(db: SqliteDb) {
  const tenantId = currentTenantId();
  return ((await db
    .prepare(
      `SELECT id, name, description, source_project_id AS sourceProjectId,
              files_json AS filesJson, created_at AS createdAt
         FROM templates
        WHERE tenant_id = ?
        ORDER BY created_at DESC`,
    )
    .all(tenantId)) as DbRow[])
    .map(normalizeTemplate);
}

export async function getTemplate(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT id, name, description, source_project_id AS sourceProjectId,
              files_json AS filesJson, created_at AS createdAt
         FROM templates WHERE id = ? AND tenant_id = ?`,
    )
    .get(id, tenantId) as DbRow | undefined;
  return row ? normalizeTemplate(row) : null;
}

export async function findTemplateByNameAndProject(
  db: SqliteDb,
  name: string,
  sourceProjectId: string,
) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT id, name, description, source_project_id AS sourceProjectId,
              files_json AS filesJson, created_at AS createdAt
         FROM templates
        WHERE name = ? AND source_project_id = ? AND tenant_id = ?`,
    )
    .get(name, sourceProjectId, tenantId) as DbRow | undefined;
  return row ? normalizeTemplate(row) : null;
}

export async function insertTemplate(db: SqliteDb, t: DbRow) {
  const tenantId = currentTenantId();
  await db.prepare(
    `INSERT INTO templates (id, name, description, source_project_id, files_json, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.name,
    t.description ?? null,
    t.sourceProjectId ?? null,
    JSON.stringify(t.files ?? []),
    t.createdAt,
    tenantId,
  );
  return getTemplate(db, t.id);
}

export async function updateTemplate(
  db: SqliteDb,
  id: string,
  t: { description: string | null; files: unknown[] },
) {
  const tenantId = currentTenantId();
  await db.prepare(
    `UPDATE templates SET description = ?, files_json = ? WHERE id = ? AND tenant_id = ?`,
  ).run(t.description, JSON.stringify(t.files), id, tenantId);
  return getTemplate(db, id);
}

export async function deleteTemplate(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  await db.prepare(`DELETE FROM templates WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

function normalizeTemplate(row: DbRow) {
  let files = [];
  try {
    files = JSON.parse(row.filesJson || '[]');
  } catch {
    files = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    sourceProjectId: row.sourceProjectId ?? undefined,
    files,
    createdAt: Number(row.createdAt),
  };
}

// ---------- conversations ----------

export async function listConversations(db: SqliteDb, projectId: string) {
  const tenantId = currentTenantId();
  return rows(await db
    .prepare(
      `WITH project_conversations AS (
          SELECT id, project_id AS projectId, title, session_mode AS sessionMode,
                 created_at AS createdAt, updated_at AS updatedAt
            FROM conversations
           WHERE project_id = ? AND tenant_id = ?
        ),
        latest_runs AS (
          SELECT conversation_id AS conversationId,
                 run_status AS latestRunStatus,
                 started_at AS latestRunStartedAt,
                 ended_at AS latestRunEndedAt,
                 events_json AS latestRunEventsJson
            FROM (
              SELECT m.conversation_id,
                     m.run_status,
                     m.started_at,
                     m.ended_at,
                     m.events_json,
                     ROW_NUMBER() OVER (
                       PARTITION BY m.conversation_id
                       ORDER BY m.position DESC
                     ) AS rn
                FROM messages m
                JOIN project_conversations c ON c.id = m.conversation_id
               WHERE m.role = 'assistant'
                 AND m.run_status IS NOT NULL
            )
           WHERE rn = 1
        ),
        message_counts AS (
          SELECT m.conversation_id AS conversationId,
                 COUNT(*) AS messageCount
            FROM messages m
            JOIN project_conversations c ON c.id = m.conversation_id
           GROUP BY m.conversation_id
        ),
        total_run_durations AS (
          SELECT m.conversation_id AS conversationId,
                 SUM(${terminalRunDurationSql('m')}) AS totalDurationMs
            FROM messages m
            JOIN project_conversations c ON c.id = m.conversation_id
           WHERE m.role = 'assistant'
             AND m.run_status IN ('succeeded', 'failed', 'canceled')
           GROUP BY m.conversation_id
        )
        SELECT c.id, c.projectId, c.title, c.sessionMode, c.createdAt, c.updatedAt,
               COALESCE(mc.messageCount, 0) AS messageCount,
               lr.latestRunStatus, lr.latestRunStartedAt,
               lr.latestRunEndedAt, lr.latestRunEventsJson,
               trd.totalDurationMs
          FROM project_conversations c
          LEFT JOIN latest_runs lr ON lr.conversationId = c.id
          LEFT JOIN message_counts mc ON mc.conversationId = c.id
          LEFT JOIN total_run_durations trd ON trd.conversationId = c.id
         ORDER BY c.updatedAt DESC`,
    )
    .all(projectId, tenantId)).map(normalizeConversation);
}

export async function getConversation(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  const r = await db
    .prepare(
      `SELECT id, project_id AS projectId, title, session_mode AS sessionMode,
              created_at AS createdAt, updated_at AS updatedAt,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) AS messageCount
         FROM conversations WHERE id = ? AND tenant_id = ?`,
    )
    .get(id, tenantId) as DbRow | undefined;
  if (!r) return null;
  return {
    ...normalizeConversation(r),
    latestRun: (await latestConversationRunSummary(db, r.id)) ?? undefined,
    ...numberProperty('totalDurationMs', await totalConversationRunDurationMs(db, r.id)),
  };
}

function normalizeConversation(r: DbRow) {
  const latestRun = conversationRunSummaryFromRow({
    runStatus: r.latestRunStatus,
    startedAt: r.latestRunStartedAt,
    endedAt: r.latestRunEndedAt,
    eventsJson: r.latestRunEventsJson,
  });
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title ?? null,
    sessionMode: normalizeConversationSessionMode(r.sessionMode),
    messageCount: Number(r.messageCount ?? 0),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    ...numberProperty('totalDurationMs', r.totalDurationMs),
    latestRun: latestRun ?? undefined,
  };
}

export function normalizeConversationSessionMode(value: unknown): ChatSessionMode {
  return value === 'chat' ? 'chat' : 'design';
}

function numberProperty(key: string, value: unknown) {
  const n = value == null ? undefined : Number(value);
  return typeof n === 'number' && Number.isFinite(n) ? { [key]: n } : {};
}

async function latestConversationRunSummary(db: SqliteDb, conversationId: string) {
  const row = await db
    .prepare(
      `SELECT run_status AS runStatus,
              started_at AS startedAt,
              ended_at AS endedAt,
              events_json AS eventsJson
         FROM messages
        WHERE conversation_id = ?
          AND role = 'assistant'
          AND run_status IS NOT NULL
        ORDER BY position DESC
        LIMIT 1`,
    )
    .get(conversationId) as DbRow | undefined;
  return conversationRunSummaryFromRow(row);
}

async function totalConversationRunDurationMs(db: SqliteDb, conversationId: string): Promise<number | undefined> {
  const row = await db
    .prepare(
      `SELECT SUM(${terminalRunDurationSql()}) AS totalDurationMs
         FROM messages
        WHERE conversation_id = ?
          AND role = 'assistant'
          AND run_status IN ('succeeded', 'failed', 'canceled')`,
    )
    .get(conversationId) as DbRow | undefined;
  return row?.totalDurationMs == null ? undefined : Number(row.totalDurationMs);
}

function terminalRunDurationSql(alias?: string) {
  const p = alias ? `${alias}.` : '';
  if (pgMode) {
    // Postgres: started/ended are BIGINT (ms epoch); CAST AS INTEGER would
    // overflow int32 and json_each/json_extract don't exist. Terminal runs
    // carry started_at/ended_at, so the events_json fallback degrades to 0.
    return `CASE
              WHEN ${p}started_at IS NOT NULL AND ${p}ended_at IS NOT NULL
                THEN GREATEST(${p}ended_at - ${p}started_at, 0)
              ELSE 0
            END`;
  }
  return `CASE
            WHEN ${p}started_at IS NOT NULL AND ${p}ended_at IS NOT NULL THEN
              CASE
                WHEN CAST(${p}ended_at AS INTEGER) >= CAST(${p}started_at AS INTEGER)
                  THEN CAST(${p}ended_at AS INTEGER) - CAST(${p}started_at AS INTEGER)
                ELSE 0
              END
            ELSE (
              SELECT CASE
                       WHEN json_extract(usage_event.value, '$.durationMs') >= 0
                         THEN json_extract(usage_event.value, '$.durationMs')
                       ELSE 0
                     END
                FROM json_each(
                  CASE
                    WHEN json_valid(${p}events_json) AND json_type(${p}events_json) = 'array'
                      THEN ${p}events_json
                    ELSE '[]'
                  END
                ) AS usage_event
               WHERE usage_event.type = 'object'
                 AND json_extract(usage_event.value, '$.kind') = 'usage'
                 AND json_type(usage_event.value, '$.durationMs') IN ('integer', 'real')
               ORDER BY CAST(usage_event.key AS INTEGER) DESC
               LIMIT 1
            )
          END`;
}

function conversationRunSummaryFromRow(row: DbRow | undefined) {
  if (!row || typeof row.runStatus !== 'string') return null;
  const startedAt = row.startedAt == null ? undefined : Number(row.startedAt);
  const endedAt = row.endedAt == null ? undefined : Number(row.endedAt);
  const usageDurationMs = latestUsageDurationMs(row.eventsJson);
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.max(0, (endedAt as number) - (startedAt as number))
      : usageDurationMs;
  return {
    status: row.runStatus,
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(endedAt) ? { endedAt } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs)
      ? { durationMs }
      : {}),
  };
}

function latestUsageDurationMs(eventsJson: unknown): number | undefined {
  if (typeof eventsJson !== 'string' || eventsJson.length === 0) return undefined;
  try {
    const events = JSON.parse(eventsJson);
    if (!Array.isArray(events)) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (
        event &&
        typeof event === 'object' &&
        event.kind === 'usage' &&
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs)
      ) {
        return Math.max(0, event.durationMs);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function insertConversation(db: SqliteDb, c: DbRow) {
  const tenantId = currentTenantId();
  await db.prepare(
    `INSERT INTO conversations
       (id, project_id, title, session_mode, created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    c.projectId,
    c.title ?? null,
    normalizeConversationSessionMode(c.sessionMode),
    c.createdAt,
    c.updatedAt,
    tenantId,
  );
  return getConversation(db, c.id);
}

export async function updateConversation(db: SqliteDb, id: string, patch: DbRow) {
  const tenantId = currentTenantId();
  const existing = await getConversation(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    sessionMode: Object.prototype.hasOwnProperty.call(patch, 'sessionMode')
      ? normalizeConversationSessionMode(patch.sessionMode)
      : existing.sessionMode,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  await db.prepare(
    `UPDATE conversations
        SET title = ?, session_mode = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
  ).run(merged.title ?? null, merged.sessionMode, merged.updatedAt, id, tenantId);
  return getConversation(db, id);
}

export async function deleteConversation(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  await db.prepare(`DELETE FROM conversations WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

// ---------- agent sessions ----------

export async function getAgentSession(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
): Promise<string | null> {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT session_id FROM agent_sessions
        WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?`,
    )
    .get(conversationId, agentId, tenantId) as DbRow | undefined;
  return row && typeof row.session_id === 'string' ? row.session_id : null;
}

export async function upsertAgentSession(
  db: SqliteDb,
  input: {
    conversationId: string;
    agentId: string;
    sessionId: string;
    stablePromptHash?: string | null;
    model?: string | null;
    cwd?: string | null;
    lastMessageId?: string | null;
  },
): Promise<void> {
  const tenantId = currentTenantId();
  await db.prepare(
    `INSERT INTO agent_sessions
       (conversation_id, agent_id, session_id, stable_prompt_hash, model, cwd, last_message_id, updated_at, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, agent_id)
       DO UPDATE SET session_id = excluded.session_id,
                     stable_prompt_hash = excluded.stable_prompt_hash,
                     model = excluded.model,
                     cwd = excluded.cwd,
                     last_message_id = excluded.last_message_id,
                     updated_at = excluded.updated_at,
                     tenant_id = excluded.tenant_id`,
  ).run(
    input.conversationId,
    input.agentId,
    input.sessionId,
    input.stablePromptHash ?? null,
    input.model ?? null,
    input.cwd ?? null,
    input.lastMessageId ?? null,
    Date.now(),
    tenantId,
  );
}

export async function getAgentSessionRecord(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
): Promise<{
  sessionId: string;
  stablePromptHash: string | null;
  model: string | null;
  cwd: string | null;
  lastMessageId: string | null;
} | null> {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT session_id, stable_prompt_hash, model, cwd, last_message_id FROM agent_sessions
        WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?`,
    )
    .get(conversationId, agentId, tenantId) as DbRow | undefined;
  if (!row || typeof row.session_id !== 'string') return null;
  return {
    sessionId: row.session_id,
    stablePromptHash:
      typeof row.stable_prompt_hash === 'string' ? row.stable_prompt_hash : null,
    model: typeof row.model === 'string' ? row.model : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    lastMessageId: typeof row.last_message_id === 'string' ? row.last_message_id : null,
  };
}

// Conversation cursor for the resume identity guard: the id of the latest
// COMPLETED assistant message in the conversation, EXCLUDING the current run's
// in-flight placeholder (`excludeMessageId`). `resumableMessageId` is the one
// allowed exception (resume-on-failure session's own last turn). See upstream
// v0.13 agent-session-resume.ts for the full rationale.
export async function latestCompletedAssistantMessageId(
  db: SqliteDb,
  conversationId: string,
  excludeMessageId: string,
  resumableMessageId: string | null = null,
): Promise<string | null> {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT id FROM messages
        WHERE conversation_id = ? AND tenant_id = ? AND role = 'assistant' AND id != ?
          AND (run_status = 'succeeded' OR id = ?)
        ORDER BY position DESC LIMIT 1`,
    )
    .get(conversationId, tenantId, excludeMessageId, resumableMessageId) as DbRow | undefined;
  return row && typeof row.id === 'string' ? row.id : null;
}

export async function updateAgentSessionStableHash(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
  stablePromptHash: string,
): Promise<void> {
  const tenantId = currentTenantId();
  await db.prepare(
    `UPDATE agent_sessions SET stable_prompt_hash = ?, updated_at = ?
      WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?`,
  ).run(stablePromptHash, Date.now(), conversationId, agentId, tenantId);
}

export async function clearAgentSession(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
): Promise<void> {
  const tenantId = currentTenantId();
  await db.prepare(
    `DELETE FROM agent_sessions WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?`,
  ).run(conversationId, agentId, tenantId);
}

// ---------- messages ----------

export async function listMessages(db: SqliteDb, conversationId: string) {
  const tenantId = currentTenantId();
  return ((await db
    .prepare(
      `SELECT id, role, content, agent_id AS agentId, agent_name AS agentName,
              run_id AS runId, run_status AS runStatus,
              last_run_event_id AS lastRunEventId,
              events_json AS eventsJson,
              attachments_json AS attachmentsJson,
              comment_attachments_json AS commentAttachmentsJson,
              produced_files_json AS producedFilesJson,
              feedback_json AS feedbackJson,
              pre_turn_file_names_json AS preTurnFileNamesJson,
              session_mode AS sessionMode,
              run_context_json AS runContextJson,
              applied_plugin_snapshot_json AS appliedPluginSnapshotJson,
              created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt,
              position
         FROM messages
        WHERE conversation_id = ? AND tenant_id = ?
        ORDER BY position ASC`,
    )
    .all(conversationId, tenantId)) as DbRow[])
    .map(normalizeMessage);
}

export async function upsertMessage(db: SqliteDb, conversationId: string, m: DbRow) {
  const tenantId = currentTenantId();
  const existing = await db
    .prepare(`SELECT position FROM messages WHERE id = ? AND tenant_id = ?`)
    .get(m.id, tenantId) as DbRow | undefined;
  const now = Date.now();
  if (existing) {
    await db.prepare(
      `UPDATE messages
          SET role = ?, content = ?, agent_id = ?, agent_name = ?,
              run_id = ?, run_status = ?, last_run_event_id = ?,
              events_json = ?, attachments_json = ?, comment_attachments_json = ?,
              produced_files_json = ?, trace_object_files_json = ?, feedback_json = ?,
              pre_turn_file_names_json = ?,
              session_mode = ?, run_context_json = ?, applied_plugin_snapshot_json = ?,
              telemetry_finalized_at = CASE
                WHEN ? THEN COALESCE(telemetry_finalized_at, ?)
                ELSE telemetry_finalized_at
              END,
              started_at = ?, ended_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(
      m.role,
      m.content,
      m.agentId ?? null,
      m.agentName ?? null,
      m.runId ?? null,
      m.runStatus ?? null,
      m.lastRunEventId ?? null,
      m.events ? JSON.stringify(m.events) : null,
      m.attachments ? JSON.stringify(m.attachments) : null,
      m.commentAttachments ? JSON.stringify(m.commentAttachments) : null,
      m.producedFiles ? JSON.stringify(m.producedFiles) : null,
      m.traceObjectFiles ? JSON.stringify(m.traceObjectFiles) : null,
      m.feedback ? JSON.stringify(m.feedback) : null,
      m.preTurnFileNames ? JSON.stringify(m.preTurnFileNames) : null,
      normalizeMessageSessionModeForStorage(m.sessionMode),
      m.runContext ? JSON.stringify(m.runContext) : null,
      m.appliedPluginSnapshot ? JSON.stringify(m.appliedPluginSnapshot) : null,
      m.telemetryFinalized === true ? 1 : 0,
      now,
      m.startedAt ?? null,
      m.endedAt ?? null,
      m.id,
      tenantId,
    );
  } else {
    const max = await db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) AS m FROM messages WHERE conversation_id = ? AND tenant_id = ?`,
      )
      .get(conversationId, tenantId) as DbRow | undefined;
    const position = (max?.m ?? -1) + 1;
    const createdAt = typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)
      ? m.createdAt
      : now;
    // 23 values: id, conversation_id, role, content, agent_id, agent_name,
    // run_id, run_status, last_run_event_id, events_json, attachments_json,
    // comment_attachments_json, produced_files_json, feedback_json,
    // pre_turn_file_names_json, session_mode, run_context_json,
    // applied_plugin_snapshot_json, telemetry_finalized_at, started_at,
    // ended_at, position, created_at.
    await db.prepare(
      `INSERT INTO messages
         (id, conversation_id, role, content, agent_id, agent_name,
          run_id, run_status, last_run_event_id, events_json,
          attachments_json, comment_attachments_json, produced_files_json,
          trace_object_files_json, feedback_json, pre_turn_file_names_json,
          session_mode, run_context_json, applied_plugin_snapshot_json,
          telemetry_finalized_at, started_at, ended_at, position, created_at, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.id,
      conversationId,
      m.role,
      m.content,
      m.agentId ?? null,
      m.agentName ?? null,
      m.runId ?? null,
      m.runStatus ?? null,
      m.lastRunEventId ?? null,
      m.events ? JSON.stringify(m.events) : null,
      m.attachments ? JSON.stringify(m.attachments) : null,
      m.commentAttachments ? JSON.stringify(m.commentAttachments) : null,
      m.producedFiles ? JSON.stringify(m.producedFiles) : null,
      m.traceObjectFiles ? JSON.stringify(m.traceObjectFiles) : null,
      m.feedback ? JSON.stringify(m.feedback) : null,
      m.preTurnFileNames ? JSON.stringify(m.preTurnFileNames) : null,
      normalizeMessageSessionModeForStorage(m.sessionMode),
      m.runContext ? JSON.stringify(m.runContext) : null,
      m.appliedPluginSnapshot ? JSON.stringify(m.appliedPluginSnapshot) : null,
      m.telemetryFinalized === true ? now : null,
      m.startedAt ?? null,
      m.endedAt ?? null,
      position,
      createdAt,
      tenantId,
    );
  }
  // Bump conversation activity so the sidebar's recency sort works.
  await db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ? AND tenant_id = ?`).run(
    now,
    conversationId,
    tenantId,
  );
  const row = await db
    .prepare(
      `SELECT id, role, content, agent_id AS agentId, agent_name AS agentName,
              run_id AS runId, run_status AS runStatus,
              last_run_event_id AS lastRunEventId,
              events_json AS eventsJson,
              attachments_json AS attachmentsJson,
              comment_attachments_json AS commentAttachmentsJson,
              produced_files_json AS producedFilesJson,
              trace_object_files_json AS traceObjectFilesJson,
              feedback_json AS feedbackJson,
              pre_turn_file_names_json AS preTurnFileNamesJson,
              session_mode AS sessionMode,
              run_context_json AS runContextJson,
              applied_plugin_snapshot_json AS appliedPluginSnapshotJson,
              created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt,
              position
         FROM messages WHERE id = ? AND tenant_id = ?`,
    )
    .get(m.id, tenantId) as DbRow | undefined;
  return row ? normalizeMessage(row) : null;
}

export async function getMessageTelemetryFinalizationState(db: SqliteDb, messageId: string) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT telemetry_finalized_at AS telemetryFinalizedAt
         FROM messages
        WHERE id = ? AND tenant_id = ?`,
    )
    .get(messageId, tenantId) as DbRow | undefined;
  if (!row) {
    return {
      exists: false,
      finalizedAt: null,
    };
  }
  return {
    exists: true,
    finalizedAt:
      typeof row.telemetryFinalizedAt === 'number' ? row.telemetryFinalizedAt : null,
  };
}

export async function appendMessageStatusEvent(db: SqliteDb, messageId: string, event: DbRow) {
  const tenantId = currentTenantId();
  const label = typeof event?.label === 'string' ? event.label.trim() : '';
  const detail = typeof event?.detail === 'string' ? event.detail.trim() : '';
  if (!label) return null;
  const row = await db
    .prepare(`SELECT events_json AS eventsJson FROM messages WHERE id = ? AND tenant_id = ?`)
    .get(messageId, tenantId) as DbRow | undefined;
  if (!row) return null;
  const parsed = parseJsonOrUndef(row.eventsJson);
  const events = Array.isArray(parsed) ? parsed : [];
  const last = events[events.length - 1];
  if (last?.kind === 'status' && last.label === label && (last.detail ?? '') === detail) {
    return events;
  }
  const nextEvent = detail
    ? { kind: 'status', label, detail }
    : { kind: 'status', label };
  const next = [...events, nextEvent];
  await db.prepare(`UPDATE messages SET events_json = ? WHERE id = ? AND tenant_id = ?`)
    .run(JSON.stringify(next), messageId, tenantId);
  return next;
}

export async function appendMessageAgentEvent(db: SqliteDb, messageId: string, event: DbRow) {
  const tenantId = currentTenantId();
  if (!event || typeof event !== 'object') return null;
  const kind = typeof event.kind === 'string' ? event.kind : '';
  if (!kind) return null;
  const row = await db
    .prepare(`SELECT content, events_json AS eventsJson FROM messages WHERE id = ? AND tenant_id = ?`)
    .get(messageId, tenantId) as DbRow | undefined;
  if (!row) return null;
  const parsed = parseJsonOrUndef(row.eventsJson);
  const events = Array.isArray(parsed) ? parsed : [];
  const last = events[events.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(event)) {
    return events;
  }
  const next = [...events, event];
  const textDelta = kind === 'text' && typeof event.text === 'string' ? event.text : '';
  await db.prepare(`UPDATE messages SET content = COALESCE(content, '') || ?, events_json = ? WHERE id = ? AND tenant_id = ?`)
    .run(textDelta, JSON.stringify(next), messageId, tenantId);
  return next;
}

export async function deleteMessage(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  await db.prepare(`DELETE FROM messages WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

// ---------- token usage metering ----------

export interface MessageTokenUsageEntry {
  projectId?: string | null;
  conversationId?: string | null;
  messageId: string;
  runId?: string | null;
  agentId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

function meterNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// One row per persisted `usage` agent event — the flattened, SUM()-able twin
// of the usage entries inside messages.events_json (admin-side per-user /
// per-project token accounting reads this table). Insert-only and without a
// messages FK on purpose: consumption is a fact that must survive message
// rewrites, run retries, and project deletion.
export async function insertMessageTokenUsage(db: SqliteDb, entry: MessageTokenUsageEntry) {
  const tenantId = currentTenantId();
  const userId = currentUserId() ?? null;
  await db.prepare(
    `INSERT INTO message_token_usage (
        tenant_id, user_id, project_id, conversation_id, message_id, run_id,
        agent_id, model, input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenantId,
    userId,
    entry.projectId ?? null,
    entry.conversationId ?? null,
    entry.messageId,
    entry.runId ?? null,
    entry.agentId ?? null,
    typeof entry.model === 'string' && entry.model ? entry.model : null,
    meterNumber(entry.inputTokens),
    meterNumber(entry.outputTokens),
    meterNumber(entry.reasoningTokens),
    meterNumber(entry.cacheReadTokens),
    meterNumber(entry.cacheWriteTokens),
    meterNumber(entry.costUsd),
    meterNumber(entry.durationMs),
    Date.now(),
  );
}

// ---------- preview comments ----------

const PREVIEW_COMMENT_STATUSES = new Set([
  'open',
  'attached',
  'applying',
  'needs_review',
  'resolved',
  'failed',
]);

export async function listPreviewComments(db: SqliteDb, projectId: string, conversationId: string) {
  const tenantId = currentTenantId();
  return ((await db
    .prepare(
      `SELECT id, project_id AS projectId, conversation_id AS conversationId,
              file_path AS filePath, element_id AS elementId, selector, label,
              text, position_json AS positionJson, html_hint AS htmlHint,
              selection_kind AS selectionKind, member_count AS memberCount,
              pod_members_json AS podMembersJson, style_json AS styleJson,
              attachments_json AS attachmentsJson,
              slide_index AS slideIndex,
              note, status, created_at AS createdAt, updated_at AS updatedAt
         FROM preview_comments
        WHERE project_id = ? AND conversation_id = ? AND tenant_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(projectId, conversationId, tenantId)) as DbRow[])
    .map(normalizePreviewComment);
}

export async function upsertPreviewComment(db: SqliteDb, projectId: string, conversationId: string, input: DbRow) {
  const tenantId = currentTenantId();
  const target = input?.target ?? {};
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  const attachmentsProvided = Object.prototype.hasOwnProperty.call(input ?? {}, 'attachments');
  const incomingAttachments = normalizePreviewCommentAttachments(input?.attachments);
  const filePath = cleanRequiredString(target.filePath, 'filePath');
  const elementId = cleanRequiredString(target.elementId, 'elementId');
  const selector = cleanRequiredString(target.selector, 'selector');
  const label = cleanRequiredString(target.label, 'label');
  const text = typeof target.text === 'string' ? compactWhitespace(target.text).slice(0, 160) : '';
  const htmlHint = typeof target.htmlHint === 'string' ? compactWhitespace(target.htmlHint).slice(0, 180) : '';
  const position = normalizePosition(target.position);
  const selectionKind = target.selectionKind === 'pod' ? 'pod' : 'element';
  const podMembers = selectionKind === 'pod' ? normalizePodMembers(target.podMembers) : [];
  const style = normalizeAnnotationStyle(target.style);
  const memberCount = selectionKind === 'pod'
    ? (podMembers.length > 0
        ? podMembers.length
        : Number.isFinite(target.memberCount)
          ? Math.max(0, Math.round(target.memberCount))
          : 0)
    : 0;
  const slideIndex = Number.isFinite(target.slideIndex) ? Math.max(0, Math.round(target.slideIndex)) : null;
  const slideKey = slideIndex ?? -1;
  const now = Date.now();
  const existing = await db
    .prepare(
      `SELECT id, created_at AS createdAt, attachments_json AS attachmentsJson
         FROM preview_comments
        WHERE project_id = ? AND conversation_id = ? AND file_path = ? AND element_id = ? AND slide_key = ? AND tenant_id = ?`,
    )
    .get(projectId, conversationId, filePath, elementId, slideKey, tenantId) as DbRow | undefined;
  const id = existing?.id ?? randomCommentId();
  const createdAt = existing?.createdAt ?? now;
  const existingAttachments = normalizePreviewCommentAttachments(parseJsonOrUndef(existing?.attachmentsJson));
  const attachments = attachmentsProvided ? incomingAttachments : existingAttachments;
  // A comment must carry either a note or at least one image attachment.
  if (!note && attachments.length === 0) throw new Error('comment note required');
  await db.prepare(
    `INSERT INTO preview_comments
       (id, project_id, conversation_id, file_path, element_id, selector, label,
        text, position_json, html_hint, selection_kind, member_count, pod_members_json,
        style_json, attachments_json, slide_index, slide_key, note, status, created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, conversation_id, file_path, element_id, slide_key) DO UPDATE SET
       selector = excluded.selector,
       label = excluded.label,
       text = excluded.text,
       position_json = excluded.position_json,
       html_hint = excluded.html_hint,
       selection_kind = excluded.selection_kind,
       member_count = excluded.member_count,
       pod_members_json = excluded.pod_members_json,
       style_json = excluded.style_json,
       attachments_json = excluded.attachments_json,
       slide_index = excluded.slide_index,
       note = excluded.note,
       status = 'open',
       updated_at = excluded.updated_at,
       tenant_id = excluded.tenant_id`,
  ).run(
    id,
    projectId,
    conversationId,
    filePath,
    elementId,
    selector,
    label,
    text,
    JSON.stringify(position),
    htmlHint,
    selectionKind,
    selectionKind === 'pod' ? memberCount : null,
    selectionKind === 'pod' ? JSON.stringify(podMembers) : null,
    style ? JSON.stringify(style) : null,
    attachments.length > 0 ? JSON.stringify(attachments) : null,
    slideIndex,
    slideKey,
    note,
    'open',
    createdAt,
    now,
    tenantId,
  );
  return getPreviewComment(db, projectId, conversationId, id);
}

export async function updatePreviewCommentStatus(db: SqliteDb, projectId: string, conversationId: string, id: string, status: string) {
  if (!PREVIEW_COMMENT_STATUSES.has(status)) throw new Error('invalid comment status');
  const tenantId = currentTenantId();
  const now = Date.now();
  await db.prepare(
    `UPDATE preview_comments
        SET status = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND conversation_id = ? AND tenant_id = ?`,
  ).run(status, now, id, projectId, conversationId, tenantId);
  return getPreviewComment(db, projectId, conversationId, id);
}

export async function deletePreviewComment(db: SqliteDb, projectId: string, conversationId: string, id: string) {
  const tenantId = currentTenantId();
  const result = await db
    .prepare(
      `DELETE FROM preview_comments
        WHERE id = ? AND project_id = ? AND conversation_id = ? AND tenant_id = ?`,
    )
    .run(id, projectId, conversationId, tenantId);
  return result.changes > 0;
}

async function getPreviewComment(db: SqliteDb, projectId: string, conversationId: string, id: string) {
  const tenantId = currentTenantId();
  const row = await db
    .prepare(
      `SELECT id, project_id AS projectId, conversation_id AS conversationId,
              file_path AS filePath, element_id AS elementId, selector, label,
              text, position_json AS positionJson, html_hint AS htmlHint,
              selection_kind AS selectionKind, member_count AS memberCount,
              pod_members_json AS podMembersJson, style_json AS styleJson,
              attachments_json AS attachmentsJson,
              slide_index AS slideIndex,
              note, status, created_at AS createdAt, updated_at AS updatedAt
         FROM preview_comments
        WHERE id = ? AND project_id = ? AND conversation_id = ? AND tenant_id = ?`,
    )
    .get(id, projectId, conversationId, tenantId) as DbRow | undefined;
  return row ? normalizePreviewComment(row) : null;
}

function normalizePreviewComment(row: DbRow) {
  const podMembers = parseJsonOrUndef(row.podMembersJson);
  const normalizedPodMembers = Array.isArray(podMembers) ? podMembers : undefined;
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    filePath: row.filePath,
    elementId: row.elementId,
    selector: row.selector,
    label: row.label,
    text: row.text,
    position: parseJsonOrUndef(row.positionJson) ?? { x: 0, y: 0, width: 0, height: 0 },
    htmlHint: row.htmlHint,
    style: normalizeAnnotationStyle(parseJsonOrUndef(row.styleJson)),
    selectionKind: row.selectionKind === 'pod' ? 'pod' : 'element',
    memberCount:
      normalizedPodMembers && normalizedPodMembers.length > 0
        ? normalizedPodMembers.length
        : Number.isFinite(row.memberCount)
          ? row.memberCount
          : undefined,
    podMembers: normalizedPodMembers,
    slideIndex: Number.isFinite(row.slideIndex) ? row.slideIndex : undefined,
    note: row.note,
    attachments: normalizePreviewCommentAttachments(parseJsonOrUndef(row.attachmentsJson)),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePreviewCommentAttachments(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const path = typeof (item as DbRow).path === 'string' ? (item as DbRow).path.trim() : '';
      if (!path) return null;
      const rawName = typeof (item as DbRow).name === 'string' ? (item as DbRow).name.trim() : '';
      return { path, name: rawName || path.split('/').pop() || path };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function cleanRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function normalizePodMembers(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input
    .map((member) => {
      if (!member || typeof member !== 'object') return null;
      const elementId = cleanRequiredString(member.elementId, 'podMember.elementId');
      const selector = cleanRequiredString(member.selector, 'podMember.selector');
      const label = cleanRequiredString(member.label, 'podMember.label');
      return {
        elementId,
        selector,
        label,
        text:
          typeof member.text === 'string'
            ? compactWhitespace(member.text).slice(0, 160)
            : '',
        position: normalizePosition(member.position),
        htmlHint:
          typeof member.htmlHint === 'string'
            ? compactWhitespace(member.htmlHint).slice(0, 180)
            : '',
        style: normalizeAnnotationStyle(member.style),
      };
    })
    .filter(Boolean);
}

function normalizeAnnotationStyle(input: unknown) {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as DbRow;
  const style: DbRow = {};
  for (const key of ANNOTATION_STYLE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = compactWhitespace(value);
    if (trimmed) style[key] = trimmed.slice(0, 120);
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

const ANNOTATION_STYLE_KEYS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'fontFamily',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderRadius',
] as const;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePosition(input: unknown) {
  const value: DbRow = input && typeof input === 'object' ? input as DbRow : {};
  return {
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function randomCommentId(): string {
  return `cmt_${randomUUID()}`;
}

function normalizeMessage(row: DbRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    agentId: row.agentId ?? undefined,
    agentName: row.agentName ?? undefined,
    runId: row.runId ?? undefined,
    runStatus: row.runStatus ?? undefined,
    lastRunEventId: row.lastRunEventId ?? undefined,
    events: parseJsonOrUndef(row.eventsJson),
    attachments: parseJsonOrUndef(row.attachmentsJson),
    commentAttachments: parseJsonOrUndef(row.commentAttachmentsJson),
    producedFiles: parseJsonOrUndef(row.producedFilesJson),
    traceObjectFiles: parseJsonOrUndef(row.traceObjectFilesJson),
    feedback: parseJsonOrUndef(row.feedbackJson),
    preTurnFileNames: parseJsonOrUndef(row.preTurnFileNamesJson),
    sessionMode: normalizeMessageSessionMode(row.sessionMode),
    runContext: parseJsonOrUndef(row.runContextJson),
    appliedPluginSnapshot: parseJsonOrUndef(row.appliedPluginSnapshotJson),
    createdAt: row.createdAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
  };
}

function normalizeMessageSessionMode(value: unknown): ChatSessionMode | undefined {
  return value === 'chat' || value === 'design' ? value : undefined;
}

function normalizeMessageSessionModeForStorage(value: unknown): ChatSessionMode | null {
  return value === 'chat' || value === 'design' ? value : null;
}

function parseJsonOrUndef(s: unknown): any {
  if (typeof s !== 'string' || !s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------- routines ----------

const ROUTINE_COLS = `id, name, prompt,
  schedule_kind AS scheduleKind, schedule_value AS scheduleValue,
  schedule_json AS scheduleJson,
  project_mode AS projectMode, project_id AS projectId,
  skill_id AS skillId, agent_id AS agentId,
  context_json AS contextJson,
  enabled, created_at AS createdAt, updated_at AS updatedAt`;

const ROUTINE_RUN_COLS = `id, routine_id AS routineId, trigger, status,
  project_id AS projectId, conversation_id AS conversationId,
  agent_run_id AS agentRunId, started_at AS startedAt,
  completed_at AS completedAt, summary, error, error_code AS errorCode`;

export async function listRoutines(db: SqliteDb) {
  const tenantId = currentTenantId();
  return ((await db
    .prepare(`SELECT ${ROUTINE_COLS} FROM routines WHERE tenant_id = ? ORDER BY created_at ASC`)
    .all(tenantId)) as DbRow[])
    .map(normalizeRoutine);
}

export async function getRoutine(db: SqliteDb, id: string) {
  const tenantId = currentTenantId();
  const r = await db
    .prepare(`SELECT ${ROUTINE_COLS} FROM routines WHERE id = ? AND tenant_id = ?`)
    .get(id, tenantId) as DbRow | undefined;
  return r ? normalizeRoutine(r) : null;
}

export async function insertRoutine(db: SqliteDb, r: DbRow) {
  const tenantId = currentTenantId();
  await db.prepare(
    `INSERT INTO routines
       (id, name, prompt, schedule_kind, schedule_value, schedule_json,
        project_mode, project_id, skill_id, agent_id, context_json, enabled,
        created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.name,
    r.prompt,
    r.scheduleKind,
    r.scheduleValue,
    r.scheduleJson ?? null,
    r.projectMode,
    r.projectId ?? null,
    r.skillId ?? null,
    r.agentId ?? null,
    r.contextJson ?? null,
    r.enabled ? 1 : 0,
    r.createdAt,
    r.updatedAt,
    tenantId,
  );
  return getRoutine(db, r.id);
}

export async function updateRoutine(db: SqliteDb, id: string, patch: DbRow) {
  const tenantId = currentTenantId();
  const existing = await getRoutine(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  await db.prepare(
    `UPDATE routines
        SET name = ?, prompt = ?,
            schedule_kind = ?, schedule_value = ?, schedule_json = ?,
            project_mode = ?, project_id = ?,
            skill_id = ?, agent_id = ?, context_json = ?,
            enabled = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
  ).run(
    merged.name,
    merged.prompt,
    merged.scheduleKind,
    merged.scheduleValue,
    merged.scheduleJson ?? null,
    merged.projectMode,
    merged.projectId ?? null,
    merged.skillId ?? null,
    merged.agentId ?? null,
    merged.contextJson ?? null,
    merged.enabled ? 1 : 0,
    merged.updatedAt,
    id,
    tenantId,
  );
  return getRoutine(db, id);
}

export async function deleteRoutine(db: SqliteDb, id: string): Promise<boolean> {
  const tenantId = currentTenantId();
  const result = await db.prepare(`DELETE FROM routines WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
  return result.changes > 0;
}

function normalizeRoutine(row: DbRow) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    scheduleKind: row.scheduleKind,
    scheduleValue: row.scheduleValue,
    scheduleJson: row.scheduleJson ?? null,
    projectMode: row.projectMode,
    projectId: row.projectId ?? null,
    skillId: row.skillId ?? null,
    agentId: row.agentId ?? null,
    contextJson: row.contextJson ?? null,
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export async function listRoutineRuns(db: SqliteDb, routineId: string, limit = 20) {
  return ((await db
    .prepare(
      `SELECT ${ROUTINE_RUN_COLS}
         FROM routine_runs
        WHERE routine_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(routineId, limit)) as DbRow[])
    .map(normalizeRoutineRun);
}

export async function getLatestRoutineRun(db: SqliteDb, routineId: string) {
  const r = await db
    .prepare(
      `SELECT ${ROUTINE_RUN_COLS}
         FROM routine_runs
        WHERE routine_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(routineId) as DbRow | undefined;
  return r ? normalizeRoutineRun(r) : null;
}

export async function getRoutineRun(db: SqliteDb, id: string) {
  const r = await db
    .prepare(`SELECT ${ROUTINE_RUN_COLS} FROM routine_runs WHERE id = ?`)
    .get(id) as DbRow | undefined;
  return r ? normalizeRoutineRun(r) : null;
}

export async function insertRoutineRun(db: SqliteDb, r: DbRow) {
  await db.prepare(
    `INSERT INTO routine_runs
       (id, routine_id, trigger, status, project_id, conversation_id,
        agent_run_id, started_at, completed_at, summary, error, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.routineId,
    r.trigger,
    r.status,
    r.projectId,
    r.conversationId,
    r.agentRunId,
    r.startedAt,
    r.completedAt ?? null,
    r.summary ?? null,
    r.error ?? null,
    r.errorCode ?? null,
  );
  return getRoutineRun(db, r.id);
}

export async function insertScheduledRoutineRun(db: SqliteDb, r: DbRow, slotAt: number) {
  const insertClaim = db.prepare(
    `INSERT INTO routine_schedule_claims
       (routine_id, slot_at, claimed_at)
     VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  const insertRun = db.prepare(
    `INSERT INTO routine_runs
       (id, routine_id, trigger, status, project_id, conversation_id,
        agent_run_id, started_at, completed_at, summary, error, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(async () => {
    const claim = await insertClaim.run(r.routineId, slotAt, Date.now());
    if (claim.changes === 0) return false;
    await insertRun.run(
      r.id,
      r.routineId,
      r.trigger,
      r.status,
      r.projectId,
      r.conversationId,
      r.agentRunId,
      r.startedAt,
      r.completedAt ?? null,
      r.summary ?? null,
      r.error ?? null,
      r.errorCode ?? null,
    );
    return true;
  });
  if (!(await tx())) return null;
  return getRoutineRun(db, r.id);
}

export async function updateRoutineRun(db: SqliteDb, id: string, patch: DbRow) {
  const existing = await getRoutineRun(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
  };
  await db.prepare(
    `UPDATE routine_runs
        SET status = ?, project_id = ?, conversation_id = ?, agent_run_id = ?,
            completed_at = ?, summary = ?, error = ?, error_code = ?
      WHERE id = ?`,
  ).run(
    merged.status,
    merged.projectId,
    merged.conversationId,
    merged.agentRunId,
    merged.completedAt ?? null,
    merged.summary ?? null,
    merged.error ?? null,
    merged.errorCode ?? null,
    id,
  );
  return getRoutineRun(db, id);
}

function normalizeRoutineRun(row: DbRow) {
  return {
    id: row.id,
    routineId: row.routineId,
    trigger: row.trigger,
    status: row.status,
    projectId: row.projectId,
    conversationId: row.conversationId,
    agentRunId: row.agentRunId,
    startedAt: Number(row.startedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt),
    summary: row.summary ?? null,
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
  };
}

// ---------- tabs ----------

function normalizeBrowserWorkspaceTab(value: unknown): ProjectBrowserWorkspaceTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  if (typeof record.label !== 'string' || !record.label.trim()) return null;
  const tab: ProjectBrowserWorkspaceTab = {
    id: record.id,
    label: record.label,
  };
  if (record.insertAfter === null) tab.insertAfter = null;
  else if (typeof record.insertAfter === 'string') tab.insertAfter = record.insertAfter;
  if (typeof record.title === 'string' && record.title.trim()) tab.title = record.title;
  if (typeof record.url === 'string' && record.url.trim()) tab.url = record.url;
  if (typeof record.iconUrl === 'string' && record.iconUrl.trim()) tab.iconUrl = record.iconUrl;
  return tab;
}

function normalizeProjectTabsState(value: unknown): ProjectTabsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs) || !record.tabs.every((tab) => typeof tab === 'string')) {
    return null;
  }
  const browserTabs = Array.isArray(record.browserTabs)
    ? record.browserTabs
        .map(normalizeBrowserWorkspaceTab)
        .filter((tab): tab is ProjectBrowserWorkspaceTab => Boolean(tab))
    : [];
  const state: ProjectTabsState = {
    tabs: record.tabs.slice(),
    active: typeof record.active === 'string' ? record.active : null,
  };
  if (browserTabs.length > 0) state.browserTabs = browserTabs;
  return state;
}

function parseProjectTabsStateJson(value: unknown): ProjectTabsState | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeProjectTabsState(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function listTabs(db: SqliteDb, projectId: string) {
  const tenantId = currentTenantId();
  const rows = await db
    .prepare(
      `SELECT name, position, is_active AS isActive
         FROM tabs WHERE project_id = ? AND tenant_id = ? ORDER BY position ASC`,
    )
    .all(projectId, tenantId) as DbRow[];
  const state = await db
    .prepare(`SELECT project_id, updated_at AS updatedAt, state_json AS stateJson FROM tabs_state WHERE project_id = ? AND tenant_id = ? LIMIT 1`)
    .get(projectId, tenantId) as DbRow | undefined;
  const savedState = parseProjectTabsStateJson(state?.stateJson);
  if (savedState) {
    return {
      ...savedState,
      hasSavedState: true,
      updatedAt: Number(state?.updatedAt ?? Date.now()),
    };
  }
  const active = (rows as DbRow[]).find((r: DbRow) => r.isActive) ?? null;
  return {
    tabs: (rows as DbRow[]).map((r: DbRow) => r.name),
    active: active ? active.name : null,
    hasSavedState: rows.length > 0 || Boolean(state),
    updatedAt: state ? Number(state.updatedAt ?? Date.now()) : undefined,
  };
}

export async function setTabs(
  db: SqliteDb,
  projectId: string,
  stateOrNames: ProjectTabsState | string[],
  activeName: string | null = null,
) {
  const tenantId = currentTenantId();
  const state = normalizeProjectTabsState(
    Array.isArray(stateOrNames)
      ? { tabs: stateOrNames, active: activeName }
      : stateOrNames,
  ) ?? { tabs: [], active: null };
  const tx = db.transaction(async () => {
    await db.prepare(
      `INSERT INTO tabs_state (project_id, updated_at, state_json, tenant_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         state_json = excluded.state_json,
         tenant_id = excluded.tenant_id`,
    ).run(projectId, Date.now(), JSON.stringify(state), tenantId);
    await db.prepare(`DELETE FROM tabs WHERE project_id = ? AND tenant_id = ?`).run(projectId, tenantId);
    const ins = db.prepare(
      `INSERT INTO tabs (project_id, name, position, is_active, tenant_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < state.tabs.length; i += 1) {
      const name = state.tabs[i];
      await ins.run(projectId, name, i, name === state.active ? 1 : 0, tenantId);
    }
  });
  await tx();
  return listTabs(db, projectId);
}
