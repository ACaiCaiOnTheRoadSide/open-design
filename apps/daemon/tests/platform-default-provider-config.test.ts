import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPlatformDefaultCacheForTests,
  getPlatformDefaultExtractionConfig,
  getPlatformDefaultProviderConfig,
  type PlatformDefaultDeps,
} from '../src/platform-default-provider-config.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeDeps(overrides: Partial<PlatformDefaultDeps> = {}): {
  deps: PlatformDefaultDeps;
  fetchMock: ReturnType<typeof vi.fn>;
  clock: { t: number };
} {
  const clock = { t: 1000 };
  const fetchMock = vi.fn();
  const deps: PlatformDefaultDeps = {
    now: () => clock.t,
    fetchImpl: fetchMock as unknown as typeof fetch,
    target: { backendUrl: 'http://backend:8080', apiToken: 'daemon-secret' },
    ...overrides,
  };
  return { deps, fetchMock, clock };
}

describe('getPlatformDefaultProviderConfig', () => {
  afterEach(() => {
    __resetPlatformDefaultCacheForTests();
    vi.restoreAllMocks();
  });

  it('fetches the backend endpoint with the daemon bearer token and a timeout', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ providerConfig: '{"model":"minimax-m3"}' }));

    const cfg = await getPlatformDefaultProviderConfig(deps);

    expect(cfg).toBe('{"model":"minimax-m3"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://backend:8080/api/internal/agent/default-provider-config');
    expect(init.headers.authorization).toBe('Bearer daemon-secret');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null when the backend reports no default configured', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ providerConfig: '' }));

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
  });

  it('serves the cached value within the TTL without re-fetching', async () => {
    const { deps, fetchMock, clock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ providerConfig: '{"model":"m"}' }));

    await getPlatformDefaultProviderConfig(deps);
    clock.t += 30_000; // still inside 60s TTL
    const cfg = await getPlatformDefaultProviderConfig(deps);

    expect(cfg).toBe('{"model":"m"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const { deps, fetchMock, clock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ providerConfig: '{"model":"m"}' }));

    await getPlatformDefaultProviderConfig(deps);
    clock.t += 61_000;
    await getPlatformDefaultProviderConfig(deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a transport error and succeeds', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ providerConfig: '{"model":"m"}' }));

    expect(await getPlatformDefaultProviderConfig(deps)).toBe('{"model":"m"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on an HTTP error status', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the last good value when a refresh fails', async () => {
    const { deps, fetchMock, clock } = makeDeps();
    fetchMock.mockResolvedValueOnce(jsonResponse({ providerConfig: '{"model":"good"}' }));
    await getPlatformDefaultProviderConfig(deps);

    clock.t += 61_000;
    fetchMock.mockRejectedValue(new Error('backend down'));
    const cfg = await getPlatformDefaultProviderConfig(deps);

    expect(cfg).toBe('{"model":"good"}');
  });

  it('backs off after a failure: serves stale without re-fetching inside the window', async () => {
    const { deps, fetchMock, clock } = makeDeps();
    fetchMock.mockResolvedValueOnce(jsonResponse({ providerConfig: '{"model":"good"}' }));
    await getPlatformDefaultProviderConfig(deps); // 1 call, cache primed

    clock.t += 61_000; // TTL expired
    fetchMock.mockRejectedValue(new Error('backend down'));
    await getPlatformDefaultProviderConfig(deps); // 2 calls (retry), fails, backoff armed

    clock.t += 1_000; // inside FAILURE_BACKOFF_MS
    const cfg = await getPlatformDefaultProviderConfig(deps); // no new fetch
    expect(cfg).toBe('{"model":"good"}');
    // 1 (prime) + 2 (failed refresh: try + retry) = 3, no more during backoff
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null on a cold failure with no cache', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockRejectedValue(new Error('backend down'));

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
  });

  it('returns null (no fetch) when no backend target is configured', async () => {
    const { deps, fetchMock } = makeDeps({ target: null });

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent cold calls into a single fetch', async () => {
    const { deps, fetchMock } = makeDeps();
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((res) => {
        resolveFetch = res;
      }),
    );

    const a = getPlatformDefaultProviderConfig(deps);
    const b = getPlatformDefaultProviderConfig(deps);
    resolveFetch(jsonResponse({ providerConfig: '{"model":"m"}' }));

    expect(await a).toBe('{"model":"m"}');
    expect(await b).toBe('{"model":"m"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getPlatformDefaultExtractionConfig', () => {
  afterEach(() => {
    __resetPlatformDefaultCacheForTests();
    vi.restoreAllMocks();
  });

  it('fetches the flat extraction config from its own endpoint', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(
      jsonResponse({
        provider: 'openai',
        model: 'minimax-m3',
        baseUrl: 'https://api.minimax.io/v1',
        apiKey: 'sk-x',
      }),
    );

    const cfg = await getPlatformDefaultExtractionConfig(deps);

    expect(cfg).toEqual({
      provider: 'openai',
      model: 'minimax-m3',
      baseUrl: 'https://api.minimax.io/v1',
      apiKey: 'sk-x',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://backend:8080/api/internal/agent/default-extraction-config',
    );
  });

  it('returns null when provider or apiKey is missing (no default)', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ provider: '' }));
    expect(await getPlatformDefaultExtractionConfig(deps)).toBeNull();

    __resetPlatformDefaultCacheForTests();
    fetchMock.mockResolvedValue(jsonResponse({ provider: 'openai', apiKey: '' }));
    expect(await getPlatformDefaultExtractionConfig(deps)).toBeNull();
  });

  it('caches independently of the provider-config slot', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('default-provider-config')
          ? jsonResponse({ providerConfig: '{"model":"m"}' })
          : jsonResponse({ provider: 'openai', model: 'minimax-m3', baseUrl: 'b', apiKey: 'k' }),
      ),
    );

    const provider = await getPlatformDefaultProviderConfig(deps);
    const extraction = await getPlatformDefaultExtractionConfig(deps);

    expect(provider).toBe('{"model":"m"}');
    expect(extraction?.model).toBe('minimax-m3');
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per distinct endpoint
  });
});
