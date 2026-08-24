import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResult, QueryResultRow } from 'pg';

/** Resolves package-root migrations from either src/ or emitted dist/. */
export function resolvePgMigrationsDirectory(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..', 'migrations', 'postgres');
}

export interface MigrationClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface PgMigrationOptions {
  pool: MigrationPool;
  directory: string;
  schema?: string;
  lockName?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quotePgIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) throw new Error('PostgreSQL schema name is not a valid identifier');
  return `"${identifier}"`;
}

/** Applies all pending files atomically while holding a transaction advisory lock. */
export async function runPgMigrations(options: PgMigrationOptions): Promise<string[]> {
  const { directory } = options;
  const schema = options.schema ?? 'public';
  const quotedSchema = quotePgIdentifier(schema);
  const table = `${quotedSchema}."schema_migrations"`;
  const files = (await readdir(directory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const client = await options.pool.connect();

  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      options.lockName ?? `open-design-daemon-migrations:${schema}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (`
      + 'filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );

    // Older daemon releases created applied_at as a Unix-millisecond bigint
    // without a default. Inspect the actual ledger instead of relying on the
    // CREATE TABLE shape above, which is a no-op for an existing table.
    const appliedAtColumn = await client.query<{ data_type: string }>(
      'SELECT data_type FROM information_schema.columns '
      + 'WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
      [schema, 'schema_migrations', 'applied_at'],
    );
    const appliedAtType: string | undefined = appliedAtColumn.rows[0]?.data_type;
    const insertAppliedMigration = appliedAtType === 'bigint'
      ? `INSERT INTO ${table} (filename, applied_at) VALUES ($1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)`
      : appliedAtType === 'timestamp with time zone'
        ? `INSERT INTO ${table} (filename, applied_at) VALUES ($1, CURRENT_TIMESTAMP)`
        : null;
    if (!insertAppliedMigration) {
      throw new Error(`Unsupported schema_migrations.applied_at type: ${appliedAtType ?? 'missing'}`);
    }

    // This check intentionally occurs after taking the lock. Another daemon may
    // have completed migrations while this one was waiting.
    const result = await client.query<{ filename: string }>(`SELECT filename FROM ${table}`);
    const alreadyApplied = new Set(result.rows.map((row) => row.filename));
    const applied: string[] = [];

    for (const filename of files) {
      if (alreadyApplied.has(filename)) continue;
      const sql = await readFile(path.join(directory, filename), 'utf8');
      await client.query(sql);
      await client.query(insertAppliedMigration, [filename]);
      applied.push(filename);
    }

    await client.query('COMMIT');
    return applied;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Keep the migration failure as the reported error.
    }
    throw error;
  } finally {
    client.release();
  }
}
