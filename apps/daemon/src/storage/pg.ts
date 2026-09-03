import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { resolveDaemonDbConfig } from './daemon-db.js';

export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export type PgPoolFactory = (config: PoolConfig) => PgPoolLike;

const transactionClients = new AsyncLocalStorage<PoolClient>();
let sharedPool: PgPoolLike | undefined;

export function getPool(
  env: Record<string, string | undefined> = process.env,
  factory: PgPoolFactory = (config) => new Pool(config),
): PgPoolLike {
  if (sharedPool) return sharedPool;
  const config = resolveDaemonDbConfig(env);
  if (config.kind !== 'postgres') throw new Error('PostgreSQL pool requested while OD_DAEMON_DB is not postgres');

  const pg = config.postgres;
  sharedPool = factory({
    host: pg.host,
    port: pg.port,
    database: pg.database,
    user: pg.user,
    password: env.OD_PG_PASSWORD,
    max: pg.poolMax,
    application_name: 'open-design-daemon',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    ssl: pg.sslMode === 'disable'
      ? false
      : { rejectUnauthorized: pg.sslMode === 'verify-full' },
    ...(pg.schema ? { options: `-c search_path=${pg.schema}` } : {}),
  });
  return sharedPool;
}

/** Test seam; production callers should use the lazy getPool factory. */
export function setPoolForTests(pool: PgPoolLike | undefined): void {
  sharedPool = pool;
}

export async function closePool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  if (pool) await pool.end();
}

/** Covers a complete startup phase without closing a successfully returned pool. */
export async function runWithPgPoolCleanupOnFailure<T>(
  enabled: boolean,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (enabled) await closePool().catch(() => undefined);
    throw error;
  }
}

export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<R>> {
  const client = transactionClients.getStore();
  if (client) return client.query<R>(text, values);
  return getPool().query<R>(text, values);
}

export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
  pool?: PgPoolLike,
): Promise<T> {
  const active = transactionClients.getStore();
  if (active) return work(active);

  const client = await (pool ?? getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await transactionClients.run(client, () => work(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the error that caused the transaction to fail.
    }
    throw error;
  } finally {
    client.release();
  }
}
