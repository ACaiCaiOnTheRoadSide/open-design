import { describe, expect, it } from 'vitest';
import {
  buildOhMyAgentModelConfig,
  buildOhMyAgentModelConfigFromProviderConfig,
  ohmyagentProviderFromEnv,
  OHMYAGENT_API_KEY_ENV,
} from '../../src/runtimes/ohmyagent-config.js';
import { buildOhMyAgentMcpConfig } from '../../src/runtimes/ohmyagent-mcp.js';

describe('OhMyAgent secure runtime config conversion', () => {
  it('keeps BYOK API keys out of config/argv material', () => {
    const secret = 'sk-do-not-log';
    const result = buildOhMyAgentModelConfig({
      protocol: 'openai', apiKey: secret, baseUrl: 'https://proxy.example/v1', model: 'wire-model',
    }, 'wire-model');
    expect(result).toEqual({
      config: {
        name: 'open-design-runtime', type: 'openai-chat', model: 'wire-model',
        supports_images: true,
        base_url: 'https://proxy.example/v1', api_key: `env:${OHMYAGENT_API_KEY_ENV}`,
      },
      env: { [OHMYAGENT_API_KEY_ENV]: secret },
    });
    expect(JSON.stringify(result?.config)).not.toContain(secret);
  });

  it('converts the trusted backend provider config without exposing its key', () => {
    const secret = 'sk-platform-secret';
    const raw = JSON.stringify({
      provider: {
        platform: {
          npm: '@ai-sdk/openai',
          options: { apiKey: secret, baseURL: 'https://gateway.example/v1/' },
        },
      },
      model: 'platform/model/name',
    });
    const result = buildOhMyAgentModelConfigFromProviderConfig(raw, 'default');
    expect(result).toEqual({
      config: {
        name: 'open-design-runtime', type: 'openai-responses', model: 'model/name',
        supports_images: true,
        base_url: 'https://gateway.example/v1', api_key: `env:${OHMYAGENT_API_KEY_ENV}`,
      },
      env: { [OHMYAGENT_API_KEY_ENV]: secret },
    });
    expect(JSON.stringify(result?.config)).not.toContain(secret);
  });

  it.each([
    ['@ai-sdk/anthropic', 'anthropic'],
    ['@ai-sdk/openai-compatible', 'openai-chat'],
  ])('maps trusted provider package %s to %s', (npm, type) => {
    const result = buildOhMyAgentModelConfigFromProviderConfig(JSON.stringify({
      provider: { p: { npm, options: { apiKey: 'key', baseURL: 'https://gateway.example' } } },
      model: 'p/model',
    }), null);
    expect(result?.config.type).toBe(type);
  });

  it('rejects provider packages whose wire protocol OhMyAgent cannot represent', () => {
    expect(buildOhMyAgentModelConfigFromProviderConfig(JSON.stringify({
      provider: {
        google: {
          npm: '@ai-sdk/google',
          options: { apiKey: 'key', baseURL: 'https://generativelanguage.googleapis.com' },
        },
      },
      model: 'google/gemini-2.5-flash',
    }), null)).toBeNull();
  });

  it('uses a server-managed default when a run has no explicit BYOK provider', () => {
    const provider = ohmyagentProviderFromEnv({
      OD_OHMYAGENT_MODEL_PROTOCOL: 'anthropic',
      OD_OHMYAGENT_MODEL: 'managed-model',
      OD_OHMYAGENT_MODEL_BASE_URL: 'https://managed.example',
      OD_OHMYAGENT_MODEL_API_KEY: 'managed-key',
    });
    expect(buildOhMyAgentModelConfig(provider, 'default')).toEqual({
      config: {
        name: 'open-design-runtime', type: 'anthropic', model: 'managed-model',
        supports_images: true,
        base_url: 'https://managed.example', api_key: `env:${OHMYAGENT_API_KEY_ENV}`,
      },
      env: { [OHMYAGENT_API_KEY_ENV]: 'managed-key' },
    });
  });

  it('enables images for API-key-free runtime providers', () => {
    expect(buildOhMyAgentModelConfig({
      protocol: 'ollama', model: 'llava', baseUrl: 'http://localhost:11434',
      apiKey: '', requiresApiKey: false,
    }, 'default')?.config).toEqual({
      name: 'open-design-runtime', type: 'openai-chat', model: 'llava',
      supports_images: true, base_url: 'http://localhost:11434',
    });
  });

  it('converts stdio and HTTP MCP servers to OhMyAgent servers array', () => {
    const config = buildOhMyAgentMcpConfig([
      { id: 'local', enabled: true, transport: 'stdio', command: 'server', args: ['--x'], env: { TOKEN: 'env-secret' }, disabledTools: ['legacy_image'] },
      { id: 'remote', enabled: true, transport: 'http', url: 'https://mcp.test', headers: { 'X-Key': 'header-secret' }, disabledTools: ['admin_query'] },
    ]);
    expect(config).toEqual({ servers: [
      { name: 'local', transport: 'stdio', command: 'server', args: ['--x'], env: { TOKEN: 'env-secret' }, disabled_tools: ['legacy_image'] },
      { name: 'remote', transport: 'streamable-http', url: 'https://mcp.test', headers: { 'X-Key': 'header-secret' }, disabled_tools: ['admin_query'] },
    ] });
    // Secrets belong to the protected config file/env channel, never command args.
    expect(JSON.stringify(config)).not.toContain('OPENCODE_CONFIG_CONTENT');
  });
});
