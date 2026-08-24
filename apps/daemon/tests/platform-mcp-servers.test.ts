import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPlatformMcpCacheForTests, getPlatformMcpServers } from '../src/platform-mcp-servers.js';

beforeEach(() => __resetPlatformMcpCacheForTests());

describe('global platform MCP', () => {
  it('requires verified audit context but shares one global result across tenants', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ servers: [{
      id: 'platform-global', name: 'global', transport: 'http', url: 'https://platform.example/mcp', enabled: true,
    }] }), { status: 200 }));
    const base = { now: () => 10, fetchImpl: fetchImpl as typeof fetch, target: { backendUrl: 'https://backend', apiToken: 'token' } };
    const a = await getPlatformMcpServers({ ...base, principal: { tenantId: 'tenant-a', userId: 'user-a' } });
    const b = await getPlatformMcpServers({ ...base, principal: { tenantId: 'tenant-b', userId: 'user-b' } });
    expect(a.map((item) => item.id)).toEqual(['platform-global']);
    expect(b.map((item) => item.id)).toEqual(['platform-global']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('x-tenant-id')).toBe('tenant-a');
    expect(headers.get('x-od-user-id')).toBe('user-a');
  });

  it('drops disabled and malformed backend entries', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ servers: [
      { id: 'off', transport: 'http', url: 'https://x', enabled: false },
      { id: 'bad', transport: 'http', enabled: true },
      { id: 'ok', transport: 'stdio', command: 'node', args: ['server.js'], enabled: true },
    ] }), { status: 200 }));
    const result = await getPlatformMcpServers({
      now: () => 1, fetchImpl: fetchImpl as typeof fetch,
      target: { backendUrl: 'https://backend', apiToken: 'token' },
      principal: { tenantId: 'tenant', userId: 'user' },
    });
    expect(result.map((item) => item.id)).toEqual(['ok']);
  });
});
