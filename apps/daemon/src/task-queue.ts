/**
 * PG-backed task queue — replaces the in-memory run-concurrency-gate.
 *
 * All Huskbox-bound work (agent runs, PPTX/image export, brand extraction)
 * enters through acquire() and is admitted by the worker loop, which
 * respects OD_MAX_CONCURRENT_RUNS. The queue survives daemon restarts:
 * pending tasks are cleaned up on boot, stale running tasks are failed.
 *
 * Key design decisions vs the original in-memory gate:
 *
 *  - tryClaimTask(id) targets a SPECIFIC row by id, never grabs "whatever
 *    is oldest". This eliminates the orphan-livelock class of bugs entirely:
 *    pump() only ever touches rows that have a live in-memory waiter.
 *
 *  - `active` is incremented synchronously BEFORE the async tryClaimTask()
 *    await, and rolled back on failure. This prevents the TOCTOU race where
 *    two concurrent acquire() calls both pass `active < limit` before either
 *    increments (Node.js is single-threaded but async code yields at awaits).
 *
 *  - abandon() only cancels 'pending' rows (never 'running'), matching the
 *    old gate's no-op-for-already-slotted contract.
 *
 *  - stop() cancels PG rows for departing waiters so they don't linger as
 *    orphaned 'pending' rows across restarts.
 *
 *  - start() cleans up ALL orphaned pending/stale-running rows from any
 *    previous incarnation (not filtered by WORKER_ID, which embeds pid and
 *    changes on every restart).
 */

import os from 'node:os';
import type { AsyncDb } from './storage/pg-async.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

export interface TaskQueueSlot {
  taskId: string;
  release: (status?: 'completed' | 'failed' | 'canceled', error?: string) => void;
}

export interface TaskQueueAcquireOptions {
  id: string;
  taskType?: string;
  runId?: string;
  tenantId?: string;
  userId?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  onQueued?: (position: number) => void;
}

