import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPlatformDefaultCacheForTests,
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
    backendUrl: 'http://backend:8080',
    daemonToken: 'daemon-secret',
    ...overrides,
  };
  return { deps, fetchMock, clock };
}

describe('getPlatformDefaultProviderConfig', () => {
  afterEach(() => {
    __resetPlatformDefaultCacheForTests();
    vi.restoreAllMocks();
  });

  it('fetches the backend endpoint with the daemon bearer token', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ providerConfig: '{"model":"minimax-m3"}' }));

    const cfg = await getPlatformDefaultProviderConfig(deps);

    expect(cfg).toBe('{"model":"minimax-m3"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://backend:8080/api/internal/agent/default-provider-config');
    expect(init.headers.Authorization).toBe('Bearer daemon-secret');
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

  it('serves the last good value when a refresh fails', async () => {
    const { deps, fetchMock, clock } = makeDeps();
    fetchMock.mockResolvedValueOnce(jsonResponse({ providerConfig: '{"model":"good"}' }));
    await getPlatformDefaultProviderConfig(deps);

    clock.t += 61_000;
    fetchMock.mockRejectedValueOnce(new Error('backend down'));
    const cfg = await getPlatformDefaultProviderConfig(deps);

    expect(cfg).toBe('{"model":"good"}');
  });

  it('returns null on a cold failure with no cache', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockRejectedValue(new Error('backend down'));

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
  });

  it('returns null (no fetch) when the backend URL is unset', async () => {
    const { deps, fetchMock } = makeDeps({ backendUrl: undefined });

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a non-2xx response as a failure', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    expect(await getPlatformDefaultProviderConfig(deps)).toBeNull();
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
