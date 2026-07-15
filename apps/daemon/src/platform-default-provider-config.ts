// Platform-default model config — the admin's global default model, fetched
// from the backend for daemon-side run paths that can't get it any other way.
//
// Two consumers, two shapes, one backend + caching contract:
//   - getPlatformDefaultProviderConfig(): the OpenCode provider-config JSON
//     (string), for header-less agent runs — a scheduled routine firing from
//     the daemon's own timer carries neither the X-OD-Provider-Config header
//     nor an ALS store, and the shared deployment leaves the container-level
//     OD_OPENCODE_PROVIDER_CONFIG empty on purpose, so without this those runs
//     let OpenCode silently pick its built-in free model (opencode/big-pickle).
//   - getPlatformDefaultExtractionConfig(): the same default as flat
//     {provider,model,baseUrl,apiKey}, for background memory extraction, which
//     wants to call the model directly over the openai/anthropic wire rather
//     than through the agent-run machinery.
//
// The model config lives in the backend's byok table with the API key encrypted
// under the backend's key, so the daemon asks the backend (which already
// decrypts + builds it) over the shared internal channel instead of reading the
// row cross-schema and duplicating the crypto. Auth is the daemon token, via
// syncTargetFromEnv so the base-URL + bearer contract stays in one place.

import { syncTargetFromEnv, type SyncTarget } from './sync/client.js';

const CACHE_TTL_MS = 60_000;
// Both getters can be awaited inline on a spawn/extraction path, so a stalled
// backend must not park the caller on undici's multi-minute default.
const REQUEST_TIMEOUT_MS = 5_000;
// After a failed refresh, don't re-attempt on every call (no backoff would
// hammer a recovering backend); serve stale for this window first.
const FAILURE_BACKOFF_MS = 5_000;

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

// One GET against a backend internal endpoint, with a hard timeout. Throws
// `<path> HTTP <status>` on a non-2xx so the retry layer can tell a transport
// blip (retryable) from a real error status (not).
async function requestOnce(
  deps: PlatformDefaultDeps,
  target: SyncTarget,
  path: string,
): Promise<unknown> {
  const resp = await deps.fetchImpl(`${target.backendUrl}${path}`, {
    headers: { authorization: `Bearer ${target.apiToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`${path} HTTP ${resp.status}`);
  return resp.json();
}

// One retry on transport error (timeout, reset), matching sync/client.ts — a
// single blip on a cold cache would otherwise fail the caller with a misleading
// "not configured" instead of using the configured default. HTTP error statuses
// are NOT retried (a 5xx won't flip on an immediate retry).
async function requestWithRetry(deps: PlatformDefaultDeps, path: string): Promise<unknown> {
  const target = deps.target;
  if (!target) return null; // no backend configured (local/desktop dev)
  try {
    return await requestOnce(deps, target, path);
  } catch (err) {
    if (err instanceof Error && / HTTP \d+$/.test(err.message)) throw err;
    return await requestOnce(deps, target, path);
  }
}

// A cached, deduped, stale-on-failure slot around one backend endpoint.
interface CacheSlot<T> {
  cache: { value: T; fetchedAtMs: number } | null;
  lastFailedAtMs: number;
  inFlight: Promise<T> | null;
}

function newSlot<T>(): CacheSlot<T> {
  return { cache: null, lastFailedAtMs: 0, inFlight: null };
}

// Resolve a slot's value: fresh cache → serve; recent failure → serve stale
// without re-hitting the backend; otherwise fetch (deduped via inFlight). A
// failed refresh keeps the last good value; a cold failure returns `coldValue`.
async function resolveSlot<T>(
  slot: CacheSlot<T>,
  deps: PlatformDefaultDeps,
  fetchFn: (deps: PlatformDefaultDeps) => Promise<T>,
  coldValue: T,
): Promise<T> {
  const nowMs = deps.now();
  if (slot.cache && nowMs - slot.cache.fetchedAtMs < CACHE_TTL_MS) return slot.cache.value;
  if (slot.cache && nowMs - slot.lastFailedAtMs < FAILURE_BACKOFF_MS) return slot.cache.value;
  if (slot.inFlight) return slot.inFlight;
  slot.inFlight = (async () => {
    try {
      const value = await fetchFn(deps);
      slot.cache = { value, fetchedAtMs: deps.now() };
      return value;
    } catch {
      slot.lastFailedAtMs = deps.now();
      if (slot.cache) return slot.cache.value; // serve stale on refresh failure
      return coldValue;
    } finally {
      slot.inFlight = null;
    }
  })();
  return slot.inFlight;
}

// --- Provider config (OpenCode JSON string) for header-less agent runs ---

const PROVIDER_PATH = '/api/internal/agent/default-provider-config';
const providerSlot = newSlot<string | null>();

async function fetchProviderConfig(deps: PlatformDefaultDeps): Promise<string | null> {
  const body = (await requestWithRetry(deps, PROVIDER_PATH)) as { providerConfig?: unknown } | null;
  const cfg = body && typeof body.providerConfig === 'string' ? body.providerConfig.trim() : '';
  return cfg === '' ? null : cfg;
}

/**
 * The admin's global default OpenCode provider config JSON, or null when none
 * is configured / the backend is unreachable. Cached; only a cold failure with
 * no cache returns null, which the caller turns into an explicit "model not
 * configured" error rather than a silent wrong model.
 */
export async function getPlatformDefaultProviderConfig(
  deps: PlatformDefaultDeps = realDeps(),
): Promise<string | null> {
  return resolveSlot(providerSlot, deps, fetchProviderConfig, null);
}

// --- Flat extraction config for background memory extraction ---

export interface PlatformExtractionConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const EXTRACTION_PATH = '/api/internal/agent/default-extraction-config';
const extractionSlot = newSlot<PlatformExtractionConfig | null>();

async function fetchExtractionConfig(
  deps: PlatformDefaultDeps,
): Promise<PlatformExtractionConfig | null> {
  const body = (await requestWithRetry(deps, EXTRACTION_PATH)) as
    | Partial<PlatformExtractionConfig>
    | null;
  const provider = body && typeof body.provider === 'string' ? body.provider.trim() : '';
  const apiKey = body && typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!provider || !apiKey) return null; // no default configured
  return {
    provider,
    apiKey,
    model: typeof body!.model === 'string' ? body!.model.trim() : '',
    baseUrl: typeof body!.baseUrl === 'string' ? body!.baseUrl.trim() : '',
  };
}

/**
 * The admin's global default model as flat {provider,model,baseUrl,apiKey} for
 * background memory extraction, or null when none is configured / unreachable.
 * Cached alongside the provider-config slot.
 */
export async function getPlatformDefaultExtractionConfig(
  deps: PlatformDefaultDeps = realDeps(),
): Promise<PlatformExtractionConfig | null> {
  return resolveSlot(extractionSlot, deps, fetchExtractionConfig, null);
}

// Test-only: drop both caches so cases don't bleed into each other.
export function __resetPlatformDefaultCacheForTests(): void {
  providerSlot.cache = null;
  providerSlot.lastFailedAtMs = 0;
  providerSlot.inFlight = null;
  extractionSlot.cache = null;
  extractionSlot.lastFailedAtMs = 0;
  extractionSlot.inFlight = null;
}
