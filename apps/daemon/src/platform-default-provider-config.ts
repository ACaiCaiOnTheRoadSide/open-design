import { syncTargetFromEnv, type SyncTarget } from './sync/client.js';

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_MS = 5_000;
const PROVIDER_PATH = '/api/internal/agent/default-provider-config';
const EXTRACTION_PATH = '/api/internal/agent/default-extraction-config';

export interface PlatformExtractionConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}
export interface PlatformDefaultDeps { now: () => number; fetchImpl: typeof fetch; target: SyncTarget | null }
interface Slot<T> { cache: { value: T; at: number } | null; failedAt: number; inFlight: Promise<T> | null }
const slot = <T>(): Slot<T> => ({ cache: null, failedAt: 0, inFlight: null });
const providerSlot = slot<string | null>();
const extractionSlot = slot<PlatformExtractionConfig | null>();
const realDeps = (): PlatformDefaultDeps => ({ now: Date.now, fetchImpl: fetch, target: syncTargetFromEnv() });

async function request(deps: PlatformDefaultDeps, path: string): Promise<unknown> {
  if (!deps.target) return null;
  const once = async () => {
    const response = await deps.fetchImpl(`${deps.target!.backendUrl}${path}`, {
      headers: { authorization: `Bearer ${deps.target!.apiToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response.json();
  };
  try { return await once(); } catch (error) {
    if (error instanceof Error && / HTTP \d+$/u.test(error.message)) throw error;
    return once();
  }
}

async function cached<T>(state: Slot<T>, deps: PlatformDefaultDeps, load: () => Promise<T>, cold: T): Promise<T> {
  const now = deps.now();
  if (state.cache && now - state.cache.at < CACHE_TTL_MS) return state.cache.value;
  if (state.cache && now - state.failedAt < FAILURE_BACKOFF_MS) return state.cache.value;
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    try {
      const value = await load();
      state.cache = { value, at: deps.now() };
      return value;
    } catch {
      state.failedAt = deps.now();
      return state.cache?.value ?? cold;
    } finally { state.inFlight = null; }
  })();
  return state.inFlight;
}

export function getPlatformDefaultProviderConfig(deps: PlatformDefaultDeps = realDeps()): Promise<string | null> {
  return cached(providerSlot, deps, async () => {
    const body = await request(deps, PROVIDER_PATH) as { providerConfig?: unknown } | null;
    const value = typeof body?.providerConfig === 'string' ? body.providerConfig.trim() : '';
    return value || null;
  }, null);
}

export function getPlatformDefaultExtractionConfig(deps: PlatformDefaultDeps = realDeps()): Promise<PlatformExtractionConfig | null> {
  return cached(extractionSlot, deps, async () => {
    const body = await request(deps, EXTRACTION_PATH) as Partial<PlatformExtractionConfig> | null;
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!provider || !apiKey) return null;
    return { provider, apiKey, model: body?.model?.trim() ?? '', baseUrl: body?.baseUrl?.trim() ?? '' };
  }, null);
}

export function __resetPlatformDefaultCacheForTests(): void {
  for (const state of [providerSlot, extractionSlot]) { state.cache = null; state.failedAt = 0; state.inFlight = null; }
}
