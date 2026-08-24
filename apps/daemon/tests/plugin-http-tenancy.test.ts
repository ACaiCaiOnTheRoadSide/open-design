import { afterEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { migratePlugins } from '../src/plugins/persistence.js';
import {
  getInstalledPlugin,
  listInstalledPlugins,
  setPluginEnabled,
} from '../src/plugins/registry.js';
import { installPlugin, installFromLocalFolder, isSafePluginId, uninstallPlugin } from '../src/plugins/installer.js';
import { registerPluginRoutes } from '../src/routes/plugins/index.js';
import { createPrincipalAuthMiddleware } from '../src/principal-auth.js';
import { getRequestContext } from '../src/request-context.js';
import type { ResourceOwnerRegistry, ResourceOwnershipInput, SaaSResourceKind } from '../src/storage/resource-owner-registry.js';

class MemoryOwners implements ResourceOwnerRegistry {
  readonly rows = new Map<string, { deleted: boolean; backend: boolean }>();
  private key(kind: SaaSResourceKind, tenant: string, id: string) { return `${kind}\0${tenant}\0${id}`; }
  async registerUser(input: ResourceOwnershipInput) {
    const principal = getRequestContext();
    if (!principal) throw new Error('missing test principal');
    this.rows.set(this.key(input.kind, principal.tenantId, input.id), { deleted: false, backend: false });
  }
  async registerBackend(input: ResourceOwnershipInput) {
    this.rows.set(this.key(input.kind, '__backend__', input.id), { deleted: false, backend: true });
  }
  async isVisible(kind: SaaSResourceKind, id: string) {
    const tenant = getRequestContext()?.tenantId ?? '';
    return this.rows.get(this.key(kind, tenant, id))?.deleted === false
      || this.rows.get(this.key(kind, '__backend__', id))?.deleted === false;
  }
  async filterVisibleIds(kind: SaaSResourceKind, ids: readonly string[]) {
    const visible = new Set<string>();
    for (const id of ids) if (await this.isVisible(kind, id)) visible.add(id);
    return visible;
  }
  async softDelete(kind: SaaSResourceKind, id: string) {
    const tenant = getRequestContext()?.tenantId ?? '';
    const row = this.rows.get(this.key(kind, tenant, id));
    if (!row || row.backend || row.deleted) return false;
    row.deleted = true;
    return true;
  }
  async hasOtherActiveOwners(kind: SaaSResourceKind, id: string) {
    const tenant = getRequestContext()?.tenantId ?? '';
    return [...this.rows].some(([key, row]) => !row.deleted && key.startsWith(`${kind}\0`) && key.endsWith(`\0${id}`) && !key.startsWith(`${kind}\0${tenant}\0`));
  }
  async release(kind: SaaSResourceKind, id: string) {
    const deleted = await this.softDelete(kind, id);
    return { deleted, hasActiveOwners: deleted && await this.hasOtherActiveOwners(kind, id) };
  }
  async isBackendManaged(kind: SaaSResourceKind, id: string) {
    return this.rows.get(this.key(kind, '__backend__', id))?.deleted === false;
  }
}

let tmp = '';
afterEach(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ''; });

function openDb(file: string) {
  const db = new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);');
  migratePlugins(db);
  return db;
}

