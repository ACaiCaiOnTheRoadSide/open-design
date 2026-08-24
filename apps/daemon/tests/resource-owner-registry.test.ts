import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../src/request-context.js';
import { createResourceOwnerRegistry } from '../src/storage/resource-owner-registry.js';
import type { PgQueryable } from '../src/storage/pg.js';

function fakePg() {
  const rows = new Map<string, { tenant: string; domain: string; deleted: boolean }>();
  const pg: PgQueryable = {
    async query(text: string, values: readonly unknown[] = []) {
      if (text.startsWith('INSERT')) {
        const [kind, id] = values as string[];
        const backend = text.includes("'__backend__'");
        const tenant = backend ? '__backend__' : String(values[2]);
        const key = `${kind}:${tenant}:${id}`;
        const existing = rows.get(key);
        if (!existing || existing.domain === (backend ? 'backend' : 'user')) {
          rows.set(key, { tenant, domain: backend ? 'backend' : 'user', deleted: false });
        }
        return { rows: [], rowCount: 1 } as never;
      }
      if (text.startsWith('UPDATE')) {
        const [kind, id, tenant] = values as string[];
        const row = rows.get(`${kind}:${tenant}:${id}`);
        if (row?.domain === 'user' && !row.deleted) { row.deleted = true; return { rows: [], rowCount: 1 } as never; }
        return { rows: [], rowCount: 0 } as never;
      }
      const [kind, idOrIds, tenant] = values as [string, string | string[], string | undefined];
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      const visible = ids.filter((id) => [...rows.entries()].some(([key, row]) => {
        if (!key.startsWith(`${kind}:`) || !key.endsWith(`:${id}`) || row.deleted) return false;
        if (tenant === undefined && text.includes("management_domain = 'backend'")) return row.domain === 'backend';
        if (tenant === undefined) return true;
        return row.tenant === tenant || row.domain === 'backend';
      }));
      return { rows: visible.map((resource_id) => ({ resource_id })), rowCount: visible.length } as never;
    },
  };
  return { pg, rows };
}

describe('SaaS resource owner registry', () => {
  it('隔离两租户同 id，并将无 owner 历史数据 quarantine', async () => {
    const { pg } = fakePg();
    const registry = createResourceOwnerRegistry(pg);
    await runWithRequestContext({ tenantId: 'tenant-a', userId: 'alice' }, () =>
      registry.registerUser({ kind: 'plugin', id: 'same-slug', sourceKind: 'github', retrievalUrl: 'https://example.test/a.tgz' }));
    await runWithRequestContext({ tenantId: 'tenant-b', userId: 'bob' }, () =>
      registry.registerUser({ kind: 'plugin', id: 'same-slug', sourceKind: 'github', retrievalUrl: 'https://example.test/b.tgz' }));

    await expect(registry.isVisible('plugin', 'same-slug', { tenantId: 'tenant-a', userId: 'alice' })).resolves.toBe(true);
    await expect(registry.isVisible('plugin', 'same-slug', { tenantId: 'tenant-b', userId: 'bob' })).resolves.toBe(true);
    await expect(registry.isVisible('plugin', 'legacy-no-owner', { tenantId: 'tenant-a', userId: 'alice' })).resolves.toBe(false);
  });

  it('软删仅影响当前租户，backend 管理域仍全局可见', async () => {
    const { pg } = fakePg();
    const registry = createResourceOwnerRegistry(pg);
    await registry.registerUser({ kind: 'library_asset', id: 'asset-1' }, { tenantId: 'a', userId: 'u1' });
    await registry.registerUser({ kind: 'library_asset', id: 'asset-1' }, { tenantId: 'b', userId: 'u2' });
    await expect(registry.release('library_asset', 'asset-1', { tenantId: 'a', userId: 'u1' }))
      .resolves.toEqual({ deleted: true, hasActiveOwners: true });
    await expect(registry.isVisible('library_asset', 'asset-1', { tenantId: 'a', userId: 'u1' })).resolves.toBe(false);
    await expect(registry.isVisible('library_asset', 'asset-1', { tenantId: 'b', userId: 'u2' })).resolves.toBe(true);

    await registry.registerBackend({ kind: 'plugin', id: 'managed', sourceKind: 'github', retrievalUrl: 'https://example.test/managed.tgz' });
    await expect(registry.isBackendManaged('plugin', 'managed')).resolves.toBe(true);
    await expect(registry.isVisible('plugin', 'managed', { tenantId: 'a', userId: 'u1' })).resolves.toBe(true);
    await expect(registry.softDelete('plugin', 'managed', { tenantId: 'a', userId: 'u1' })).resolves.toBe(false);
  });

  it('local/upload 必须声明 PVC 路径且不能伪装为可重取', async () => {
    const registry = createResourceOwnerRegistry(fakePg().pg);
    await expect(registry.registerUser({ kind: 'plugin', id: 'local', sourceKind: 'local' }, { tenantId: 'a', userId: 'u' }))
      .rejects.toThrow('PVC localPath');
    await expect(registry.registerUser({ kind: 'plugin', id: 'upload', sourceKind: 'upload', localPath: '/pvc/x', retrievalUrl: 'https://evil.test/x' }, { tenantId: 'a', userId: 'u' }))
      .rejects.toThrow('not remotely retrievable');
  });
});
