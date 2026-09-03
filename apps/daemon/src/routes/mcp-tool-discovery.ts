import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_TOOLS = 1_000;

export interface McpToolDiscoveryConfig {
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface DiscoveredMcpTool {
  name: string;
  description?: string;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, item]) => key.length > 0 && typeof item === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseConfig(value: unknown): McpToolDiscoveryConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.transport !== 'stdio' && raw.transport !== 'sse' && raw.transport !== 'http') return null;
  const args = raw.args === undefined
    ? undefined
    : Array.isArray(raw.args) && raw.args.every((item) => typeof item === 'string')
      ? raw.args as string[]
      : null;
  if (args === null || (args?.length ?? 0) > 128) return null;
  const config: McpToolDiscoveryConfig = { transport: raw.transport };
  if (raw.transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return null;
    config.command = raw.command.trim();
    if (args) config.args = args;
    const env = stringRecord(raw.env);
    if (raw.env !== undefined && !env) return null;
    if (env) config.env = env;
  } else {
    if (typeof raw.url !== 'string') return null;
    try {
      const url = new URL(raw.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      config.url = url.toString();
    } catch {
      return null;
    }
    const headers = stringRecord(raw.headers);
    if (raw.headers !== undefined && !headers) return null;
    if (headers) config.headers = headers;
  }
  return config;
}

function createTransport(config: McpToolDiscoveryConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command!,
      ...(config.args ? { args: config.args } : {}),
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: 'pipe',
    });
  }
  const url = new URL(config.url!);
  const requestInit = Object.keys(config.headers ?? {}).length
    ? { headers: config.headers! }
    : undefined;
  if (config.transport === 'sse') {
    return new SSEClientTransport(url, requestInit ? { requestInit } : {}) as unknown as Transport;
  }
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : {}) as unknown as Transport;
}

export async function discoverMcpTools(config: McpToolDiscoveryConfig): Promise<DiscoveredMcpTool[]> {
  const client = new Client({ name: 'open-design-tool-discovery', version: '1.0.0' });
  const transport = createTransport(config);
  try {
    await client.connect(transport, { timeout: DISCOVERY_TIMEOUT_MS });
    const tools: DiscoveredMcpTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: DISCOVERY_TIMEOUT_MS });
      if (tools.length + result.tools.length > MAX_TOOLS) {
        throw new Error(`MCP server returned too many tools (max ${MAX_TOOLS})`);
      }
      tools.push(...result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      })));
      cursor = result.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('MCP server returned a repeated tools cursor');
        seenCursors.add(cursor);
      }
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export interface McpToolDiscoveryRouteOptions {
  authorize: (authorization: string | undefined) => boolean;
}

export function registerMcpToolDiscoveryRoutes(
  app: Express,
  options: McpToolDiscoveryRouteOptions,
): void {
  app.post('/api/internal/mcp/discover-tools', async (req, res) => {
    if (!options.authorize(req.get('authorization'))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const config = parseConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'invalid MCP server configuration' });
      return;
    }
    try {
      const tools = await discoverMcpTools(config);
      res.json({ tools });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP tool discovery failed';
      res.status(502).json({ error: message });
    }
  });
}
