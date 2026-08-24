import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPersistentRunQueue,
  createPostgresRunQueue,
  createPostgresRunQueueBackend,
  type PersistentRunQueueBackend,
} from '../../src/storage/run-queue.js';

const url = process.env.OD_TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for PostgreSQL queue state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

suite('PostgreSQL run queue integration', () => {
  const schema = `run_queue_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const sql = await readFile(path.resolve(import.meta.dirname, '../../migrations/postgres/005_run_queue.sql'), 'utf8');
    await pool.query(sql);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('fairly shares global=2 while remaining work-conserving for one tenant', async () => {
    const backend = createPostgresRunQueueBackend(pool);
    const lease = new Date(Date.now() + 60_000);
    const enqueue = (id: string, tenantId: string) => backend.enqueue(
      { id, principal: { tenantId, userId: `${tenantId}-user` } },
      `owner-${id}`,
      lease,
    );

    await enqueue('a1', 'tenant-a');
    await enqueue('a2', 'tenant-a');
    await enqueue('b1', 'tenant-b');
    expect(await backend.tryClaim('a1', 'owner-a1', lease, 2, 0)).toBe(true);
    expect(await backend.position('b1', 2, 0)).toBe(1);
    expect(await backend.position('a2', 2, 0)).toBe(2);
    expect(await backend.tryClaim('a2', 'owner-a2', lease, 2, 0)).toBe(false);
    expect(await backend.tryClaim('b1', 'owner-b1', lease, 2, 0)).toBe(true);
    const running = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM run_queue WHERE status = 'running' ORDER BY tenant_id",
    );
    expect(running.rows.map((row) => row.tenant_id)).toEqual(['tenant-a', 'tenant-b']);

    await pool.query('TRUNCATE run_queue');
    await enqueue('solo-1', 'solo');
    await enqueue('solo-2', 'solo');
    expect(await backend.tryClaim('solo-1', 'owner-solo-1', lease, 2, 0)).toBe(true);
    expect(await backend.tryClaim('solo-2', 'owner-solo-2', lease, 2, 0)).toBe(true);
    await pool.query('TRUNCATE run_queue');
  });

  it('retries the first failed finish and restores capacity in real PostgreSQL', async () => {
    const durable = createPostgresRunQueueBackend(pool);
    let failFirstFinish = true;
    const backend: PersistentRunQueueBackend = {
      ...durable,
      async finish(...args) {
        if (failFirstFinish) {
          failFirstFinish = false;
          throw new Error('injected transient finish failure');
        }
        await durable.finish(...args);
      },
    };
    const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'pg-finish-retry', pollMs: 20, leaseMs: 3_000 });
    await queue.start();
    const first = await queue.acquire({ id: 'pg-retry-first', principal: { tenantId: 't1', userId: 'u1' } });
    first!.release();
    const secondPromise = queue.acquire({ id: 'pg-retry-second', principal: { tenantId: 't2', userId: 'u2' } });

    await waitFor(async () => (await pool.query(
      "SELECT status FROM run_queue WHERE id = 'pg-retry-first'",
    )).rows[0]?.status === 'completed');
    const second = await secondPromise;
    expect(second).not.toBeNull();
    second!.release();
    await queue.shutdown();
    await pool.query('TRUNCATE run_queue');
  }, 10_000);

  it('does not leave a ghost row when canceled during enqueue in real PostgreSQL', async () => {
    const durable = createPostgresRunQueueBackend(pool);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const backend: PersistentRunQueueBackend = {
      ...durable,
      async enqueue(...args) {
        await durable.enqueue(...args);
        if (args[0].id === 'pg-enqueue-race') await gate;
      },
    };
    const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'pg-enqueue-owner', pollMs: 20 });
    await queue.start();
    const acquiring = queue.acquire({ id: 'pg-enqueue-race', principal: { tenantId: 't1', userId: 'u1' } });
    await waitFor(async () => (await pool.query(
      "SELECT status FROM run_queue WHERE id = 'pg-enqueue-race'",
    )).rows[0]?.status === 'pending');
    queue.cancelPending('pg-enqueue-race');
    await waitFor(async () => (await pool.query(
      "SELECT status FROM run_queue WHERE id = 'pg-enqueue-race'",
    )).rows[0]?.status === 'canceled');
    unblock();
    expect(await acquiring).toBeNull();
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM run_queue WHERE id = 'pg-enqueue-race' AND status IN ('pending', 'running')",
    )).rows[0]?.count).toBe(0);
    await queue.shutdown();
    await pool.query('TRUNCATE run_queue');
  }, 10_000);

  it('cancels a claim interleaving without returning a slot in real PostgreSQL', async () => {
    const durable = createPostgresRunQueueBackend(pool);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const backend: PersistentRunQueueBackend = {
      ...durable,
      async tryClaim(...args) {
        const claimed = await durable.tryClaim(...args);
        if (claimed && args[0] === 'pg-claim-race') await gate;
        return claimed;
      },
    };
    const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'pg-claim-owner', pollMs: 20 });
    await queue.start();
    const acquiring = queue.acquire({ id: 'pg-claim-race', principal: { tenantId: 't1', userId: 'u1' } });
    await waitFor(async () => (await pool.query(
      "SELECT status FROM run_queue WHERE id = 'pg-claim-race'",
    )).rows[0]?.status === 'running');
    queue.cancelPending('pg-claim-race');
    await waitFor(async () => (await pool.query(
      "SELECT status FROM run_queue WHERE id = 'pg-claim-race'",
    )).rows[0]?.status === 'canceled');
    unblock();
    expect(await acquiring).toBeNull();
    const replacement = await queue.acquire({ id: 'pg-claim-replacement', principal: { tenantId: 't2', userId: 'u2' } });
    expect(replacement).not.toBeNull();
    replacement!.release();
    await queue.shutdown();
    await pool.query('TRUNCATE run_queue');
  }, 10_000);

  it('serializes claims from two daemon instances in real PostgreSQL', async () => {
    const a = createPostgresRunQueue(pool, 1);
    const b = createPostgresRunQueue(pool, 1);
    await Promise.all([a.start(), b.start()]);
    const first = await a.acquire({ id: 'pg-first', principal: { tenantId: 't1', userId: 'u1' } });
    const secondPromise = b.acquire({ id: 'pg-second', principal: { tenantId: 't2', userId: 'u2' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await pool.query("SELECT count(*)::int AS count FROM run_queue WHERE status = 'running'")).rows[0]?.count).toBe(1);
    first!.release();
    const second = await secondPromise;
    expect(second).not.toBeNull();
    second!.release();
    await Promise.all([a.shutdown(), b.shutdown()]);
  }, 10_000);
});
