import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfigPrefs } from '../src/app-config.js';
import { requireRequestContext, runWithRequestContext } from '../src/request-context.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';

const principals = {
  alice: { tenantId: 'tenant-shared', userId: 'alice' },
  bob: { tenantId: 'tenant-shared', userId: 'bob' },
} as const;

const configs = new Map<string, AppConfigPrefs>([
  ['tenant-shared:alice', { telemetry: { metrics: true }, installationId: 'install-alice' }],
  ['tenant-shared:bob', { telemetry: { metrics: false }, installationId: 'install-bob' }],
]);

describe('hosted telemetry app-config isolation', () => {
  let server: http.Server;
  let baseUrl: string;
  let dispose: () => void;
  const previousKey = process.env.POSTHOG_KEY;

  beforeAll(async () => {
    process.env.POSTHOG_KEY = 'phc_test_key';
    const app = express();
    app.use((req, res, next) => {
      const token = req.get('authorization')?.replace(/^Bearer /u, '');
      const principal = token === 'alice' ? principals.alice : token === 'bob' ? principals.bob : null;
      if (!principal) return res.status(401).json({ error: 'verified principal required' });
      return runWithRequestContext(principal, next);
    });
    const telemetry = registerTelemetryRoutes(app, {
      dataDir: '/unused-in-hosted-mode',
      readAppConfig: async () => {
        const principal = tokenPrincipal();
        return configs.get(`${principal.tenantId}:${principal.userId}`) ?? {};
      },
      writeAppConfig: async (_dir, patch) => {
        const principal = tokenPrincipal();
        const key = `${principal.tenantId}:${principal.userId}`;
        const next = { ...(configs.get(key) ?? {}), ...patch } as AppConfigPrefs;
        configs.set(key, next);
        return next;
      },
    });
    dispose = telemetry.disposeFatalHandlers;
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    dispose?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousKey === undefined) delete process.env.POSTHOG_KEY;
    else process.env.POSTHOG_KEY = previousKey;
  });

  it('returns each verified principal’s own consent and installation id', async () => {
    const [aliceResponse, bobResponse] = await Promise.all([
      fetch(`${baseUrl}/api/analytics/config`, { headers: { authorization: 'Bearer alice' } }),
      fetch(`${baseUrl}/api/analytics/config`, { headers: { authorization: 'Bearer bob' } }),
    ]);
    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);
    expect(await aliceResponse.json()).toMatchObject({ enabled: true, installationId: 'install-alice' });
    expect(await bobResponse.json()).toMatchObject({ enabled: false, installationId: 'install-bob' });
  });

  it('creates and persists distinct installation ids for each verified principal', async () => {
    configs.set('tenant-shared:alice', { telemetry: { metrics: true } });
    configs.set('tenant-shared:bob', { telemetry: { metrics: true } });
    const [aliceResponse, bobResponse] = await Promise.all([
      fetch(`${baseUrl}/api/analytics/mcp/context`, { method: 'POST', headers: { authorization: 'Bearer alice' } }),
      fetch(`${baseUrl}/api/analytics/mcp/context`, { method: 'POST', headers: { authorization: 'Bearer bob' } }),
    ]);
    const alice = await aliceResponse.json() as { deviceId: string };
    const bob = await bobResponse.json() as { deviceId: string };
    expect(alice.deviceId).toBeTruthy();
    expect(bob.deviceId).toBeTruthy();
    expect(alice.deviceId).not.toBe(bob.deviceId);
    expect(configs.get('tenant-shared:alice')?.installationId).toBe(alice.deviceId);
    expect(configs.get('tenant-shared:bob')?.installationId).toBe(bob.deviceId);
  });
});

function tokenPrincipal() {
  // Deliberately imports through the verified ALS boundary rather than reading
  // request headers in the app-config dependency.
  return requireRequestContext();
}
