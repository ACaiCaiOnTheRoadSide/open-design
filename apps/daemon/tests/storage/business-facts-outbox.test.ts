import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { requireRequestContext, runWithRequestContext } from '../../src/request-context.js';
import { createBusinessFactsOutbox } from '../../src/storage/business-facts-outbox.js';
import type { BusinessFactsStore } from '../../src/storage/business-facts.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE business_fact_outbox (
    id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
  return db;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('business facts durable outbox', () => {
  it('keeps a failed fact and replays it with the originally verified principal', async () => {
    const db = setupDb();
    let fail = true;
    const principals: string[] = [];
    const store = {
      enabled: true,
      async upsertMessage() {
        principals.push(requireRequestContext().tenantId);
        if (fail) throw new Error('pg unavailable');
      },
    } as unknown as BusinessFactsStore;
    const outbox = createBusinessFactsOutbox(db, store, { intervalMs: 60_000 });
    await expect(runWithRequestContext({ tenantId: 'tenant-a', userId: 'user-a' }, () =>
      outbox.recordMessage({
        id: 'm', conversationId: 'c', projectId: 'p', runStatus: 'succeeded', createdAt: 1, updatedAt: 2,
      }))).rejects.toThrow('queued for durable retry');
    expect(db.prepare('SELECT attempts FROM business_fact_outbox').get()).toEqual({ attempts: 1 });

    fail = false;
    await outbox.drain();
    expect(db.prepare('SELECT COUNT(*) AS count FROM business_fact_outbox').get()).toEqual({ count: 0 });
    expect(principals).toEqual(['tenant-a', 'tenant-a']);
    outbox.stop();
    db.close();
  });

  it('stops globally on the first failed row so later facts cannot overtake it', async () => {
    const db = setupDb();
    const calls: string[] = [];
    const store = {
      enabled: true,
      async upsertMessage(message: { id: string }) {
        calls.push(message.id);
        if (message.id === 'first') throw new Error('blocked aggregate');
      },
    } as unknown as BusinessFactsStore;
    const outbox = createBusinessFactsOutbox(db, store, { intervalMs: 60_000 });
    const principal = { tenantId: 'tenant-a', userId: 'user-a' };
    for (const [id, updatedAt] of [['first', 1], ['second', 2]] as const) {
      db.prepare(`INSERT INTO business_fact_outbox (id, payload_json, created_at) VALUES (?, ?, ?)`)
        .run(`message:${id}:${updatedAt}`, JSON.stringify({
          kind: 'message', principal,
          message: { id, conversationId: 'c', projectId: 'p', runStatus: 'succeeded', createdAt: updatedAt, updatedAt },
        }), updatedAt);
    }
    await outbox.drain();
    expect(calls).toEqual(['first']);
    expect(db.prepare('SELECT attempts FROM business_fact_outbox WHERE id = ?').get('message:second:2'))
      .toEqual({ attempts: 0 });
    outbox.stop();
    db.close();
  });

  it('replaces a same message/status probe with later complete usage', async () => {
    const db = setupDb();
    let fail = true;
    const observed: unknown[] = [];
    const store = {
      enabled: true,
      async upsertMessage(_message: unknown, usage: unknown) {
        observed.push(usage);
        if (fail) throw new Error('pg unavailable');
      },
    } as unknown as BusinessFactsStore;
    const outbox = createBusinessFactsOutbox(db, store, { intervalMs: 60_000 });
    const message = {
      id: 'same', conversationId: 'c', projectId: 'p', runStatus: 'succeeded', createdAt: 1, updatedAt: 2,
    };
    const principal = { tenantId: 'tenant-a', userId: 'user-a' };
    await expect(runWithRequestContext(principal, () => outbox.recordMessage(message)))
      .rejects.toThrow('queued for durable retry');
    const firstUsage = { model: 'model-a', inputTokens: 10, createdAt: 2 };
    await expect(runWithRequestContext(principal, () => outbox.recordMessage(message, firstUsage)))
      .rejects.toThrow('queued for durable retry');
    const laterUsage = { model: 'model-a', outputTokens: 2, totalTokens: 12, createdAt: 2 };
    await expect(runWithRequestContext(principal, () => outbox.recordMessage(message, laterUsage)))
      .rejects.toThrow('queued for durable retry');
    const expectedUsage = { ...firstUsage, ...laterUsage };
    const row = db.prepare('SELECT payload_json AS payloadJson FROM business_fact_outbox').get() as { payloadJson: string };
    expect(JSON.parse(row.payloadJson).usage).toEqual(expectedUsage);

    fail = false;
    await outbox.drain();
    expect(observed.at(-1)).toEqual(expectedUsage);
    expect(db.prepare('SELECT COUNT(*) AS count FROM business_fact_outbox').get()).toEqual({ count: 0 });
    outbox.stop();
    db.close();
  });

  it('retains and promptly drains a newer stable-ID payload after the old PG write completes', async () => {
    const db = setupDb();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    const calls: string[] = [];
    const store = {
      enabled: true,
      async updateProjectProjection(project: { name: string }) {
        calls.push(project.name);
        if (calls.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
      },
    } as unknown as BusinessFactsStore;
    const outbox = createBusinessFactsOutbox(db, store, { intervalMs: 60_000 });
    const oldProject = { id: 'same', name: 'old', createdAt: 1, updatedAt: 1 };
    const newProject = { ...oldProject, name: 'new', updatedAt: 2 };

    outbox.enqueueProjectUpdate(oldProject);
    const draining = outbox.drain();
    await firstStarted.promise;
    outbox.enqueueProjectUpdate(newProject);
    releaseFirst.resolve();
    await secondStarted.promise;

    const pending = db.prepare(
      `SELECT payload_json AS payloadJson FROM business_fact_outbox WHERE id = ?`,
    ).get('project:update:same') as { payloadJson: string };
    expect(JSON.parse(pending.payloadJson).project).toEqual(newProject);
    expect(calls).toEqual(['old', 'new']);

    releaseSecond.resolve();
    await draining;
    expect(db.prepare('SELECT COUNT(*) AS count FROM business_fact_outbox').get()).toEqual({ count: 0 });
    outbox.stop();
    db.close();
  });

  it('keeps a shared drain alive for work enqueued during its original snapshot', async () => {
    const db = setupDb();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    const store = {
      enabled: true,
      async upsertMessage(message: { id: string }) {
        calls.push(message.id);
        if (message.id === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      },
    } as unknown as BusinessFactsStore;
    const outbox = createBusinessFactsOutbox(db, store, { intervalMs: 60_000 });
    const principal = { tenantId: 'tenant-a', userId: 'user-a' };
    const message = (id: string, updatedAt: number) => ({
      id, conversationId: 'c', projectId: 'p', runStatus: 'succeeded', createdAt: updatedAt, updatedAt,
    });

    const first = runWithRequestContext(principal, () => outbox.recordMessage(message('first', 1)));
    await firstStarted.promise;
    const second = runWithRequestContext(principal, () => outbox.recordMessage(message('second', 2)));
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual(['first', 'second']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM business_fact_outbox').get()).toEqual({ count: 0 });
    outbox.stop();
    db.close();
  });
});
