import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistoryOutbox, type MemoryHistoryProjection } from '../src/storage/memory-history-outbox.js';
import { requireRequestContext, type VerifiedPrincipal } from '../src/request-context.js';

const principal: VerifiedPrincipal = { tenantId: 'tenant', userId: 'alice' };

type Row = { version: number; record: Record<string, unknown> };

class VersionedProjection implements MemoryHistoryProjection {
  readonly rows = {
    extraction: new Map<string, Row>(),
    verification: new Map<string, Row>(),
  };
  readonly cutoffs = { extraction: -1, verification: -1 };
  readonly tombstones = {
    extraction: new Map<string, number>(),
    verification: new Map<string, number>(),
  };

  private upsert(kind: 'extraction' | 'verification', record: Record<string, unknown>) {
    expect(requireRequestContext()).toEqual(principal);
    const id = String(record.id);
    const version = Number(record._projectionVersion);
    if (version <= this.cutoffs[kind] || version <= (this.tombstones[kind].get(id) ?? -1)) return;
    if (version >= (this.rows[kind].get(id)?.version ?? -1)) this.rows[kind].set(id, { version, record });
  }
  async upsertExtraction(record: Record<string, unknown>) { this.upsert('extraction', record); }
  async upsertVerification(record: Record<string, unknown>) { this.upsert('verification', record); }

  private remove(kind: 'extraction' | 'verification', id: string, version = Date.now()) {
    this.tombstones[kind].set(id, Math.max(version, this.tombstones[kind].get(id) ?? -1));
    const row = this.rows[kind].get(id);
    if (row && row.version <= version) this.rows[kind].delete(id);
    return row && row.version <= version ? 1 : 0;
  }
  async removeExtraction(id: string, version?: number) { return this.remove('extraction', id, version); }
  async removeVerification(id: string, version?: number) { return this.remove('verification', id, version); }

  private clear(kind: 'extraction' | 'verification', version = Date.now()) {
    this.cutoffs[kind] = Math.max(version, this.cutoffs[kind]);
    let removed = 0;
    for (const [id, row] of this.rows[kind]) if (row.version <= version) {
      this.rows[kind].delete(id); removed += 1;
    }
    return removed;
  }
  async clearExtractions(version?: number) { return this.clear('extraction', version); }
  async clearVerifications(version?: number) { return this.clear('verification', version); }
}

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE memory_history_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, projection_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
  return db;
}

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

describe('memory history outbox delete ordering', () => {
  it.each([
    ['extraction', 'delete'],
    ['verification', 'delete'],
    ['extraction', 'clear'],
    ['verification', 'clear'],
  ] as const)('does not revive pending %s upserts after a restarted %s barrier', async (kind, operation) => {
    const db = database(); open.push(db);
    const unavailable: MemoryHistoryProjection = {
      upsertExtraction: async () => { throw new Error('postgres unavailable'); },
      upsertVerification: async () => { throw new Error('postgres unavailable'); },
      removeExtraction: async () => 0, removeVerification: async () => 0,
      clearExtractions: async () => 0, clearVerifications: async () => 0,
    };
    const beforeCrash = createMemoryHistoryOutbox(db, unavailable, { intervalMs: 60_000 });
    const record = kind === 'extraction'
      ? { id: 'old', phase: 'success', startedAt: 1 }
      : { id: 'old', status: 'pass', at: 1 };
    beforeCrash.enqueue(kind, principal, record);
    await beforeCrash.drain();
    await expect(operation === 'delete'
      ? beforeCrash.enqueueDelete(kind, principal, 'old')
      : beforeCrash.enqueueClear(kind, principal)).rejects.toThrow(/pending|postgres unavailable/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_history_outbox').get() as { count: number }).count).toBe(2);
    beforeCrash.stop();

    const projection = new VersionedProjection();
    const restarted = createMemoryHistoryOutbox(db, projection, { intervalMs: 60_000 });
    await restarted.drain();
    expect(projection.rows[kind].has('old')).toBe(false);
    restarted.stop();

    // Reopen once more with an empty outbox. The durable SQLite clock must
    // still order this legitimate post-delete event after the PG cutoff.
    const afterDeleteRestart = createMemoryHistoryOutbox(db, projection, { intervalMs: 60_000 });
    const newer = kind === 'extraction'
      ? { id: 'old', phase: 'success', startedAt: 2 }
      : { id: 'old', status: 'pass', at: 2 };
    afterDeleteRestart.enqueue(kind, principal, newer);
    await afterDeleteRestart.drain();
    expect(projection.rows[kind].has('old')).toBe(true);
    afterDeleteRestart.stop();
  });
});
