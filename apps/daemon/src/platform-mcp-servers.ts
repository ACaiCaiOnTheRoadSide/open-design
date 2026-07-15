// Platform-level MCP servers — admin-configured servers that apply to ALL
// tenants, fetched from the Go backend's internal API.
//
// Mirrors the caching pattern of `platform-default-provider-config.ts`:
// 60s TTL, 5s failure backoff, single-retry on transport error, deduped
// in-flight. The daemon merges these into the per-run external MCP config
// at spawn time so every agent runtime (Claude Code, OpenCode, ACP) picks
// them up through the existing injection paths.

import { syncTargetFromEnv, type SyncTarget } from './sync/client.js';
import type { McpServerConfig, McpTransport } from './mcp-config.js';

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_MS = 5_000;

const MCP_SERVERS_PATH = '/api/internal/mcp-servers';

export interface PlatformMcpDeps {
  now: () => number;
  fetchImpl: typeof fetch;
  target: SyncTarget | null;
}

function realDeps(): PlatformMcpDeps {
  return {
    now: () => Date.now(),
    fetchImpl: fetch,
    target: syncTargetFromEnv(),
  };
}

interface DaemonMcpServer {
  id: string;
  name?: string;
  transport: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

async function requestOnce(
  deps: PlatformMcpDeps,
  target: SyncTarget,
): Promise<unknown> {
  const resp = await deps.fetchImpl(`${target.backendUrl}${MCP_SERVERS_PATH}`, {
    headers: { authorization: `Bearer ${target.apiToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`${MCP_SERVERS_PATH} HTTP ${resp.status}`);
  return resp.json();
}

async function requestWithRetry(deps: PlatformMcpDeps): Promise<unknown> {
  const target = deps.target;
  if (!target) return null;
  try {
    return await requestOnce(deps, target);
  } catch (err) {
    if (err instanceof Error && / HTTP \d+$/.test(err.message)) throw err;
    return await requestOnce(deps, target);
  }
}

interface CacheSlot<T> {
  cache: { value: T; fetchedAtMs: number } | null;
  lastFailedAtMs: number;
  inFlight: Promise<T> | null;
}

function newSlot<T>(): CacheSlot<T> {
  return { cache: null, lastFailedAtMs: 0, inFlight: null };
}

async function resolveSlot<T>(
  slot: CacheSlot<T>,
  deps: PlatformMcpDeps,
  fetchFn: (deps: PlatformMcpDeps) => Promise<T>,
  coldValue: T,
): Promise<T> {
  const nowMs = deps.now();
  if (slot.cache && nowMs - slot.cache.fetchedAtMs < CACHE_TTL_MS) return slot.cache.value;
  if (slot.cache && nowMs - slot.lastFailedAtMs < FAILURE_BACKOFF_MS) return slot.cache.value;
  if (slot.inFlight) return slot.inFlight;
  slot.inFlight = (async () => {
    try {
      const value = await fetchFn(deps);
      slot.cache = { value, fetchedAtMs: deps.now() };
      return value;
    } catch {
      slot.lastFailedAtMs = deps.now();
      if (slot.cache) return slot.cache.value;
      return coldValue;
    } finally {
      slot.inFlight = null;
    }
  })();
  return slot.inFlight;
}

const mcpSlot = newSlot<McpServerConfig[]>();

function isValidTransport(t: unknown): t is McpTransport {
  return t === 'stdio' || t === 'sse' || t === 'http';
}

async function fetchPlatformMcpServers(deps: PlatformMcpDeps): Promise<McpServerConfig[]> {
  const body = await requestWithRetry(deps);
  if (!body || typeof body !== 'object') return [];
  const wrapper = body as { servers?: unknown };
  const list = Array.isArray(wrapper.servers) ? wrapper.servers : [];
  const out: McpServerConfig[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as DaemonMcpServer;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    if (!isValidTransport(entry.transport)) continue;
    const config: McpServerConfig = {
      id: entry.id,
      label: typeof entry.name === 'string' ? entry.name : undefined,
      transport: entry.transport,
      enabled: entry.enabled !== false,
    };
    if (entry.transport === 'stdio') {
      if (typeof entry.command !== 'string' || !entry.command) continue;
      config.command = entry.command;
      if (Array.isArray(entry.args)) config.args = entry.args;
      if (entry.env && typeof entry.env === 'object') config.env = entry.env;
    } else {
      if (typeof entry.url !== 'string' || !entry.url) continue;
      config.url = entry.url;
      config.authMode = 'none';
      if (entry.headers && typeof entry.headers === 'object') {
        config.headers = entry.headers;
      }
    }
    out.push(config);
  }
  return out;
}

/**
 * Admin-configured platform MCP servers, or empty when none configured /
 * backend unreachable. Cached 60s; stale-on-failure.
 */
export async function getPlatformMcpServers(
  deps: PlatformMcpDeps = realDeps(),
): Promise<McpServerConfig[]> {
  return resolveSlot(mcpSlot, deps, fetchPlatformMcpServers, []);
}

export function __resetPlatformMcpCacheForTests(): void {
  mcpSlot.cache = null;
  mcpSlot.lastFailedAtMs = 0;
  mcpSlot.inFlight = null;
}
