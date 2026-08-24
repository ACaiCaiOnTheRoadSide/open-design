import type { Express, Request, Response } from 'express';
import type * as BetterSqlite3 from 'better-sqlite3';
import type { ResourceOwnerRegistry } from '../../storage/resource-owner-registry.js';

type MarketplaceTrust = 'trusted' | 'restricted' | 'official';

type SqliteDbLike = BetterSqlite3.Database;

interface MarketplaceManifest {
  plugins?: unknown[];
  [key: string]: unknown;
}

interface MarketplaceRow {
  id: string;
  url: string;
  version?: string;
  specVersion?: string;
  trust?: MarketplaceTrust;
  manifest: MarketplaceManifest;
  [key: string]: unknown;
}

interface MarketplaceMutationResult {
  ok: boolean;
  status: number;
  message: string;
  errors?: unknown[];
  row: MarketplaceRow;
}

type MarketplaceFetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface RegisterPluginMarketplaceRoutesDeps {
  db: SqliteDbLike;
  resourceOwnerRegistry?: ResourceOwnerRegistry;
  bundledMarketplaceEntries: unknown;
  createMarketplaceFetcher: (seedId: string | null, bundled: unknown) => MarketplaceFetcher;
  marketplaceRegistryIdFromUrl: (url: string) => string | null;
}

export function registerPluginMarketplaceRoutes(app: Express, deps: RegisterPluginMarketplaceRoutesDeps): void {
  const { db, resourceOwnerRegistry, bundledMarketplaceEntries, createMarketplaceFetcher, marketplaceRegistryIdFromUrl } = deps;
  const visible = async (id: string) => !resourceOwnerRegistry
    || resourceOwnerRegistry.isVisible('plugin_marketplace', id);
  const backendManaged = async (id: string) => Boolean(resourceOwnerRegistry
    && await resourceOwnerRegistry.isBackendManaged('plugin_marketplace', id));
  const sendBackendReadOnly = (res: Response) =>
    res.status(403).json({ error: { code: 'backend-managed-read-only', message: 'backend-managed marketplaces are read-only' } });

  const readBody = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

  app.get('/api/marketplaces', async (_req, res) => {
    try {
      const { listMarketplaces } = await import('../../plugins/marketplaces.js');
      const rows = listMarketplaces(db);
      if (!resourceOwnerRegistry) return res.json({ marketplaces: rows });
      const ids = await resourceOwnerRegistry.filterVisibleIds('plugin_marketplace', rows.map((row) => row.id));
      res.json({ marketplaces: rows.filter((row) => ids.has(row.id)) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  app.post('/api/marketplaces', async (req, res) => {
    try {
      const body = readBody(req);
      const url = typeof body.url === 'string' ? body.url : '';
      if (!url) return res.status(400).json({ error: 'url is required' });
      const registryId = marketplaceRegistryIdFromUrl(url);
      if (registryId && await backendManaged(registryId)) return sendBackendReadOnly(res);
      const trust = body.trust === 'trusted' || body.trust === 'official' ? body.trust : 'restricted';
      const { addMarketplace } = await import('../../plugins/marketplaces.js');
      const result = await addMarketplace(db, {
        url,
        trust,
        fetcher: createMarketplaceFetcher(marketplaceRegistryIdFromUrl(url), bundledMarketplaceEntries),
      }) as MarketplaceMutationResult;
      if (!result.ok) return res.status(result.status).json({ error: { code: 'marketplace-add-failed', message: result.message, data: { errors: result.errors ?? [] } } });
      await resourceOwnerRegistry?.registerUser({
        kind: 'plugin_marketplace', id: result.row.id, sourceKind: 'http', retrievalUrl: result.row.url,
      });
      res.status(201).json(result.row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  app.get('/api/marketplaces/:id', async (req, res) => {
    try {
      if (!await visible(req.params.id)) return res.status(404).json({ error: 'marketplace not found' });
      const { getMarketplace } = await import('../../plugins/marketplaces.js');
      const row = getMarketplace(db, req.params.id) as MarketplaceRow | null;
      if (!row) return res.status(404).json({ error: 'marketplace not found' });
      res.json(row);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.delete('/api/marketplaces/:id', async (req, res) => {
    try {
      if (!await visible(req.params.id)) return res.status(404).json({ error: 'marketplace not found' });
      if (await backendManaged(req.params.id)) return sendBackendReadOnly(res);
      if (resourceOwnerRegistry && !await resourceOwnerRegistry.softDelete('plugin_marketplace', req.params.id)) return res.status(404).json({ error: 'marketplace not found' });
      const { removeMarketplace } = await import('../../plugins/marketplaces.js');
      const ok = removeMarketplace(db, req.params.id);
      if (!ok) return res.status(404).json({ error: 'marketplace not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.post('/api/marketplaces/:id/refresh', async (req, res) => {
    try {
      if (!await visible(req.params.id)) return res.status(404).json({ error: 'marketplace not found' });
      if (await backendManaged(req.params.id)) return sendBackendReadOnly(res);
      const { getMarketplace, refreshMarketplace } = await import('../../plugins/marketplaces.js');
      const row = getMarketplace(db, req.params.id) as MarketplaceRow | null;
      const seedId = row ? marketplaceRegistryIdFromUrl(row.url) ?? req.params.id : req.params.id;
      const result = await refreshMarketplace(db, req.params.id, createMarketplaceFetcher(seedId, bundledMarketplaceEntries)) as MarketplaceMutationResult;
      if (!result.ok) return res.status(result.status).json({ error: { code: 'marketplace-refresh-failed', message: result.message, data: { errors: result.errors ?? [] } } });
      try {
        const { recordPluginEvent } = await import('../../plugins/events.js');
        recordPluginEvent({ kind: 'plugin.marketplace-refreshed', pluginId: '', details: { marketplaceId: req.params.id, marketplaceVersion: result.row.version, specVersion: result.row.specVersion } });
      } catch {}
      res.json(result.row);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.post('/api/marketplaces/:id/trust', async (req, res) => {
    try {
      if (!await visible(req.params.id)) return res.status(404).json({ error: 'marketplace not found' });
      if (await backendManaged(req.params.id)) return sendBackendReadOnly(res);
      const body = readBody(req);
      const trust = body.trust === 'trusted' || body.trust === 'restricted' || body.trust === 'official' ? body.trust : null;
      if (!trust) return res.status(400).json({ error: 'trust must be one of: trusted, restricted, official' });
      const { setMarketplaceTrust } = await import('../../plugins/marketplaces.js');
      const row = setMarketplaceTrust(db, req.params.id, trust) as MarketplaceRow | null;
      if (!row) return res.status(404).json({ error: 'marketplace not found' });
      res.json(row);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.get('/api/marketplaces/:id/plugins', async (req, res) => {
    try {
      if (!await visible(req.params.id)) return res.status(404).json({ error: 'marketplace not found' });
      const { getMarketplace } = await import('../../plugins/marketplaces.js');
      const row = getMarketplace(db, req.params.id) as MarketplaceRow | null;
      if (!row) return res.status(404).json({ error: 'marketplace not found' });
      res.json({ plugins: row.manifest.plugins ?? [] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
}
