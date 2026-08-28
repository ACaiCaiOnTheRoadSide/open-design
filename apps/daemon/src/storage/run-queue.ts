import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { PgPoolLike, PgQueryable } from './pg.js';
import type { VerifiedPrincipal } from '../request-context.js';

export type RunQueueTerminalStatus = 'completed' | 'failed' | 'canceled';

export interface RunQueueSlot {
  release(status?: RunQueueTerminalStatus, error?: string): void;
}

export interface RunQueueAcquireOptions {
  id: string;
  principal: VerifiedPrincipal;
  onQueued?: (position: number, ahead: number) => void;
}

export interface RunQueue {
  start(): Promise<void>;
  acquire(options: RunQueueAcquireOptions): Promise<RunQueueSlot | null>;
  cancelPending(id: string): void;
  shutdown(): Promise<void>;
}

export function resolveMaxConcurrentRuns(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env.OD_MAX_CONCURRENT_RUNS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Optional fairness ceiling while multiple tenants are waiting. Zero selects
 * ceil(global slots / waiting tenants). With one waiting tenant the ceiling is
 * relaxed so the queue remains work-conserving. */
export function resolveMaxConcurrentRunsPerTenant(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env.OD_MAX_CONCURRENT_RUNS_PER_TENANT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

interface Waiter {
  options: RunQueueAcquireOptions;
  resolve(slot: RunQueueSlot | null): void;
  lastPosition: number;
}

/** SQLite/desktop path: intentionally process-local and allocation-free when unlimited. */
export function createMemoryRunQueue(max: number): RunQueue {
  const limit = normalizeLimit(max);
  const waiters: Waiter[] = [];
  let active = 0;
  let stopped = false;

  const notifyPositions = () => {
    waiters.forEach((waiter, index) => {
      const position = index + 1;
      if (position !== waiter.lastPosition) {
        waiter.lastPosition = position;
        waiter.options.onQueued?.(position, position - 1);
      }
    });
  };
  const makeSlot = (): RunQueueSlot => {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (limit > 0) active -= 1;
        pump();
      },
    };
  };
  const pump = () => {
    if (stopped || limit === 0) return;
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift()!;
      active += 1;
      waiter.resolve(makeSlot());
    }
    notifyPositions();
  };

  return {
    async start() { stopped = false; },
    async acquire(options) {
      if (stopped) return null;
      if (limit === 0) return makeSlot();
      if (active < limit) {
        active += 1;
        return makeSlot();
      }
      return new Promise((resolve) => {
        const waiter: Waiter = { options, resolve, lastPosition: 1 };
        waiters.push(waiter);
        const position = waiters.length;
        waiter.lastPosition = position;
        options.onQueued?.(position, position - 1);
      });
    },
    cancelPending(id) {
      const index = waiters.findIndex((waiter) => waiter.options.id === id);
      if (index < 0) return;
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(null);
      notifyPositions();
    },
    async shutdown() {
      stopped = true;
      for (const waiter of waiters.splice(0)) waiter.resolve(null);
    },
  };
}

export interface PersistentRunQueueBackend {
  recoverStale(now: Date): Promise<void>;
  enqueue(options: RunQueueAcquireOptions, ownerId: string, leaseUntil: Date): Promise<void>;
  tryClaim(id: string, ownerId: string, leaseUntil: Date, globalLimit: number, tenantLimit: number): Promise<boolean>;
  position(id: string, globalLimit: number, tenantLimit: number): Promise<number | null>;
  heartbeat(ownerId: string, leaseUntil: Date, excludedIds?: readonly string[]): Promise<void>;
  finish(id: string, ownerId: string, status: RunQueueTerminalStatus, error?: string): Promise<void>;
  cancelPending(id: string, ownerId: string): Promise<boolean>;
  expireOwner(ownerId: string, now: Date): Promise<void>;
}