export interface TaskQueue {
  acquire: (opts: TaskQueueAcquireOptions) => Promise<TaskQueueSlot | null>;
  abandon: (id: string) => void;
  stats: () => { active: number; queued: number; max: number };
  start: () => void;
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Worker identity — survives within one process, unique across replicas.
// ---------------------------------------------------------------------------

const WORKER_ID = `${os.hostname()}-${process.pid}`;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface PendingWaiter {
  id: string;
  resolve: (slot: TaskQueueSlot | null) => void;
  onQueued?: ((position: number) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskQueue(db: AsyncDb, max: number): TaskQueue {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const unlimited = limit === 0;

  let active = 0;
  const waiters: PendingWaiter[] = [];

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let pumpScheduled = false;
  let stopped = false;

  const activeTasks = new Set<string>();

  // ---- slot ----

  const makeSlot = (taskId: string): TaskQueueSlot => {
    let released = false;
    return {
      taskId,
      release: (status: 'completed' | 'failed' | 'canceled' = 'completed', error?: string) => {
        if (released) return;
        released = true;
        active -= 1;
        activeTasks.delete(taskId);
        finishTask(taskId, status, error).catch(() => {});
        schedulePump();
      },
    };
  };

  // ---- DB helpers ----

  async function insertTask(
    opts: TaskQueueAcquireOptions,
    initialStatus: TaskStatus = 'pending',
  ): Promise<void> {
    const now = Date.now();
    await db.prepare(
      `INSERT INTO task_queue
         (id, tenant_id, user_id, task_type, run_id, payload_json,
          status, priority, worker_id, started_at, heartbeat_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.tenantId ?? '__legacy__',
      opts.userId ?? null,
      opts.taskType ?? 'run',
      opts.runId ?? null,
      opts.payload ? JSON.stringify(opts.payload) : null,
      initialStatus,
      opts.priority ?? 0,
      initialStatus === 'running' ? WORKER_ID : null,
      initialStatus === 'running' ? now : null,
      initialStatus === 'running' ? now : null,
      now,
    );
  }

  async function tryClaimTask(taskId: string): Promise<boolean> {
    const now = Date.now();
    const row = await db.prepare(
      `UPDATE task_queue
          SET status = 'running', worker_id = ?, started_at = ?, heartbeat_at = ?
        WHERE id = ? AND status = 'pending'
        RETURNING id`,
    ).get(WORKER_ID, now, now, taskId);
    return !!row;
  }

  async function finishTask(
    taskId: string,
    status: 'completed' | 'failed' | 'canceled',
    error?: string,
  ): Promise<void> {
    await db.prepare(
      `UPDATE task_queue
          SET status = ?, finished_at = ?, error_text = ?
        WHERE id = ? AND status = 'running'`,
    ).run(status, Date.now(), error ?? null, taskId);
  }

  async function cancelPendingTask(taskId: string): Promise<boolean> {
    const result = await db.prepare(
      `UPDATE task_queue SET status = 'canceled', finished_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).run(Date.now(), taskId);
    return result.changes > 0;
  }

  // ---- heartbeat ----

  async function sendHeartbeat(): Promise<void> {
    if (activeTasks.size === 0) return;
    const now = Date.now();
    try {
      for (const taskId of activeTasks) {
        await db.prepare(
          `UPDATE task_queue SET heartbeat_at = ? WHERE id = ? AND status = 'running'`,
        ).run(now, taskId);
      }
    } catch {
      // Best effort — recovery timer handles failures.
    }
  }

  // ---- stale task recovery ----

  const STALE_THRESHOLD_MS = 2 * 60 * 1000;

  async function recoverStaleTasks(): Promise<void> {
    const threshold = Date.now() - STALE_THRESHOLD_MS;
    const result = await db.prepare(
      `UPDATE task_queue
          SET status = 'failed', finished_at = ?, error_text = 'worker died (heartbeat timeout)'
        WHERE status = 'running' AND heartbeat_at < ?`,
    ).run(Date.now(), threshold);
    if (result.changes > 0) {
      console.log(`[task-queue] failed ${result.changes} stale running task(s)`);
    }
  }

  async function cleanupOnStartup(): Promise<void> {
    const pending = await db.prepare(
      `UPDATE task_queue SET status = 'canceled', finished_at = ?,
              error_text = 'orphaned on daemon restart'
        WHERE status = 'pending'`,
    ).run(Date.now());
    if (pending.changes > 0) {
      console.log(`[task-queue] canceled ${pending.changes} orphaned pending task(s) on startup`);
    }
    await recoverStaleTasks();
  }

  // ---- pump: admit waiters ----

  function schedulePump(): void {
    if (pumpScheduled || stopped) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump().catch((err) =>
        console.error('[task-queue] pump error:', err?.message ?? err),
      );
    });
  }

  async function pump(): Promise<void> {
    if (stopped || unlimited) return;

    while (active < limit && waiters.length > 0) {
      const waiter = waiters[0]!;
      // Reserve a slot synchronously BEFORE the await — prevents TOCTOU.
      active += 1;
      const claimed = await tryClaimTask(waiter.id);
      // After the await, abandon() may have removed this waiter.
      if (waiters[0] !== waiter) {
        active -= 1;
        if (claimed) finishTask(waiter.id, 'canceled').catch(() => {});
        continue;
      }
      waiters.shift();
      if (claimed) {
        activeTasks.add(waiter.id);
        waiter.resolve(makeSlot(waiter.id));
      } else {
        active -= 1;
        waiter.resolve(null);
      }
    }

    for (let i = 0; i < waiters.length; i += 1) {
      waiters[i]!.onQueued?.(i + 1);
    }
  }

  // ---- public API ----

  const acquire = async (opts: TaskQueueAcquireOptions): Promise<TaskQueueSlot | null> => {
    if (unlimited) {
      await insertTask(opts, 'running');
      active += 1;
      activeTasks.add(opts.id);
      return makeSlot(opts.id);
    }

    await insertTask(opts);

    // Fast path: claim immediately if capacity is available.
    // active is incremented synchronously before the await to prevent TOCTOU.
    if (active < limit) {
      active += 1;
      const claimed = await tryClaimTask(opts.id);
      if (claimed) {
        activeTasks.add(opts.id);
        return makeSlot(opts.id);
      }
      active -= 1;
      schedulePump();
      return null;
    }

    opts.onQueued?.(waiters.length + 1);

    return new Promise<TaskQueueSlot | null>((resolve) => {
      waiters.push({ id: opts.id, resolve, onQueued: opts.onQueued });
    });
  };

  const abandon = (id: string): void => {
    const idx = waiters.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const [dropped] = waiters.splice(idx, 1);
    dropped!.resolve(null);
    cancelPendingTask(id).catch(() => {});
    schedulePump();
  };

  const stats = (): { active: number; queued: number; max: number } => ({
    active,
    queued: waiters.length,
    max: limit,
  });

  const start = (): void => {
    stopped = false;
    cleanupOnStartup().then(() => schedulePump()).catch(() => {});

    heartbeatTimer = setInterval(() => {
      sendHeartbeat().catch(() => {});
    }, 30_000);
    heartbeatTimer.unref();

    recoveryTimer = setInterval(() => {
      recoverStaleTasks().catch(() => {});
    }, 60_000);
    recoveryTimer.unref();
  };

  const stop = (): void => {
    stopped = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
    const ids = waiters.map(w => w.id);
    for (const w of waiters.splice(0)) w.resolve(null);
    for (const id of ids) cancelPendingTask(id).catch(() => {});
  };

  return { acquire, abandon, stats, start, stop };
}
