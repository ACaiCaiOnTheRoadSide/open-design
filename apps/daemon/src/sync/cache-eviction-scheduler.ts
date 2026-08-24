import {
  evictColdProjects,
  syncEnabled as manifestSyncEnabled,
} from './engine.js';

const CACHE_EVICTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_TTL_HOURS = 72;

type SchedulerOptions = {
  enabled?: boolean;
  ttlHours?: string;
  intervalMs?: number;
  evict?: (ttlHours: number) => Promise<unknown>;
  onError?: (error: unknown) => void;
};

export function startProjectCacheEvictionScheduler(
  options: SchedulerOptions = {},
): () => void {
  const enabled = options.enabled ?? manifestSyncEnabled();
  if (!enabled) return () => {};

  const ttlHours = Number(options.ttlHours ?? process.env.OD_PROJECT_CACHE_TTL_HOURS ?? '72')
    || DEFAULT_CACHE_TTL_HOURS;
  // evictColdProjects uses the project sync chain; run setup writes must use
  // runProjectMutation so a sweep cannot remove newly staged run assets.
  const evict = options.evict ?? evictColdProjects;
  const onError = options.onError
    ?? ((error: unknown) => console.warn('[sync] cold project eviction failed:', error));
  let sweepInFlight = false;
  const timer = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void evict(ttlHours)
      .catch(onError)
      .finally(() => {
        sweepInFlight = false;
      });
  }, options.intervalMs ?? CACHE_EVICTION_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}
