import { request as httpRequest, type OutgoingHttpHeaders, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPrincipalAuthMiddleware,
  PrincipalAuthConfigError,
  principalContextModeForApiRequest,
  resolvePrincipalAuthConfig,
  runWithStaticPrincipalContext,
} from '../src/principal-auth.js';
import { requireRequestContext } from '../src/request-context.js';

type Response = { status: number; body: string };
const servers: Server[] = [];

async function serve(
  config: ReturnType<typeof resolvePrincipalAuthConfig>,
  mode: 'required' | 'optional' = 'required',
): Promise<string> {
  const app = express();
  app.use('/api', createPrincipalAuthMiddleware(config, mode));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/no-context', (_req, res) => res.json({ ok: true }));
  app.get('/api/context', async (req, res) => {
    const before = requireRequestContext();
    await new Promise((resolve) => setTimeout(resolve, Number(req.query.delay ?? 0)));
    const after = requireRequestContext();
    res.json({ before, after });
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

function request(method: string, url: string, headers: OutgoingHttpHeaders = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function get(url: string, headers: OutgoingHttpHeaders = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('principal auth configuration', () => {
  it('does not require principal configuration in SQLite mode', () => {
    expect(resolvePrincipalAuthConfig({})).toEqual({ enabled: false });
    expect(resolvePrincipalAuthConfig({ OD_DAEMON_DB: 'sqlite', OD_PRINCIPAL_SOURCE: 'bogus' }))
      .toEqual({ enabled: false });
  });

  it('fails PostgreSQL startup configuration for missing or invalid sources', () => {
    expect(() => resolvePrincipalAuthConfig({ OD_DAEMON_DB: 'postgres' }))
      .toThrow(PrincipalAuthConfigError);
    expect(() => resolvePrincipalAuthConfig({ OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'legacy' }))
      .toThrow(/static or trusted-proxy/);
    expect(() => resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'static',
      OD_PRINCIPAL_TENANT_ID: '', OD_PRINCIPAL_USER_ID: 'user',
    })).toThrow(/OD_PRINCIPAL_TENANT_ID/);
    expect(() => resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'static',
      OD_PRINCIPAL_TENANT_ID: 'bad\nvalue', OD_PRINCIPAL_USER_ID: 'user',
    })).toThrow(/control characters/);
  });

  it('requires auth and a non-empty token in trusted-proxy mode without revealing it', () => {
    expect(() => resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy',
      OD_API_TOKEN: 'super-secret', OD_DISABLE_API_AUTH: 'true',
    })).toThrow(/OD_DISABLE_API_AUTH/);
    expect(() => resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: '   ',
    })).toThrow(/OD_API_TOKEN/);
  });
});

describe('principal route policy', () => {
  it('requires context for tenant-aware routes while preserving SQLite project deletion policy', () => {
    for (const [method, path] of [
      ['GET', '/api/memory'], ['PUT', '/memory/index'], ['POST', '/api/runs'], ['POST', '/chat'],
      ['POST', '/api/runs/'], ['POST', '/api/RUNS'], ['POST', '/CHAT/'],
    ] as const) expect(principalContextModeForApiRequest(method, path)).toBe('required');
    for (const [method, path] of [
      ['GET', '/api/runs'], ['GET', '/runs/run-id/events'], ['POST', '/runs/run-id/cancel'],
      ['GET', '/projects/id/preview/file.html'], ['POST', '/projects/id/export'],
      ['DELETE', '/api/projects/id'], ['POST', '/api/workspaces/ws/projects/batch-delete'],
    ] as const) expect(principalContextModeForApiRequest(method, path, { backend: 'sqlite' })).toBe('optional');

    for (const [method, path] of [
      ['DELETE', '/api/projects/id'], ['DELETE', '/projects/ID/'],
      ['POST', '/api/workspaces/ws/projects/batch-delete'],
      ['POST', '/api/projects/project-1/stats-events'],
      ['GET', '/api/brands'], ['POST', '/api/brands/id/finalize'],
      ['DELETE', '/api/brands/id'], ['GET', '/api/design-systems'],
      ['GET', '/api/design-systems/id/file'], ['POST', '/api/design-systems/import/github'],
      ['DELETE', '/api/design-systems/id'],
    ] as const) expect(principalContextModeForApiRequest(method, path, { backend: 'postgres' })).toBe('required');
    expect(principalContextModeForApiRequest('GET', '/api/projects/id', { backend: 'postgres' })).toBe('required');
    expect(principalContextModeForApiRequest('DELETE', '/api/projects/id/files/name', { backend: 'postgres' })).toBe('required');
  });
});

