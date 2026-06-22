// Worker side of the synchronous Postgres adapter (see pg-sync.ts).
//
// The daemon's data layer is written against better-sqlite3's SYNCHRONOUS API.
// To back it with Postgres without rewriting 170+ call sites to async, the
// async `pg` client runs HERE in a worker thread; the main thread blocks on
// Atomics.wait until we publish the result into a shared buffer.
//
// Signaling is asymmetric on purpose:
//   - main → worker: postMessage('request')  (worker's event loop must stay
//     free to drive pg's async socket I/O, so the worker can NOT Atomics.wait)
//   - worker → main: Atomics.notify          (main IS blocked on Atomics.wait,
//     so it can only be woken via Atomics, not postMessage)
//
// Exactly one operation is in flight at a time (main is blocked between
// request and response), so a single pg Client suffices and transactions are
// just BEGIN/COMMIT on that connection.
//
// control Int32Array layout (over a small SAB):
//   [0] STATE  : 1 = request ready (main set), 2 = response ready (worker set)
//   [1] STATUS : 0 = ok, 1 = error
//   [2] LEN    : response byte length in the data SAB
// data SAB: fixed-size byte buffer carrying the UTF-8 JSON request, then the
//   UTF-8 JSON response. Oversized responses error (64MB ceiling).

import { parentPort, workerData } from 'node:worker_threads';
import { Client, types } from 'pg';

// node-pg returns BIGINT (oid 20) as a string to avoid precision loss. Our
// BIGINT columns are ms-epoch timestamps / small counters, all well under
// 2^53, so parse them back to Number to match better-sqlite3's INTEGER → JS
// number behavior (the daemon code expects numbers, e.g. Number(row.createdAt)).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const STATE = 0;
const STATUS = 1;
const LEN = 2;

const control: Int32Array = workerData.control;
const data = new Uint8Array(workerData.data);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const client = new Client({
  host:     workerData.pg.host,
  port:     workerData.pg.port,
  database: workerData.pg.database,
  user:     workerData.pg.user,
  password: workerData.pg.password,
  ssl:      workerData.pg.ssl,
});
const schema: string | undefined = workerData.pg.schema;
// 连接后:配了 schema 就建它并把 search_path 固定过去 —— daemon 的表落在该 schema,
// 与 Go backend 的 public schema 隔离,从而共用平台那一个单库(<app>-db),不撞名。
const ready = client.connect().then(async () => {
  if (schema) {
    const ident = '"' + schema.replace(/"/g, '""') + '"';
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident}`);
    await client.query(`SET search_path TO ${ident}`);
  }
});

function respond(status: number, payload: unknown): void {
  const bytes = encoder.encode(JSON.stringify(payload ?? {}));
  if (bytes.length > data.length) {
    const msg = encoder.encode(JSON.stringify({ message: `pg result ${bytes.length}B exceeds ${data.length}B buffer` }));
    data.set(msg, 0);
    Atomics.store(control, STATUS, 1);
    Atomics.store(control, LEN, msg.length);
  } else {
    data.set(bytes, 0);
    Atomics.store(control, STATUS, status);
    Atomics.store(control, LEN, bytes.length);
  }
  Atomics.store(control, STATE, 2);
  Atomics.notify(control, STATE);
}

async function handle(req: any): Promise<void> {
  try {
    await ready;
    switch (req.op) {
      case 'query': {
        const res = await client.query({ text: req.sql, values: req.params ?? [] });
        respond(0, { rows: res.rows, rowCount: res.rowCount ?? 0 });
        break;
      }
      case 'exec':     await client.query(req.sql);      respond(0, { rowCount: 0 }); break;
      case 'begin':    await client.query('BEGIN');      respond(0, {}); break;
      case 'commit':   await client.query('COMMIT');     respond(0, {}); break;
      case 'rollback': await client.query('ROLLBACK');   respond(0, {}); break;
      case 'close':    await client.end();               respond(0, {}); break;
      default:         respond(1, { message: `unknown op: ${req.op}` });
    }
  } catch (err: any) {
    respond(1, { message: err?.message ?? String(err) });
  }
}

parentPort?.on('message', (msg: any) => {
  if (msg?.type === 'request') {
    const len = Atomics.load(control, LEN);
    const req = JSON.parse(decoder.decode(data.subarray(0, len)));
    void handle(req);
  }
});
