import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  discoverMcpTools,
  registerMcpToolDiscoveryRoutes,
} from '../src/routes/mcp-tool-discovery.js';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/mcp-tool-discovery-server.mjs',
);

describe('MCP tool discovery', () => {
  it('connects to a stdio server and returns names and descriptions', async () => {
    const tools = await discoverMcpTools({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });

    expect(tools).toEqual([
      { name: 'text_to_image', description: 'Generate an image' },
      { name: 'image_to_image' },
    ]);
  });

  it('requires route-specific authorization before starting discovery', async () => {
    const app = express();
    app.use(express.json());
    registerMcpToolDiscoveryRoutes(app, {
      authorize: (authorization) => authorization === 'Bearer daemon-token',
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/internal/mcp/discover-tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transport: 'stdio',
          command: process.execPath,
          args: [fixture],
        }),
      });
      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
