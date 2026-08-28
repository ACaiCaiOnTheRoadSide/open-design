import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { huskboxExecutionConfigFromEnv, type HuskboxExecutionConfig } from '../../../src/runtimes/execution/huskbox-config.js';
import {
  HUSKBOX_BOOTSTRAP_SCRIPT,
  HuskboxExecutionError,
  HuskboxExecutionTransport,
  createHuskboxSandboxEnv,
} from '../../../src/runtimes/execution/huskbox-transport.js';

const config: HuskboxExecutionConfig = {
  baseUrl: 'https://huskbox.test', apiKey: 'secret-key', image: 'registry.test/ohmyagent:latest',
  sandboxMount: '/workspace', daemonMount: '/data',
  daemonPublicUrl: 'https://daemon.test', backendPublicUrl: 'https://backend.test',
  retryMaxAttempts: 3, retryBaseMs: 1, requestTimeoutMs: 20,
};

function sse(...events: Array<[string, unknown]>): Response {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  let output = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { output += String(chunk); });
  await once(stream, 'end');
  return output;
}

function execute(fetcher: typeof fetch, stdin: 'pipe' | 'ignore' = 'ignore', options: Record<string, unknown> = {}) {
  const transport = new HuskboxExecutionTransport(config, { fetcher, sleep: async () => {}, ...options });
  return transport.execute({ command: 'agent', args: ['--json'], cwd: '/data/projects/p1', env: { LANG: 'zh_CN.UTF-8', TOKEN: 'ambient-drop' }, remoteEnv: { ARBITRARY_SECRET: 'drop' }, stdin });
}

