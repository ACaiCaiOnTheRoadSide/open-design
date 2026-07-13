// 品牌(brand kit)多租户隔离:BRANDS_DIR 是共享文件夹,可见性由 brands
// 登记表(tenant_id + ALS)决定。红线:
//   - A 租户的品牌,B 租户列表看不到、详情/logo 404、删不掉;
//   - 删除是软删:行保留 deleted_at,目录文件保留,列表/详情排除;
//   - 未登记(存量)目录默认对真实租户不可见——由启动 backfill 归属。
// 品牌创建走真实提取链路依赖外网,这里直接落盘 fixture + ALS 上下文里
// 写登记行,专测注册表这一层的过滤/软删语义。
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { insertBrandRow, openDatabase } from '../src/db.js';
import { runWithTenant } from '../src/multitenant.js';

const TENANT_A = `tenant-a-${randomUUID().slice(0, 8)}`;
const TENANT_B = `tenant-b-${randomUUID().slice(0, 8)}`;

describe('brand tenant isolation', () => {
  let server: http.Server;
  let baseUrl: string;
  let brandsRoot: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
    brandsRoot = path.join(process.env.OD_DATA_DIR!, 'brands');
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function headersFor(tenant: string) {
    return { 'Content-Type': 'application/json', 'X-Tenant-Id': tenant };
  }

  /** 直接落一个最小可 list 的品牌目录 + 在指定租户下登记归属行。 */
  async function seedBrand(tenant: string): Promise<string> {
    const id = `acme-${randomUUID().slice(0, 6)}`;
    const dir = path.join(brandsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ id, sourceUrl: 'https://acme.example', createdAt: now, updatedAt: now, status: 'ready' }),
      'utf8',
    );
    const db = await openDatabase(process.cwd());
    await runWithTenant(tenant, () => insertBrandRow(db, { id, name: `Acme ${id}` }));
    return id;
  }

  async function listBrandIds(tenant: string): Promise<string[]> {
    const resp = await fetch(`${baseUrl}/api/brands`, { headers: headersFor(tenant) });
    expect(resp.status).toBe(200);
    const payload = (await resp.json()) as { brands: Array<{ meta: { id: string } }> };
    return payload.brands.map((b) => b.meta.id);
  }

  it('hides one tenant\'s brand from another tenant entirely', async () => {
    const id = await seedBrand(TENANT_A);

    expect(await listBrandIds(TENANT_A)).toContain(id);
    expect(await listBrandIds(TENANT_B)).not.toContain(id);

    const detailB = await fetch(`${baseUrl}/api/brands/${id}`, { headers: headersFor(TENANT_B) });
    expect(detailB.status).toBe(404);
    const logoB = await fetch(`${baseUrl}/api/brands/${id}/logo`, { headers: headersFor(TENANT_B) });
    expect(logoB.status).toBe(404);
    const detailA = await fetch(`${baseUrl}/api/brands/${id}`, { headers: headersFor(TENANT_A) });
    expect(detailA.status).toBe(200);

    // B 租户删不掉 A 的品牌。
    const deleteAsB = await fetch(`${baseUrl}/api/brands/${id}`, {
      method: 'DELETE',
      headers: headersFor(TENANT_B),
    });
    expect(deleteAsB.status).toBe(404);
    expect(await listBrandIds(TENANT_A)).toContain(id);
  });

  it('deletes are soft: row keeps deleted_at, files stay on disk', async () => {
    const id = await seedBrand(TENANT_A);

    const del = await fetch(`${baseUrl}/api/brands/${id}`, {
      method: 'DELETE',
      headers: headersFor(TENANT_A),
    });
    expect(del.status).toBe(200);

    const db = await openDatabase(process.cwd());
    const row = (await db
      .prepare(`SELECT deleted_at AS deletedAt FROM brands WHERE id = ?`)
      .get(id)) as { deletedAt: number | null };
    expect(row).toBeTruthy();
    expect(row.deletedAt).not.toBeNull();

    // 目录文件保留(软删不动盘)。
    expect(fs.existsSync(path.join(brandsRoot, id, 'meta.json'))).toBe(true);

    // 列表/详情不可见,再删 404。
    expect(await listBrandIds(TENANT_A)).not.toContain(id);
    const detail = await fetch(`${baseUrl}/api/brands/${id}`, { headers: headersFor(TENANT_A) });
    expect(detail.status).toBe(404);
    const again = await fetch(`${baseUrl}/api/brands/${id}`, {
      method: 'DELETE',
      headers: headersFor(TENANT_A),
    });
    expect(again.status).toBe(404);
  });

  it('unregistered legacy brand dirs are invisible to real tenants', async () => {
    const id = `legacy-${randomUUID().slice(0, 6)}`;
    const dir = path.join(brandsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ id, sourceUrl: 'https://legacy.example', createdAt: now, updatedAt: now, status: 'ready' }),
      'utf8',
    );
    expect(await listBrandIds(TENANT_A)).not.toContain(id);
    const detail = await fetch(`${baseUrl}/api/brands/${id}`, { headers: headersFor(TENANT_A) });
    expect(detail.status).toBe(404);
  });
});
