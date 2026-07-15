// Platform-default provider config — the admin's global default model, fetched
// from the backend for run paths that never carried a per-request
// X-OD-Provider-Config header.
//
// Normal chat runs get the caller's model via that header (ALS →
// currentProviderConfig()). But runs triggered WITHOUT an HTTP request — a
// scheduled routine firing from the daemon's own timer — have no header and no
// ALS store, and the shared deployment leaves the container-level
// OD_OPENCODE_PROVIDER_CONFIG empty on purpose. Without a fallback those runs
// let OpenCode silently pick its built-in free model (opencode/big-pickle),
// which rate-limits under load and fails opaquely.
//
// The model config lives in the backend's byok table with the API key encrypted
// under the backend's key, so the daemon asks the backend (which already
// decrypts + builds it) over the shared internal channel instead of reading the
// row cross-schema and duplicating the crypto. Auth is the daemon token
// (OD_API_TOKEN), same as the sync/media internal endpoints — reuse
// syncTargetFromEnv so the base-URL + bearer contract stays in one place.
// Cached briefly so a burst of scheduled runs doesn't hammer the backend, and
// so an admin's model change is picked up within the TTL without a restart.

import { syncTargetFromEnv, type SyncTarget } from './sync/client.js';

const CACHE_TTL_MS = 60_000;
// Awaited inline in the run-spawn path, so a stalled backend must not park the
// spawn (and every concurrent header-less run sharing the inFlight promise) on
// undici's multi-minute default. Fail fast and let the caller serve stale/null.
const REQUEST_TIMEOUT_MS = 5_000;
// After a failed refresh, don't re-attempt on every call (no backoff would
// hammer a recovering backend); serve stale for this window first.
const FAILURE_BACKOFF_MS = 5_000;

interface CacheEntry {
  value: string | null;
  fetchedAtMs: number;
}

let cache: CacheEntry | null = null;
let lastFailedAtMs = 0;
let inFlight: Promise<string | null> | null = null;

// Injectable clock/fetch/target for tests; defaults to real ones.
export interface PlatformDefaultDeps {
  now: () => number;
  fetchImpl: typeof fetch;
  target: SyncTarget | null;
}

function realDeps(): PlatformDefaultDeps {
  return {
    now: () => Date.now(),
    fetchImpl: fetch,
    target: syncTargetFromEnv(),
  };
}

async function fetchOnce(deps: PlatformDefaultDeps, target: SyncTarget): Promise<string | null> {
  const url = `${target.backendUrl}/api/internal/agent/default-provider-config`;
  const resp = await deps.fetchImpl(url, {
    headers: { authorization: `Bearer ${target.apiToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`default-provider-config HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { providerConfig?: unknown };
  const cfg = typeof body.providerConfig === 'string' ? body.providerConfig.trim() : '';
  return cfg === '' ? null : cfg;
}

async function fetchFromBackend(deps: PlatformDefaultDeps): Promise<string | null> {
  const target = deps.target;
  if (!target) return null; // no backend configured (local/desktop dev)
  // One retry on transport error (timeout, reset), matching sync/client.ts —
  // a single blip on a cold cache would otherwise fail the scheduled run with a
  // misleading "model not configured" instead of using the configured default.
  // HTTP error statuses are NOT retried (a 5xx won't flip on an immediate retry).
  try {
    return await fetchOnce(deps, target);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('default-provider-config HTTP')) {
      throw err;
    }
    return await fetchOnce(deps, target);
  }
}

/**
 * Resolve the admin's global default provider config JSON, or null when none is
 * configured / the backend is unreachable. Cached for CACHE_TTL_MS. A failed
 * refresh keeps serving the last good value (better a slightly-stale model than
 * dropping a scheduled run onto the free fallback) and backs off for
 * FAILURE_BACKOFF_MS before retrying; only a cold failure with no cache returns
 * null, which the caller turns into an explicit "model not configured" error
 * rather than a silent wrong model.
 */
export async function getPlatformDefaultProviderConfig(
  deps: PlatformDefaultDeps = realDeps(),
): Promise<string | null> {
  const nowMs = deps.now();
  if (cache && nowMs - cache.fetchedAtMs < CACHE_TTL_MS) return cache.value;
  // Recent failure: serve stale (or null) without re-hitting the backend yet.
  if (cache && nowMs - lastFailedAtMs < FAILURE_BACKOFF_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const value = await fetchFromBackend(deps);
      cache = { value, fetchedAtMs: deps.now() };
      return value;
    } catch {
      lastFailedAtMs = deps.now();
      if (cache) return cache.value; // serve stale on refresh failure
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Test-only: drop the cache so cases don't bleed into each other.
export function __resetPlatformDefaultCacheForTests(): void {
  cache = null;
  lastFailedAtMs = 0;
  inFlight = null;
}
