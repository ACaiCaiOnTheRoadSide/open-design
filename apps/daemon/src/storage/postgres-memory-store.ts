import type { QueryResultRow } from 'pg';
import { MemoryInputError, ProjectMemoryScopeUnverifiedError } from '../memory-errors.js';
import { validateMemoryProjectId } from '../memory-scope.js';
import { requireRequestContext } from '../request-context.js';
import { query as pgQuery, transaction as pgTransaction, type PgQueryable } from './pg.js';

export const POSTGRES_MEMORY_TYPES = [
  'profile',
  'user',
  'feedback',
  'project',
  'reference',
  'rule',
] as const;

export type PostgresMemoryType = (typeof POSTGRES_MEMORY_TYPES)[number];

export const POSTGRES_MEMORY_SOURCES = [
  'heuristic',
  'llm',
  'manual',
  'connector',
  'brand',
  'annotation',
] as const;

export type PostgresMemorySource = (typeof POSTGRES_MEMORY_SOURCES)[number];

export interface PostgresMemoryEntry {
  id: string;
  name: string;
  description: string;
  type: PostgresMemoryType;
  source?: PostgresMemorySource;
  /** null is principal-global; undefined inputs are normalized to null. */
  projectId?: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export type MemoryConfigValue =
  | null
  | boolean
  | number
  | string
  | MemoryConfigValue[]
  | { [key: string]: MemoryConfigValue };

export type PostgresMemoryConfig = { [key: string]: MemoryConfigValue };

interface EntryRow extends QueryResultRow {
  id: string;
  name: string;
  description: string;
  type: PostgresMemoryType;
  source: PostgresMemorySource | null;
  project_id: string | null;
  body: string;
  created_at: Date | string | number;
  updated_at: Date | string | number;
}

interface IndexRow extends QueryResultRow {
  index_body: string | null;
}

interface ConfigRow extends QueryResultRow {
  config: PostgresMemoryConfig | string | null;
}

interface SnapshotRow extends QueryResultRow {
  id: string | null;
  name: string;
  description: string;
  type: PostgresMemoryType;
  source: PostgresMemorySource | null;
  project_id: string | null;
  body: string;
  created_at: Date | string | number;
  updated_at: Date | string | number;
  index_body: string | null;
  config: PostgresMemoryConfig | string | null;
}

interface CapabilityRow extends QueryResultRow {
  payload: Record<string, unknown> | string;
  cursor_at: string | number;
  id: string;
}

export interface MemoryCapabilityPage {
  records: Record<string, unknown>[];
  nextCursor: string | null;
}

export interface PostgresMemorySnapshot {
  entries: PostgresMemoryEntry[];
  index: string | null;
  config: PostgresMemoryConfig | null;
}

const ENTRY_ID = /^[a-z0-9_]+$/;
const MEMORY_TYPES = new Set<string>(POSTGRES_MEMORY_TYPES);
const MEMORY_SOURCES = new Set<string>(POSTGRES_MEMORY_SOURCES);

const defaultQueryable: PgQueryable = {
  query: (text, values) => pgQuery(text, values === undefined ? undefined : [...values]),
};

function validateEntry(entry: PostgresMemoryEntry): void {
  if (!ENTRY_ID.test(entry.id) || entry.id.length > 96) throw new MemoryInputError('invalid memory id');
  if (!entry.name) throw new MemoryInputError('memory entry requires a name');
  if (!MEMORY_TYPES.has(entry.type)) throw new MemoryInputError('invalid memory type');
  if (entry.source !== undefined && !MEMORY_SOURCES.has(entry.source)) {
    throw new MemoryInputError('invalid memory source');
  }
  if (entry.projectId !== undefined && entry.projectId !== null) validateMemoryProjectId(entry.projectId);
  if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) {
    throw new MemoryInputError('invalid memory timestamp');
  }
}

function configValue(value: PostgresMemoryConfig | string | null | undefined): PostgresMemoryConfig | null {
  if (typeof value === 'string') return JSON.parse(value) as PostgresMemoryConfig;
  return value ?? null;
}

function timestampMillis(value: Date | string | number): number {
  const millis = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error('PostgreSQL returned an invalid memory timestamp');
  return millis;
}

function mapEntry(row: EntryRow): PostgresMemoryEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    ...(row.source === null ? {} : { source: row.source }),
    projectId: row.project_id,
    body: row.body,
    createdAt: timestampMillis(row.created_at),
    updatedAt: timestampMillis(row.updated_at),
  };
}