export interface PersistentRunQueueOptions {
  max: number;
  tenantMax?: number;
  pollMs?: number;
  leaseMs?: number;
  ownerId?: string;
}

/**
 * Promise coordinator around a durable backend. Every daemon polls only its own
 * waiters; atomic backend claims provide the cross-daemon concurrency truth.
 */
export function createPersistentRunQueue(
  backend: PersistentRunQueueBackend,
  options: PersistentRunQueueOptions,
): RunQueue {
  const limit = normalizeLimit(options.max);
  const tenantLimit = normalizeLimit(options.tenantMax ?? 0);
  const pollMs = options.pollMs ?? 250;
  const leaseMs = options.leaseMs ?? 30_000;
  const ownerId = options.ownerId ?? `${os.hostname()}:${process.pid}:${randomUUID()}`;
  const waiters = new Map<string, Waiter>();
  const active = new Set<string>();
  const acquiring = new Set<string>();
  const canceled = new Set<string>();
  const cancelIntents = new Set<string>();
  const cancelAttempts = new Map<string, Promise<void>>();
  // Terminal intents remain until the durable UPDATE succeeds. Released rows are
  // excluded from heartbeats immediately, so a database outage can never renew
  // their slot forever; retries normally finish them sooner and lease expiry is
  // the fallback. Cancellation intents use the same exclusion before a waiter
  // exists, closing the enqueue-to-waiter race.
  const terminalIntents = new Map<string, { status: RunQueueTerminalStatus; error?: string }>();
  const terminalAttempts = new Map<string, Promise<void>>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = true;
  let pumping: Promise<void> | null = null;

  const leaseUntil = () => new Date(Date.now() + leaseMs);
  const flushTerminal = (id: string): Promise<void> => {
    const existing = terminalAttempts.get(id);
    if (existing) return existing;
    const intent = terminalIntents.get(id);
    if (!intent) return Promise.resolve();
    const attempt = backend.finish(id, ownerId, intent.status, intent.error)
      .then(() => {
        if (terminalIntents.get(id) === intent) terminalIntents.delete(id);
        schedulePump();
      })
      .catch((finishError) => console.error('[run-queue] finish failed', finishError))
      .finally(() => {
        if (terminalAttempts.get(id) === attempt) terminalAttempts.delete(id);
      });
    terminalAttempts.set(id, attempt);
    return attempt;
  };
  const flushCancellation = (id: string): Promise<void> => {
    cancelIntents.add(id);
    const existing = cancelAttempts.get(id);
    if (existing) return existing;
    const attempt = backend.cancelPending(id, ownerId)
      .then(() => { cancelIntents.delete(id); })
      .catch((cancelError) => console.error('[run-queue] cancel failed', cancelError))
      .finally(() => {
        if (cancelAttempts.get(id) === attempt) cancelAttempts.delete(id);
        if (!cancelIntents.has(id) && !acquiring.has(id) && !waiters.has(id)) canceled.delete(id);
        schedulePump();
      });
    cancelAttempts.set(id, attempt);
    return attempt;
  };
  const makeSlot = (id: string): RunQueueSlot => {
    let released = false;
    return {
      release(status = 'completed', error) {
        if (released) return;
        released = true;
        active.delete(id);
        terminalIntents.set(id, error === undefined ? { status } : { status, error });
        void flushTerminal(id);
      },
    };
  };
  const updatePosition = async (waiter: Waiter) => {
    const position = await backend.position(waiter.options.id, limit, tenantLimit);
    if (position === null || position === waiter.lastPosition) return;
    waiter.lastPosition = position;
    waiter.options.onQueued?.(position, Math.max(0, position - 1));
  };
  const pumpOnce = async () => {
    await Promise.all([
      ...[...terminalIntents.keys()].map((id) => flushTerminal(id)),
      ...[...cancelIntents.keys()].map((id) => flushCancellation(id)),
    ]);
    if (stopped) return;
    await backend.recoverStale(new Date());
    for (const waiter of [...waiters.values()]) {
      if (!waiters.has(waiter.options.id)) continue;
      const claimed = await backend.tryClaim(
        waiter.options.id,
        ownerId,
        leaseUntil(),
        limit,
        tenantLimit,
      );
      if (claimed) {
        waiters.delete(waiter.options.id);
        if (canceled.has(waiter.options.id)) {
          await flushCancellation(waiter.options.id);
          waiter.resolve(null);
        } else {
          active.add(waiter.options.id);
          waiter.resolve(makeSlot(waiter.options.id));
        }
      } else {
        await updatePosition(waiter);
      }
    }
  };
  function schedulePump(): void {
    if (stopped || pumping) return;
    pumping = pumpOnce()
      .catch((error) => console.error('[run-queue] pump failed', error))
      .finally(() => { pumping = null; });
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      await backend.recoverStale(new Date());
      pollTimer = setInterval(schedulePump, pollMs);
      pollTimer.unref?.();
      heartbeatTimer = setInterval(() => {
        const excluded = [...new Set([...terminalIntents.keys(), ...cancelIntents.keys()])];
        void backend.heartbeat(ownerId, leaseUntil(), excluded).catch((error) => {
          console.error('[run-queue] heartbeat failed', error);
        });
      }, Math.max(1_000, Math.floor(leaseMs / 3)));
      heartbeatTimer.unref?.();
    },
    async acquire(acquireOptions) {
      if (stopped) return null;
      acquiring.add(acquireOptions.id);
      try {
        while (terminalIntents.has(acquireOptions.id) && !stopped) {
          await flushTerminal(acquireOptions.id);
          if (terminalIntents.has(acquireOptions.id)) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
        }
        if (stopped) return null;
        await backend.enqueue(acquireOptions, ownerId, leaseUntil());
        if (canceled.has(acquireOptions.id)) {
          await flushCancellation(acquireOptions.id);
          return null;
        }
        const claimed = await backend.tryClaim(
          acquireOptions.id,
          ownerId,
          leaseUntil(),
          limit,
          tenantLimit,
        );
        if (canceled.has(acquireOptions.id)) {
          await flushCancellation(acquireOptions.id);
          return null;
        }
        if (claimed) {
          active.add(acquireOptions.id);
          return makeSlot(acquireOptions.id);
        }
        const position = await backend.position(acquireOptions.id, limit, tenantLimit) ?? 1;
        if (canceled.has(acquireOptions.id)) {
          await flushCancellation(acquireOptions.id);
          return null;
        }
        acquireOptions.onQueued?.(position, Math.max(0, position - 1));
        return await new Promise((resolve) => {
          // There is no await between the final tombstone check and registration,
          // so cancelPending cannot slip through this window in the JS process.
          if (canceled.has(acquireOptions.id)) {
            void flushCancellation(acquireOptions.id).then(() => resolve(null));
            return;
          }
          waiters.set(acquireOptions.id, {
            options: acquireOptions,
            resolve,
            lastPosition: position,
          });
        });
      } finally {
        acquiring.delete(acquireOptions.id);
        if (!cancelIntents.has(acquireOptions.id) && !waiters.has(acquireOptions.id)) {
          canceled.delete(acquireOptions.id);
        }
      }
    },
    cancelPending(id) {
      canceled.add(id);
      const waiter = waiters.get(id);
      if (waiter) {
        waiters.delete(id);
        waiter.resolve(null);
      }
      void flushCancellation(id);
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
      for (const waiter of waiters.values()) waiter.resolve(null);
      waiters.clear();
      // One final retry is bounded: shutdown must not hang on a wedged database.
      const drainMs = Math.min(2_000, Math.max(100, pollMs * 4));
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const drain = Promise.all([
        ...[...terminalIntents.keys()].map((id) => flushTerminal(id)),
        ...[...cancelIntents.keys()].map((id) => flushCancellation(id)),
        backend.expireOwner(ownerId, new Date()),
      ]).catch((error) => { console.error('[run-queue] shutdown drain failed', error); });
      await Promise.race([
        drain,
        new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, drainMs); }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
      active.clear();
    },
  };
}

