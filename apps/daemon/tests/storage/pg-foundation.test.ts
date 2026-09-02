import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PoolClient, QueryResult } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { requireRequestContext, runWithRequestContext } from '../../src/request-context.js';
import { resolveDaemonDbConfig } from '../../src/storage/daemon-db.js';
import {
  resolvePgMigrationsDirectory,
  runPgMigrations,
  type MigrationClient,
  type MigrationPool,
} from '../../src/storage/pg-migrations.js';
import {
  closePool,
  query,
  runWithPgPoolCleanupOnFailure,
  setPoolForTests,
  transaction,
  type PgPoolLike,
} from '../../src/storage/pg.js';

const result = (rows: unknown[] = []): QueryResult => ({
  command: '', rowCount: rows.length, oid: 0, fields: [], rows,
});

afterEach(async () => {
  await closePool();
});

describe('daemon database configuration', () => {
  it('defaults to sqlite and strictly parses postgres settings without retaining secrets', () => {
    expect(resolveDaemonDbConfig({})).toEqual({ kind: 'sqlite' });
    const config = resolveDaemonDbConfig({
      OD_DAEMON_DB: 'postgres', OD_PG_HOST: 'db', OD_PG_PORT: '6543',
      OD_PG_DATABASE: 'od', OD_PG_USER: 'daemon', OD_PG_PASSWORD: 'top-secret',
      OD_PG_SSL_MODE: 'verify-full', OD_PG_POOL_MAX: '17', OD_PG_SCHEMA: 'tenant_data',
    });
    expect(config).toEqual({
      kind: 'postgres',
      postgres: {
        host: 'db', port: 6543, database: 'od', user: 'daemon', sslMode: 'verify-full',
        poolMax: 17, schema: 'tenant_data',
      },
    });
    expect(JSON.stringify(config)).not.toContain('top-secret');
  });

  it.each([
    [{ OD_DAEMON_DB: 'postgres' }],
    [{ OD_DAEMON_DB: 'postgres', OD_PG_HOST: 'h', OD_PG_DATABASE: 'd', OD_PG_USER: 'u', OD_PG_PORT: '12x' }],
    [{ OD_DAEMON_DB: 'postgres', OD_PG_HOST: 'h', OD_PG_DATABASE: 'd', OD_PG_USER: 'u', OD_PG_SSL_MODE: 'maybe' }],
    [{ OD_DAEMON_DB: 'postgres', OD_PG_HOST: 'h', OD_PG_DATABASE: 'd', OD_PG_USER: 'u', OD_PG_POOL_MAX: '0' }],
    [{ OD_DAEMON_DB: 'postgres', OD_PG_HOST: 'h', OD_PG_DATABASE: 'd', OD_PG_USER: 'u', OD_PG_SCHEMA: 'bad;drop' }],
  ])('rejects invalid postgres configuration without echoing secrets', (env) => {
    expect(() => resolveDaemonDbConfig({ ...env, OD_PG_PASSWORD: 'never-print-me' }))
      .toThrowError(/OD_/);
    try {
      resolveDaemonDbConfig({ ...env, OD_PG_PASSWORD: 'never-print-me' });
    } catch (error) {
      expect(String(error)).not.toContain('never-print-me');
    }
  });
});

describe('verified request context', () => {
  it('fails explicitly outside a scope', () => {
    expect(() => requireRequestContext()).toThrow(/No verified principal/);
  });

  it('isolates concurrent async work and restores nested scopes', async () => {
    const observe = (tenantId: string, delay: number) => runWithRequestContext(
      { tenantId, userId: `user-${tenantId}` },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return requireRequestContext().tenantId;
      },
    );
    expect(await Promise.all([observe('a', 10), observe('b', 0)])).toEqual(['a', 'b']);

    await runWithRequestContext({ tenantId: 'outer', userId: 'u' }, async () => {
      expect(requireRequestContext().tenantId).toBe('outer');
      await runWithRequestContext({ tenantId: 'inner', userId: 'u2', workspaceId: 'w' }, async () => {
        await Promise.resolve();
        expect(requireRequestContext().tenantId).toBe('inner');
      });
      expect(requireRequestContext().tenantId).toBe('outer');
    });
  });
});

