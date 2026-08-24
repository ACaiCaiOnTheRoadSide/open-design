import Database from 'better-sqlite3';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  importLegacyPostgresMetadata,
  LEGACY_METADATA_TABLES_V2,
  type LegacyMetadataPgSource,
} from '../../src/storage/legacy-metadata-import.js';

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function sqlite(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata_json TEXT,
      fact_tenant_id TEXT, fact_creator_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT,
      session_mode TEXT NOT NULL DEFAULT 'design', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, events_json TEXT, position INTEGER NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id));
    CREATE TABLE agent_sessions (conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, agent_id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id));
    CREATE TABLE tabs (project_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, name), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE tabs_state (project_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, state_json TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE preview_comments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL, element_id TEXT NOT NULL, selector TEXT NOT NULL, label TEXT NOT NULL,
      text TEXT NOT NULL, position_json TEXT NOT NULL, html_hint TEXT NOT NULL, slide_key INTEGER NOT NULL DEFAULT -1,
      note TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(conversation_id) REFERENCES conversations(id));
  `);
  return db;
}

const fullRows: Record<string, Array<Record<string, unknown>>> = {
  projects: [{
    id: 'p1', name: 'legacy project', metadata_json: '{"source":"pg"}', tenant_id: 'tenant-1',
    creator_id: 'user-1', created_at: 10, updated_at: 20,
  }],
  conversations: [{ id: 'c1', project_id: 'p1', title: 'legacy title', session_mode: 'chat', created_at: 11, updated_at: 21 }],
  messages: [{ id: 'm1', conversation_id: 'c1', role: 'assistant', content: 'secret body',
    events_json: `[${'"event",'.repeat(500)}"done"]`, position: 0, created_at: 12 }],
  agent_sessions: [{ conversation_id: 'c1', agent_id: 'a1', session_id: 's1', updated_at: 22 }],
  tabs: [{ project_id: 'p1', name: 'index.html', position: 0, is_active: 1 }],
  tabs_state: [{ project_id: 'p1', updated_at: 23, state_json: '{"active":"index.html"}' }],
  preview_comments: [{ id: 'pc1', project_id: 'p1', conversation_id: 'c1', file_path: 'index.html',
    element_id: 'hero', selector: '#hero', label: 'Hero', text: 'comment body', position_json: '{}',
    html_hint: '<div>', slide_key: -1, note: 'note body', status: 'open', created_at: 13, updated_at: 24 }],
};

function pgSource(
  tableRows: Record<string, Array<Record<string, unknown>>>,
  options: {
    failTable?: string;
    failDomainOnce?: string;
    domains?: Set<string>;
    ownerWrites?: unknown[][];
    brandWrites?: unknown[][];
  } = {},
): LegacyMetadataPgSource & { pageCalls: Array<{ table: string; limit: number; offset: number }> } {
  const pageCalls: Array<{ table: string; limit: number; offset: number }> = [];
  const domains = options.domains ?? new Set<string>();
  return {
    pageCalls,
    async query<R extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<R>> {
      if (sql.includes('information_schema.columns')) {
        const rows = Object.entries(tableRows).flatMap(([table_name, entries]) => {
          const columns = new Set(entries.flatMap((entry) => Object.keys(entry)));
          return [...columns].map((column_name) => ({ table_name, column_name }));
        });
        return result(rows as unknown as R[]);
      }
      if (sql.includes('CREATE TABLE IF NOT EXISTS') && sql.includes('legacy_metadata_import_domains')) {
        return result([] as R[]);
      }
      if (sql.includes('SELECT domain FROM') && sql.includes('legacy_metadata_import_domains')) {
        return result([...domains].map((domain) => ({ domain })) as unknown as R[]);
      }
      if (sql.includes('INSERT INTO') && sql.includes('saas_resource_owners')) {
        options.ownerWrites?.push([...(values ?? [])]);
        return result([] as R[]);
      }
      if (sql.includes('INSERT INTO') && sql.includes('brand_design_system_registry')) {
        options.brandWrites?.push([...(values ?? [])]);
        return result([] as R[]);
      }
      if (sql.includes('INSERT INTO') && sql.includes('legacy_metadata_import_domains')) {
        const domain = String(values?.[1]);
        if (options.failDomainOnce === domain) {
          delete options.failDomainOnce;
          throw new Error(`domain marker crash: ${domain}`);
        }
        domains.add(domain);
        return result([] as R[]);
      }
      const table = /FROM "legacy"\."([a-z_]+)"/.exec(sql)?.[1];
      if (!table) throw new Error(`unexpected SQL: ${sql}`);
      if (options.failTable === table) throw new Error('fixture query failed');
      const limit = Number(values?.[0]);
      const offset = Number(values?.[1]);
      pageCalls.push({ table, limit, offset });
      return result((tableRows[table] ?? []).slice(offset, offset + limit) as R[]);
    },
  };
}

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fullManifestFixture(pvcRoot: string): Record<string, Array<Record<string, unknown>>> {
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  for (const spec of LEGACY_METADATA_TABLES_V2) {
    const row: Record<string, unknown> = {};
    for (const column of spec.columns) {
      row[column] = column.endsWith('_json') ? '{}'
        : column.endsWith('_at') || ['position', 'is_active', 'dim', 'size', 'width', 'height', 'iteration'].includes(column) ? 1
          : `${spec.name}-${column}`;
    }
    rows[spec.name] = [row];
  }
  const one = (name: string) => rows[name]![0]!;
  Object.assign(one('projects'), { id: 'p1', tenant_id: 'tenant-1', creator_id: 'user-1' });
  Object.assign(one('conversations'), { id: 'c1', project_id: 'p1', session_mode: 'chat' });
  Object.assign(one('messages'), { id: 'm1', conversation_id: 'c1', role: 'assistant', content: 'body', position: 0 });
  Object.assign(one('agent_sessions'), { conversation_id: 'c1', agent_id: 'agent-1' });
  Object.assign(one('tabs'), { project_id: 'p1', name: 'index.html' });
  Object.assign(one('tabs_state'), { project_id: 'p1' });
  Object.assign(one('preview_comments'), { id: 'comment-1', project_id: 'p1', conversation_id: 'c1' });
  Object.assign(one('templates'), { id: 'template-1', source_project_id: 'p1' });
  Object.assign(one('deployments'), { id: 'deployment-1', project_id: 'p1' });
  Object.assign(one('routines'), { id: 'routine-1', project_id: 'p1' });
  Object.assign(one('routine_runs'), { id: 'routine-run-1', routine_id: 'routine-1', project_id: 'p1', conversation_id: 'c1' });
  Object.assign(one('routine_schedule_claims'), { routine_id: 'routine-1', slot_at: 1 });
  Object.assign(one('critique_runs'), { id: 'critique-1', project_id: 'p1', conversation_id: 'c1' });
  Object.assign(one('installed_plugins'), { id: 'plugin-1', source_kind: 'local', fs_path: '/outside-pvc/plugin' });
  Object.assign(one('plugin_marketplaces'), { id: 'market-1', url: 'https://example.test/market.json' });
  Object.assign(one('applied_plugin_snapshots'), { id: 'snapshot-1', project_id: 'p1', conversation_id: 'c1' });
  Object.assign(one('run_devloop_iterations'), { id: 'iteration-1' });
  Object.assign(one('genui_surfaces'), { id: 'surface-1', project_id: 'p1', conversation_id: 'c1', plugin_snapshot_id: 'snapshot-1' });
  Object.assign(one('skill_plugin_candidates'), { id: 'candidate-1', project_id: 'p1', conversation_id: 'c1', assistant_message_id: 'm1' });
  Object.assign(one('registry_entries'), { backend_id: 'backend-1', name: 'entry-1' });
  Object.assign(one('library_assets'), {
    id: 'asset-1', origin_project_id: 'p1', storage: 'owned', file_path: path.join(pvcRoot, 'library', 'asset.png'),
  });
  Object.assign(one('library_asset_sources'), { id: 'asset-source-1', asset_id: 'asset-1', project_id: 'p1', conversation_id: 'c1' });
  Object.assign(one('library_embeddings'), { asset_id: 'asset-1' });
  Object.assign(one('library_tasks'), { id: 'task-1', asset_id: 'asset-1' });
  Object.assign(one('library_tokens'), { token_hash: 'token-1' });
  return rows;
}

function fullManifestSqlite(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const spec of LEGACY_METADATA_TABLES_V2) {
    const columns = [...spec.columns];
    if (spec.name === 'projects' || spec.name === 'routines') columns.push('fact_tenant_id', 'fact_creator_id');
    const definitions = columns.map((column) => `"${column}" ${spec.key.includes(column) ? 'TEXT NOT NULL' : 'TEXT'}`);
    definitions.push(`PRIMARY KEY (${spec.key.map((column) => `"${column}"`).join(',')})`);
    for (const parent of spec.parents ?? []) {
      definitions.push(`FOREIGN KEY ("${parent.column}") REFERENCES "${parent.table}"("${parent.targetColumn}")`);
    }
    db.exec(`CREATE TABLE "${spec.name}" (${definitions.join(',')})`);
  }
  return db;
}

describe('legacy PostgreSQL metadata import', () => {
  it('covers every one of the 25-table manifest with columns, PK/FK and owner/PVC disposition', async () => {
    expect(LEGACY_METADATA_TABLES_V2).toHaveLength(25);
    const db = fullManifestSqlite(); databases.push(db);
    const ownerWrites: unknown[][] = [];
    const pvcRoot = path.resolve('/trusted-pvc');
    const rows = fullManifestFixture(pvcRoot);
    const pg = pgSource(rows, { ownerWrites });
    const imported = await importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy', pageSize: 1, pvcRoots: [pvcRoot] });

    expect(imported).toEqual({ status: 'imported', importedRows: 25, discardedRows: {}, quarantinedRows: 3 });
    expect(new Set(pg.pageCalls.map(({ table }) => table))).toEqual(new Set(LEGACY_METADATA_TABLES_V2.map(({ name }) => name)));
    for (const spec of LEGACY_METADATA_TABLES_V2) {
      expect((db.prepare(`SELECT count(*) AS count FROM "${spec.name}"`).get() as { count: number }).count, spec.name).toBe(1);
      const sourceColumns = Object.keys(rows[spec.name]![0]!);
      const targetColumns = (db.prepare(`PRAGMA table_info("${spec.name}")`).all() as Array<{ name: string }>).map(({ name }) => name);
      expect(sourceColumns.filter((column) => targetColumns.includes(column)), spec.name).toEqual([...spec.columns]);
    }
    expect(ownerWrites).toHaveLength(7);
    const assetOwner = ownerWrites.find((values) => values[0] === 'library_asset');
    expect(assetOwner?.[2]).toBe('tenant-1');
    expect(assetOwner?.[6]).toBe(path.join(pvcRoot, 'library', 'asset.png'));
    const pluginOwner = ownerWrites.find((values) => values[0] === 'plugin');
    expect(pluginOwner?.[2]).toBe('__legacy_quarantine__');
    expect(pluginOwner?.[8]).toContain('legacy-local-path-outside-pvc');
  });

  it('restarts safely after a cross-database domain-marker crash', async () => {
    const db = fullManifestSqlite(); databases.push(db);
    const domains = new Set<string>();
    const ownerWrites: unknown[][] = [];
    const options = { domains, ownerWrites, failDomainOnce: 'brand-design-system-registry' };
    const rows = {
      ...fullManifestFixture('/trusted-pvc'),
      brands: [{ id: 'brand-1', name: 'Brand', tenant_id: 'tenant-1', creator_id: 'user-1', created_at: 1, updated_at: 1, deleted_at: null }],
    };
    const pg = pgSource(rows, options);
    await expect(importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy', pvcRoots: ['/trusted-pvc'] }))
      .rejects.toThrow('domain marker crash');
    expect(domains).toEqual(new Set(['resource-owner-registry']));
    expect(db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 0 });
    const ownerCountAfterCrash = ownerWrites.length;

    await expect(importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy', pvcRoots: ['/trusted-pvc'] }))
      .resolves.toMatchObject({ status: 'imported', importedRows: 25 });
    expect(ownerWrites).toHaveLength(ownerCountAfterCrash); // completed PG domain is not replayed
    expect(domains).toEqual(new Set(['resource-owner-registry', 'brand-design-system-registry']));
    expect(db.prepare('SELECT count(*) AS count FROM external_metadata_imports').get()).toEqual({ count: 1 });
  });

  it('explicitly retains and counts manifest rows whose SQLite target is unavailable', async () => {
    const db = sqlite(); databases.push(db);
    const rows = structuredClone(fullRows);
    rows.installed_plugins = [{
      id: 'plugin-retained', title: 'Retained', source_kind: 'github',
      resolved_source: 'https://github.com/example/plugin', installed_at: 1, updated_at: 2,
      tenant_id: 'tenant-1', creator_id: 'user-1',
    }];
    const ownerWrites: unknown[][] = [];
    await expect(importLegacyPostgresMetadata({ sqlite: db, pg: pgSource(rows, { ownerWrites }), schema: 'legacy' }))
      .resolves.toEqual({
        status: 'imported', importedRows: 7, discardedRows: {},
        retainedRows: { installed_plugins: 1 }, quarantinedRows: 0,
      });
    expect(ownerWrites).toHaveLength(1);
    expect(ownerWrites[0]?.slice(0, 4)).toEqual(['plugin', 'plugin-retained', 'tenant-1', 'user-1']);
  });

  it('imports the full fixture in pages and maps project ownership', async () => {
    const db = sqlite(); databases.push(db);
    const pg = pgSource(fullRows);
    const imported = await importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy', pageSize: 1 });

    expect(imported).toEqual({ status: 'imported', importedRows: 7, discardedRows: {}, quarantinedRows: 0 });
    expect(db.prepare('SELECT name, metadata_json, fact_tenant_id, fact_creator_id FROM projects').get()).toEqual({
      name: 'legacy project', metadata_json: '{"source":"pg"}', fact_tenant_id: 'tenant-1', fact_creator_id: 'user-1',
    });
    expect(db.prepare('SELECT title, session_mode FROM conversations').get()).toEqual({ title: 'legacy title', session_mode: 'chat' });
    expect(db.prepare('SELECT role, content, position FROM messages').get()).toEqual({ role: 'assistant', content: 'secret body', position: 0 });
    expect(pg.pageCalls.filter(({ table }) => table === 'messages')).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS count FROM external_metadata_imports').get()).toEqual({ count: 1 });
  });

  it('merges into non-empty SQLite without overwriting current rows and is idempotent', async () => {
    const db = sqlite(); databases.push(db);
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('p1', 'current project', '{"source":"sqlite"}', '', null, 100, 200);
    const pg = pgSource(fullRows);

    await importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy' });
    expect(db.prepare('SELECT name, metadata_json, fact_tenant_id, fact_creator_id FROM projects').get()).toEqual({
      name: 'current project', metadata_json: '{"source":"sqlite"}', fact_tenant_id: 'tenant-1', fact_creator_id: 'user-1',
    });
    await expect(importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy' })).resolves.toEqual({
      status: 'already-imported', importedRows: 0,
    });
  });

  it('treats a narrow facts schema as a no-op without recording a marker', async () => {
    const db = sqlite(); databases.push(db);
    const pg = pgSource({
      projects: [{ id: 'p1', name: 'fact', tenant_id: 't', creator_id: 'u', created_at: 1, updated_at: 1 }],
      conversations: [{ id: 'c1', project_id: 'p1' }],
      messages: [{ id: 'm1', conversation_id: 'c1', run_status: 'running', created_at: 1, updated_at: 1 }],
    });
    await expect(importLegacyPostgresMetadata({ sqlite: db, pg, schema: 'legacy' })).resolves.toEqual({
      status: 'not-legacy-full-schema', importedRows: 0,
    });
    expect(db.prepare('SELECT count(*) AS count FROM external_metadata_imports').get()).toEqual({ count: 0 });
  });

  it('clears an orphaned nullable parent while preserving the child', async () => {
    const db = fullManifestSqlite(); databases.push(db);
    const orphanRows = fullManifestFixture(path.resolve('/trusted-pvc'));
    orphanRows.templates![0]!.source_project_id = 'missing';

    await expect(importLegacyPostgresMetadata({ sqlite: db, pg: pgSource(orphanRows), schema: 'legacy' }))
      .resolves.toMatchObject({ status: 'imported' });
    expect(db.prepare('SELECT id, source_project_id FROM templates').get()).toEqual({
      id: 'template-1', source_project_id: null,
    });
  });

  it('fails closed on a required orphan and rolls back rows and marker', async () => {
    const db = sqlite(); databases.push(db);
    const orphanRows = structuredClone(fullRows);
    orphanRows.conversations![0]!.project_id = 'missing';
    await expect(importLegacyPostgresMetadata({ sqlite: db, pg: pgSource(orphanRows), schema: 'legacy' }))
      .rejects.toThrow(/orphan conversations\.project_id/);
    expect(db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM external_metadata_imports').get()).toEqual({ count: 0 });
  });

  it('does not leave partial rows or marker when a page query fails', async () => {
    const db = sqlite(); databases.push(db);
    await expect(importLegacyPostgresMetadata({
      sqlite: db, pg: pgSource(fullRows, { failTable: 'messages' }), schema: 'legacy',
    })).rejects.toThrow('fixture query failed');
    expect(db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM external_metadata_imports').get()).toEqual({ count: 0 });
  });

  it('reports a versioned count for every explicitly discarded cache row', async () => {
    const db = sqlite(); databases.push(db);
    const rows = structuredClone(fullRows);
    rows.library_digests = [
      { date: '2026-08-22', summary: 'rebuild me' },
      { date: '2026-08-23', summary: 'rebuild me too' },
    ];
    const imported = await importLegacyPostgresMetadata({
      sqlite: db, pg: pgSource(rows), schema: 'legacy', pageSize: 1,
    });
    expect(imported.discardedRows).toEqual({ library_digests: 2 });
  });
});
