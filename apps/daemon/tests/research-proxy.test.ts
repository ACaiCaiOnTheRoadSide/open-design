import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  directFirstFetch,
  resolveResearchProxyEnv,
} from '../src/research/net.js';
import { searchResearch } from '../src/research/index.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

// A stand-in for an undici dispatcher; identity is all the tests check.
const PROXY_SENTINEL = { proxy: true } as unknown as NonNullable<
  RequestInit['dispatcher']
>;

describe('resolveResearchProxyEnv (req 1: unify on the agent proxy)', () => {
  it('prefers OD_AGENT_PROXY over the ambient HTTP(S)_PROXY', () => {
    const resolved = resolveResearchProxyEnv({
      OD_AGENT_PROXY: 'http://192.168.0.97:30234',
      HTTP_PROXY: 'http://47.89.255.71:7010',
      HTTPS_PROXY: 'http://47.89.255.71:7010',
      NO_PROXY: 'localhost,.svc',
    } as NodeJS.ProcessEnv);

    expect(resolved).toEqual({
      HTTP_PROXY: 'http://192.168.0.97:30234',
      HTTPS_PROXY: 'http://192.168.0.97:30234',
      ALL_PROXY: 'http://192.168.0.97:30234',
      NO_PROXY: 'localhost,.svc',
    });
  });

  it('returns null (fall back to ambient env) when OD_AGENT_PROXY is unset', () => {
    expect(
      resolveResearchProxyEnv({
        HTTPS_PROXY: 'http://47.89.255.71:7010',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('directFirstFetch (req 2/3: direct-first, proxy fallback)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never touches a proxy when none is configured', async () => {
    const fetchMock = vi.fn(
      async (_input: FetchInput, _init?: FetchInit) =>
        new Response('ok', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const doFetch = directFirstFetch({});
    await doFetch('https://example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [FetchInput, FetchInit];
    expect((init as { dispatcher?: unknown })?.dispatcher).toBeUndefined();
  });

  it('uses direct (no dispatcher) when the direct attempt succeeds', async () => {
    const fetchMock = vi.fn(
      async (_input: FetchInput, _init?: FetchInit) =>
        new Response('ok', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const doFetch = directFirstFetch({ dispatcher: PROXY_SENTINEL });
    await doFetch('https://example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [FetchInput, FetchInit];
    expect((init as { dispatcher?: unknown })?.dispatcher).toBeUndefined();
  });

  it('retries through the proxy exactly once when direct fails', async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      const viaProxy = (init as { dispatcher?: unknown })?.dispatcher;
      if (!viaProxy) throw new TypeError('fetch failed');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const doFetch = directFirstFetch({ dispatcher: PROXY_SENTINEL });
    const res = await doFetch('https://example.com');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as [FetchInput, FetchInit];
    expect((retryInit as { dispatcher?: unknown })?.dispatcher).toBe(
      PROXY_SENTINEL,
    );
  });

  it('does not retry when the caller-owned signal aborted', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const doFetch = directFirstFetch({ dispatcher: PROXY_SENTINEL });
    await expect(
      doFetch('https://example.com', { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('research bug: direct works, proxy is broken', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Reproduces the reported failure: the ambient/agent proxy cannot reach
  // Pinterest, but the origin is reachable directly. With direct-first egress
  // the search must still succeed and never dial the broken proxy. (Before the
  // fix the route force-proxied every request and this threw `fetch failed`.)
  it('returns Pinterest sources via direct without using the broken proxy', async () => {
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      if ((init as { dispatcher?: unknown })?.dispatcher === PROXY_SENTINEL) {
        throw new TypeError('fetch failed'); // broken proxy
      }
      const url = String(input);
      if (url === 'https://www.pinterest.com') {
        return new Response('', { status: 200 }); // bootstrapCookies
      }
      return new Response(
        JSON.stringify({
          resource_response: {
            data: {
              results: [
                {
                  id: '123',
                  images: {
                    orig: {
                      url: 'https://i.pinimg.com/orig/x.jpg',
                      width: 800,
                      height: 600,
                    },
                  },
                  auto_alt_text: 'minimalist onboarding screen',
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const findings = await searchResearch({
      projectRoot: '/nonexistent',
      query: 'minimalist mobile app onboarding',
      providers: ['pinterest'],
      fetchImpl: directFirstFetch({ dispatcher: PROXY_SENTINEL }),
    });

    expect(findings.provider).toBe('pinterest');
    expect(findings.sources[0]).toMatchObject({
      url: 'https://www.pinterest.com/pin/123/',
      imageUrl: 'https://i.pinimg.com/orig/x.jpg',
      provider: 'pinterest',
    });
    const dialedProxy = fetchMock.mock.calls.some(
      ([, init]) =>
        (init as { dispatcher?: unknown })?.dispatcher === PROXY_SENTINEL,
    );
    expect(dialedProxy).toBe(false);
  });
});