function makeApp(db: Database.Database, roots: { userPluginsRoot: string }, owners: MemoryOwners): Express {
  const app = express();
  app.use(express.json());
  app.use(createPrincipalAuthMiddleware({ enabled: true, source: 'trusted-proxy', apiToken: 'test-secret' }));
  const helpers = {
    PLUGIN_PREVIEWS_DIR: '', pluginUpload: { single: () => (_req: unknown, _res: unknown, next: (error?: unknown) => void) => next(), array: () => (_req: unknown, _res: unknown, next: (error?: unknown) => void) => next() },
    pluginInstallation: { stageUploadedPluginZip: async () => ({ ok: false }), stageUploadedPluginFolder: async () => ({ ok: false }) },
    connectorService: {}, resolvedPortRef: { current: 0 }, pluginShareTaskStore: { get: () => null, snapshot: () => ({}) },
    applyBakedPreviews: (rows: unknown) => rows, assembleExample: () => '', sendMulterError: () => undefined, decodeMultipartFilename: (s: string) => s,
    installOrUpgradePlugin: async (req: express.Request, res: express.Response, mode: 'install' | 'upgrade') => {
      const requestId = Array.isArray(req.params.id) ? req.params.id[0] ?? '' : req.params.id ?? '';
      const current = mode === 'upgrade' ? getInstalledPlugin(db, requestId) : null;
      const source = mode === 'upgrade' ? current?.source : req.body?.source;
      if (!source) return res.status(400).json({ error: 'source is required' });
      for await (const event of installPlugin(db, { source, roots, ...(mode === 'upgrade' ? { expectedPluginId: requestId } : {}) })) {
        if (event.kind === 'error') return res.status(400).json(event);
        if (event.kind === 'success') {
          await owners.registerUser({ kind: 'plugin', id: event.plugin.id, sourceKind: 'local', localPath: event.plugin.fsPath });
          return res.json(event.plugin);
        }
      }
      return res.status(500).end();
    },
    loadPluginRegistryView: async () => ({}), buildConnectorProbe: () => ({}), handleShareProject: async () => undefined,
    handlePluginTrust: async () => undefined, handlePluginStats: () => undefined, requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
    handleAppliedPluginExport: async () => undefined, handleProjectInstallFolder: async () => undefined, handleProjectPluginCli: async () => undefined,
    getProject: () => null, sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }),
    isLocalSameOrigin: () => true, handleCandidateDraft: async () => undefined, handleCandidateShareTask: async () => undefined, handleProjectShareTask: async () => undefined,
  };
  registerPluginRoutes(app, {
    db: db as never, resourceOwnerRegistry: owners, authorizeProjectRequest: async () => true,
    paths: { PROJECTS_DIR: tmp, PLUGIN_REGISTRY_ROOTS: roots as never, PLUGIN_LOCKFILE_PATH: path.join(tmp, 'lock.json') },
    ids: { randomId: () => crypto.randomUUID() },
    projectStore: { insertProject: () => null, getProject: () => null, ensureWorkspaceProject: () => undefined, dbDeleteProject: () => undefined, removeProjectDir: async () => undefined },
    conversations: { insertConversation: () => undefined },
    plugins: ({
      listInstalledPlugins, getInstalledPlugin, setPluginEnabled, installPlugin, isSafePluginId, uninstallPlugin, installFromLocalFolder,
      applyPlugin: () => ({ result: { capabilitiesGranted: [], appliedPlugin: { capabilitiesGranted: [] } }, warnings: [] }), doctorPlugin: () => ({}),
      getSnapshot: () => null, pruneExpiredSnapshots: () => ({ removed: 0, ids: [] }), readPluginLockfile: async () => ({}), resolvePluginSnapshot: () => null,
      MissingInputError: class extends Error { fields: string[] = []; constructor(..._args: unknown[]) { super(); } }, pluginPromptBlock: () => '', listSkillPluginCandidates: () => [], dismissSkillPluginCandidate: () => null,
      generateSkillPluginDraft: async () => null, FIRST_PARTY_ATOMS: [],
    } as never),
    helpers: helpers as never,
  });
  return app;
}

