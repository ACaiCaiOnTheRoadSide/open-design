/**
 * PG-backed task queue — replaces the in-memory run-concurrency-gate.
 *
 * All Huskbox-bound work (agent runs, PPTX/image export, brand extraction)
 * enters through acquire() and is admitted by the worker loop, which
 * respects OD_MAX_CONCURRENT_RUNS. The queue survives daemon restarts:
 * pending tasks are cleaned up on boot, stale running tasks are failed.
 *
 * Capacity is decided entirely by PG — there is no in-memory counter.
 * tryClaimTask() atomically checks `running < limit` inside the UPDATE,
 * so two concurrent acquire() calls can never both pass the check. This
 * eliminates the counter-leak class of bugs that plagued the old design
 * (a DB error after `active += 1` would permanently shrink capacity).
 *
 * The only in-memory state is the `waiters` array, which holds Promise
 * resolvers for HTTP requests parked behind a full queue. pump() wakes
 * them when a slot is released or a stale task is recovered.
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
  stats: () => Promise<{ active: number; queued: number; max: number }>;
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

  const waiters: PendingWaiter[] = [];

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let pumpScheduled = false;
  let stopped = false;

  // Tracks tasks this process owns, for heartbeat only.
  const activeTasks = new Set<string>();

  // ---- slot ----

  const makeSlot = (taskId: string): TaskQueueSlot => {
    let released = false;
    return {
      taskId,
      release: (status: 'completed' | 'failed' | 'canceled' = 'completed', error?: string) => {
        if (released) return;
        released = true;
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         priority = EXCLUDED.priority,
         worker_id = EXCLUDED.worker_id,
         started_at = EXCLUDED.started_at,
         heartbeat_at = EXCLUDED.heartbeat_at,
         created_at = EXCLUDED.created_at,
         finished_at = NULL,
         result_json = NULL,
         error_text = NULL`,
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
          AND (SELECT COUNT(*) FROM task_queue WHERE status = 'running') < ?
        RETURNING id`,
    ).get(WORKER_ID, now, now, taskId, limit);
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

  async function countRunning(): Promise<number> {
    const row = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM task_queue WHERE status = 'running'`,
    ).get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
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
      schedulePump();
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

    while (waiters.length > 0) {
      const waiter = waiters[0]!;
      let claimed: boolean;
      try {
        claimed = await tryClaimTask(waiter.id);
      } catch (err) {
        console.error('[task-queue] tryClaimTask failed in pump:', (err as Error)?.message ?? err);
        break;
      }
      // After the await, abandon() may have removed this waiter.
      if (waiters[0] !== waiter) {
        if (claimed) finishTask(waiter.id, 'canceled').catch(() => {});
        continue;
      }
      if (!claimed) {
        // Queue is full — stop trying, remaining waiters stay parked.
        break;
      }
      waiters.shift();
      activeTasks.add(waiter.id);
      waiter.resolve(makeSlot(waiter.id));
    }

    for (let i = 0; i < waiters.length; i += 1) {
      waiters[i]!.onQueued?.(i + 1);
    }
  }

  // ---- public API ----

  const acquire = async (opts: TaskQueueAcquireOptions): Promise<TaskQueueSlot | null> => {
    if (unlimited) {
      await insertTask(opts, 'running');
      activeTasks.add(opts.id);
      return makeSlot(opts.id);
    }

    await insertTask(opts);

    // Try to claim immediately — the SQL checks capacity atomically.
    try {
      const claimed = await tryClaimTask(opts.id);
      if (claimed) {
        activeTasks.add(opts.id);
        return makeSlot(opts.id);
      }
    } catch {
      // DB error — fall through to queue the waiter.
    }

    // Queue is full (or DB errored). Park the request.
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

  const stats = async (): Promise<{ active: number; queued: number; max: number }> => ({
    active: await countRunning(),
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
