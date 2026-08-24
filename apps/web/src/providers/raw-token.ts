import { useEffect, useReducer } from 'react';

interface TokenEntry {
  token: string;
  exp: number;
}

const REFRESH_SKEW_MS = 60_000;
const USABLE_SKEW_MS = 5_000;
const MIN_REFRESH_DELAY_MS = 15_000;
export const RAW_TOKEN_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const RAW_TOKEN_RECOVERY_DELAY_MS = 60_000;

const cache = new Map<string, TokenEntry>();
const inflight = new Map<string, Promise<string | null>>();
const failureCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function isUsable(entry: TokenEntry | undefined): entry is TokenEntry {
  return !!entry && Date.now() < entry.exp * 1000 - USABLE_SKEW_MS;
}

function isRefreshFresh(entry: TokenEntry | undefined): entry is TokenEntry {
  return !!entry && Date.now() < entry.exp * 1000 - REFRESH_SKEW_MS;
}

function recordFailure(projectId: string): void {
  failureCounts.set(projectId, (failureCounts.get(projectId) ?? 0) + 1);
}

function retryDelay(projectId: string): number | null {
  const failures = failureCounts.get(projectId) ?? 0;
  if (failures <= 0) return null;
  // Fast retries handle brief failures; after they are exhausted, retain a
  // low-frequency recovery timer for as long as a consumer remains mounted.
  return failures <= RAW_TOKEN_RETRY_DELAYS_MS.length
    ? RAW_TOKEN_RETRY_DELAYS_MS[failures - 1]!
    : RAW_TOKEN_RECOVERY_DELAY_MS;
}

export function cachedRawToken(projectId: string): string | null {
  const entry = cache.get(projectId);
  return isUsable(entry) ? entry.token : null;
}

export function ensureRawToken(projectId: string): Promise<string | null> {
  const entry = cache.get(projectId);
  if (isRefreshFresh(entry)) return Promise.resolve(entry.token);
  const pending = inflight.get(projectId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/raw-token`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        recordFailure(projectId);
        return null;
      }
      const data = (await response.json()) as { token?: unknown; exp?: unknown };
      const nowSeconds = Date.now() / 1000;
      if (
        typeof data.token !== 'string'
        || data.token.length === 0
        || typeof data.exp !== 'number'
        || !Number.isFinite(data.exp)
        || data.exp <= nowSeconds + USABLE_SKEW_MS / 1000
      ) {
        recordFailure(projectId);
        return null;
      }
      cache.set(projectId, { token: data.token, exp: data.exp });
      failureCounts.delete(projectId);
      for (const listener of listeners) listener();
      return data.token;
    } catch {
      recordFailure(projectId);
      return null;
    } finally {
      inflight.delete(projectId);
    }
  })();
  inflight.set(projectId, request);
  return request;
}

export function useRawToken(projectId: string | null | undefined): string | null {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = () => rerender();
    listeners.add(listener);

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, delay);
    };
    const refresh = () => {
      void ensureRawToken(projectId).then((token) => {
        if (cancelled) return;
        if (!token) {
          const delay = retryDelay(projectId);
          if (delay !== null) schedule(delay);
          return;
        }
        const entry = cache.get(projectId);
        if (!entry) return;
        schedule(Math.max(
          MIN_REFRESH_DELAY_MS,
          entry.exp * 1000 - REFRESH_SKEW_MS - Date.now(),
        ));
      });
    };
    refresh();

    return () => {
      cancelled = true;
      listeners.delete(listener);
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);
  return projectId ? cachedRawToken(projectId) : null;
}

/** Test-only state reset; production callers should never need to clear tokens. */
export function resetRawTokenStateForTests(): void {
  cache.clear();
  inflight.clear();
  failureCounts.clear();
  listeners.clear();
}
