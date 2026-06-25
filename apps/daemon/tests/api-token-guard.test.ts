// Plan §3.K1 / spec §15.7 — bound-API-token guard.
//
// Two halves:
//   1. The daemon refuses to start with OD_BIND_HOST=0.0.0.0 when no
//      OD_API_TOKEN is set.
//   2. When OD_API_TOKEN is set, every /api/* request from a non-loopback
//      peer must carry `Authorization: Bearer <OD_API_TOKEN>`. The
//      health/readiness/version probes stay open for monitoring.
//
// Tests force the bearer-required code path by stamping the env vars
// before startServer. The daemon listens on 127.0.0.1 throughout (so
// the "refuse 0.0.0.0 without token" path is exercised by a separate
// negative case that constructs the start call directly).

import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import {
  decideBoundApiTokenGuard,
  TOOL_TOKEN_GUARD_BYPASS_ENDPOINTS,
  type ApiTokenGuardInput,
} from '../src/api-token-guard.js';
import { toolTokenRegistry } from '../src/tool-tokens.js';

const PREVIOUS_TOKEN = process.env.OD_API_TOKEN;
const PREVIOUS_HOST  = process.env.OD_BIND_HOST;

let server: http.Server | undefined;
let baseUrl = '';
let shutdown: (() => Promise<void> | void) | undefined;

afterEach(async () => {
  if (shutdown) await Promise.resolve(shutdown());
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  shutdown = undefined;
  if (PREVIOUS_TOKEN === undefined) delete process.env.OD_API_TOKEN;
  else process.env.OD_API_TOKEN = PREVIOUS_TOKEN;
  if (PREVIOUS_HOST === undefined) delete process.env.OD_BIND_HOST;
  else process.env.OD_BIND_HOST = PREVIOUS_HOST;
});

describe('bound-API-token guard', () => {
  it('refuses to start with OD_BIND_HOST=0.0.0.0 when OD_API_TOKEN is unset', async () => {
    delete process.env.OD_API_TOKEN;
    await expect(startServer({ port: 0, host: '0.0.0.0', returnServer: true }))
      .rejects.toThrow(/OD_API_TOKEN/);
  });

  it('starts on a public host when OD_API_TOKEN is set', async () => {
    process.env.OD_API_TOKEN = 'test-token-abc';
    // Bind to 127.0.0.1 (loopback) but pretend we crossed the guard
    // by setting the env var; the assertion is that startup succeeds.
    const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    server = started.server;
    shutdown = started.shutdown;
    baseUrl = started.url;
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

describe('bearer middleware', () => {
  beforeEach(async () => {
    process.env.OD_API_TOKEN = 'secret-test-token';
    const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  it('accepts loopback callers without a bearer (desktop UI flow)', async () => {
    // The HTTP test client is on the same machine → req.socket.remoteAddress
    // is 127.0.0.1 → middleware short-circuits.
    const resp = await fetch(`${baseUrl}/api/plugins`);
    expect(resp.status).toBe(200);
  });

  it('keeps health / readiness / version probes open without a bearer', async () => {
    for (const path of ['/api/health', '/api/ready', '/api/version']) {
      const resp = await fetch(`${baseUrl}${path}`);
      expect(resp.status).toBe(200);
    }
  });
});

// Pure guard-decision tests. The HTTP suite above cannot reach the
// non-loopback branch (the test client is always 127.0.0.1, so the loopback
// short-circuit fires first). These drive decideBoundApiTokenGuard directly
// with a non-loopback peer — the only way to reproduce the multitenant
// regression where a per-run agent carrying only an `odtt_` tool token was
// rejected with API_TOKEN_REQUIRED before reaching the tool endpoint.
describe('decideBoundApiTokenGuard (tool-token bypass)', () => {
  const API_TOKEN = 'od-api-token-fixture';
  const MEDIA_ENDPOINT = '/api/tools/media/generate';
  const ADMIN_ENDPOINT = '/api/projects/abc/media/tasks';

  function mintToolToken(): string {
    const grant = toolTokenRegistry.mint({
      runId: `run-${Math.random().toString(36).slice(2)}`,
      projectId: `project-${Math.random().toString(36).slice(2)}`,
    });
    return grant.token;
  }

  function guard(overrides: Partial<ApiTokenGuardInput> = {}) {
    const path = overrides.path ?? MEDIA_ENDPOINT;
    return decideBoundApiTokenGuard({
      path,
      method: 'POST',
      authorization: '',
      apiToken: API_TOKEN,
      isLoopbackPeer: false,
      isOpenProbePath: false,
      previewAssetAllowed: false,
      isToolTokenValid: (bearer) =>
        toolTokenRegistry.validate(bearer, { endpoint: path }).ok,
      ...overrides,
    });
  }

  afterEach(() => {
    toolTokenRegistry.clear();
  });

  it('allows a valid agent tool token to a tool endpoint over a non-loopback hop', () => {
    const token = mintToolToken();
    expect(guard({ authorization: `Bearer ${token}` })).toEqual({ allow: true });
  });

  it('rejects a forged/unknown bearer to a tool endpoint (no widening)', () => {
    const decision = guard({ authorization: 'Bearer odtt_not-in-registry' });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.code).toBe('API_TOKEN_REQUIRED');
  });

  it('rejects a missing bearer to a tool endpoint', () => {
    expect(guard({ authorization: '' }).allow).toBe(false);
  });

  it('does NOT let a valid tool token bypass a non-tool (admin) endpoint', () => {
    const token = mintToolToken();
    const decision = guard({ path: ADMIN_ENDPOINT, authorization: `Bearer ${token}` });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.code).toBe('API_TOKEN_REQUIRED');
  });

  it('keeps the admin path working: exact OD_API_TOKEN is accepted', () => {
    expect(
      guard({ path: ADMIN_ENDPOINT, authorization: `Bearer ${API_TOKEN}` }),
    ).toEqual({ allow: true });
  });

  it('keeps the desktop path working: loopback peer with no bearer is allowed', () => {
    expect(
      guard({ path: ADMIN_ENDPOINT, authorization: '', isLoopbackPeer: true }),
    ).toEqual({ allow: true });
  });

  it('lets open probe paths through', () => {
    expect(guard({ path: '/api/health', isOpenProbePath: true })).toEqual({ allow: true });
  });

  it('lets a valid project-preview asset GET through', () => {
    expect(
      guard({
        path: '/api/projects/abc/preview/scope/index.html',
        method: 'GET',
        previewAssetAllowed: true,
      }),
    ).toEqual({ allow: true });
  });

  it('exposes the media generate endpoint in the bypass allowlist', () => {
    expect(TOOL_TOKEN_GUARD_BYPASS_ENDPOINTS.has(MEDIA_ENDPOINT)).toBe(true);
  });
});