const ENTRY_COLUMNS = `
  id, name, description, type, source, project_id, body, created_at, updated_at
`;

export type PgMemoryTransactionRunner = <T>(
  work: (database: PgQueryable) => Promise<T>,
) => Promise<T>;

const INDEX_LINK_RE = /^\s*-\s+\[[^\]]+\]\(([^)]+)\)(?:\s+—\s+.*)?$/;

function replaceOrAppendIndexLine(index: string, id: string, line: string): string {
  const target = `${id}.md`;
  const lines = index.split(/\r?\n/);
  const position = lines.findIndex((candidate) => INDEX_LINK_RE.exec(candidate)?.[1] === target);
  if (position >= 0) lines[position] = line;
  else {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(line);
  }
  return lines.join('\n');
}

function removeIndexLine(index: string, id: string): string {
  const target = `${id}.md`;
  return index.split(/\r?\n/).filter((candidate) => INDEX_LINK_RE.exec(candidate)?.[1] !== target).join('\n');
}

function removeIndexLines(index: string, ids: ReadonlySet<string>): string {
  return index.split(/\r?\n/).filter((candidate) => {
    const target = INDEX_LINK_RE.exec(candidate)?.[1];
    return target === undefined || !target.endsWith('.md') || !ids.has(target.slice(0, -3));
  }).join('\n');
}

/** PostgreSQL memory persistence. Authentication must already have established request context. */
export class PostgresMemoryStore {
  private readonly runTransaction: PgMemoryTransactionRunner;

  constructor(
    private readonly database: PgQueryable = defaultQueryable,
    transactionRunner?: PgMemoryTransactionRunner,
  ) {
    // Production uses a real pool transaction. An injected queryable can also
    // inject transaction behavior; the direct fallback keeps lightweight fakes
    // useful without pretending to own their connection lifecycle.
    this.runTransaction = transactionRunner
      ?? (database === defaultQueryable
        ? (work) => pgTransaction((client) => work(client))
        : (work) => work(database));
  }

  async listEntries(): Promise<PostgresMemoryEntry[]> {
    const { tenantId, userId } = requireRequestContext();
    const result = await this.database.query<EntryRow>(`
      SELECT ${ENTRY_COLUMNS}
      FROM memory_entries
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY updated_at DESC, id ASC
    `, [tenantId, userId]);
    return result.rows.map(mapEntry);
  }

  /** One SQL statement gives composition a single MVCC snapshot, including bodies. */
  async readCompositionSnapshot(options: { projectId?: string } = {}): Promise<PostgresMemorySnapshot> {
    const { tenantId, userId } = requireRequestContext();
    const projectId = options.projectId === undefined ? null : validateMemoryProjectId(options.projectId);
    const result = await this.database.query<SnapshotRow>(`
      SELECT s.index_body, s.config,
        e.id, e.name, e.description, e.type, e.source, e.project_id, e.body, e.created_at, e.updated_at
      FROM (SELECT $1::text AS tenant_id, $2::text AS user_id) principal
      LEFT JOIN memory_settings s
        ON s.tenant_id = principal.tenant_id AND s.user_id = principal.user_id
      LEFT JOIN memory_entries e
        ON e.tenant_id = principal.tenant_id AND e.user_id = principal.user_id
       AND (e.project_id IS NULL OR e.project_id = $3)
      ORDER BY e.updated_at DESC, e.id ASC
    `, [tenantId, userId, projectId]);
    const first = result.rows[0];
    return {
      index: first?.index_body ?? null,
      config: configValue(first?.config),
      entries: result.rows.filter((row) => row.id !== null).map((row) => mapEntry(row as EntryRow)),
    };
  }

  async readEntry(id: string): Promise<PostgresMemoryEntry | null> {
    const { tenantId, userId } = requireRequestContext();
    const result = await this.database.query<EntryRow>(`
      SELECT ${ENTRY_COLUMNS}
      FROM memory_entries
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3
    `, [tenantId, userId, id]);
    const row = result.rows[0];
    return row === undefined ? null : mapEntry(row);
  }

