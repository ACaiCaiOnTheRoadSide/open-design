// Synchronous Postgres adapter exposing the better-sqlite3 interface subset
// the daemon actually uses (prepare/get/all/run, exec, pragma, transaction,
// close, statement.changes). Lets db.ts and all 170+ call sites run UNCHANGED
// against Postgres — the sync→async impedance is bridged by a worker thread
// (pg-sync-worker.ts) that the main thread blocks on via Atomics.wait.
//
// Trade-off: every query blocks the event loop until Postgres responds (same
// blocking model as better-sqlite3 today, but with network latency instead of
// local disk). The daemon's DB layer was already synchronous, so this adds no
// new concurrency hazard; throughput scales horizontally via multiple daemon
// replicas sharing one Postgres. See migrations/README.md.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { DaemonDbConfig } from './daemon-db.js';

const STATE = 0;
const STATUS = 1;
const LEN = 2;
const DATA_BYTES = 64 * 1024 * 1024; // 64MB ceiling per result
const CALL_TIMEOUT_MS = 30_000;

interface QueryResponse { rows?: any[]; rowCount?: number; message?: string }

export interface SqliteLikeStatement {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number };
}

export interface SqliteLike {
  prepare(sql: string): SqliteLikeStatement;
  exec(sql: string): void;
  pragma(_source?: string): any[];
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

/**
 * Postgres folds unquoted identifiers to lower-case, so `col AS createdAt`
 * comes back as `createdat` and the daemon's `row.createdAt` reads undefined.
 * Quote EVERY camelCase identifier (lower→upper transition, e.g. createdAt /
 * projectId / latestRunStatus) — both the `AS createdAt` definitions AND the
 * later `c.projectId` references — so they keep their case and still match
 * each other inside CTEs/subqueries. snake_case columns and SQL keywords
 * (INTEGER, ROW_NUMBER) have no lower→upper transition, so they're untouched.
 * No SQL string literal in this codebase contains a camelCase token, so a
 * global pass is safe.
 */
function quoteCamelIdentifiers(sql: string): string {
  return sql.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (m) =>
    /[a-z][A-Z]/.test(m) ? `"${m}"` : m,
  );
}

/**
 * Translate better-sqlite3 `?` placeholders to Postgres `$1,$2,...`, skipping
 * any `?` inside single-quoted SQL string literals. Also quotes camelCase
 * identifiers so Postgres preserves their case.
 */
function toPgPlaceholders(sql: string): string {
  sql = quoteCamelIdentifiers(sql);
  let out = '';
  let inStr = false;
  let n = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      // handle escaped '' inside strings
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

export function openPgSync(cfg: DaemonDbConfig, password: string): SqliteLike {
  if (cfg.kind !== 'postgres' || !cfg.postgres) {
    throw new Error('openPgSync requires postgres config');
  }
  const controlSab = new SharedArrayBuffer(16);
  const dataSab = new SharedArrayBuffer(DATA_BYTES);
  const control = new Int32Array(controlSab);
  const data = new Uint8Array(dataSab);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const worker = new Worker(new URL('./pg-sync-worker.js', import.meta.url), {
    workerData: {
      control,
      data: dataSab,
      pg: {
        host: cfg.postgres.host,
        port: cfg.postgres.port,
        database: cfg.postgres.database,
        user: cfg.postgres.user,
        password,
        ssl: cfg.postgres.sslMode === 'disable'
          ? false
          : { rejectUnauthorized: cfg.postgres.sslMode === 'verify-full' },
        schema: cfg.postgres.schema,
      },
    },
  });
  worker.unref(); // don't keep the process alive on the worker alone

  let closed = false;

  function call(req: unknown): QueryResponse {
    if (closed) throw new Error('pg-sync: database is closed');
    const bytes = encoder.encode(JSON.stringify(req));
    if (bytes.length > data.length) throw new Error('pg-sync: request too large');
    data.set(bytes, 0);
    Atomics.store(control, LEN, bytes.length);
    Atomics.store(control, STATE, 1);
    worker.postMessage({ type: 'request' });
    const waited = Atomics.wait(control, STATE, 1, CALL_TIMEOUT_MS);
    if (waited === 'timed-out') throw new Error('pg-sync: query timed out');
    const status = Atomics.load(control, STATUS);
    const len = Atomics.load(control, LEN);
    const resp = JSON.parse(decoder.decode(data.subarray(0, len))) as QueryResponse;
    Atomics.store(control, STATE, 0);
    if (status !== 0) throw new Error(resp.message ?? 'pg-sync: query failed');
    return resp;
  }

  // better-sqlite3 accepts both .get(a, b) and .get([a, b]); SQLite params are
  // always scalars, so a lone array arg means "these are the positional binds".
  function normParams(params: any[]): any[] {
    return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  }

  function query(sql: string, params: any[]): QueryResponse {
    return call({ op: 'query', sql: toPgPlaceholders(sql), params });
  }

  return {
    prepare(sql: string): SqliteLikeStatement {
      const pgSql = toPgPlaceholders(sql);
      return {
        get(...params: any[]) {
          const r = call({ op: 'query', sql: pgSql, params: normParams(params) });
          return r.rows && r.rows.length > 0 ? r.rows[0] : undefined;
        },
        all(...params: any[]) {
          const r = call({ op: 'query', sql: pgSql, params: normParams(params) });
          return r.rows ?? [];
        },
        run(...params: any[]) {
          const r = call({ op: 'query', sql: pgSql, params: normParams(params) });
          return { changes: r.rowCount ?? 0 };
        },
      };
    },
    exec(sql: string): void {
      call({ op: 'exec', sql });
    },
    pragma(): any[] {
      return []; // no-op on Postgres
    },
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      const wrapped = (...args: any[]) => {
        call({ op: 'begin' });
        try {
          const result = fn(...args);
          call({ op: 'commit' });
          return result;
        } catch (err) {
          try { call({ op: 'rollback' }); } catch { /* best effort */ }
          throw err;
        }
      };
      return wrapped as T;
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { call({ op: 'close' }); } catch { /* ignore */ }
      void worker.terminate();
    },
  };
  void query; // reserved for future direct-query use
}
