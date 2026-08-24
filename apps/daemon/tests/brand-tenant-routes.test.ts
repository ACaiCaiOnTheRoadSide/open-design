import express from 'express';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerBrandRoutes } from '../src/brand-routes.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { runWithRequestContext, requireRequestContext } from '../src/request-context.js';
import type { BrandDesignSystemRegistry, RegistryResource } from '../src/storage/brand-design-system-registry.js';

function memoryRegistry(): BrandDesignSystemRegistry {
  const rows = new Map<string, RegistryResource>();
  return {
    enabled: true,
    async register(input, principal = requireRequestContext()) {
      const key = `${input.resourceType}:${input.resourceId}`;
      const old = rows.get(key);
      if (old && (old.tenantId !== principal.tenantId || old.deletedAt !== null)) throw new Error('conflict');
      const now = Date.now();
      rows.set(key, {
        resourceType: input.resourceType, resourceId: input.resourceId, slug: input.slug,
        name: input.name ?? '', tenantId: principal.tenantId, creatorId: principal.userId,
        createdAt: old?.createdAt ?? now, updatedAt: now, deletedAt: null, quarantineReason: null,
      });
    },
    async rename() { return true; },
    async owns(type, id, principal = requireRequestContext()) {
      const row = rows.get(`${type}:${id}`);
      return row?.tenantId === principal.tenantId && row.deletedAt === null;
    },
    async listOwned(type, principal = requireRequestContext()) {
      return [...rows.values()].filter((row) => row.resourceType === type && row.tenantId === principal.tenantId && row.deletedAt === null);
    },
    async softDelete(type, id, principal = requireRequestContext(), deletedAt = Date.now()) {
      const row = rows.get(`${type}:${id}`);
      if (!row || row.tenantId !== principal.tenantId || row.deletedAt !== null) return false;
      row.deletedAt = deletedAt;
      return true;
    },
    async allocateSlug(_type, requested) { return requested; },
    async backfill() {},
  };
}

describe('brand production HTTP tenant lifecycle', () => {
  let root = '';
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeDatabase();
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  it('creates and deletes through the real route while denying a second tenant', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-brand-tenant-route-'));
    const dataDir = path.join(root, 'data');
    const projectsRoot = path.join(dataDir, 'projects');
    const brandsRoot = path.join(dataDir, 'brands');
    const designSystemsRoot = path.join(dataDir, 'design-systems');
    await Promise.all([fsp.mkdir(projectsRoot, { recursive: true }), fsp.mkdir(brandsRoot, { recursive: true })]);
    const db = openDatabase(process.cwd(), { dataDir });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => runWithRequestContext({
      tenantId: String(req.header('x-test-tenant') || 'missing'),
      userId: String(req.header('x-test-user') || 'user'),
    }, next));
    registerBrandRoutes(app, {
      brandsRoot, userDesignSystemsRoot: designSystemsRoot, projectsRoot,
      skillsRoot: path.resolve(process.cwd(), '../../skills'), dataDir, db,
      registry: memoryRegistry(), randomId: () => 'tenant-brand',
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (tenant: string, url: string, init: RequestInit = {}) => fetch(`${base}${url}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-test-tenant': tenant, 'x-test-user': `${tenant}-user`, ...(init.headers || {}) },
    });

    const created = await request('tenant-a', '/api/brands', {
      method: 'POST', body: JSON.stringify({ designMd: '# Acme\n\n## Colors\n- blue' }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as { id: string };
    expect(body.id).toMatch(/^acme-/u);
    expect((await request('tenant-b', `/api/brands/${body.id}`)).status).toBe(404);
    expect((await (await request('tenant-b', '/api/brands')).json() as { brands: unknown[] }).brands).toEqual([]);
    expect((await request('tenant-b', `/api/brands/${body.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await request('tenant-a', `/api/brands/${body.id}`)).status).toBe(200);
    expect((await request('tenant-a', `/api/brands/${body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await request('tenant-a', `/api/brands/${body.id}`)).status).toBe(404);
  });
});
