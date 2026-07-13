// 用户设计体系多租户隔离:文件本体在共享目录,可见性由 design_systems
// 登记表(tenant_id + ALS)决定。红线:
//   - A 租户创建的设计体系,B 租户列表看不到、详情/文件 404、删不掉;
//   - 删除是软删:deleted_at 置位、行保留、目录文件保留,列表/读取排除;
//   - 登记行记录 creator_id(X-OD-User-Id)做归因。
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import {
  getDesignSystemRow,
  insertDesignSystem,
  openDatabase,
  softDeleteDesignSystem,
} from '../src/db.js';
import { runWithTenant } from '../src/multitenant.js';

const TENANT_A = `tenant-a-${randomUUID().slice(0, 8)}`;
const TENANT_B = `tenant-b-${randomUUID().slice(0, 8)}`;

describe('design system tenant isolation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function headersFor(tenant: string, userId?: string) {
    return {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenant,
      ...(userId ? { 'X-OD-User-Id': userId } : {}),
    };
  }

  async function createDesignSystem(tenant: string, title: string, userId?: string) {
    const resp = await fetch(`${baseUrl}/api/design-systems`, {
      method: 'POST',
      headers: headersFor(tenant, userId),
      body: JSON.stringify({ title }),
    });
    expect(resp.status).toBe(201);
    const payload = (await resp.json()) as { designSystem: { id: string } };
    return payload.designSystem.id;
  }

  async function listIds(tenant: string): Promise<string[]> {
    const resp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: headersFor(tenant),
    });
    expect(resp.status).toBe(200);
    const payload = (await resp.json()) as { designSystems: Array<{ id: string }> };
    return payload.designSystems.map((s) => s.id);
  }

  it('hides one tenant\'s design system from another tenant entirely', async () => {
    const id = await createDesignSystem(TENANT_A, `Isolation ${randomUUID().slice(0, 6)}`, 'user-a');

    expect(await listIds(TENANT_A)).toContain(id);
    expect(await listIds(TENANT_B)).not.toContain(id);

    // 详情 / 文件 / 归档,B 租户一律 404。
    for (const path of [
      `/api/design-systems/${encodeURIComponent(id)}`,
      `/api/design-systems/${encodeURIComponent(id)}/files`,
      `/api/design-systems/${encodeURIComponent(id)}/archive`,
    ]) {
      const respB = await fetch(`${baseUrl}${path}`, { headers: headersFor(TENANT_B) });
      expect(respB.status).toBe(404);
      const respA = await fetch(`${baseUrl}${path}`, { headers: headersFor(TENANT_A) });
      expect(respA.status).toBe(200);
    }

    // B 租户删不掉 A 的设计体系;行保持存活。
    const deleteAsB = await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headersFor(TENANT_B),
    });
    expect(deleteAsB.status).toBe(404);
    expect(await listIds(TENANT_A)).toContain(id);
  });

  it('records tenant + creator attribution on the registry row', async () => {
    const id = await createDesignSystem(TENANT_A, `Attribution ${randomUUID().slice(0, 6)}`, 'user-a');
    const dirId = id.replace(/^user:/, '');

    const db = await openDatabase(process.cwd());
    const row = (await db
      .prepare(
        `SELECT tenant_id AS tenantId, creator_id AS creatorId, deleted_at AS deletedAt
           FROM design_systems WHERE id = ?`,
      )
      .get(dirId)) as { tenantId: string; creatorId: string | null; deletedAt: number | null };
    expect(row).toBeTruthy();
    expect(row.tenantId).toBe(TENANT_A);
    expect(row.creatorId).toBe('user-a');
    expect(row.deletedAt).toBeNull();
  });

  it('deletes are soft: row keeps deleted_at, listing/detail exclude it', async () => {
    const id = await createDesignSystem(TENANT_A, `SoftDelete ${randomUUID().slice(0, 6)}`, 'user-a');
    const dirId = id.replace(/^user:/, '');

    const del = await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headersFor(TENANT_A),
    });
    expect(del.status).toBe(204);

    // 行还在,deleted_at 置位——不是硬删。
    const db = await openDatabase(process.cwd());
    const row = (await db
      .prepare(`SELECT deleted_at AS deletedAt FROM design_systems WHERE id = ?`)
      .get(dirId)) as { deletedAt: number | null };
    expect(row).toBeTruthy();
    expect(row.deletedAt).not.toBeNull();

    // 列表与详情从此不可见(本租户也一样)。
    expect(await listIds(TENANT_A)).not.toContain(id);
    const detail = await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}`, {
      headers: headersFor(TENANT_A),
    });
    expect(detail.status).toBe(404);

    // 再删一次 → 404(行已软删,tenant WHERE 匹配不到存活行)。
    const again = await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headersFor(TENANT_A),
    });
    expect(again.status).toBe(404);
  });

  it('re-registering a soft-deleted id revives it (clears deleted_at), same tenant', async () => {
    // 品牌重新 finalize 会复用同一 designSystemId,走 insertDesignSystem 撞
    // 已软删行。ON CONFLICT DO NOTHING 会让 deleted_at 残留、体系永不可见;
    // 现在同租户复用应复活并刷新 name。
    const db = await openDatabase(process.cwd());
    const id = `revive-${randomUUID().slice(0, 6)}`;
    await runWithTenant(TENANT_A, () => insertDesignSystem(db, { id, name: 'V1', source: 'created' }));
    await runWithTenant(TENANT_A, () => softDeleteDesignSystem(db, id));
    expect(await runWithTenant(TENANT_A, () => getDesignSystemRow(db, id))).toBeNull();

    const revived = await runWithTenant(TENANT_A, () =>
      insertDesignSystem(db, { id, name: 'V2', source: 'brand' }));
    expect(revived).not.toBeNull();
    expect(revived?.name).toBe('V2');
    const row = await runWithTenant(TENANT_A, () => getDesignSystemRow(db, id));
    expect(row).not.toBeNull();
  });

  it('re-registering an id owned by another tenant does not steal it', async () => {
    // 跨租户撞 id:B 的 insert 不能改到 A 的行(WHERE tenant 限定)。A 保持原样,
    // B 视角看不到(insertDesignSystem 返回 null)。
    const db = await openDatabase(process.cwd());
    const id = `nosteal-${randomUUID().slice(0, 6)}`;
    await runWithTenant(TENANT_A, () => insertDesignSystem(db, { id, name: 'OwnedByA', source: 'created' }));

    const bView = await runWithTenant(TENANT_B, () =>
      insertDesignSystem(db, { id, name: 'StolenByB', source: 'created' }));
    expect(bView).toBeNull(); // B 看不到这行

    const aRow = await runWithTenant(TENANT_A, () => getDesignSystemRow(db, id));
    expect(aRow?.name).toBe('OwnedByA'); // A 的行没被 B 改动
  });

  it('keeps built-in design systems visible to every tenant', async () => {
    const a = await listIds(TENANT_A);
    const b = await listIds(TENANT_B);
    const builtInA = a.filter((id) => !id.startsWith('user:'));
    const builtInB = b.filter((id) => !id.startsWith('user:'));
    expect(builtInA.length).toBeGreaterThan(0);
    expect(builtInB).toEqual(builtInA);
  });
});
