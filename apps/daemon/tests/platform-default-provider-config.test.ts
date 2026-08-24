import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPlatformDefaultCacheForTests,
  getPlatformDefaultProviderConfig,
} from '../src/platform-default-provider-config.js';
import {
  extractionConfigFromProviderConfig,
  sanitizeProviderConfig,
} from '../src/runtime-provider-config.js';

beforeEach(() => __resetPlatformDefaultCacheForTests());

describe('platform default provider config', () => {
  it('retries one transport failure and does not expose the secret to logs', async () => {
    const secret = 'sk-never-log';
    const config = JSON.stringify({ provider: { p: { options: { apiKey: secret } } }, model: 'p/m' });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ providerConfig: config }), { status: 200 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await getPlatformDefaultProviderConfig({
      now: () => 1,
      fetchImpl,
      target: { backendUrl: 'https://backend.example', apiToken: 'daemon-token' },
    });
    expect(result).toBe(config);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    warn.mockRestore();
  });

  it('fails closed on malformed or model-less configs', () => {
    expect(sanitizeProviderConfig('{bad')).toBeUndefined();
    expect(sanitizeProviderConfig(JSON.stringify({ provider: { p: {} } }))).toBeUndefined();
  });

  it('derives a direct memory provider without changing the key', () => {
    expect(extractionConfigFromProviderConfig(JSON.stringify({
      provider: { p: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'sk-x', baseURL: 'https://gw/v1' } } },
      model: 'p/model/name',
    }))).toEqual({ provider: 'openai', model: 'model/name', baseUrl: 'https://gw/v1', apiKey: 'sk-x' });
  });
});
