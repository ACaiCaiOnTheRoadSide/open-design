import { syncTargetFromEnv, type SyncTarget } from './sync/client.js';
import type { McpServerConfig, McpTransport } from './mcp-config.js';
import { requireRequestContext, type VerifiedPrincipal } from './request-context.js';

const TTL = 60_000;
const TIMEOUT = 5_000;
interface CacheEntry { value: McpServerConfig[]; at: number; failedAt: number; inFlight: Promise<McpServerConfig[]> | null }
const cache: CacheEntry = { value: [], at: 0, failedAt: 0, inFlight: null };
export interface PlatformMcpDeps { now: () => number; fetchImpl: typeof fetch; target: SyncTarget | null; principal?: VerifiedPrincipal }
const validTransport = (value: unknown): value is McpTransport => value === 'stdio' || value === 'sse' || value === 'http';

/**
 * Fetch the operator-controlled global MCP policy. A verified principal remains
 * mandatory and is forwarded as audit context, but it never scopes the result
 * or cache: enabled platform servers apply identically to every tenant.
 */
export async function getPlatformMcpServers(deps?: PlatformMcpDeps): Promise<McpServerConfig[]> {
  const principal = deps?.principal ?? requireRequestContext();
  if (!principal.tenantId || !principal.userId) throw new Error('Platform MCP requires a verified principal');
  const target = deps?.target ?? syncTargetFromEnv();
  if (!target) return [];
  const now = deps?.now ?? Date.now;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const timestamp = now();
  if (cache.at && timestamp - cache.at < TTL) return cache.value;
  if (cache.failedAt && timestamp - cache.failedAt < 5_000) return cache.value;
  if (cache.inFlight) return cache.inFlight;
  const once = async () => {
    const response = await fetchImpl(`${target.backendUrl}/api/internal/mcp-servers`, {
      headers: {
        authorization: `Bearer ${target.apiToken}`,
        'x-tenant-id': principal.tenantId,
        'x-od-user-id': principal.userId,
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) throw new Error(`platform MCP HTTP ${response.status}`);
    return response.json();
  };
  cache.inFlight = (async () => {
    try {
      let body: unknown;
      try { body = await once(); } catch (error) {
        if (error instanceof Error && / HTTP \d+$/u.test(error.message)) throw error;
        body = await once();
      }
      const servers = (body && typeof body === 'object' && Array.isArray((body as { servers?: unknown }).servers))
        ? (body as { servers: unknown[] }).servers : [];
      const value: McpServerConfig[] = [];
      for (const raw of servers) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== 'string' || !item.id || !validTransport(item.transport) || item.enabled === false) continue;
        const config: McpServerConfig = { id: item.id, transport: item.transport, enabled: true };
        if (Array.isArray(item.disabled_tools) && item.disabled_tools.every((tool) => typeof tool === 'string')) {
          config.disabledTools = [...new Set(item.disabled_tools as string[])];
        }
        if (typeof item.name === 'string') config.label = item.name;
        if (item.transport === 'stdio') {
          if (typeof item.command !== 'string' || !item.command) continue;
          config.command = item.command;
          if (Array.isArray(item.args) && item.args.every((arg) => typeof arg === 'string')) config.args = item.args as string[];
          if (item.env && typeof item.env === 'object') config.env = item.env as Record<string, string>;
        } else {
          if (typeof item.url !== 'string' || !item.url) continue;
          config.url = item.url;
          config.authMode = 'none';
          if (item.headers && typeof item.headers === 'object') config.headers = item.headers as Record<string, string>;
        }
        value.push(config);
      }
      cache.value = value; cache.at = now();
      return value;
    } catch {
      cache.failedAt = now();
      return cache.value;
    } finally { cache.inFlight = null; }
  })();
  return cache.inFlight;
}

export function __resetPlatformMcpCacheForTests(): void {
  cache.value = [];
  cache.at = 0;
  cache.failedAt = 0;
  cache.inFlight = null;
}