describe('PostgreSQL startup pool lifecycle', () => {
  it('closes the shared pool for any later initialization failure and preserves the original error', async () => {
    let endCalls = 0;
    const pool = {
      connect: async () => { throw new Error('not used'); },
      query: async () => result(),
      end: async () => { endCalls += 1; },
    } as unknown as PgPoolLike;
    setPoolForTests(pool);
    const original = new Error('listener installation failed');

    await expect(runWithPgPoolCleanupOnFailure(true, async () => {
      await Promise.resolve(); // migration completed
      throw original; // any subsequent initialization stage
    })).rejects.toBe(original);
    expect(endCalls).toBe(1);

    const replacement = { ...pool, end: async () => { endCalls += 1; } } as PgPoolLike;
    setPoolForTests(replacement);
    await expect(runWithPgPoolCleanupOnFailure(true, async () => 'started')).resolves.toBe('started');
    expect(endCalls).toBe(1);
  });
});

describe('postgres transactions', () => {
  it('commits on success and routes helper queries through one checked-out client', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => { calls.push(sql); return result(); },
      release: () => calls.push('RELEASE'),
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
      query: async () => { throw new Error('pool query must not be used in a transaction'); },
      end: async () => undefined,
    } as PgPoolLike;

    await transaction(async (checkedOut) => {
      expect(checkedOut).toBe(client);
      await query('SELECT inside');
    }, pool);
    expect(calls).toEqual(['BEGIN', 'SELECT inside', 'COMMIT', 'RELEASE']);
  });

  it('rolls back and releases the same client on failure', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => { calls.push(sql); return result(); },
      release: () => calls.push('RELEASE'),
    } as unknown as PoolClient;
    const pool = { connect: async () => client, query: client.query, end: async () => undefined } as PgPoolLike;
    await expect(transaction(async () => { throw new Error('boom'); }, pool)).rejects.toThrow('boom');
    expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  it('reuses the active client for nested transactions without resolving the global pool', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => { calls.push(sql); return result(); },
      release: () => calls.push('RELEASE'),
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
      query: async () => { throw new Error('pool query must not be used in a transaction'); },
      end: async () => undefined,
    } as PgPoolLike;

    await transaction(async (outerClient) => {
      await transaction(async (innerClient) => {
        expect(innerClient).toBe(outerClient);
        calls.push('INNER');
      });
    }, pool);

    expect(calls).toEqual(['BEGIN', 'INNER', 'COMMIT', 'RELEASE']);
  });
});

