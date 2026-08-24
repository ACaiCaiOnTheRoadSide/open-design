import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryRunQueue,
  createPersistentRunQueue,
  resolveMaxConcurrentRunsPerTenant,
  type PersistentRunQueueBackend,
  type RunQueueAcquireOptions,
  type RunQueueTerminalStatus,
} from '../../src/storage/run-queue.js';

interface Row {
  id: string;
  tenant: string;
  owner: string;
  status: 'pending' | 'running' | RunQueueTerminalStatus;
  order: number;
  leaseUntil: number;
}

class FakeBackend implements PersistentRunQueueBackend {
  rows = new Map<string, Row>();
  nextOrder = 0;
  maxObservedRunning = 0;
  failFinish = 0;
  afterEnqueue?: (id: string) => Promise<void>;
  afterClaim?: (id: string) => Promise<void>;

  async recoverStale(now: Date) {
    for (const row of this.rows.values()) {
      if ((row.status === 'pending' || row.status === 'running') && row.leaseUntil < now.getTime()) {
        row.status = row.status === 'running' ? 'failed' : 'canceled';
      }
    }
  }
  async enqueue(options: RunQueueAcquireOptions, owner: string, lease: Date) {
    this.rows.set(options.id, {
      id: options.id,
      tenant: options.principal.tenantId,
      owner,
      status: 'pending',
      order: this.nextOrder++,
      leaseUntil: lease.getTime(),
    });
    await this.afterEnqueue?.(options.id);
  }
  async tryClaim(id: string, owner: string, lease: Date, global: number, tenant: number) {
    const running = [...this.rows.values()].filter((row) => row.status === 'running');
    if (global > 0 && running.length >= global) return false;
    const eligible = [...this.rows.values()]
      .filter((row) => row.status === 'pending')
      .filter((row) => tenant <= 0 || running.filter((active) => active.tenant === row.tenant).length < tenant)
      .sort((a, b) => a.order - b.order)[0];
    if (!eligible || eligible.id !== id || eligible.owner !== owner) return false;
    eligible.status = 'running';
    eligible.leaseUntil = lease.getTime();
    this.maxObservedRunning = Math.max(
      this.maxObservedRunning,
      [...this.rows.values()].filter((row) => row.status === 'running').length,
    );
    await this.afterClaim?.(id);
    return true;
  }
  async position(id: string) {
    const pending = [...this.rows.values()]
      .filter((row) => row.status === 'pending')
      .sort((a, b) => a.order - b.order);
    const index = pending.findIndex((row) => row.id === id);
    return index < 0 ? null : index + 1;
  }
  async heartbeat(owner: string, lease: Date, excludedIds: readonly string[] = []) {
    for (const row of this.rows.values()) {
      if (row.owner === owner && !excludedIds.includes(row.id)) row.leaseUntil = lease.getTime();
    }
  }
  async finish(id: string, owner: string, status: RunQueueTerminalStatus) {
    if (this.failFinish > 0) {
      this.failFinish -= 1;
      throw new Error('injected finish failure');
    }
    const row = this.rows.get(id);
    if (row?.owner === owner && row.status === 'running') row.status = status;
  }
  async cancelPending(id: string, owner: string) {
    const row = this.rows.get(id);
    if (!row || row.owner !== owner || (row.status !== 'pending' && row.status !== 'running')) return false;
    row.status = 'canceled';
    return true;
  }
  async expireOwner(owner: string, now: Date) {
    for (const row of this.rows.values()) {
      if (row.owner !== owner) continue;
      if (row.status === 'pending') row.status = 'canceled';
      if (row.status === 'running') row.leaseUntil = now.getTime();
    }
  }
}

