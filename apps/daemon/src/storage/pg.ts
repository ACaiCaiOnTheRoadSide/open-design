// Postgres backend for the daemon (baizhi multitenant fork).
//
// STATUS: foundation. This module is NOT yet imported by the running daemon
// (which still uses better-sqlite3 via apps/daemon/src/db.ts). It provides:
//   - a pg Pool factory reading the OD_DAEMON_DB / OD_PG_* env contract
//     (see ./daemon-db.ts resolveDaemonDbConfig)
//   - a migration runner that applies apps/daemon/migrations/*.sql in order
//
// To activate the Postgres backend the remaining work is the sync→async
// conversion of db.ts (better-sqlite3 is synchronous; pg is async), which
// ripples `await` through every db.* call site and HTTP handler. See
// migrations/README.md for the staged conversion plan.
//
// Requires the `pg` package (add to apps/daemon/package.json dependencies:
//   "pg": "^8.13.0", and devDependencies "@types/pg": "^8.11.0").

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { resolveDaemonDbConfig } from './daemon-db.js';

let pool: Pool | null = null;

/**
 * Returns the shared pg Pool, constructed lazily from the resolved
 * Postgres config. Password / connection string come from env at this
 * layer (OD_PG_PASSWORD) — the daemon-db resolver intentionally omits it.
 */
export function getPool(env: Record<string, string | undefined> = process.env): Pool {
  if (pool) return pool;
  const cfg = resolveDaemonDbConfig(env);
  if (cfg.kind !== 'postgres' || !cfg.postgres) {
    throw new Error('getPool() called but OD_DAEMON_DB is not "postgres"');
  }
  const pg = cfg.postgres;
  pool = new Pool({
    host:     pg.host,
    port:     pg.port,
    database: pg.database,
    user:     pg.user,
    password: env.OD_PG_PASSWORD ?? '',
    ssl:      pg.sslMode === 'disable' ? false : { rejectUnauthorized: pg.sslMode === 'verify-full' },
    max:      Number.parseInt(env.OD_PG_POOL_MAX ?? '10', 10) || 10,
    // BigInt-safe: timestamps are BIGINT (ms epoch). node-pg returns BIGINT as
    // string by default to avoid precision loss; the async db layer parses
    // them with Number()/BigInt() at the boundary. We keep the default.
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

function migrationsDir(): string {
  // dist/storage/pg.js → ../../migrations (repo migrations/ ships alongside)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../migrations');
}

/**
 * Applies every migrations/*.sql file (lexicographic order) exactly once,
 * tracking applied files in a schema_migrations table. Each file is run in
 * its own transaction (the .sql files already wrap themselves in BEGIN/COMMIT,
 * so we run them as-is and record success after).
 *
 * Idempotent: re-running skips already-applied files. Safe to call at boot.
 */
export async function runMigrations(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const p = getPool(env);
  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`);
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await p.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if ((done.rowCount ?? 0) > 0) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    // The .sql file owns its own BEGIN/COMMIT. Run it, then record.
    await p.query(sql);
    await p.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, $2)', [file, Date.now()]);
    applied.push(file);
  }
  return applied;
}
