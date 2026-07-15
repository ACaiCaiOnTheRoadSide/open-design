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
// (OD_API_TOKEN), same as the sync/media internal endpoints. Cached briefly so
// a burst of scheduled runs doesn't hammer the backend, and so an admin's model
// change is picked up within the TTL without a restart.

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string | null;
  fetchedAtMs: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<string | null> | null = null;

// Injectable clock/fetch for tests; defaults to real ones.
export interface PlatformDefaultDeps {
  now: () => number;
  fetchImpl: typeof fetch;
  backendUrl: string | undefined;
  daemonToken: string | undefined;
}

function realDeps(): PlatformDefaultDeps {
  return {
    now: () => Date.now(),
    fetchImpl: fetch,
    backendUrl: process.env.OD_BACKEND_URL,
    daemonToken: process.env.OD_API_TOKEN,
  };
}

async function fetchFromBackend(deps: PlatformDefaultDeps): Promise<string | null> {
  const base = (deps.backendUrl ?? '').trim().replace(/\/$/, '');
  if (!base) return null;
  const url = `${base}/api/internal/agent/default-provider-config`;
  const headers: Record<string, string> = {};
  if (deps.daemonToken) headers.Authorization = `Bearer ${deps.daemonToken}`;
  const resp = await deps.fetchImpl(url, { headers });
  if (!resp.ok) {
    throw new Error(`default-provider-config HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { providerConfig?: unknown };
  const cfg = typeof body.providerConfig === 'string' ? body.providerConfig.trim() : '';
  return cfg === '' ? null : cfg;
}

/**
 * Resolve the admin's global default provider config JSON, or null when none is
 * configured / the backend is unreachable. Cached for CACHE_TTL_MS. A failed
 * refresh keeps serving the last good value (better a slightly-stale model than
 * dropping a scheduled run onto the free fallback); only a cold failure with no
 * cache returns null, which the caller turns into an explicit "model not
 * configured" error rather than a silent wrong model.
 */
export async function getPlatformDefaultProviderConfig(
  deps: PlatformDefaultDeps = realDeps(),
): Promise<string | null> {
  const fresh = cache && deps.now() - cache.fetchedAtMs < CACHE_TTL_MS;
  if (fresh) return cache!.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const value = await fetchFromBackend(deps);
      cache = { value, fetchedAtMs: deps.now() };
      return value;
    } catch {
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
  inFlight = null;
}
