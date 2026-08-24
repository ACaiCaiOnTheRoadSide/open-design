import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { runWithRequestContext, type VerifiedPrincipal } from '../request-context.js';

type HistoryKind = 'extraction' | 'verification';
type UpsertPayload = {
  operation: 'upsert';
  kind: HistoryKind;
  principal: VerifiedPrincipal;
  record: Record<string, unknown>;
};
type DeletePayload = {
  operation: 'delete';
  kind: HistoryKind;
  principal: VerifiedPrincipal;
  id: string;
};
type ClearPayload = {
  operation: 'clear';
  kind: HistoryKind;
  principal: VerifiedPrincipal;
};
type LegacyUpsertPayload = Omit<UpsertPayload, 'operation'>;
type CurrentPayload = UpsertPayload | DeletePayload | ClearPayload;
type Payload = CurrentPayload | LegacyUpsertPayload;

export interface MemoryHistoryProjection {
  upsertExtraction(record: Record<string, unknown>): Promise<void>;
  upsertVerification(record: Record<string, unknown>): Promise<void>;
  removeExtraction?(id: string, projectionVersion?: number): Promise<number>;
  removeVerification?(id: string, projectionVersion?: number): Promise<number>;
  clearExtractions?(projectionVersion?: number): Promise<number>;
  clearVerifications?(projectionVersion?: number): Promise<number>;
}

export interface MemoryHistoryOutbox {
  enqueue(kind: HistoryKind, principal: VerifiedPrincipal, record: Record<string, unknown>): void;
  enqueueDelete(kind: HistoryKind, principal: VerifiedPrincipal, id: string): Promise<number>;
  enqueueClear(kind: HistoryKind, principal: VerifiedPrincipal): Promise<number>;
  drain(): Promise<void>;
  stop(): void;
}

/** Durable SQLite FIFO. Every projection mutation, including tombstones, crosses the same crash boundary. */
export function createMemoryHistoryOutbox(
  db: Database.Database,
  projection: MemoryHistoryProjection,
  options: { intervalMs?: number } = {},
): MemoryHistoryOutbox {
  let draining: Promise<void> | null = null;
  let stopped = false;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_history_projection_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    projection_version INTEGER NOT NULL
  )`);
  const clockVersion = Number((db.prepare(
    `SELECT projection_version AS value FROM memory_history_projection_clock WHERE singleton = 1`,
  ).get() as { value?: number } | undefined)?.value ?? 0);
  const pendingVersion = Number((db.prepare(
    `SELECT COALESCE(MAX(projection_version), 0) AS value FROM memory_history_outbox`,
  ).get() as { value?: number } | undefined)?.value ?? 0);
  let lastVersion = Math.max(clockVersion, pendingVersion);
  const mutationResults = new Map<number, number>();

  const flush = async (): Promise<void> => {
    if (stopped) return;
    while (!stopped) {
      const row = db.prepare(`SELECT sequence, idempotency_key AS idempotencyKey,
          payload_json AS payloadJson, projection_version AS projectionVersion
        FROM memory_history_outbox ORDER BY sequence LIMIT 1`).get() as {
          sequence: number; idempotencyKey: string; payloadJson: string; projectionVersion: number;
        } | undefined;
      if (!row) return;
      try {
        const rawPayload = JSON.parse(row.payloadJson) as Payload;
        // Rows accepted by the first outbox release had no explicit operation;
        // retain their upsert meaning across an in-place daemon upgrade.
        const payload: CurrentPayload = 'operation' in rawPayload
          ? rawPayload
          : { ...rawPayload, operation: 'upsert' };
        const result = await runWithRequestContext(payload.principal, async () => {
          if (payload.operation === 'upsert') {
            const record = { ...payload.record, _projectionVersion: row.projectionVersion };
            await (payload.kind === 'extraction'
              ? projection.upsertExtraction(record)
              : projection.upsertVerification(record));
            return 0;
          }
          if (payload.operation === 'delete') {
            const remove = payload.kind === 'extraction'
              ? projection.removeExtraction : projection.removeVerification;
            if (!remove) throw new Error(`Memory ${payload.kind} delete projection is unavailable`);
            return remove.call(projection, payload.id, row.projectionVersion);
          }
          const clear = payload.kind === 'extraction'
            ? projection.clearExtractions : projection.clearVerifications;
          if (!clear) throw new Error(`Memory ${payload.kind} clear projection is unavailable`);
          return clear.call(projection, row.projectionVersion);
        });
        mutationResults.set(row.sequence, result);
        db.prepare(`DELETE FROM memory_history_outbox WHERE sequence = ? AND idempotency_key = ?`)
          .run(row.sequence, row.idempotencyKey);
      } catch (error) {
        db.prepare(`UPDATE memory_history_outbox SET attempts = attempts + 1, last_error = ?
          WHERE sequence = ? AND idempotency_key = ?`)
          .run(String(error).slice(0, 1000), row.sequence, row.idempotencyKey);
        return;
      }
    }
  };

  const drain = (): Promise<void> => {
    if (!draining) draining = flush().finally(() => { draining = null; });
    return draining;
  };

  const insert = (payload: CurrentPayload): number => {
    if (stopped) throw new Error('Memory history outbox is stopped');
    lastVersion = Math.max(Date.now(), lastVersion + 1);
    const canonical = JSON.stringify(payload);
    const identity = payload.operation === 'upsert'
      ? String(payload.record.id ?? '')
      : payload.operation === 'delete' ? payload.id : 'all';
    // Mutations intentionally include their monotonic version: two user deletes
    // are distinct ordering barriers even when their visible payload is equal.
    const digestInput = payload.operation === 'upsert' ? canonical : `${canonical}:${lastVersion}`;
    const id = `${payload.kind}:${payload.operation}:${identity}:${createHash('sha256').update(digestInput).digest('hex')}`;
    const transaction = db.transaction(() => {
      const result = db.prepare(`INSERT INTO memory_history_outbox
          (idempotency_key, payload_json, projection_version, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING`).run(id, canonical, lastVersion, Date.now());
      db.prepare(`INSERT INTO memory_history_projection_clock (singleton, projection_version)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET projection_version = MAX(projection_version, excluded.projection_version)`)
        .run(lastVersion);
      return Number(result.lastInsertRowid);
    });
    const sequence = transaction();
    queueMicrotask(() => { void drain(); });
    return sequence;
  };

  const enqueueMutation = async (payload: DeletePayload | ClearPayload): Promise<number> => {
    const sequence = insert(payload);
    await drain();
    const pending = db.prepare(`SELECT last_error AS lastError FROM memory_history_outbox WHERE sequence = ?`)
      .get(sequence) as { lastError: string | null } | undefined;
    if (pending) throw new Error(pending.lastError || 'Memory history projection mutation is still pending');
    const result = mutationResults.get(sequence) ?? 0;
    mutationResults.delete(sequence);
    return result;
  };

  const interval = setInterval(() => { void drain(); }, options.intervalMs ?? 5_000);
  interval.unref();
  queueMicrotask(() => { void drain(); });

  return {
    enqueue(kind, principal, record) {
      insert({ operation: 'upsert', kind, principal, record });
    },
    enqueueDelete(kind, principal, id) {
      return enqueueMutation({ operation: 'delete', kind, principal, id });
    },
    enqueueClear(kind, principal) {
      return enqueueMutation({ operation: 'clear', kind, principal });
    },
    drain,
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}
