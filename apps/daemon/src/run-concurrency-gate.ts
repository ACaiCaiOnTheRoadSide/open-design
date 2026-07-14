/**
 * Admission control for agent runs.
 *
 * Without a gate the daemon accepts every concurrent run it is handed, and each
 * one costs a spawned child, a buffered prompt, and a live output stream for as
 * long as the turn lasts (minutes). Two things then go wrong at once:
 *
 *  - The sandbox platform caps concurrent executions per tenant. Runs past that
 *    cap do not fail fast — they sit in the executor's retry loop burning their
 *    backoff, still holding every resource, having accomplished nothing. A
 *    traffic spike turns into a fleet of processes spinning on 429s.
 *  - The daemon is a single-threaded event loop and (in the hosted deployment) a
 *    single replica shared by every tenant. Enough concurrent work to stall that
 *    loop past the liveness probe's timeout restarts the container and kills
 *    every in-flight run, for every tenant, at once.
 *
 * So bound the work at the door instead of letting it pile up downstream: hold
 * excess runs in a FIFO queue, admit them as slots free, and tell the waiting
 * user their position instead of showing them a spinner that means nothing.
 *
 * `max <= 0` disables the gate entirely (every acquire is granted immediately).
 * That is the default, and it is what a single-user desktop install wants; the
 * hosted deployment sets a real cap sized to the sandbox platform's tenant limit.
 */

/** A granted admission slot. `release` is idempotent and safe to call from any path. */
export interface RunGateSlot {
  release: () => void;
}

export interface RunGateAcquireOptions {
  /**
   * Identifies the waiter so a run cancelled while still queued can drop out of
   * the line (see `abandon`). Runs are the only caller, so this is the run id.
   */
  id: string;
  /**
   * Called when the request is parked, and again whenever its position improves.
   * `position` is 1-based: 1 means "next to be admitted". Never called when the
   * slot is granted immediately — a run that never waited has no queue to report.
   */
  onQueued?: (position: number) => void;
}

export interface RunConcurrencyGate {
  /**
   * Resolves with a slot once capacity exists, or with `null` if the waiter was
   * abandoned first. A `null` result means the caller must NOT proceed to run;
   * it should finalize the run as cancelled.
   */
  acquire: (opts: RunGateAcquireOptions) => Promise<RunGateSlot | null>;
  /**
   * Drop a still-queued waiter (user cancelled before admission). Resolves that
   * waiter's pending `acquire` with `null`. No-op if the id already got a slot or
   * was never queued — cancellation races admission, and both orders are normal.
   */
  abandon: (id: string) => void;
  /** Live counters, for diagnostics endpoints and tests. */
  stats: () => { active: number; queued: number; max: number };
}

interface Waiter {
  id: string;
  resolve: (slot: RunGateSlot | null) => void;
  onQueued?: ((position: number) => void) | undefined;
}

export function createRunConcurrencyGate(max: number): RunConcurrencyGate {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const unlimited = limit === 0;

  let active = 0;
  const waiters: Waiter[] = [];

  const makeSlot = (): RunGateSlot => {
    let released = false;
    return {
      release: () => {
        // Idempotent: the run finalizer is the single release point, but it is
        // reachable from many paths and a double-release would silently inflate
        // capacity for the rest of the process's life.
        if (released) return;
        released = true;
        active -= 1;
        pump();
      },
    };
  };

  // Admit as many waiters as capacity allows, then re-broadcast positions to
  // whoever is still in line so their UI counts down instead of sitting still.
  const pump = (): void => {
    while (active < limit && waiters.length > 0) {
      const next = waiters.shift()!;
      active += 1;
      next.resolve(makeSlot());
    }
    for (let i = 0; i < waiters.length; i += 1) {
      waiters[i]!.onQueued?.(i + 1);
    }
  };

  return {
    acquire: ({ id, onQueued }) => {
      if (unlimited) return Promise.resolve(makeSlot());
      if (active < limit) {
        active += 1;
        return Promise.resolve(makeSlot());
      }
      return new Promise<RunGateSlot | null>((resolve) => {
        waiters.push({ id, resolve, onQueued });
        onQueued?.(waiters.length);
      });
    },

    abandon: (id) => {
      const idx = waiters.findIndex((w) => w.id === id);
      if (idx === -1) return;
      const [dropped] = waiters.splice(idx, 1);
      dropped!.resolve(null);
      // The line moved: everyone behind the departed waiter is one step closer.
      for (let i = 0; i < waiters.length; i += 1) {
        waiters[i]!.onQueued?.(i + 1);
      }
    },

    stats: () => ({ active, queued: waiters.length, max: limit }),
  };
}

/**
 * Reads the cap from the environment. Absent/invalid/`0` means unlimited, which
 * preserves the desktop behavior of never queueing a single user behind
 * themselves. The hosted deployment sets this to roughly the sandbox platform's
 * per-tenant concurrent-execution limit, leaving a little headroom so a burst
 * queues here (where we can show the user their position) instead of over there
 * (where it only comes back as an opaque 429 and a five-minute retry backoff).
 */
export function resolveMaxConcurrentRuns(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.OD_MAX_CONCURRENT_RUNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
