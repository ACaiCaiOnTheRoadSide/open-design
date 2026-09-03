import type { McpServerConfig } from '../mcp-config.js';

export interface OhMyAgentMcpConfig { servers: Array<Record<string, unknown>> }

/** Shape verified against internal/mcp/client.go ServerConfig. */
export function buildOhMyAgentMcpConfig(
  servers: McpServerConfig[],
  tokens: Record<string, string> = {},
): OhMyAgentMcpConfig {
  const out: Array<Record<string, unknown>> = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    if (server.transport === 'stdio') {
      const command = server.command?.trim();
      if (!command) continue;
      out.push({
        name: server.id,
        transport: 'stdio',
        command,
        ...(server.args?.length ? { args: [...server.args] } : {}),
        ...(server.env && Object.keys(server.env).length ? { env: { ...server.env } } : {}),
        ...(server.disabledTools?.length ? { disabled_tools: [...server.disabledTools] } : {}),
      });
      continue;
    }
    const url = server.url?.trim();
    if (!url) continue;
    const headers = { ...(server.headers ?? {}) };
    if (tokens[server.id] && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization' && headers[key]?.trim())) {
      headers.Authorization = `Bearer ${tokens[server.id]}`;
    }
    out.push({
      name: server.id,
      // OpenDesign's http means MCP Streamable HTTP. OhMyAgent also supports
      // legacy sse, but hosted forwarding intentionally standardizes on the
      // requested streamable-http transport.
      transport: server.transport === 'http' ? 'streamable-http' : 'sse',
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(server.disabledTools?.length ? { disabled_tools: [...server.disabledTools] } : {}),
    });
  }
  return { servers: out };
}
