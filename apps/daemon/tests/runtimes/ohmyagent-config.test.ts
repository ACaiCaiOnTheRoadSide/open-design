import { describe, expect, it } from 'vitest';
import { buildOhMyAgentModelConfig, OHMYAGENT_API_KEY_ENV } from '../../src/runtimes/ohmyagent-config.js';
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
        base_url: 'https://proxy.example/v1', api_key: `env:${OHMYAGENT_API_KEY_ENV}`,
      },
      env: { [OHMYAGENT_API_KEY_ENV]: secret },
    });
    expect(JSON.stringify(result?.config)).not.toContain(secret);
  });

  it('converts stdio and HTTP MCP servers to OhMyAgent servers array', () => {
    const config = buildOhMyAgentMcpConfig([
      { id: 'local', enabled: true, transport: 'stdio', command: 'server', args: ['--x'], env: { TOKEN: 'env-secret' } },
      { id: 'remote', enabled: true, transport: 'http', url: 'https://mcp.test', headers: { 'X-Key': 'header-secret' } },
    ]);
    expect(config).toEqual({ servers: [
      { name: 'local', transport: 'stdio', command: 'server', args: ['--x'], env: { TOKEN: 'env-secret' } },
      { name: 'remote', transport: 'streamable-http', url: 'https://mcp.test', headers: { 'X-Key': 'header-secret' } },
    ] });
    // Secrets belong to the protected config file/env channel, never command args.
    expect(JSON.stringify(config)).not.toContain('OPENCODE_CONFIG_CONTENT');
  });
});
