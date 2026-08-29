import { randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { startServer, type StartServerResult } from '../src/server.js';
import {
  MEDIA_GENERATE_TOOL_ENDPOINT,
  MEDIA_TASK_WAIT_TOOL_ENDPOINT,
  toolTokenRegistry,
} from '../src/tool-tokens.js';

const daemonApiToken = 'media-nonloopback-daemon-api-token';

type StartedServer = Pick<StartServerResult, 'server' | 'shutdown' | 'url'>;

function isStartedServer(value: unknown): value is StartedServer {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'server') === 'object'
    && typeof Reflect.get(value, 'shutdown') === 'function'
    && typeof Reflect.get(value, 'url') === 'string';
}

async function reachableNonLoopbackIpv4(): Promise<string> {
  const candidates: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) candidates.push(address.address);
    }
  }
  const failures: string[] = [];
  for (const address of [...new Set(candidates)].sort()) {
    const probe = http.createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, address, resolve);
      });
      const bound = probe.address();
      if (!bound || typeof bound === 'string') throw new Error('probe did not bind a TCP port');
      const response = await fetch(`http://${address}:${bound.port}`);
      if (response.status === 204) return address;
      failures.push(`${address}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }
  throw new Error(`no reachable non-loopback IPv4 interface: ${failures.join('; ')}`);
}

describe('media non-loopback run-scoped authority', () => {
  let daemon: StartedServer;
  const projectId = `project_${randomUUID()}`;

  beforeAll(async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required by the daemon test harness');
    const db = openDatabase(process.cwd(), { dataDir });
    const now = Date.now();
    insertProject(db, {
      id: projectId,
      name: 'Non-loopback media token project',
      createdAt: now,
      updatedAt: now,
    });

    vi.stubEnv('OD_API_TOKEN', daemonApiToken);
    const started = await startServer({
      port: 0,
      host: await reachableNonLoopbackIpv4(),
      returnServer: true,
    });
    if (!isStartedServer(started)) throw new Error('daemon did not return its server handle');
    daemon = started;
    vi.stubEnv('OD_API_TOKEN', 'changed-after-server-start');
  });

  afterAll(async () => {
    toolTokenRegistry.clear();
    if (daemon) {
      await daemon.shutdown();
      daemon.server.closeAllConnections?.();
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
    }
    closeDatabase();
    vi.unstubAllEnvs();
  });

  it.each([
    [MEDIA_GENERATE_TOOL_ENDPOINT, { surface: 'invalid' }, 400, 'BAD_REQUEST'],
    ['/api/media/tasks/missing-task/wait', { since: 0 }, 404, undefined],
  ] as const)('admits a valid media grant to POST %s', async (pathname, body, status, code) => {
    const token = toolTokenRegistry.mint({
      projectId,
      runId: `run_${randomUUID()}`,
    }).token;

    const response = await post(pathname, token, body);
    const responseBody = await response.json();

    expect(response.status).toBe(status);
    expect(responseBody).not.toMatchObject({ error: { code: 'API_TOKEN_REQUIRED' } });
    if (code) expect(responseBody).toMatchObject({ error: { code } });
  });

  it.each([
    ['generate endpoint', MEDIA_GENERATE_TOOL_ENDPOINT, MEDIA_TASK_WAIT_TOOL_ENDPOINT, 'media:generate'],
    ['generate operation', MEDIA_GENERATE_TOOL_ENDPOINT, MEDIA_GENERATE_TOOL_ENDPOINT, 'research:search'],
    ['wait endpoint', '/api/media/tasks/missing-task/wait', MEDIA_GENERATE_TOOL_ENDPOINT, 'media:generate'],
    ['wait operation', '/api/media/tasks/missing-task/wait', MEDIA_TASK_WAIT_TOOL_ENDPOINT, 'research:search'],
  ] as const)('rejects a token with the wrong %s at the outer API boundary', async (
    _case,
    pathname,
    allowedEndpoint,
    allowedOperation,
  ) => {
    const token = toolTokenRegistry.mint({
      projectId,
      runId: `run_${randomUUID()}`,
      allowedEndpoints: [allowedEndpoint],
      allowedOperations: [allowedOperation],
    }).token;

    const response = await post(pathname, token, {});

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'API_TOKEN_REQUIRED' },
    });
  });

  it.each([
    ['GET', MEDIA_GENERATE_TOOL_ENDPOINT],
    ['GET', '/api/media/tasks/missing-task/wait'],
    ['POST', `${MEDIA_GENERATE_TOOL_ENDPOINT}/extra`],
    ['POST', '/api/media/tasks/missing-task/wait/extra'],
  ] as const)('does not extend media authority to %s %s', async (method, pathname) => {
    const token = toolTokenRegistry.mint({
      projectId,
      runId: `run_${randomUUID()}`,
    }).token;
    const response = await fetch(`${daemon.url}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'API_TOKEN_REQUIRED' },
    });
  });

  it('preserves the broad daemon API-token lane', async () => {
    const response = await post(MEDIA_GENERATE_TOOL_ENDPOINT, daemonApiToken, { surface: 'invalid' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'TOOL_TOKEN_INVALID' },
    });
  });

  async function post(pathname: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${daemon.url}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
});
