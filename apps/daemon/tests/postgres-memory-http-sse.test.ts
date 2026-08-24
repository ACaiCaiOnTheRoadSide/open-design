import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __setPostgresMemoryStoreForTests,
  configureMemoryHistoryOutbox,
  drainMemoryHistoryWrites,
  stopMemoryHistoryOutbox,
} from '../src/memory.js';
import { recordHeuristic } from '../src/memory-extractions.js';
import { recordVerify } from '../src/memory-verify.js';
import { runWithRequestContext } from '../src/request-context.js';
import { registerMemoryRoutes } from '../src/routes/memory.js';
import { resolvePgMigrationsDirectory, runPgMigrations } from '../src/storage/pg-migrations.js';
import { createMemoryHistoryOutbox, type MemoryHistoryProjection } from '../src/storage/memory-history-outbox.js';
import { createPostgresMemoryStore } from '../src/storage/postgres-memory-store.js';
import { closePool, setPoolForTests } from '../src/storage/pg.js';

const url = process.env.OD_TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;

suite('real PostgreSQL two-tenant memory HTTP/SSE', () => {
  const schema = `od_memory_http_${process.pid}_${Date.now()}`;
  let admin: Client;
  let sqlite: Database.Database;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.OD_DAEMON_DB = 'postgres';
    admin = new Client({ connectionString: url });
    await admin.connect();
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    setPoolForTests(pool);
    await runPgMigrations({ pool, schema, directory: resolvePgMigrationsDirectory(new URL('../src/storage/pg-migrations.js', import.meta.url).href) });
    __setPostgresMemoryStoreForTests(undefined);
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE memory_history_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, projection_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
    configureMemoryHistoryOutbox(sqlite);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const tenantId = String(req.headers['x-tenant-id'] ?? '');
      const userId = String(req.headers['x-user-id'] ?? '');
      res.locals.principalSource = 'static';
      runWithRequestContext({ tenantId, userId }, next);
    });
    registerMemoryRoutes(app, {
      paths: { RUNTIME_DATA_DIR: '/tmp/od-memory-http', PROJECT_ROOT: '/tmp', PROJECTS_DIR: '/tmp' },
      http: {
        createSseResponse: (res: express.Response) => {
          res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders();
          return { send: (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`) };
        },
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      },
      appConfig: { readAppConfig: async () => ({}) },
    } as never);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);

  afterAll(async () => {
    stopMemoryHistoryOutbox();
    sqlite?.close();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
    delete process.env.OD_DAEMON_DB;
  });

  const headers = (tenant: string) => ({
    'content-type': 'application/json', 'x-tenant-id': tenant, 'x-user-id': `${tenant}-user`,
  });

  async function openEvents(tenant: string) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/memory/events`, { headers: headers(tenant), signal: controller.signal });
    const reader = response.body!.getReader();
    let text = '';
    const pump = (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          text += new TextDecoder().decode(next.value);
        }
      } catch { /* abort closes the test stream */ }
    })();
    return { controller, pump, text: () => text };
  }

  it('keeps restarted pending history behind durable delete cutoffs while allowing newer events', async () => {
    const local = new Database(':memory:');
    local.exec(`CREATE TABLE memory_history_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, projection_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
    const unavailable: MemoryHistoryProjection = {
      upsertExtraction: async () => { throw new Error('simulate hard stop before PG'); },
      upsertVerification: async () => { throw new Error('simulate hard stop before PG'); },
    };
    const principal = { tenantId: 'restart-tenant', userId: 'restart-user' };
    const first = createMemoryHistoryOutbox(local, unavailable, { intervalMs: 60_000 });
    first.enqueue('extraction', principal, { id: 'deleted-old', phase: 'success', startedAt: 1 });
    await first.drain();
    await expect(first.enqueueDelete('extraction', principal, 'deleted-old')).rejects.toThrow();
    first.enqueue('verification', principal, { id: 'cleared-old', status: 'pass', at: 1 });
    await expect(first.enqueueClear('verification', principal)).rejects.toThrow();
    first.stop();

    const store = createPostgresMemoryStore();
    const restarted = createMemoryHistoryOutbox(local, store, { intervalMs: 60_000 });
    await restarted.drain();
    await runWithRequestContext(principal, async () => {
      expect((await store.listExtractions()).records).toEqual([]);
      expect((await store.listVerifications()).records).toEqual([]);
    });
    restarted.stop();

    const afterDeleteRestart = createMemoryHistoryOutbox(local, store, { intervalMs: 60_000 });
    afterDeleteRestart.enqueue('extraction', principal, { id: 'deleted-old', phase: 'success', startedAt: 2 });
    afterDeleteRestart.enqueue('verification', principal, { id: 'cleared-old', status: 'pass', at: 2 });
    await afterDeleteRestart.drain();
    await runWithRequestContext(principal, async () => {
      expect((await store.listExtractions()).records).toEqual([
        expect.objectContaining({ id: 'deleted-old' }),
      ]);
      expect((await store.listVerifications()).records).toEqual([
        expect.objectContaining({ id: 'cleared-old' }),
      ]);
    });
    afterDeleteRestart.stop();
    local.close();
  });

  it('isolates manual/connectors HTTP, extraction/verification history and SSE events', async () => {
    const streamA = await openEvents('tenant-a');
    const streamB = await openEvents('tenant-b');
    try {
      const create = async (tenant: string, id: string) => fetch(`${base}/api/memory`, {
        method: 'POST', headers: headers(tenant),
        body: JSON.stringify({ id, name: id, description: 'manual', type: 'user', body: `${tenant} secret` }),
      });
      expect((await create('tenant-a', 'tenant_a_manual')).status).toBe(200);
      expect((await create('tenant-b', 'tenant_b_manual')).status).toBe(200);

      runWithRequestContext({ tenantId: 'tenant-a', userId: 'tenant-a-user' }, () => {
        recordHeuristic({ userMessage: 'tenant-a extraction', writtenCount: 1, writtenIds: ['tenant_a_manual'] });
        recordVerify({ status: 'pass', rulesActive: 1, rulesCovered: 1, uncoveredRules: [], rowsTotal: 1, rowsFailed: 0, hadArtifact: true }, { runId: 'run-a' });
      });
      runWithRequestContext({ tenantId: 'tenant-b', userId: 'tenant-b-user' }, () => {
        recordHeuristic({ userMessage: 'tenant-b extraction', writtenCount: 1, writtenIds: ['tenant_b_manual'] });
        recordVerify({ status: 'fail', rulesActive: 1, rulesCovered: 0, uncoveredRules: ['b'], rowsTotal: 1, rowsFailed: 1, hadArtifact: true }, { runId: 'run-b' });
      });
      await drainMemoryHistoryWrites();

      for (const tenant of ['tenant-a', 'tenant-b']) {
        const connector = await fetch(`${base}/api/memory/connectors/suggest`, {
          method: 'POST', headers: headers(tenant), body: JSON.stringify({ connectorIds: [], query: tenant }),
        });
        expect(connector.status).toBe(200);
      }
      const json = async (tenant: string, endpoint: string) => (await fetch(`${base}${endpoint}`, { headers: headers(tenant) })).json();
      expect((await json('tenant-a', '/api/memory/extractions') as any).extractions[0].userMessagePreview).toContain('tenant-a');
      expect((await json('tenant-b', '/api/memory/extractions') as any).extractions[0].userMessagePreview).toContain('tenant-b');
      expect((await json('tenant-a', '/api/memory/verifications') as any).verifications[0].runId).toBe('run-a');
      expect((await json('tenant-b', '/api/memory/verifications') as any).verifications[0].runId).toBe('run-b');
      expect((await json('tenant-a', '/api/memory/tenant_b_manual') as any).error).toBe('memory not found');
      expect((await json('tenant-b', '/api/memory/tenant_a_manual') as any).error).toBe('memory not found');

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(streamA.text()).toContain('tenant_a_manual');
      expect(streamA.text()).toContain('run-a');
      expect(streamA.text()).not.toContain('tenant_b_manual');
      expect(streamA.text()).not.toContain('run-b');
      expect(streamB.text()).toContain('tenant_b_manual');
      expect(streamB.text()).toContain('run-b');
      expect(streamB.text()).not.toContain('tenant_a_manual');
      expect(streamB.text()).not.toContain('run-a');
    } finally {
      streamA.controller.abort(); streamB.controller.abort();
      await Promise.all([streamA.pump, streamB.pump]);
    }
  }, 30_000);
});