describe('background principal context', () => {
  it('keeps a strictly parsed static principal across the complete async work chain', async () => {
    const config = resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres',
      OD_PRINCIPAL_SOURCE: 'static',
      OD_PRINCIPAL_TENANT_ID: 'tenant-routine',
      OD_PRINCIPAL_USER_ID: 'user-routine',
    });

    const observed = await runWithStaticPrincipalContext(config, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return requireRequestContext();
    });

    expect(observed).toEqual({ tenantId: 'tenant-routine', userId: 'user-routine' });
  });

  it('does not invent a principal for trusted-proxy background work', async () => {
    const config = resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres',
      OD_PRINCIPAL_SOURCE: 'trusted-proxy',
      OD_API_TOKEN: 'secret',
    });

    await expect(runWithStaticPrincipalContext(config, async () => {
      await Promise.resolve();
      return requireRequestContext();
    })).rejects.toThrow('Missing principal');
  });
});

describe('principal auth middleware', () => {
  it('rejects stats-events at the auth boundary with standard 401/400 responses', async () => {
    const config = resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: 'global',
    });
    const app = express();
    const routePath = '/api/projects/:id/stats-events';
    const mode = principalContextModeForApiRequest('POST', '/api/projects/p/stats-events', { backend: 'postgres' });
    app.post(routePath, createPrincipalAuthMiddleware(config, mode), (_req, res) => res.json(requireRequestContext()));
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `http://127.0.0.1:${address.port}/api/projects/p/stats-events`;

    const missingToken = await request('POST', url);
    expect(missingToken.status).toBe(401);
    expect(JSON.parse(missingToken.body).error.code).toBe('API_TOKEN_REQUIRED');
    const missingPrincipal = await request('POST', url, { authorization: 'Bearer global' });
    expect(missingPrincipal.status).toBe(400);
    expect(JSON.parse(missingPrincipal.body).error.code).toBe('INVALID_PRINCIPAL_HEADERS');
    const accepted = await request('POST', url, {
      authorization: 'Bearer global', 'x-tenant-id': 'tenant-a', 'x-od-user-id': 'user-a',
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ tenantId: 'tenant-a', userId: 'user-a' });
  });

  it('creates static context and rejects client identity headers', async () => {
    const config = resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'static',
      OD_PRINCIPAL_TENANT_ID: 'env-tenant', OD_PRINCIPAL_USER_ID: 'env-user',
    });
    const base = await serve(config);
    const accepted = await get(`${base}/api/context`);
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body).before).toEqual({ tenantId: 'env-tenant', userId: 'env-user' });

    const rejected = await get(`${base}/api/context`, { 'x-tenant-id': 'client' });
    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejected.body).error.code).toBe('PRINCIPAL_HEADERS_FORBIDDEN');
  });

  it('requires the exact token even on loopback and never echoes it', async () => {
    const token = 'token-that-must-not-leak';
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: token,
    }));
    const headers = { 'x-tenant-id': 'tenant', 'x-od-user-id': 'user' };
    const missing = await get(`${base}/api/context`, headers);
    const wrong = await get(`${base}/api/context`, { ...headers, authorization: 'Bearer wrong' });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.body + wrong.body).not.toContain(token);

    const basic = Buffer.from(`open-design:${token}`).toString('base64');
    const accepted = await get(`${base}/api/context`, { ...headers, authorization: `Basic ${basic}` });
    expect(accepted.status).toBe(200);
  });

  it('rejects missing, multi-value, repeated, and oversized principal headers', async () => {
    const token = 'secret';
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: token,
    }));
    const authorization = `Bearer ${token}`;
    const cases: OutgoingHttpHeaders[] = [
      { authorization, 'x-tenant-id': 'tenant' },
      { authorization, 'x-tenant-id': 'one,two', 'x-od-user-id': 'user' },
      { authorization, 'x-tenant-id': ['one', 'two'], 'x-od-user-id': 'user' },
      { authorization, 'x-tenant-id': 'x'.repeat(129), 'x-od-user-id': 'user' },
    ];
    for (const headers of cases) {
      const response = await get(`${base}/api/context`, headers);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('INVALID_PRINCIPAL_HEADERS');
    }
  });

  it('keeps concurrent trusted-proxy principals and BYOK configs isolated across awaits', async () => {
    const token = 'secret';
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: token,
    }));
    const provider = (tenant: string) => JSON.stringify({
      provider: { [tenant]: { options: { apiKey: `secret-${tenant}` } } },
      model: `${tenant}/model`,
    });
    const call = (tenant: string, delay: number) => get(`${base}/api/context?delay=${delay}`, {
      authorization: `Bearer ${token}`, 'x-tenant-id': tenant, 'x-od-user-id': `${tenant}-user`,
      'x-od-provider-config': provider(tenant),
    });
    const [slow, fast] = await Promise.all([call('slow', 30), call('fast', 0)]);
    for (const [response, tenant] of [[slow, 'slow'], [fast, 'fast']] as const) {
      expect(response.status, response.body).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.before.tenantId).toBe(tenant);
      expect(parsed.after.tenantId).toBe(tenant);
      expect(JSON.parse(parsed.before.providerConfig).model).toBe(`${tenant}/model`);
      expect(parsed.after.providerConfig).toBe(parsed.before.providerConfig);
    }
  });

  it('accepts provider config only after trusted-proxy authentication and rejects malformed values', async () => {
    const token = 'secret';
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: token,
    }));
    const headers = { 'x-tenant-id': 'tenant', 'x-od-user-id': 'user', 'x-od-provider-config': '{bad' };
    expect((await get(`${base}/api/context`, headers)).status).toBe(401);
    const malformed = await get(`${base}/api/context`, { ...headers, authorization: `Bearer ${token}` });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body).error.code).toBe('INVALID_PROVIDER_CONFIG');
  });

  it('allows scoped-token-shaped requests without principal headers in optional mode', async () => {
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: 'global',
    }), 'optional');
    for (const authorization of ['Bearer preview-scope-token', 'Bearer tool-run-scope-token']) {
      expect((await get(`${base}/api/no-context`, { authorization })).status).toBe(200);
    }
  });

  it('authenticates every principal assertion in optional mode', async () => {
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: 'global',
    }), 'optional');
    expect((await get(`${base}/api/no-context`, { 'x-tenant-id': 'tenant-a' })).status).toBe(401);
    expect((await get(`${base}/api/no-context`, {
      authorization: 'Bearer global', 'x-tenant-id': 'tenant-a',
    })).status).toBe(400);
    const valid = await get(`${base}/api/context`, {
      authorization: 'Bearer global', 'x-tenant-id': 'tenant-a', 'x-od-user-id': 'user-a',
    });
    expect(valid.status).toBe(200);
    expect(JSON.parse(valid.body).before).toEqual({ tenantId: 'tenant-a', userId: 'user-a' });
  });

  it('keeps static mode principal-bearing when context is optional', async () => {
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'static',
      OD_PRINCIPAL_TENANT_ID: 'tenant-static', OD_PRINCIPAL_USER_ID: 'user-static',
    }), 'optional');
    const response = await get(`${base}/api/context`);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).before).toEqual({ tenantId: 'tenant-static', userId: 'user-static' });
    expect((await get(`${base}/api/no-context`, { 'x-tenant-id': 'spoof' })).status).toBe(400);
  });

  it('leaves open GET probes unauthenticated', async () => {
    const base = await serve(resolvePrincipalAuthConfig({
      OD_DAEMON_DB: 'postgres', OD_PRINCIPAL_SOURCE: 'trusted-proxy', OD_API_TOKEN: 'secret',
    }));
    const response = await get(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });
});
