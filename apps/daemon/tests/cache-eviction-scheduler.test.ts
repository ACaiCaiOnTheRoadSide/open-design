import { afterEach, describe, expect, it, vi } from 'vitest';

import { startProjectCacheEvictionScheduler } from '../src/sync/cache-eviction-scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('project cache eviction scheduler', () => {
  it('runs hourly with the historical 72-hour default and stops cleanly', async () => {
    vi.useFakeTimers();
    const evict = vi.fn(async () => []);
    const stop = startProjectCacheEvictionScheduler({ enabled: true, evict });

    expect(evict).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(evict).toHaveBeenCalledOnce();
    expect(evict).toHaveBeenCalledWith(72);

    stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(evict).toHaveBeenCalledOnce();
  });

  it('uses the configured environment TTL and reports asynchronous sweep failures', async () => {
    vi.useFakeTimers();
    const previousTtl = process.env.OD_PROJECT_CACHE_TTL_HOURS;
    process.env.OD_PROJECT_CACHE_TTL_HOURS = '24';
    const failure = new Error('sweep failed');
    const evict = vi.fn(async () => { throw failure; });
    const onError = vi.fn();
    try {
      startProjectCacheEvictionScheduler({
        enabled: true,
        intervalMs: 10,
        evict,
        onError,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(evict).toHaveBeenCalledWith(24);
      expect(onError).toHaveBeenCalledWith(failure);
    } finally {
      if (previousTtl === undefined) delete process.env.OD_PROJECT_CACHE_TTL_HOURS;
      else process.env.OD_PROJECT_CACHE_TTL_HOURS = previousTtl;
    }
  });

  it('does not overlap sweeps when an earlier interval is still running', async () => {
    vi.useFakeTimers();
    let finishSweep!: () => void;
    const evict = vi.fn(() => new Promise<void>((resolve) => { finishSweep = resolve; }));
    startProjectCacheEvictionScheduler({ enabled: true, intervalMs: 10, evict });

    await vi.advanceTimersByTimeAsync(20);
    expect(evict).toHaveBeenCalledOnce();

    finishSweep();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(evict).toHaveBeenCalledTimes(2);
  });

  it('does not schedule eviction when manifest sync is disabled', async () => {
    vi.useFakeTimers();
    const evict = vi.fn(async () => []);
    startProjectCacheEvictionScheduler({ enabled: false, intervalMs: 10, evict });

    await vi.advanceTimersByTimeAsync(100);
    expect(evict).not.toHaveBeenCalled();
  });
});