async function request(base: string, tenant: string, method: string, pathname: string, body?: unknown) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: 'Bearer test-secret', 'x-tenant-id': tenant, 'x-od-user-id': `${tenant}-user`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function listen(app: Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('plugin tenant HTTP isolation', () => {
  it('isolates same slug version/state/delete and survives restart', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-http-'));
    const roots = { userPluginsRoot: path.join(tmp, 'plugins') };
    const sourceA = path.join(tmp, 'source-a'); const sourceB = path.join(tmp, 'source-b'); const uniqueA = path.join(tmp, 'unique-a');
    await Promise.all([sourceA, sourceB, uniqueA].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(sourceA, 'open-design.json'), JSON.stringify({ name: 'same-slug', version: '1.0.0', title: 'A' }));
    await writeFile(path.join(sourceB, 'open-design.json'), JSON.stringify({ name: 'same-slug', version: '2.0.0', title: 'B' }));
    await writeFile(path.join(uniqueA, 'open-design.json'), JSON.stringify({ name: 'only-a', version: '1.0.0', title: 'Only A' }));
    const dbFile = path.join(tmp, 'daemon.sqlite'); const owners = new MemoryOwners(); let db = openDb(dbFile);
    let running = await listen(makeApp(db, roots, owners));
    expect((await request(running.base, 'tenant-a', 'POST', '/api/plugins/install', { source: sourceA })).status).toBe(200);
    expect((await request(running.base, 'tenant-b', 'POST', '/api/plugins/install', { source: sourceB })).status).toBe(200);
    expect((await request(running.base, 'tenant-a', 'POST', '/api/plugins/install', { source: uniqueA })).status).toBe(200);
    expect((await (await request(running.base, 'tenant-a', 'GET', '/api/plugins/same-slug')).json() as { version: string }).version).toBe('1.0.0');
    expect((await (await request(running.base, 'tenant-b', 'GET', '/api/plugins/same-slug')).json() as { version: string }).version).toBe('2.0.0');
    expect((await request(running.base, 'tenant-b', 'GET', '/api/plugins/only-a')).status).toBe(404);
    expect((await request(running.base, 'tenant-b', 'POST', '/api/plugins/only-a/disable')).status).toBe(404);
    const disabled = await request(running.base, 'tenant-a', 'POST', '/api/plugins/same-slug/disable');
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { plugin: { enabled: boolean } }).plugin.enabled).toBe(false);
    expect(((await (await request(running.base, 'tenant-b', 'GET', '/api/plugins/same-slug')).json()) as { enabled: boolean }).enabled).toBe(true);
    await writeFile(path.join(sourceA, 'open-design.json'), JSON.stringify({ name: 'same-slug', version: '1.1.0', title: 'A upgraded' }));
    expect((await request(running.base, 'tenant-a', 'POST', '/api/plugins/same-slug/upgrade', { policy: 'latest' })).status).toBe(200);
    expect(((await (await request(running.base, 'tenant-a', 'GET', '/api/plugins/same-slug')).json()) as { version: string }).version).toBe('1.1.0');
    expect(((await (await request(running.base, 'tenant-b', 'GET', '/api/plugins/same-slug')).json()) as { version: string }).version).toBe('2.0.0');
    expect((await request(running.base, 'tenant-a', 'POST', '/api/plugins/same-slug/enable')).status).toBe(200);
    expect((await request(running.base, 'tenant-a', 'POST', '/api/plugins/same-slug/uninstall')).status).toBe(200);
    expect((await request(running.base, 'tenant-a', 'GET', '/api/plugins/same-slug')).status).toBe(404);
    expect((await request(running.base, 'tenant-b', 'GET', '/api/plugins/same-slug')).status).toBe(200);
    await new Promise<void>((resolve) => running.server.close(() => resolve())); db.close();
    db = openDb(dbFile); running = await listen(makeApp(db, roots, owners));
    expect((await request(running.base, 'tenant-a', 'GET', '/api/plugins/same-slug')).status).toBe(404);
    const afterRestart = await request(running.base, 'tenant-b', 'GET', '/api/plugins/same-slug');
    expect(afterRestart.status).toBe(200);
    expect(((await afterRestart.json()) as { version: string }).version).toBe('2.0.0');
    await new Promise<void>((resolve) => running.server.close(() => resolve())); db.close();
  });
});
