import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('MonkeyCode handoff URL', () => {
  it('loads the environment address from site-config and keeps the prompt in the fragment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { monkeycode_url: 'https://mc.example.com/' } }),
    }));
    const handoff = await import('../../src/runtime/monkeycode');
    await handoff.ensureSiteConfig();
    const url = handoff.buildMonkeycodeTaskUrl('开发首页');
    expect(url).toMatch(/^https:\/\/mc\.example\.com\/console\/tasks#od-task=/);
    expect(url).not.toContain(encodeURIComponent('开发首页'));
  });

  it('rejects oversized task URLs instead of opening a truncated task', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const handoff = await import('../../src/runtime/monkeycode');
    expect(handoff.buildMonkeycodeTaskUrl('x'.repeat(80_000))).toBeNull();
  });
});
