import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireRequestContext } from '../../src/request-context.js';
import { createMemoryHistoryOutbox } from '../../src/storage/memory-history-outbox.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function open(file: string): Database.Database {
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_history_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    projection_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  )`);
  return db;
}

describe('memory history durable outbox', () => {
  it('survives a hard-stop/reopen, preserves FIFO and deduplicates identical events', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-memory-outbox-'));
    roots.push(root);
    const file = path.join(root, 'daemon.sqlite');
    const firstDb = open(file);
    const neverProject = { async upsertExtraction() {}, async upsertVerification() {} };
    const first = createMemoryHistoryOutbox(firstDb, neverProject, { intervalMs: 60_000 });
    const principal = { tenantId: 'tenant-a', userId: 'alice' };
    const running = { id: 'e1', phase: 'running', startedAt: 1 };
    first.enqueue('extraction', principal, running);
    first.enqueue('extraction', principal, running); // same idempotency key
    first.enqueue('extraction', principal, { ...running, phase: 'success', finishedAt: 2 });
    first.enqueue('verification', principal, {
      id: 'v1', status: 'pass', at: 3, rulesActive: 1, rulesCovered: 1,
    });
    first.stop(); // queued durably, deliberately never projected
    expect((firstDb.prepare('SELECT count(*) AS count FROM memory_history_outbox').get() as { count: number }).count).toBe(3);
    firstDb.close();

    const projected: Array<{ kind: string; state: unknown; tenant: string; version: number }> = [];
    const secondDb = open(file);
    const second = createMemoryHistoryOutbox(secondDb, {
      async upsertExtraction(record) {
        projected.push({
          kind: 'extraction', state: record.phase,
          tenant: requireRequestContext().tenantId,
          version: Number(record._projectionVersion),
        });
      },
      async upsertVerification(record) {
        projected.push({
          kind: 'verification', state: record.status,
          tenant: requireRequestContext().tenantId,
          version: Number(record._projectionVersion),
        });
      },
    }, { intervalMs: 60_000 });
    await second.drain();
    expect(projected.map(({ kind, state, tenant }) => ({ kind, state, tenant }))).toEqual([
      { kind: 'extraction', state: 'running', tenant: 'tenant-a' },
      { kind: 'extraction', state: 'success', tenant: 'tenant-a' },
      { kind: 'verification', state: 'pass', tenant: 'tenant-a' },
    ]);
    expect(projected[0]!.version).toBeLessThan(projected[1]!.version);
    expect(projected[1]!.version).toBeLessThan(projected[2]!.version);
    expect((secondDb.prepare('SELECT count(*) AS count FROM memory_history_outbox').get() as { count: number }).count).toBe(0);
    second.stop();
    secondDb.close();
  });
});
