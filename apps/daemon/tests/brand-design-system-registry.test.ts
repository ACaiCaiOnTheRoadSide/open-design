import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  createBrandDesignSystemRegistry,
  LEGACY_QUARANTINE_TENANT,
} from '../src/storage/brand-design-system-registry.js';
import type { VerifiedPrincipal } from '../src/request-context.js';

interface Row extends QueryResultRow {
  resource_type: 'brand' | 'design_system';
  resource_id: string;
  slug: string;
  name: string;
  tenant_id: string;
  creator_id: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  quarantine_reason: string | null;
}

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: '', rowCount: rows.length, oid: 0, fields: [], rows };
}

function harness() {
  const rows = new Map<string, Row>();
  const key = (type: string, id: string) => `${type}:${id}`;
  const execute = async <R extends QueryResultRow>(sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('INSERT INTO brand_design_system_registry') && sql.includes('quarantine_reason')) {
      const [type, id, slug, name, tenant, creator, created, updated, reason] = values;
      const resourceKey = key(String(type), String(id));
      if (!rows.has(resourceKey)) rows.set(resourceKey, {
        resource_type: type as Row['resource_type'], resource_id: String(id), slug: String(slug), name: String(name),
        tenant_id: String(tenant), creator_id: String(creator), created_at: Number(created), updated_at: Number(updated),
        deleted_at: null, quarantine_reason: reason == null ? null : String(reason),
      });
      return result([] as R[]);
    }
    if (sql.includes('INSERT INTO brand_design_system_registry')) {
      const [type, id, slug, name, tenant, creator, created, updated] = values;
      const resourceKey = key(String(type), String(id));
      const old = rows.get(resourceKey);
      if (!old) {
        const duplicateSlug = [...rows.values()].some((row) => row.resource_type === type
          && row.tenant_id === tenant && row.slug === slug && row.deleted_at === null);
        if (duplicateSlug) throw new Error('duplicate tenant slug');
        const row: Row = {
          resource_type: type as Row['resource_type'], resource_id: String(id), slug: String(slug), name: String(name),
          tenant_id: String(tenant), creator_id: String(creator), created_at: Number(created), updated_at: Number(updated),
          deleted_at: null, quarantine_reason: null,
        };
        rows.set(resourceKey, row);
        return result([row as unknown as R]);
      }
      if (old.tenant_id !== tenant || old.deleted_at !== null) return result([] as R[]);
      old.name = String(name);
      old.updated_at = Math.max(old.updated_at, Number(updated));
      return result([old as unknown as R]);
    }
    if (sql.includes('SET deleted_at')) {
      const [type, id, tenant, deletedAt] = values;
      const row = rows.get(key(String(type), String(id)));
      if (!row || row.tenant_id !== tenant || row.deleted_at !== null) return result([] as R[]);
      row.deleted_at = Number(deletedAt);
      row.updated_at = Math.max(row.updated_at, Number(deletedAt));
      return result([row as unknown as R]);
    }
    if (sql.includes('SELECT resource_type')) {
      const [type, tenant] = values;
      return result([...rows.values()].filter((row) => row.resource_type === type
        && row.tenant_id === tenant && row.deleted_at === null) as unknown as R[]);
    }
    if (sql.includes('slug = $3')) {
      const [type, tenant, slug] = values;
      const found = [...rows.values()].filter((row) => row.resource_type === type
        && row.tenant_id === tenant && row.slug === slug && row.deleted_at === null);
      return result(found as unknown as R[]);
    }
    if (sql.includes('SELECT 1')) {
      const [type, id, tenant] = values;
      const row = rows.get(key(String(type), String(id)));
      return result((row && row.tenant_id === tenant && row.deleted_at === null ? [row] : []) as unknown as R[]);
    }
    if (sql.includes('SET name')) return result([] as R[]);
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const registry = createBrandDesignSystemRegistry({
    enabled: true,
    query: execute,
    transaction: async (work) => work({ query: execute }),
  });
  return { registry, rows };
}

const principal = (tenantId: string): VerifiedPrincipal => ({ tenantId, userId: `${tenantId}-user` });

describe('brand/design-system tenant registry', () => {
  it('isolates two tenants and resolves slug conflicts within each tenant only', async () => {
    const { registry } = harness();
    await registry.register({ resourceType: 'design_system', resourceId: 'ds-a', slug: 'acme', name: 'A' }, principal('a'));
    await registry.register({ resourceType: 'design_system', resourceId: 'ds-b', slug: 'acme', name: 'B' }, principal('b'));

    expect(await registry.owns('design_system', 'ds-a', principal('a'))).toBe(true);
    expect(await registry.owns('design_system', 'ds-a', principal('b'))).toBe(false);
    expect((await registry.listOwned('design_system', principal('b'))).map((row) => row.resourceId)).toEqual(['ds-b']);
    expect(await registry.allocateSlug('design_system', 'acme', principal('a'))).toBe('acme-2');
    expect(await registry.allocateSlug('design_system', 'other', principal('b'))).toBe('other');
  });

  it('soft-delete is atomic and a concurrent/stale register cannot resurrect files', async () => {
    const { registry, rows } = harness();
    const owner = principal('tenant');
    await registry.register({ resourceType: 'brand', resourceId: 'brand-1', slug: 'brand', name: 'Brand' }, owner);
    const deletes = await Promise.all([
      registry.softDelete('brand', 'brand-1', owner, 100),
      registry.softDelete('brand', 'brand-1', owner, 101),
    ]);
    expect(deletes.filter(Boolean)).toHaveLength(1);
    await expect(registry.register({ resourceType: 'brand', resourceId: 'brand-1', slug: 'brand', name: 'stale' }, owner))
      .rejects.toThrow(/deleted resource/);
    expect(rows.get('brand:brand-1')?.deleted_at).not.toBeNull();
    expect(await registry.owns('brand', 'brand-1', owner)).toBe(false);
  });

  it('backfills trusted owners and explicitly quarantines unverifiable legacy directories', async () => {
    const { registry, rows } = harness();
    await registry.backfill([
      { resourceType: 'brand', resourceId: 'known', slug: 'known', owner: principal('trusted') },
      { resourceType: 'design_system', resourceId: 'unknown', slug: 'unknown' },
    ]);
    expect(rows.get('brand:known')?.tenant_id).toBe('trusted');
    expect(rows.get('design_system:unknown')).toMatchObject({
      tenant_id: LEGACY_QUARANTINE_TENANT,
      creator_id: LEGACY_QUARANTINE_TENANT,
      quarantine_reason: 'ownership-unverifiable',
    });
    expect(await registry.owns('design_system', 'unknown', principal('trusted'))).toBe(false);
  });
});
