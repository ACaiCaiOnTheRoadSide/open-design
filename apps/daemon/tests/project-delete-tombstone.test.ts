// 项目删除墓碑:DELETE /api/projects/:id 硬删 projects 行之前,必须把
// id/tenant/name/created_at 拷入 deleted_projects,后台"创建过的项目数"
// 统计(现存 projects + deleted_projects)才不随删除缩水。
// 创建失败的回滚删除(deleteProject 的 tombstone:false)不写墓碑 ——
// 那种项目用户从未真正拥有过。
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { deleteProject, openDatabase } from '../src/db.js';

describe('project delete tombstone', () => {
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

  async function createProject(id: string, name: string) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    expect(resp.status).toBe(200);
  }

  it('copies the project row into deleted_projects before hard-deleting', async () => {
    const id = `tomb-${randomUUID().slice(0, 8)}`;
    await createProject(id, `Tombstone ${id}`);

    // 生前攒两次下载:删除后计数必须随墓碑保留(后台列表已删项目也展示下载次数)。
    for (let i = 0; i < 2; i += 1) {
      const bump = await fetch(`${baseUrl}/api/projects/${id}/download-events`, { method: 'POST' });
      expect(bump.status).toBe(200);
    }

    const resp = await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' });
    expect(resp.status).toBe(200);

    const db = await openDatabase(process.cwd());
    const gone = await db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id);
    expect(gone).toBeFalsy();

    const tomb = (await db
      .prepare(
        `SELECT tenant_id AS tenantId, name, created_at AS createdAt, deleted_at AS deletedAt,
                download_count AS downloadCount
           FROM deleted_projects WHERE id = ?`,
      )
      .get(id)) as
      | {
          tenantId: string;
          name: string;
          createdAt: number | string;
          deletedAt: number | string;
          downloadCount: number | string;
        }
      | undefined;
    expect(tomb).toBeTruthy();
    expect(tomb!.name).toBe(`Tombstone ${id}`);
    // 无 X-Tenant-Id 的直连请求落在 __legacy__ 租户,墓碑必须继承同一租户。
    expect(tomb!.tenantId).toBe('__legacy__');
    expect(Number(tomb!.createdAt)).toBeGreaterThan(0);
    expect(Number(tomb!.deletedAt)).toBeGreaterThanOrEqual(Number(tomb!.createdAt));
    expect(Number(tomb!.downloadCount)).toBe(2);
  });

  it('skips the tombstone for creation-rollback deletes (tombstone:false)', async () => {
    const id = `tomb-${randomUUID().slice(0, 8)}`;
    await createProject(id, `Rollback ${id}`);

    const db = await openDatabase(process.cwd());
    await deleteProject(db, id, { tombstone: false });

    const gone = await db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id);
    expect(gone).toBeFalsy();
    const tomb = await db.prepare(`SELECT id FROM deleted_projects WHERE id = ?`).get(id);
    expect(tomb).toBeFalsy();
  });
});