describe('HuskboxExecutionTransport', () => {
  it('does not require or forward tenant config and leaves image empty for the platform default', () => {
    const parsed = huskboxExecutionConfigFromEnv({
      OD_HUSKBOX_BASE_URL: 'https://huskbox.test/',
      OD_HUSKBOX_API_KEY: ' secret ',
      OD_HUSKBOX_TENANT_ID: 'legacy-ignored',
      OD_HUSKBOX_IMAGE: '  ',
    });
    expect(parsed).toMatchObject({ baseUrl: 'https://huskbox.test', apiKey: 'secret' });
    expect(parsed).not.toHaveProperty('tenantId');
    expect(parsed).not.toHaveProperty('image');
  });

  it('sends the OpenAPI snake_case request without a tenant header and streams output', async () => {
    let requestBody: any;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      expect(init?.method).toBe('POST');
      expect(String(_url)).toBe('https://huskbox.test/openapi/v1/executions/stream');
      expect(new Headers(init?.headers).get('X-Huskbox-Tenant-ID')).toBeNull();
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-key');
      return sse(
        ['started', { id: 'exec-1', status: 'running' }],
        ['stdout', { id: 'exec-1', data: '你好' }],
        ['stderr', { id: 'exec-1', data: 'warn' }],
        ['completed', { id: 'exec-1', status: 'succeeded', exit_code: 0, timed_out: false }],
      );
    }) as typeof fetch;
    const handle = execute(fetcher);
    const [stdout, stderr, result] = await Promise.all([read(handle.stdout), read(handle.stderr), handle.result]);
    expect(stdout).toBe('你好');
    expect(stderr).toBe('warn');
    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(handle.pid).toBeNull();
    expect(requestBody).toMatchObject({ cmd: ['bash', '-c', expect.any(String), 'bash', 'agent', '--json'], env: { LANG: 'zh_CN.UTF-8' } });
    expect(requestBody.env.TOKEN).toBeUndefined();
    expect(requestBody.env.ARBITRARY_SECRET).toBeUndefined();
    expect(requestBody).toHaveProperty('idempotency_key');
    expect(requestBody).toHaveProperty('image', 'registry.test/ohmyagent:latest');
    expect(requestBody).not.toHaveProperty('idempotencyKey');
  });

  it('dispatches the actual ohmyagent headless command and stages protected configs in bootstrap', async () => {
    let body: any;
    const fetcher = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse(['started', { id: 'oma' }], ['completed', { id: 'oma', status: 'succeeded', exit_code: 0 }]);
    }) as typeof fetch;
    const transport = new HuskboxExecutionTransport(config, { fetcher });
    const handle = transport.execute({
      command: 'ohmyagent',
      args: ['--output-format', 'json', '--permission-mode', 'bypassPermissions', '--cwd', '/workspace/projects/p1'],
      cwd: '/data/projects/p1',
      remoteEnv: {
        OD_OHMYAGENT_MODEL_CONFIG_B64: Buffer.from('{}').toString('base64'),
        OD_OHMYAGENT_MODEL_CONFIG_PATH: '/workspace/.od/tmp/model.json',
      },
      stdin: 'pipe',
    });
    handle.endStdin('prompt');
    await handle.result;
    expect(body.cmd).toEqual([
      'bash', '-c', HUSKBOX_BOOTSTRAP_SCRIPT, 'bash', 'ohmyagent',
      '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--cwd', '/workspace/projects/p1',
    ]);
    expect(body.stdin).toBe('prompt');
    expect(HUSKBOX_BOOTSTRAP_SCRIPT).toContain('OD_OHMYAGENT_MODEL_CONFIG_B64');
  });

  it('buffers remote stdin until endStdin', async () => {
    let body: any;
    const fetcher = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse(['started', { id: 'e' }], ['completed', { id: 'e', status: 'succeeded', exit_code: 0 }]);
    }) as typeof fetch;
    const handle = execute(fetcher, 'pipe');
    handle.writeStdin('pro');
    expect(fetcher).not.toHaveBeenCalled();
    handle.endStdin('mpt');
    await handle.result;
    expect(body.stdin).toBe('prompt');
    expect(body.env.OD_STDIN_LEN).toBe('6');
  });

  it('retries pre-ack 429/network failures with one stable idempotency key', async () => {
    const keys: string[] = [];
    let attempt = 0;
    const fetcher = vi.fn(async (_url, init) => {
      keys.push(JSON.parse(String(init?.body)).idempotency_key);
      attempt++;
      if (attempt === 1) return new Response(JSON.stringify({ code: 'RESOURCE_EXHAUSTED', message: 'busy', trace_id: 'trace-busy', data: { retry_after: 1 } }), { status: 429 });
      if (attempt === 2) throw new TypeError('socket reset');
      return sse(['started', { id: 'e3' }], ['completed', { id: 'e3', status: 'succeeded', exit_code: 0 }]);
    }) as typeof fetch;
    const handle = execute(fetcher);
    const stderr = read(handle.stderr);
    await expect(handle.result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(await stderr).toContain('[od-retry]');
  });

  it('retries retryable HTTP 500 responses', async () => {
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      attempts++;
      if (attempts === 1) return Response.json({ code: 'UNAVAILABLE', message: 'try again' }, { status: 500 });
      return sse(['started', { id: 'ok' }], ['completed', { id: 'ok', status: 'succeeded', exit_code: 0 }]);
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(attempts).toBe(2);
  });

  it('accepts a terminal idempotency replay that completes without a started event', async () => {
    const fetcher = vi.fn(async () => sse(
      ['completed', { id: 'terminal-replay', status: 'succeeded', exit_code: 0, timed_out: false }],
    )) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.started).resolves.toBeUndefined();
    await expect(handle.result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recovers EXECUTION_IN_PROGRESS with an error data id through enveloped GET without re-POSTing', async () => {
    let posts = 0;
    let gets = 0;
    const fetcher = vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return Response.json({
          code: 'EXECUTION_IN_PROGRESS', message: 'already running', trace_id: 'trace-409', data: { id: 'existing' },
        }, { status: 409 });
      }
      gets++;
      expect(String(url)).toBe('https://huskbox.test/openapi/v1/executions/existing');
      return Response.json({ code: 0, message: 'ok', data: { id: 'existing', status: 'succeeded', exit_code: 0 } });
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(posts).toBe(1);
    expect(gets).toBe(1);
  });

  it('retries a bounded EXECUTION_IN_PROGRESS without an id using the same key', async () => {
    const keys: string[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      keys.push(JSON.parse(String(init?.body)).idempotency_key);
      return Response.json({ code: 'EXECUTION_IN_PROGRESS', message: 'already running', data: {} }, { status: 409 });
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toMatchObject({
      exitCode: 127,
      error: expect.objectContaining({ code: 'EXECUTION_IN_PROGRESS' }),
    });
    expect(keys).toHaveLength(config.retryMaxAttempts);
    expect(new Set(keys).size).toBe(1);
  });

  it('treats IDEMPOTENCY_KEY_REUSED and unrelated 409 errors as permanent and preserves flat error fields', async () => {
    for (const code of ['IDEMPOTENCY_KEY_REUSED', 'CONFLICT']) {
      const fetcher = vi.fn(async () => Response.json({
        code, message: 'permanent conflict', trace_id: 'trace-permanent', data: { reason: 'different request' },
      }, { status: 409 })) as typeof fetch;
      const handle = execute(fetcher);
      await expect(handle.result).resolves.toMatchObject({
        exitCode: 127,
        error: expect.objectContaining({
          code,
          details: expect.objectContaining({
            status: 409, retryable: false, trace_id: 'trace-permanent', data: { reason: 'different request' },
          }),
        }),
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps reading after completed and reports a following post-processing error', async () => {
    const fetcher = vi.fn(async () => sse(
      ['started', { id: 'post' }],
      ['completed', { id: 'post', status: 'succeeded', exit_code: 0 }],
      ['error', { id: 'post', error: { code: 'POST_PROCESSING_FAILED', message: 'wallet confirmation failed' }, trace_id: 'trace-post' }],
    )) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toMatchObject({
      exitCode: 127,
      error: expect.objectContaining({ code: 'POST_PROCESSING_FAILED' }),
    });
  });

  it('completes from a succeeded probe after a started-only dropped stream without re-POSTing', async () => {
    let posts = 0;
    let probes = 0;
    const fetcher = vi.fn(async (_url, init) => {
      if (init?.method !== 'POST') {
        probes++;
        return Response.json({ code: 0, message: 'ok', data: { id: 'first', status: 'succeeded', exit_code: 0, timed_out: false } });
      }
      posts++;
      return sse(['started', { id: 'first', status: 'running' }]);
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(posts).toBe(1);
    expect(probes).toBe(1);
  });

  it('does not retry a dropped stream after partial stdout and probes status', async () => {
    let posts = 0;
    let probes = 0;
    const fetcher = vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return sse(['started', { id: 'partial' }], ['stdout', { id: 'partial', data: 'part' }]);
      }
      probes++;
      expect(String(url)).toBe('https://huskbox.test/openapi/v1/executions/partial');
      return Response.json({ code: 0, message: 'ok', data: { id: 'partial', status: 'failed', exit_code: 1 } });
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toMatchObject({ exitCode: 1 });
    expect(posts).toBe(1);
    expect(probes).toBe(1);
  });

  it.each([
    [{ id: 'e', status: 'failed', exit_code: 7, error: { code: 'WORKER_FAILED', message: 'boom' } }, 7, 'WORKER_FAILED'],
    [{ id: 'e', status: 'timed_out', timed_out: true }, 124, 'EXECUTION_TIMEOUT'],
  ] as const)('does not re-POST an acknowledged dropped execution probed as %s', async (probe, exitCode, code) => {
    let posts = 0;
    let gets = 0;
    const fetcher = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return sse(['started', { id: 'e', status: 'running' }]);
      }
      gets++;
      return Response.json({ code: 0, message: 'ok', data: probe });
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toMatchObject({
      exitCode,
      error: expect.objectContaining({ code }),
    });
    expect(posts).toBe(1);
    expect(gets).toBe(1);
  });

  it('polls the same acknowledged execution until terminal without re-POSTing', async () => {
    let posts = 0;
    let gets = 0;
    const fetcher = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return sse(['started', { id: 'poll-success', status: 'running' }]);
      }
      gets++;
      if (gets === 1) return Response.json({ code: 0, message: 'ok', data: { id: 'poll-success', status: 'pending' } });
      if (gets === 2) return Response.json({ code: 0, message: 'ok', data: { id: 'poll-success', status: 'running' } });
      return Response.json({ code: 0, message: 'ok', data: { id: 'poll-success', status: 'succeeded', exit_code: 0 } });
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(posts).toBe(1);
    expect(gets).toBe(3);
  });

  it('returns structured status timeout with the last remote state and never re-POSTs', async () => {
    let posts = 0;
    let gets = 0;
    const fetcher = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return sse(['started', { id: 'poll-timeout', status: 'running' }]);
      }
      gets++;
      return Response.json({ code: 0, message: 'ok', data: { id: 'poll-timeout', status: gets === 1 ? 'pending' : 'running' } });
    }) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toMatchObject({
      exitCode: 127,
      error: expect.objectContaining({
        code: 'EXECUTION_STATUS_TIMEOUT',
        details: expect.objectContaining({ executionId: 'poll-timeout', remoteStatus: 'running' }),
      }),
    });
    expect(posts).toBe(1);
    expect(gets).toBe(config.retryMaxAttempts);
  });

  it('maps an SSE error event to a structured non-retryable failure', async () => {
    const fetcher = vi.fn(async () => sse(
      ['started', { id: 'bad' }],
      ['error', { id: 'bad', error: { code: 'WORKER_LOST', message: 'worker disappeared' } }],
    )) as typeof fetch;
    const handle = execute(fetcher);
    await expect(handle.result).resolves.toMatchObject({
      exitCode: 127,
      error: expect.objectContaining({ code: 'WORKER_LOST', message: 'worker disappeared' }),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('maps timeout, structured error, and missing exit code', async () => {
    const cases = [
      [{ id: 't', status: 'timed_out', timed_out: true }, 124, 'EXECUTION_TIMEOUT'],
      [{ id: 'f', status: 'failed', exit_code: 9, error: { code: 'WORKER_FAILED', message: 'boom' } }, 9, 'WORKER_FAILED'],
      [{ id: 'm', status: 'failed' }, 127, 'EXECUTION_FAILED'],
    ] as const;
    for (const [completed, exitCode, code] of cases) {
      const handle = execute(vi.fn(async () => sse(['started', { id: completed.id }], ['completed', completed])) as typeof fetch);
      await expect(handle.result).resolves.toMatchObject({ exitCode, ...(exitCode ? { error: expect.objectContaining({ code }) } : {}) });
    }
  });

  it('cancels the in-flight request with AbortController and never exposes a process', async () => {
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const handle = execute(fetcher);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect('childProcess' in handle).toBe(false);
    await expect(handle.cancel()).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('filters executor secrets, maps paths, and preserves pull -> command -> push bootstrap order', async () => {
    const mapped = createHuskboxSandboxEnv({
      command: 'agent', cwd: '/data/projects/p42',
      env: { OD_HUSKBOX_API_KEY: 'leak', OD_API_TOKEN: 'leak', OD_PRINCIPAL_USER_ID: 'u', SAFE: 'ambient-drop' },
      remoteEnv: { ARBITRARY_SECRET: 'drop', OD_TOOL_TOKEN: 'trusted-run-tool-token' },
    }, config);
    expect(mapped).toMatchObject({ projectId: 'p42', env: { OD_TOOL_TOKEN: 'trusted-run-tool-token', OD_AGENT_CWD: '/workspace/projects/p42', OD_PROJECT_ID: 'p42' } });
    expect(mapped.env.ARBITRARY_SECRET).toBeUndefined();
    expect(mapped.env.OD_HUSKBOX_API_KEY).toBeUndefined();
    expect(mapped.env.OD_API_TOKEN).toBeUndefined();
    const pull = HUSKBOX_BOOTSTRAP_SCRIPT.indexOf('sync pull');
    const command = HUSKBOX_BOOTSTRAP_SCRIPT.indexOf('"$@"');
    const push = HUSKBOX_BOOTSTRAP_SCRIPT.indexOf('sync push');
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(command);
    expect(command).toBeLessThan(push);
  });

  it('strictly drops ambient database/cloud/principal secrets and forces writable sandbox paths', () => {
    const mapped = createHuskboxSandboxEnv({
      command: 'ohmyagent', cwd: '/data/projects/p42',
      env: {
        OD_PG_PASSWORD: 'pg-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
        VOLCENGINE_ACCESS_KEY: 'cloud-secret', OD_HUSKBOX_API_KEY: 'executor-secret',
        OD_API_TOKEN: 'master', OD_PRINCIPAL_USER_ID: 'principal', UNKNOWN_SECRET: 'unknown',
        HOME: '/root', XDG_CONFIG_HOME: '/root/.config', XDG_CACHE_HOME: '/root/.cache',
        PATH: '/host/bin', OPEN_DESIGN_OHMYAGENT_API_KEY: 'ambient-key-must-drop',
      },
      remoteEnv: {
        ARBITRARY_SECRET: 'arbitrary', AWS_SECRET_ACCESS_KEY: 'remote-aws',
        DATABASE_URL: 'remote-db', OD_SYNC_TOKEN: 'untrusted-sync-token',
        HOME: '/remote/home', XDG_CONFIG_HOME: '/remote/xdg',
        PATH: '/remote/bin', OPEN_DESIGN_OHMYAGENT_API_KEY: 'run-key',
        OD_OHMYAGENT_MODEL_CONFIG_B64: 'model-b64',
        OD_OHMYAGENT_MCP_CONFIG_B64: 'mcp-b64',
        OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
        OPEN_DESIGN_BYOK_API_KEY: 'byok-key',
      },
    }, config).env;
    expect(mapped).toMatchObject({
      HOME: '/home/sandbox', XDG_CONFIG_HOME: '/home/sandbox/.config',
      XDG_CACHE_HOME: '/home/sandbox/.cache', PATH: '/usr/local/bin:/usr/bin:/bin',
      OHMYAGENT_CONFIG_DIR: '/workspace/.od/ohmyagent',
      OPEN_DESIGN_OHMYAGENT_API_KEY: 'run-key',
      OD_OHMYAGENT_MODEL_CONFIG_B64: 'model-b64',
      OD_OHMYAGENT_MCP_CONFIG_B64: 'mcp-b64',
      OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
      OPEN_DESIGN_BYOK_API_KEY: 'byok-key',
    });
    for (const key of ['OD_PG_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'VOLCENGINE_ACCESS_KEY',
      'OD_HUSKBOX_API_KEY', 'OD_API_TOKEN', 'OD_PRINCIPAL_USER_ID', 'UNKNOWN_SECRET',
      'ARBITRARY_SECRET', 'DATABASE_URL', 'OD_SYNC_TOKEN']) {
      expect(mapped[key]).toBeUndefined();
    }
  });

  it('runs prepare before dispatch and hydrate after completed but before result', async () => {
    const order: string[] = [];
    const workspaceService = {
      prepare: () => { order.push('prepare'); },
      hydrateAfterExecution: async () => { order.push('hydrate'); },
    };
    const fetcher = vi.fn(async () => { order.push('dispatch'); return sse(['started', { id: 'e' }], ['completed', { id: 'e', status: 'succeeded', exit_code: 0 }]); }) as typeof fetch;
    const handle = execute(fetcher, 'ignore', { workspaceService });
    await handle.result;
    order.push('result');
    expect(order).toEqual(['prepare', 'dispatch', 'hydrate', 'result']);
  });
});