const principal = (tenantId: string) => ({ tenantId, userId: `${tenantId}-user` });

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe('persistent run queue', () => {
  it('uses dynamic tenant fairness by default and accepts an explicit cap', () => {
    expect(resolveMaxConcurrentRunsPerTenant({})).toBe(0);
    expect(resolveMaxConcurrentRunsPerTenant({ OD_MAX_CONCURRENT_RUNS_PER_TENANT: '3' })).toBe(3);
    expect(resolveMaxConcurrentRunsPerTenant({ OD_MAX_CONCURRENT_RUNS_PER_TENANT: '-1' })).toBe(0);
  });

  it('atomically enforces the shared cap across daemons and admits in FIFO order', async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeBackend();
      const a = createPersistentRunQueue(backend, { max: 1, ownerId: 'a', pollMs: 10, leaseMs: 1000 });
      const b = createPersistentRunQueue(backend, { max: 1, ownerId: 'b', pollMs: 10, leaseMs: 1000 });
      await Promise.all([a.start(), b.start()]);

      const first = await a.acquire({ id: 'first', principal: principal('t1') });
      const positions: Array<[number, number]> = [];
      const secondPromise = b.acquire({
        id: 'second',
        principal: principal('t2'),
        onQueued: (position, ahead) => positions.push([position, ahead]),
      });
      await flush();
      expect(backend.rows.get('second')?.status).toBe('pending');
      expect(positions).toEqual([[1, 0]]);
      expect(backend.maxObservedRunning).toBe(1);

      first!.release('completed');
      await flush();
      await vi.advanceTimersByTimeAsync(10);
      const second = await secondPromise;
      expect(second).not.toBeNull();
      expect(backend.rows.get('second')?.status).toBe('running');
      expect(backend.maxObservedRunning).toBe(1);
      second!.release();
      await Promise.all([a.shutdown(), b.shutdown()]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transient terminal failure and frees the slot', async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeBackend();
      backend.failFinish = 1;
      const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'owner', pollMs: 10, leaseMs: 3_000 });
      await queue.start();
      const first = await queue.acquire({ id: 'first', principal: principal('t1') });
      first!.release();
      await flush();
      expect(backend.rows.get('first')?.status).toBe('running');

      const secondPromise = queue.acquire({ id: 'second', principal: principal('t2') });
      await flush();
      expect(backend.rows.get('second')?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(10);
      expect(backend.rows.get('first')?.status).toBe('completed');
      const second = await secondPromise;
      expect(second).not.toBeNull();
      second!.release();
      await queue.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists cancellation while enqueue is blocked before waiter registration', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const backend = new FakeBackend();
    backend.afterEnqueue = (id) => id === 'blocked' ? gate : Promise.resolve();
    const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'owner', pollMs: 10 });
    await queue.start();

    const acquiring = queue.acquire({ id: 'blocked', principal: principal('t1') });
    await flush();
    expect(backend.rows.get('blocked')?.status).toBe('pending');
    queue.cancelPending('blocked');
    await flush();
    unblock();
    expect(await acquiring).toBeNull();
    expect(backend.rows.get('blocked')?.status).toBe('canceled');
    await queue.shutdown();
  });

  it('cancels a row claimed concurrently without returning a ghost slot', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const backend = new FakeBackend();
    backend.afterClaim = (id) => id === 'racing' ? gate : Promise.resolve();
    const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'owner', pollMs: 10 });
    await queue.start();

    const acquiring = queue.acquire({ id: 'racing', principal: principal('t1') });
    await flush();
    expect(backend.rows.get('racing')?.status).toBe('running');
    queue.cancelPending('racing');
    await flush();
    expect(backend.rows.get('racing')?.status).toBe('canceled');
    unblock();
    expect(await acquiring).toBeNull();

    const replacement = await queue.acquire({ id: 'replacement', principal: principal('t2') });
    expect(replacement).not.toBeNull();
    replacement!.release();
    await queue.shutdown();
  });

  it('cancels queued work and recovers an expired running lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'));
    try {
      const backend = new FakeBackend();
      const queue = createPersistentRunQueue(backend, { max: 1, ownerId: 'old', pollMs: 10, leaseMs: 100 });
      await queue.start();
      await queue.acquire({ id: 'active', principal: principal('t1') });
      const canceled = queue.acquire({ id: 'queued', principal: principal('t1') });
      await flush();
      queue.cancelPending('queued');
      expect(await canceled).toBeNull();
      await queue.shutdown();

      vi.setSystemTime(new Date('2026-08-23T00:00:01Z'));
      const replacement = createPersistentRunQueue(backend, { max: 1, ownerId: 'new', pollMs: 10, leaseMs: 100 });
      await replacement.start();
      expect(backend.rows.get('active')?.status).toBe('failed');
      const slot = await replacement.acquire({ id: 'replacement', principal: principal('t2') });
      expect(slot).not.toBeNull();
      await replacement.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('memory run queue', () => {
  it('preserves lightweight SQLite FIFO and queued cancellation', async () => {
    const queue = createMemoryRunQueue(1);
    await queue.start();
    const first = await queue.acquire({ id: 'first', principal: principal('local') });
    const positions: number[] = [];
    const second = queue.acquire({
      id: 'second',
      principal: principal('local'),
      onQueued: (position) => positions.push(position),
    });
    queue.cancelPending('second');
    expect(await second).toBeNull();
    expect(positions).toEqual([1]);
    first!.release();
    await queue.shutdown();
  });
});
