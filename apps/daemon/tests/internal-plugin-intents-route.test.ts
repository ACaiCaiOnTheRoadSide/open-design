import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInternalPluginIntentRoutes } from '../src/routes/internal-plugin-intents.js';
import type { PluginInstallIntent, PluginInstallIntentStore } from '../src/storage/plugin-install-intents.js';

const servers: import('node:http').Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function fixture(lastError: string | null = null) {
  let row: PluginInstallIntent | null = null;
  const store: PluginInstallIntentStore = {
    putInstalled: vi.fn(async (id, source, sourceKind) => row = { pluginId: id, source, sourceKind, desiredState: 'installed', revision: 1, lastAttemptAt: null, lastSuccessAt: null, lastErrorAt: null, lastError, updatedAt: new Date() }),
    putAbsent: vi.fn(async (id) => row = { pluginId: id, source: null, sourceKind: null, desiredState: 'absent', revision: 2, lastAttemptAt: null, lastSuccessAt: null, lastErrorAt: null, lastError, updatedAt: new Date() }),
    get: vi.fn(async () => row), list: vi.fn(async () => row ? [row] : []),
    markAttempt: vi.fn(async () => true), markSuccess: vi.fn(async () => true), markError: vi.fn(async () => true),
  };
  const reconciler = { start: vi.fn(), reconcileNow: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
  const app = express(); app.use(express.json()); registerInternalPluginIntentRoutes(app, { apiToken: 'secret', store, reconciler });
  const server = app.listen(0); servers.push(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen failed');
  return { base: `http://127.0.0.1:${address.port}`, store, reconciler };
}

describe('internal plugin intent API', () => {
  it('requires the OD_API_TOKEN Bearer credential', async () => {
    const { base } = fixture();
    expect((await fetch(`${base}/api/internal/plugin-intents/p`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"source":"github:o/r"}' })).status).toBe(401);
    expect((await fetch(`${base}/api/internal/plugin-intents/p`, { method: 'PUT', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"source":"github:o/r"}' })).status).toBe(401);
  });

  it('PUT persists installed intent before materialization', async () => {
    const { base, store, reconciler } = fixture();
    const response = await fetch(`${base}/api/internal/plugin-intents/plugin-id`, { method: 'PUT', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{"source":"github:owner/repo@main/path"}' });
    expect(response.status).toBe(200);
    expect(store.putInstalled).toHaveBeenCalledWith('plugin-id', 'github:owner/repo@main/path', 'github');
    expect(vi.mocked(store.putInstalled).mock.invocationCallOrder[0]).toBeLessThan(reconciler.reconcileNow.mock.invocationCallOrder[0]!);
  });

  it('DELETE writes absent tombstone before uninstall reconciliation', async () => {
    const { base, store, reconciler } = fixture();
    const response = await fetch(`${base}/api/internal/plugin-intents/plugin-id`, { method: 'DELETE', headers: { authorization: 'Bearer secret' } });
    expect(response.status).toBe(200); expect(store.putAbsent).toHaveBeenCalledWith('plugin-id');
    expect(vi.mocked(store.putAbsent).mock.invocationCallOrder[0]).toBeLessThan(reconciler.reconcileNow.mock.invocationCallOrder[0]!);
  });

  it('rejects non-refetchable sources and reports materialization failure', async () => {
    const invalid = fixture();
    expect((await fetch(`${invalid.base}/api/internal/plugin-intents/p`, { method: 'PUT', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{"source":"/tmp/local"}' })).status).toBe(400);
    const failed = fixture('manifest mismatch');
    expect((await fetch(`${failed.base}/api/internal/plugin-intents/p`, { method: 'PUT', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{"source":"https://example.com/p.tgz"}' })).status).toBe(422);
  });
});