describe('postgres migrations', () => {
  it('resolves package-root migrations from source and emitted module locations', () => {
    const packageRoot = path.resolve(import.meta.dirname, '..', '..');
    expect(resolvePgMigrationsDirectory(new URL('../../src/storage/pg-migrations.js', import.meta.url).href))
      .toBe(path.join(packageRoot, 'migrations', 'postgres'));
    expect(resolvePgMigrationsDirectory(new URL('../../dist/storage/pg-migrations.js', import.meta.url).href))
      .toBe(path.join(packageRoot, 'migrations', 'postgres'));
  });

  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

  async function migrationDirectory(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'od-pg-migrations-'));
    directories.push(directory);
    await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(path.join(directory, name), sql)));
    return directory;
  }

  function fakePool(failSql?: string, appliedAtType = 'timestamp with time zone') {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const applied = new Set<string>();
    let connections = 0;
    let releases = 0;
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push(values === undefined ? { sql } : { sql, values });
        if (sql.startsWith('SELECT data_type FROM information_schema.columns')) {
          return result([{ data_type: appliedAtType }]);
        }
        if (sql.startsWith('SELECT filename')) return result([...applied].map((filename) => ({ filename })));
        if (sql.startsWith('INSERT INTO')) applied.add(String(values?.[0]));
        if (sql === failSql) throw new Error('migration failed');
        return result();
      },
      release() { releases += 1; },
    } as MigrationClient;
    const pool = {
      async connect() {
        connections += 1;
        return client;
      },
    } as MigrationPool;
    return { pool, calls, applied, connections: () => connections, releases: () => releases };
  }

  it('sorts files, locks before rechecking, and is idempotent', async () => {
    const directory = await migrationDirectory({ '002_second.sql': 'SQL TWO', '001_first.sql': 'SQL ONE', 'notes.txt': 'ignored' });
    const fake = fakePool();
    expect(await runPgMigrations({ pool: fake.pool, directory, schema: 'daemon' }))
      .toEqual(['001_first.sql', '002_second.sql']);
    expect(fake.calls.map(({ sql }) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'CREATE SCHEMA IF NOT EXISTS "daemon"',
      'CREATE TABLE IF NOT EXISTS "daemon"."schema_migrations" (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
      'SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
      'SELECT filename FROM "daemon"."schema_migrations"',
      'SQL ONE', 'INSERT INTO "daemon"."schema_migrations" (filename, applied_at) VALUES ($1, CURRENT_TIMESTAMP)',
      'SQL TWO', 'INSERT INTO "daemon"."schema_migrations" (filename, applied_at) VALUES ($1, CURRENT_TIMESTAMP)',
      'COMMIT',
    ]);
    expect(await runPgMigrations({ pool: fake.pool, directory, schema: 'daemon' })).toEqual([]);
    expect(fake.connections()).toBe(2);
    expect(fake.releases()).toBe(2);
  });

  it('records and rechecks migrations with the legacy bigint applied_at ledger', async () => {
    const directory = await migrationDirectory({ '001_legacy_compatible.sql': 'LEGACY SQL' });
    const fake = fakePool(undefined, 'bigint');

    await expect(runPgMigrations({ pool: fake.pool, directory, schema: 'legacy' }))
      .resolves.toEqual(['001_legacy_compatible.sql']);
    expect(fake.calls).toContainEqual({
      sql: 'INSERT INTO "legacy"."schema_migrations" (filename, applied_at) VALUES ($1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)',
      values: ['001_legacy_compatible.sql'],
    });
    await expect(runPgMigrations({ pool: fake.pool, directory, schema: 'legacy' })).resolves.toEqual([]);
    expect(fake.applied).toEqual(new Set(['001_legacy_compatible.sql']));
  });

  it('keeps transaction control exclusively in the runner for every packaged migration', async () => {
    const directory = resolvePgMigrationsDirectory(
      new URL('../../src/storage/pg-migrations.js', import.meta.url).href,
    );
    const sqlFiles = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    expect(sqlFiles).toEqual([
      '001_core_memory.sql',
      '002_project_memory_scope.sql',
      '003_plugin_install_intents.sql',
      '004_business_facts.sql',
      '005_run_queue.sql',
      '006_brand_design_system_registry.sql',
      '007_library_plugin_registry.sql',
      '008_memory_capabilities.sql',
      '009_business_fact_dimensions.sql',
      '010_memory_history_tombstones.sql',
      '011_app_configs.sql',
      '012_legacy_conversation_timestamps.sql',
      '013_appstats_run_results.sql',
      '014_legacy_message_projection.sql',
      '015_backfill_appstats_run_results.sql',
      '016_tool_call_facts.sql',
      '017_recover_legacy_project_owners.sql',
      '018_tool_call_dimensions.sql',
    ]);
    for (const filename of sqlFiles) {
      const sql = await readFile(path.join(directory, filename), 'utf8');
      // PL/pgSQL DO blocks contain BEGIN/END, but no migration file may own a
      // top-level transaction terminator: the runner must commit schema + marker.
      expect(sql, filename).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/imu);
    }
  });

  it('packages and applies the real PostgreSQL migrations in order', async () => {
    const directory = resolvePgMigrationsDirectory(
      new URL('../../src/storage/pg-migrations.js', import.meta.url).href,
    );
    const fake = fakePool();
    await expect(runPgMigrations({ pool: fake.pool, directory })).resolves.toEqual([
      '001_core_memory.sql',
      '002_project_memory_scope.sql',
      '003_plugin_install_intents.sql',
      '004_business_facts.sql',
      '005_run_queue.sql',
      '006_brand_design_system_registry.sql',
      '007_library_plugin_registry.sql',
      '008_memory_capabilities.sql',
      '009_business_fact_dimensions.sql',
      '010_memory_history_tombstones.sql',
      '011_app_configs.sql',
      '012_legacy_conversation_timestamps.sql',
      '013_appstats_run_results.sql',
      '014_legacy_message_projection.sql',
      '015_backfill_appstats_run_results.sql',
      '016_tool_call_facts.sql',
      '017_recover_legacy_project_owners.sql',
      '018_tool_call_dimensions.sql',
    ]);
    const projectScopeSql = fake.calls.find(({ sql }) => sql.includes('ADD COLUMN IF NOT EXISTS project_id'))?.sql;
    expect(projectScopeSql).toContain('memory_entries_project_id_check');
    expect(projectScopeSql).toContain('memory_entries_principal_project_updated_idx');
    expect(projectScopeSql).not.toContain('REFERENCES projects');
    // PL/pgSQL requires the block body's END statement and the dollar-quoted
    // DO command itself to each terminate with a semicolon.
    expect(projectScopeSql).toMatch(/DO \$migration\$[\s\S]*\nEND;\n\$migration\$;/);
    expect(projectScopeSql).not.toMatch(/\nEND\n\$migration\$;/);

    const businessFactsSql = fake.calls.find(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS business_stat_events'))?.sql;
    expect(businessFactsSql).toBeDefined();
    const businessSql = businessFactsSql ?? '';
    expect(businessSql).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at bigint');
    expect(businessSql).toMatch(/UPDATE messages SET updated_at = COALESCE\(updated_at, ended_at, started_at, created_at, 0\)/);
    expect(businessSql).toContain('ALTER TABLE projects ADD COLUMN IF NOT EXISTS creator_id text');
    expect(businessSql).toContain('ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS updated_at bigint');
    expect(businessSql).toContain('ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS published_count bigint DEFAULT 0');
    expect(businessSql.indexOf('ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at bigint'))
      .toBeLessThan(businessSql.indexOf('idx_messages_conversation_updated'));

    const pluginIntentSql = fake.calls.find(({ sql }) => sql.includes('CREATE TABLE plugin_install_intents'))?.sql;
    expect(pluginIntentSql).toContain('plugin_id text PRIMARY KEY');
    expect(pluginIntentSql).toContain("desired_state IN ('installed', 'absent')");
    expect(pluginIntentSql).toContain('revision bigint NOT NULL DEFAULT 1');
    expect(pluginIntentSql).toContain('last_attempt_at timestamptz');
    expect(pluginIntentSql).toContain('last_success_at timestamptz');
    expect(pluginIntentSql).toContain('last_error_at timestamptz');
    expect(pluginIntentSql).toContain("source_kind IN ('github', 'https')");
  });

  it.each(['BEGIN ISOLATION LEVEL READ COMMITTED', 'BROKEN SQL'])('rolls back and releases when %s fails', async (failSql) => {
    const directory = await migrationDirectory({ '001_broken.sql': 'BROKEN SQL' });
    const fake = fakePool(failSql);
    await expect(runPgMigrations({ pool: fake.pool, directory })).rejects.toThrow('migration failed');
    expect(fake.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(fake.calls.some(({ sql }) => sql === 'COMMIT')).toBe(false);
    expect(fake.connections()).toBe(1);
    expect(fake.releases()).toBe(1);
  });

  it('validates schema and directory before checking out a connection', async () => {
    const fake = fakePool();
    await expect(runPgMigrations({ pool: fake.pool, directory: '/definitely/missing', schema: 'bad;schema' }))
      .rejects.toThrow(/valid identifier/);
    expect(fake.connections()).toBe(0);
  });
});
