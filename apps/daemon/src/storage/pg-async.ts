// Async Postgres backend for the daemon (async-pg rewrite branch).
//
// Replaces the interim sync adapter (pg-sync.ts + worker/Atomics) with a real
// async pg.Pool. Exposes the better-sqlite3 method SHAPE (prepare(sql).get/
// all/run, exec, pragma, transaction, close) but every data method returns a
// Promise — so db.ts converts to async with minimal churn: keep the SQL and
// the .get()/.all()/.run() calls, just add `await` and make functions async.
//
// vs the sync adapter: NO event-loop blocking — the daemon can serve other
// requests while a query is in flight. Concurrency within one process is back.
//
// Transactions use AsyncLocalStorage to carry the checked-out client, so the
// inner queries inside db.transaction(fn) run on the SAME connection while
// concurrent transactions each get their own client.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient } from 'pg';
import type { DaemonDbConfig } from './daemon-db.js';

// BIGINT (oid 20) → Number (ms-epoch timestamps / small counters, all < 2^53),
// matching better-sqlite3's INTEGER → JS number behavior.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// Carries the active transaction's client; inner queries route to it.
const txStorage = new AsyncLocalStorage<PoolClient>();

export interface AsyncStatement {
  get(...params: any[]): Promise<any>;
  all(...params: any[]): Promise<any[]>;
  run(...params: any[]): Promise<{ changes: number }>;
}

export interface AsyncDb {
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
  pragma(source?: string): Promise<any[]>;
  transaction<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  close(): Promise<void>;
}

/** Quote camelCase identifiers so Postgres preserves alias case (col AS createdAt). */
function quoteCamelIdentifiers(sql: string): string {
  return sql.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (m) =>
    /[a-z][A-Z]/.test(m) ? `"${m}"` : m,
  );
}

/** better-sqlite3 `?` → Postgres `$1,$2`, skipping `?` inside single-quoted strings. */
function toPgPlaceholders(sql: string): string {
  sql = quoteCamelIdentifiers(sql);
  let out = '';
  let inStr = false;
  let n = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      if (inStr && sql[i + 1] === "'") { out += "''"; i += 1; continue; }
      inStr = !inStr;
      out += ch;
    } else if (ch === '?' && !inStr) {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function normParams(params: any[]): any[] {
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

export function openPgAsync(cfg: DaemonDbConfig, password: string): AsyncDb {
  if (cfg.kind !== 'postgres' || !cfg.postgres) {
    throw new Error('openPgAsync requires postgres config');
  }
  const pg = cfg.postgres;
  const pool = new Pool({
    host:     pg.host,
    port:     pg.port,
    database: pg.database,
    user:     pg.user,
    password,
    ssl:      pg.sslMode === 'disable' ? false : { rejectUnauthorized: pg.sslMode === 'verify-full' },
    max:      Number.parseInt(process.env.OD_PG_POOL_MAX ?? '10', 10) || 10,
  });

  // Run a query on the active transaction client if inside one, else the pool.
  async function query(text: string, values: any[]): Promise<{ rows: any[]; rowCount: number }> {
    const client = txStorage.getStore();
    const res = client
      ? await client.query({ text, values })
      : await pool.query({ text, values });
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  }

  return {
    prepare(sql: string): AsyncStatement {
      const text = toPgPlaceholders(sql);
      return {
        async get(...params: any[]) {
          const r = await query(text, normParams(params));
          return r.rows.length > 0 ? r.rows[0] : undefined;
        },
        async all(...params: any[]) {
          const r = await query(text, normParams(params));
          return r.rows;
        },
        async run(...params: any[]) {
          const r = await query(text, normParams(params));
          return { changes: r.rowCount };
        },
      };
    },

    async exec(sql: string): Promise<void> {
      const client = txStorage.getStore();
      if (client) await client.query(sql);
      else await pool.query(sql);
    },

    async pragma(): Promise<any[]> {
      return []; // no-op on Postgres
    },

    transaction<T extends (...args: any[]) => any>(fn: T) {
      return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await txStorage.run(client, async () => await fn(...args));
          await client.query('COMMIT');
          return result as Awaited<ReturnType<T>>;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* best effort */ }
          throw err;
        } finally {
          client.release();
        }
      };
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