export function createPostgresRunQueue(pool: PgPoolLike, max: number, tenantMax = 0): RunQueue {
  if (normalizeLimit(max) === 0) return createMemoryRunQueue(0);
  return createPersistentRunQueue(createPostgresRunQueueBackend(pool), { max, tenantMax });
}

export function createPostgresRunQueueBackend(pool: PgPoolLike): PersistentRunQueueBackend {
  const withClaimLock = async <T>(work: (client: PgQueryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('open-design:run-queue:claim'))");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    async recoverStale(now) {
      await pool.query(
        `UPDATE run_queue SET status = CASE WHEN status = 'running' THEN 'failed' ELSE 'canceled' END,
          finished_at = $1, owner_id = NULL, lease_expires_at = NULL,
          error_text = CASE WHEN status = 'running' THEN 'run lease expired' ELSE 'queue owner disappeared' END
         WHERE status IN ('pending', 'running') AND lease_expires_at < $1`,
        [now],
      );
    },
    async enqueue(options, ownerId, leaseUntil) {
      const result = await pool.query(
        `INSERT INTO run_queue (id, tenant_id, user_id, run_id, status, owner_id, lease_expires_at)
         VALUES ($1, $2, $3, $1, 'pending', $4, $5)
         ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id,
           user_id = EXCLUDED.user_id, status = 'pending', owner_id = EXCLUDED.owner_id,
           lease_expires_at = EXCLUDED.lease_expires_at, created_at = clock_timestamp(),
           claimed_at = NULL, finished_at = NULL, error_text = NULL
         WHERE run_queue.status IN ('completed', 'failed', 'canceled')
         RETURNING id`,
        [options.id, options.principal.tenantId, options.principal.userId, ownerId, leaseUntil],
      );
      if (result.rowCount !== 1) throw new Error(`run queue id is already active: ${options.id}`);
    },
    async tryClaim(id, ownerId, until, globalLimit, tenantLimit) {
      return withClaimLock(async (client) => {
        const row = await client.query<{ id: string }>(
          `WITH pending_tenants AS (
             SELECT tenant_id, min(created_at) AS oldest_pending
               FROM run_queue WHERE status = 'pending' GROUP BY tenant_id
           ), tenant_state AS (
             SELECT p.tenant_id, p.oldest_pending,
                    (SELECT count(*) FROM run_queue r
                      WHERE r.status = 'running' AND r.tenant_id = p.tenant_id) AS running_count,
                    (SELECT max(claimed_at) FROM run_queue h
                      WHERE h.tenant_id = p.tenant_id AND h.claimed_at IS NOT NULL) AS last_claimed,
                    (SELECT count(*) FROM pending_tenants) AS contender_count
               FROM pending_tenants p
           ), chosen_tenant AS (
             SELECT tenant_id FROM tenant_state
              ORDER BY CASE
                 WHEN contender_count <= 1 OR $3 <= 0 THEN 0
                 WHEN running_count < CASE WHEN $2 > 0 THEN $2
                      ELSE ceil($3::numeric / contender_count)::bigint END THEN 0
                 ELSE 1
               END,
               last_claimed ASC NULLS FIRST, oldest_pending, tenant_id LIMIT 1
           ), candidate AS (
             SELECT q.id FROM run_queue q JOIN chosen_tenant t USING (tenant_id)
              WHERE q.status = 'pending' ORDER BY q.created_at, q.id LIMIT 1
           ), capacity AS (
             SELECT $3 <= 0 OR (SELECT count(*) FROM run_queue WHERE status = 'running') < $3 AS available
           )
           UPDATE run_queue q SET status = 'running', owner_id = $4,
             lease_expires_at = $5, claimed_at = clock_timestamp()
            FROM candidate, capacity
            WHERE q.id = $1 AND q.id = candidate.id AND capacity.available
              AND q.status = 'pending' AND q.owner_id = $4
           RETURNING q.id`,
          [id, tenantLimit, globalLimit, ownerId, until],
        );
        return row.rowCount === 1;
      });
    },
    async position(id, globalLimit, tenantLimit) {
      const result = await pool.query<{ position: string }>(
        `WITH tenant_state AS (
           SELECT tenant_id,
                  (SELECT count(*) FROM run_queue r
                    WHERE r.status = 'running' AND r.tenant_id = p.tenant_id) AS running_count,
                  (SELECT max(claimed_at) FROM run_queue h
                    WHERE h.tenant_id = p.tenant_id AND h.claimed_at IS NOT NULL) AS last_claimed,
                  count(*) OVER () AS contender_count
             FROM run_queue p WHERE status = 'pending' GROUP BY tenant_id
         ), tenant_rows AS (
           SELECT q.id, q.tenant_id, q.created_at, s.running_count, s.last_claimed,
                  CASE
                    WHEN s.contender_count <= 1 OR $3 <= 0 THEN 0
                    WHEN s.running_count < CASE WHEN $2 > 0 THEN $2
                         ELSE ceil($3::numeric / s.contender_count)::bigint END THEN 0
                    ELSE 1
                  END AS over_fair_cap,
                  row_number() OVER (PARTITION BY q.tenant_id ORDER BY q.created_at, q.id) AS tenant_position
             FROM run_queue q JOIN tenant_state s USING (tenant_id) WHERE q.status = 'pending'
         ), pending AS (
           SELECT id, row_number() OVER (
             ORDER BY over_fair_cap, tenant_position, running_count,
                      last_claimed ASC NULLS FIRST, created_at, id
           ) AS position FROM tenant_rows
         ) SELECT position::text FROM pending WHERE id = $1`,
        [id, tenantLimit, globalLimit],
      );
      return result.rows[0] ? Number(result.rows[0].position) : null;
    },
    async heartbeat(ownerId, until, excludedIds = []) {
      await pool.query(
        `UPDATE run_queue SET lease_expires_at = $2
          WHERE owner_id = $1 AND status IN ('pending', 'running')
            AND NOT (id = ANY($3::text[]))`,
        [ownerId, until, excludedIds],
      );
    },
    async finish(id, ownerId, status, error) {
      await pool.query(
        `UPDATE run_queue SET status = $3, finished_at = clock_timestamp(),
           owner_id = NULL, lease_expires_at = NULL, error_text = $4
         WHERE id = $1 AND owner_id = $2 AND status = 'running'`,
        [id, ownerId, status, error ?? null],
      );
    },
    async cancelPending(id, ownerId) {
      const result = await pool.query(
        `UPDATE run_queue SET status = 'canceled', finished_at = clock_timestamp(),
           owner_id = NULL, lease_expires_at = NULL
         WHERE id = $1 AND owner_id = $2 AND status IN ('pending', 'running')`,
        [id, ownerId],
      );
      return result.rowCount === 1;
    },
    async expireOwner(ownerId, now) {
      await pool.query(
        `UPDATE run_queue SET
           status = CASE WHEN status = 'pending' THEN 'canceled' ELSE status END,
           finished_at = CASE WHEN status = 'pending' THEN $2 ELSE finished_at END,
           lease_expires_at = CASE WHEN status = 'running' THEN $2 ELSE NULL END,
           owner_id = CASE WHEN status = 'pending' THEN NULL ELSE owner_id END,
           error_text = CASE WHEN status = 'pending' THEN 'daemon shutdown while queued' ELSE error_text END
         WHERE owner_id = $1 AND status IN ('pending', 'running')`,
        [ownerId, now],
      );
    },
  };
}

function normalizeLimit(max: number): number {
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
}
