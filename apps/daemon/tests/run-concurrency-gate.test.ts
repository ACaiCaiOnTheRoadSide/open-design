import { describe, expect, it } from 'vitest';

import {
  createRunConcurrencyGate,
  resolveMaxConcurrentRuns,
} from '../src/run-concurrency-gate.js';

const settle = () => new Promise((r) => setImmediate(r));

describe('createRunConcurrencyGate', () => {
  it('admits up to the cap immediately and queues the rest', async () => {
    const gate = createRunConcurrencyGate(2);

    const a = await gate.acquire({ id: 'a' });
    const b = await gate.acquire({ id: 'b' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    let cAdmitted = false;
    void gate.acquire({ id: 'c' }).then(() => { cAdmitted = true; });
    await settle();

    expect(cAdmitted).toBe(false);
    expect(gate.stats()).toEqual({ active: 2, queued: 1, max: 2 });
  });

  it('admits a queued waiter as soon as a slot is released', async () => {
    const gate = createRunConcurrencyGate(1);
    const a = await gate.acquire({ id: 'a' });

    const pending = gate.acquire({ id: 'b' });
    await settle();
    expect(gate.stats().queued).toBe(1);

    a!.release();
    const b = await pending;

    expect(b).not.toBeNull();
    expect(gate.stats()).toEqual({ active: 1, queued: 0, max: 1 });
  });

  it('reports queue position and counts it down as the line moves', async () => {
    const gate = createRunConcurrencyGate(1);
    const held = await gate.acquire({ id: 'held' });

    const bPositions: number[] = [];
    const cPositions: number[] = [];
    void gate.acquire({ id: 'b', onQueued: (p) => bPositions.push(p) });
    void gate.acquire({ id: 'c', onQueued: (p) => cPositions.push(p) });
    await settle();

    expect(bPositions).toEqual([1]);
    expect(cPositions).toEqual([2]);

    // Releasing the held slot admits b; c should be told it moved up to 1.
    held!.release();
    await settle();
    expect(cPositions).toEqual([2, 1]);
  });

  it('does not report a position to a run that never had to wait', async () => {
    const gate = createRunConcurrencyGate(2);
    const positions: number[] = [];

    await gate.acquire({ id: 'a', onQueued: (p) => positions.push(p) });

    // A spinner that says "queued, position 1" for a run that started instantly
    // is worse than no message at all.
    expect(positions).toEqual([]);
  });

  // A slot leaked by a double-release permanently inflates capacity for the rest
  // of the process's life — the gate would admit max+1, then max+2, silently
  // undoing the protection it exists to provide. The run finalizer is idempotent
  // but is reachable from ~16 call sites, so the slot must defend itself.
  it('ignores a double release instead of inflating capacity', async () => {
    const gate = createRunConcurrencyGate(1);
    const a = await gate.acquire({ id: 'a' });

    a!.release();
    a!.release();
    a!.release();

    expect(gate.stats().active).toBe(0);

    // Capacity must still be exactly 1: the second acquire has to queue.
    await gate.acquire({ id: 'b' });
    let cAdmitted = false;
    void gate.acquire({ id: 'c' }).then(() => { cAdmitted = true; });
    await settle();

    expect(cAdmitted).toBe(false);
    expect(gate.stats()).toEqual({ active: 1, queued: 1, max: 1 });
  });

  // Cancelling while queued must resolve the pending acquire, or the run's
  // request handler stays parked until an unrelated run happens to finish —
  // the user pressed stop and the UI would keep spinning anyway.
  it('resolves an abandoned waiter with null and lets the line close up', async () => {
    const gate = createRunConcurrencyGate(1);
    const held = await gate.acquire({ id: 'held' });

    const bPending = gate.acquire({ id: 'b' });
    const cPositions: number[] = [];
    const cPending = gate.acquire({ id: 'c', onQueued: (p) => cPositions.push(p) });
    await settle();
    expect(cPositions).toEqual([2]);

    gate.abandon('b');

    await expect(bPending).resolves.toBeNull();
    expect(cPositions).toEqual([2, 1]);
    expect(gate.stats().queued).toBe(1);

    // c is still a real waiter and must still be admitted when a slot frees.
    held!.release();
    await expect(cPending).resolves.not.toBeNull();
  });

  it('treats abandoning an already-admitted or unknown id as a no-op', async () => {
    const gate = createRunConcurrencyGate(1);
    const a = await gate.acquire({ id: 'a' });

    // Cancellation races admission; both orders happen and neither may throw
    // or corrupt the counters.
    expect(() => gate.abandon('a')).not.toThrow();
    expect(() => gate.abandon('never-seen')).not.toThrow();
    expect(gate.stats()).toEqual({ active: 1, queued: 0, max: 1 });

    a!.release();
    expect(gate.stats().active).toBe(0);
  });

  it('admits waiters in FIFO order', async () => {
    const gate = createRunConcurrencyGate(1);
    const held = await gate.acquire({ id: 'held' });

    const order: string[] = [];
    void gate.acquire({ id: 'first' }).then(() => order.push('first'));
    void gate.acquire({ id: 'second' }).then(() => order.push('second'));
    void gate.acquire({ id: 'third' }).then(() => order.push('third'));
    await settle();

    held!.release();
    await settle();
    expect(order).toEqual(['first']);
  });

  it('is disabled when max is zero or negative', async () => {
    for (const max of [0, -1, Number.NaN]) {
      const gate = createRunConcurrencyGate(max);
      const slots = await Promise.all(
        Array.from({ length: 50 }, (_, i) => gate.acquire({ id: `r${i}` })),
      );
      expect(slots.every((s) => s !== null)).toBe(true);
      expect(gate.stats().queued).toBe(0);
    }
  });
});

describe('resolveMaxConcurrentRuns', () => {
  it('defaults to unlimited so a desktop install never queues a user behind themselves', () => {
    expect(resolveMaxConcurrentRuns({})).toBe(0);
    expect(resolveMaxConcurrentRuns({ OD_MAX_CONCURRENT_RUNS: '' })).toBe(0);
    expect(resolveMaxConcurrentRuns({ OD_MAX_CONCURRENT_RUNS: 'abc' })).toBe(0);
    expect(resolveMaxConcurrentRuns({ OD_MAX_CONCURRENT_RUNS: '0' })).toBe(0);
    expect(resolveMaxConcurrentRuns({ OD_MAX_CONCURRENT_RUNS: '-3' })).toBe(0);
  });

  it('reads a positive cap', () => {
    expect(resolveMaxConcurrentRuns({ OD_MAX_CONCURRENT_RUNS: '8' })).toBe(8);
    expect(resolveMaxConcurrentRuns({ OD_MAX_CONCURRENT_RUNS: '8.9' })).toBe(8);
  });
});
