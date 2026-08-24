// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedRawToken,
  ensureRawToken,
  RAW_TOKEN_RECOVERY_DELAY_MS,
  RAW_TOKEN_RETRY_DELAYS_MS,
  resetRawTokenStateForTests,
  useRawToken,
} from '../../src/providers/raw-token';

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => resetRawTokenStateForTests());
afterEach(() => {
  cleanup();
  resetRawTokenStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('raw token cache and retry policy', () => {
  it('deduplicates the API request and serves a fresh cached token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token: 'token-1',
      exp: Date.now() / 1000 + 600,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(Promise.all([ensureRawToken('p1'), ensureRawToken('p1')]))
      .resolves.toEqual(['token-1', 'token-1']);
    await expect(ensureRawToken('p1')).resolves.toBe('token-1');
    expect(cachedRawToken('p1')).toBe('token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a low-frequency recovery timer after bounded fast retries and resumes expiry refresh', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 1 + RAW_TOKEN_RETRY_DELAYS_MS.length) {
        return new Response(JSON.stringify({ token: 123, exp: 'bad' }));
      }
      return new Response(JSON.stringify({
        token: 'recovered-token',
        exp: Date.now() / 1000 + 600,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useRawToken('p-bad'));
    await flushPromises();

    for (const delay of RAW_TOKEN_RETRY_DELAYS_MS) {
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(delay));
      await flushPromises();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1 + RAW_TOKEN_RETRY_DELAYS_MS.length);
    expect(vi.getTimerCount()).toBe(1);
    expect(cachedRawToken('p-bad')).toBeNull();

    act(() => vi.advanceTimersByTime(RAW_TOKEN_RECOVERY_DELAY_MS));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2 + RAW_TOKEN_RETRY_DELAYS_MS.length);
    expect(cachedRawToken('p-bad')).toBe('recovered-token');
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(600_000 - 60_000 - 1));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2 + RAW_TOKEN_RETRY_DELAYS_MS.length);
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3 + RAW_TOKEN_RETRY_DELAYS_MS.length);
  });

  it('cleans a pending failure retry timer when the hook unmounts', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const view = renderHook(() => useRawToken('p-unmount'));
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the previous project timer when the project changes', async () => {
    vi.useFakeTimers();
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      requestedUrls.push(input);
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHook(({ projectId }) => useRawToken(projectId), {
      initialProps: { projectId: 'p-old' },
    });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    view.rerender({ projectId: 'p-new' });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrls).toEqual([
      '/api/projects/p-old/raw-token',
      '/api/projects/p-new/raw-token',
    ]);
  });

  it('shares failed refresh requests across concurrent consumers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useRawToken('p-shared'));
    const second = renderHook(() => useRawToken('p-shared'));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(RAW_TOKEN_RETRY_DELAYS_MS[0]));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    first.unmount();
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a minimum refresh delay for valid near-expiry tokens instead of a tight loop', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token: `token-${Date.now()}`,
      exp: Date.now() / 1000 + 30,
    })));
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useRawToken('p-short'));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(14_999));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });
});
