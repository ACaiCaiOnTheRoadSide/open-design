import express from 'express';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrincipalAuthMiddleware } from '../src/principal-auth.js';
import { migratePlugins } from '../src/plugins/persistence.js';
import { ensureMarketplaceManifest, getMarketplace } from '../src/plugins/marketplaces.js';
import { registerPluginMarketplaceRoutes } from '../src/routes/plugins/marketplaces.js';
import type { ResourceOwnerRegistry } from '../src/storage/resource-owner-registry.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const manifest = JSON.stringify({
  name: 'official',
  version: '1.0.0',
  specVersion: '1',
  plugins: [],
});

describe('backend-managed marketplace HTTP mutations', () => {
  it('rejects add/update, refresh, trust, and delete without changing shared SQLite', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE conversations (id TEXT PRIMARY KEY);');
    migratePlugins(db);
    const url = 'https://open-design.ai/marketplace/official/open-design-marketplace.json';
    const seeded = ensureMarketplaceManifest(db, { id: 'official', url, trust: 'official', manifestText: manifest });
    expect(seeded.ok).toBe(true);
    const before = JSON.stringify(getMarketplace(db, 'official'));
    const owners = {
      isVisible: async () => true,
      filterVisibleIds: async (_kind, ids) => new Set(ids),
      isBackendManaged: async (_kind, id) => id === 'official',
      registerUser: async () => { throw new Error('must not register a backend marketplace as user-owned'); },
      registerBackend: async () => undefined,
      softDelete: async () => { throw new Error('must not soft-delete a backend marketplace'); },
      hasOtherActiveOwners: async () => true,
      release: async () => { throw new Error('must not release a backend marketplace'); },
    } satisfies ResourceOwnerRegistry;
    let fetchCalls = 0;
    const app = express();
    app.use(express.json());
    app.use(createPrincipalAuthMiddleware({ enabled: true, source: 'trusted-proxy', apiToken: 'test-secret' }));
    registerPluginMarketplaceRoutes(app, {
      db,
      resourceOwnerRegistry: owners,
      bundledMarketplaceEntries: [],
      marketplaceRegistryIdFromUrl: (candidate) => candidate === url ? 'official' : null,
      createMarketplaceFetcher: () => async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, text: async () => manifest.replace('1.0.0', '9.9.9') };
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const base = `http://127.0.0.1:${address.port}`;
    close = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    };
    const request = (method: string, pathname: string, body?: unknown) => fetch(`${base}${pathname}`, {
      method,
      headers: {
        authorization: 'Bearer test-secret',
        'x-tenant-id': 'tenant-a',
        'x-od-user-id': 'alice',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const attempts = [
      await request('POST', '/api/marketplaces', { url, trust: 'restricted' }),
      await request('POST', '/api/marketplaces/official/refresh'),
      await request('POST', '/api/marketplaces/official/trust', { trust: 'restricted' }),
      await request('DELETE', '/api/marketplaces/official'),
    ];
    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'backend-managed-read-only' } });
    }
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(getMarketplace(db, 'official'))).toBe(before);
  });
});