  async upsertEntry(
    entry: PostgresMemoryEntry,
    options: { preserveScope?: boolean; requireGlobalExisting?: boolean } = {},
  ): Promise<PostgresMemoryEntry> {
    const { tenantId, userId } = requireRequestContext();
    validateEntry(entry);
    const result = await this.database.query<EntryRow>(`
      INSERT INTO memory_entries (
        tenant_id, user_id, id, name, description, type, source, project_id, body, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
      ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        type = EXCLUDED.type,
        source = EXCLUDED.source,
        -- Scope omission is resolved only after PostgreSQL locks the conflicting
        -- row. This prevents an earlier facade read from restoring stale scope.
        project_id = CASE WHEN $11::boolean THEN memory_entries.project_id ELSE EXCLUDED.project_id END,
        body = EXCLUDED.body,
        -- Evaluated after PostgreSQL acquires the conflicting row lock. A
        -- later serialized writer therefore cannot return an older timestamp.
        updated_at = clock_timestamp()
      WHERE NOT $12::boolean OR memory_entries.project_id IS NULL
      RETURNING ${ENTRY_COLUMNS}
    `, [
      tenantId,
      userId,
      entry.id,
      entry.name,
      entry.description,
      entry.type,
      entry.source ?? null,
      entry.projectId ?? null,
      entry.body,
      new Date(entry.createdAt),
      options.preserveScope === true,
      options.requireGlobalExisting === true,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      if (options.requireGlobalExisting) throw new ProjectMemoryScopeUnverifiedError();
      throw new Error('PostgreSQL memory upsert returned no row');
    }
    return mapEntry(row);
  }

  /** Atomically writes an entry and its canonical MEMORY.md link. */
  async upsertEntryAndIndex(
    entry: PostgresMemoryEntry,
    indexLine: string,
    defaultIndex: string,
    options: { preserveScope?: boolean; requireGlobalExisting?: boolean } = {},
  ): Promise<PostgresMemoryEntry> {
    return this.runTransaction(async (database) => {
      const store = new PostgresMemoryStore(database, (work) => work(database));
      const saved = await store.upsertEntry(entry, options);
      const { tenantId, userId } = requireRequestContext();
      await database.query(`
        INSERT INTO memory_settings (tenant_id, user_id, index_body)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, user_id) DO NOTHING
      `, [tenantId, userId, defaultIndex]);
      const locked = await database.query<IndexRow>(`
        SELECT index_body FROM memory_settings
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE
      `, [tenantId, userId]);
      const current = locked.rows[0]?.index_body ?? defaultIndex;
      await store.writeIndex(replaceOrAppendIndexLine(current, entry.id, indexLine));
      return saved;
    });
  }

  /** Atomically removes all current-principal entries for projects and their exact index links. */
  async deleteProjectEntriesAndIndexForCurrentPrincipal(projectIds: readonly string[]): Promise<number> {
    const { tenantId, userId } = requireRequestContext();
    const validProjectIds = [...new Set(projectIds.map(validateMemoryProjectId))];
    if (validProjectIds.length === 0) return 0;

    return this.runTransaction(async (database) => {
      // Keep entry-before-settings lock order consistent with ordinary entry mutations.
      const deleted = await database.query<{ id: string }>(`
        DELETE FROM memory_entries
        WHERE tenant_id = $1 AND user_id = $2 AND project_id = ANY($3::text[])
        RETURNING id
      `, [tenantId, userId, validProjectIds]);
      if (deleted.rows.length === 0) return 0;

      const locked = await database.query<IndexRow>(`
        SELECT index_body FROM memory_settings
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE
      `, [tenantId, userId]);
      const current = locked.rows[0]?.index_body;
      if (current != null) {
        const next = removeIndexLines(current, new Set(deleted.rows.map((row) => row.id)));
        if (next !== current) {
          await database.query(`
            UPDATE memory_settings
            SET index_body = $3, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $1 AND user_id = $2
          `, [tenantId, userId, next]);
        }
      }
      return deleted.rows.length;
    });
  }

  async deleteProjectEntriesForCurrentPrincipal(projectId: string): Promise<number> {
    return this.deleteProjectEntriesAndIndexForCurrentPrincipal([projectId]);
  }

  async deleteEntry(id: string, options: { requireGlobal?: boolean } = {}): Promise<boolean> {
    const { tenantId, userId } = requireRequestContext();
    const result = await this.database.query(`
      DELETE FROM memory_entries
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3
        AND (NOT $4::boolean OR project_id IS NULL)
    `, [tenantId, userId, id, options.requireGlobal === true]);
    if ((result.rowCount ?? 0) > 0) return true;
    if (options.requireGlobal) {
      // The conditional DELETE waits for/rechecks concurrent row updates. Read
      // under the same transaction to distinguish a missing row from project scope.
      const existing = await this.database.query<{ project_id: string | null }>(`
        SELECT project_id FROM memory_entries
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3
        FOR UPDATE
      `, [tenantId, userId, id]);
      if (existing.rows[0]?.project_id != null) throw new ProjectMemoryScopeUnverifiedError();
    }
    return false;
  }

  /** Atomically removes an entry and its MEMORY.md link. */
  async deleteEntryAndIndex(
    id: string,
    defaultIndex: string,
    options: { requireGlobal?: boolean } = {},
  ): Promise<boolean> {
    return this.runTransaction(async (database) => {
      const store = new PostgresMemoryStore(database, (work) => work(database));
      const { tenantId, userId } = requireRequestContext();
      // Match the upsert lock order (entry first, settings second) to avoid a
      // same-id upsert/delete deadlock while keeping both changes atomic.
      const removed = await store.deleteEntry(id, options);
      // A failed conditional mutation must not touch or lock the shared index.
      if (!removed) return false;
      await database.query(`
        INSERT INTO memory_settings (tenant_id, user_id, index_body)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, user_id) DO NOTHING
      `, [tenantId, userId, defaultIndex]);
      const locked = await database.query<IndexRow>(`
        SELECT index_body FROM memory_settings
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE
      `, [tenantId, userId]);
      const current = locked.rows[0]?.index_body ?? defaultIndex;
      await store.writeIndex(removeIndexLine(current, id));
      return removed;
    });
  }

  async readIndex(): Promise<string | null> {
    const { tenantId, userId } = requireRequestContext();
    const result = await this.database.query<IndexRow>(`
      SELECT index_body
      FROM memory_settings
      WHERE tenant_id = $1 AND user_id = $2
    `, [tenantId, userId]);
    return result.rows[0]?.index_body ?? null;
  }

  async writeIndex(index: string): Promise<void> {
    const { tenantId, userId } = requireRequestContext();
    await this.database.query(`
      INSERT INTO memory_settings (tenant_id, user_id, index_body)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        index_body = EXCLUDED.index_body,
        updated_at = CURRENT_TIMESTAMP
    `, [tenantId, userId, index]);
  }

  async readConfig(): Promise<PostgresMemoryConfig | null> {
    const { tenantId, userId } = requireRequestContext();
    const result = await this.database.query<ConfigRow>(`
      SELECT config
      FROM memory_settings
      WHERE tenant_id = $1 AND user_id = $2
    `, [tenantId, userId]);
    return configValue(result.rows[0]?.config);
  }

  /** Locks one principal's settings row and applies a top-level patch atomically. */
  async patchConfig(
    patch: PostgresMemoryConfig,
    defaults: PostgresMemoryConfig,
  ): Promise<{ previous: PostgresMemoryConfig; config: PostgresMemoryConfig }> {
    return this.runTransaction(async (database) => {
      const { tenantId, userId } = requireRequestContext();
      await database.query(`
        INSERT INTO memory_settings (tenant_id, user_id, config)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (tenant_id, user_id) DO NOTHING
      `, [tenantId, userId, JSON.stringify(defaults)]);
      const locked = await database.query<ConfigRow>(`
        SELECT config FROM memory_settings
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE
      `, [tenantId, userId]);
      const previous = { ...defaults, ...(configValue(locked.rows[0]?.config) ?? {}) };
      const config = { ...previous, ...patch };
      const store = new PostgresMemoryStore(database, (work) => work(database));
      await store.writeConfig(config);
      return { previous, config };
    });
  }

  async writeConfig(config: PostgresMemoryConfig): Promise<void> {
    const { tenantId, userId } = requireRequestContext();
    await this.database.query(`
      INSERT INTO memory_settings (tenant_id, user_id, config)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        config = EXCLUDED.config,
        updated_at = CURRENT_TIMESTAMP
    `, [tenantId, userId, JSON.stringify(config)]);
  }

  async upsertExtraction(record: Record<string, unknown>): Promise<void> {
    const { tenantId, userId } = requireRequestContext();
    const id = typeof record.id === 'string' ? record.id : '';
    const phase = typeof record.phase === 'string' ? record.phase : '';
    const startedAt = Number(record.startedAt);
    const projectionVersion = Number(record._projectionVersion ?? Date.now());
    if (!id || id === '*' || !['running', 'success', 'failed', 'skipped'].includes(phase)
      || !Number.isSafeInteger(startedAt) || startedAt < 0
      || !Number.isSafeInteger(projectionVersion) || projectionVersion < 0) {
      throw new MemoryInputError('invalid memory extraction record');
    }
    await this.database.query(`
      WITH barriers AS (
        INSERT INTO memory_history_tombstones
          (tenant_id, user_id, kind, record_id, projection_version)
        VALUES ($1, $2, 'extraction', '*', 0), ($1, $2, 'extraction', $3, 0)
        ON CONFLICT (tenant_id, user_id, kind, record_id) DO UPDATE SET
          projection_version = memory_history_tombstones.projection_version
        RETURNING projection_version
      )
      INSERT INTO memory_extractions
        (tenant_id, user_id, id, phase, payload, started_at, updated_at)
      SELECT $1, $2, $3, $4, $5::jsonb, $6, $7
      WHERE $7 > (SELECT MAX(projection_version) FROM barriers)
      ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
        phase = CASE
          WHEN memory_extractions.phase <> 'running' AND EXCLUDED.phase = 'running'
            THEN memory_extractions.phase
          ELSE EXCLUDED.phase
        END,
        payload = CASE
          WHEN memory_extractions.phase <> 'running' AND EXCLUDED.phase = 'running'
            THEN memory_extractions.payload
          ELSE EXCLUDED.payload
        END,
        updated_at = EXCLUDED.updated_at
      WHERE memory_extractions.updated_at <= EXCLUDED.updated_at
    `, [tenantId, userId, id, phase, JSON.stringify(record), startedAt, projectionVersion]);
  }

  async listExtractions(options: { limit?: number; cursor?: string; phase?: string } = {}): Promise<MemoryCapabilityPage> {
    return this.listCapability('memory_extractions', 'started_at', 'phase', options);
  }

  async removeExtraction(id: string, projectionVersion = Date.now()): Promise<number> {
    return this.removeCapability('memory_extractions', 'extraction', id, projectionVersion);
  }

  async clearExtractions(projectionVersion = Date.now()): Promise<number> {
    return this.clearCapability('memory_extractions', 'extraction', projectionVersion);
  }

  async upsertVerification(record: Record<string, unknown>): Promise<void> {
    const { tenantId, userId } = requireRequestContext();
    const id = typeof record.id === 'string' ? record.id : '';
    const status = typeof record.status === 'string' ? record.status : '';
    const occurredAt = Number(record.at);
    const projectionVersion = Number(record._projectionVersion ?? Date.now());
    const projectId = record.projectId == null ? null : validateMemoryProjectId(record.projectId);
    if (!id || id === '*' || !['pass', 'fail', 'missing'].includes(status)
      || !Number.isSafeInteger(occurredAt) || occurredAt < 0
      || !Number.isSafeInteger(projectionVersion) || projectionVersion < 0) {
      throw new MemoryInputError('invalid memory verification record');
    }
    await this.database.query(`
      WITH barriers AS (
        INSERT INTO memory_history_tombstones
          (tenant_id, user_id, kind, record_id, projection_version)
        VALUES ($1, $2, 'verification', '*', 0), ($1, $2, 'verification', $3, 0)
        ON CONFLICT (tenant_id, user_id, kind, record_id) DO UPDATE SET
          projection_version = memory_history_tombstones.projection_version
        RETURNING projection_version
      )
      INSERT INTO memory_verifications
        (tenant_id, user_id, id, project_id, status, payload, occurred_at, updated_at)
      SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8
      WHERE $8 > (SELECT MAX(projection_version) FROM barriers)
      ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
        project_id = EXCLUDED.project_id, status = EXCLUDED.status,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
      WHERE memory_verifications.updated_at <= EXCLUDED.updated_at
    `, [tenantId, userId, id, projectId, status, JSON.stringify(record), occurredAt, projectionVersion]);
  }

  async listVerifications(options: { limit?: number; cursor?: string; status?: string } = {}): Promise<MemoryCapabilityPage> {
    return this.listCapability('memory_verifications', 'occurred_at', 'status', options);
  }

  async removeVerification(id: string, projectionVersion = Date.now()): Promise<number> {
    return this.removeCapability('memory_verifications', 'verification', id, projectionVersion);
  }

  async clearVerifications(projectionVersion = Date.now()): Promise<number> {
    return this.clearCapability('memory_verifications', 'verification', projectionVersion);
  }

  private async listCapability(
    table: 'memory_extractions' | 'memory_verifications',
    timeColumn: 'started_at' | 'occurred_at',
    stateColumn: 'phase' | 'status',
    options: { limit?: number; cursor?: string; phase?: string; status?: string },
  ): Promise<MemoryCapabilityPage> {
    const { tenantId, userId } = requireRequestContext();
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
    const state = stateColumn === 'phase' ? options.phase : options.status;
    const allowedStates = stateColumn === 'phase'
      ? ['running', 'success', 'failed', 'skipped']
      : ['pass', 'fail', 'missing'];
    if (state !== undefined && !allowedStates.includes(state)) {
      throw new MemoryInputError(`invalid memory history ${stateColumn}`);
    }
    let cursorAt: number | null = null;
    let cursorId: string | null = null;
    if (options.cursor) {
      const match = /^(\d+):(.+)$/.exec(options.cursor);
      if (!match) throw new MemoryInputError('invalid memory history cursor');
      cursorAt = Number(match[1]);
      cursorId = match[2] ?? null;
    }
    const result = await this.database.query<CapabilityRow>(`
      SELECT payload, ${timeColumn} AS cursor_at, id
      FROM ${table}
      WHERE tenant_id = $1 AND user_id = $2
        AND ($3::text IS NULL OR ${stateColumn} = $3)
        AND ($4::bigint IS NULL OR (${timeColumn}, id) < ($4, $5))
      ORDER BY ${timeColumn} DESC, id DESC
      LIMIT $6
    `, [tenantId, userId, state ?? null, cursorAt, cursorId, limit + 1]);
    const page = result.rows.slice(0, limit);
    const records = page.map((row) => typeof row.payload === 'string'
      ? JSON.parse(row.payload) as Record<string, unknown> : row.payload);
    const last = page.at(-1);
    return {
      records,
      nextCursor: result.rows.length > limit && last
        ? `${Number(last.cursor_at)}:${last.id}` : null,
    };
  }

  private async removeCapability(
    table: 'memory_extractions' | 'memory_verifications',
    kind: 'extraction' | 'verification',
    id: string,
    projectionVersion: number,
  ): Promise<number> {
    const { tenantId, userId } = requireRequestContext();
    if (!id || id === '*' || !Number.isSafeInteger(projectionVersion) || projectionVersion < 0) {
      throw new MemoryInputError('invalid memory history tombstone');
    }
    const result = await this.database.query(`
      WITH tombstone AS (
        INSERT INTO memory_history_tombstones
          (tenant_id, user_id, kind, record_id, projection_version)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, user_id, kind, record_id) DO UPDATE SET
          projection_version = GREATEST(memory_history_tombstones.projection_version, EXCLUDED.projection_version)
        RETURNING projection_version
      )
      DELETE FROM ${table}
      WHERE tenant_id = $1 AND user_id = $2 AND id = $4
        AND updated_at <= (SELECT projection_version FROM tombstone)
    `, [tenantId, userId, kind, id, projectionVersion]);
    return result.rowCount ?? 0;
  }

  private async clearCapability(
    table: 'memory_extractions' | 'memory_verifications',
    kind: 'extraction' | 'verification',
    projectionVersion: number,
  ): Promise<number> {
    const { tenantId, userId } = requireRequestContext();
    if (!Number.isSafeInteger(projectionVersion) || projectionVersion < 0) {
      throw new MemoryInputError('invalid memory history cutoff');
    }
    const result = await this.database.query(`
      WITH cutoff AS (
        INSERT INTO memory_history_tombstones
          (tenant_id, user_id, kind, record_id, projection_version)
        VALUES ($1, $2, $3, '*', $4)
        ON CONFLICT (tenant_id, user_id, kind, record_id) DO UPDATE SET
          projection_version = GREATEST(memory_history_tombstones.projection_version, EXCLUDED.projection_version)
        RETURNING projection_version
      )
      DELETE FROM ${table}
      WHERE tenant_id = $1 AND user_id = $2
        AND updated_at <= (SELECT projection_version FROM cutoff)
    `, [tenantId, userId, kind, projectionVersion]);
    return result.rowCount ?? 0;
  }
}

export function createPostgresMemoryStore(database?: PgQueryable): PostgresMemoryStore {
  return new PostgresMemoryStore(database);
}
