import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteMemoryEntriesByProject,
  listMemoryEntries,
  upsertMemoryEntry,
} from '../src/memory.js';
import { dropState, initSyncEngine } from '../src/sync/engine.js';

let dataDir = '';

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-project-delete-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

// 项目删除只删 PROJECTS_DIR/<id> 与 DB 行;记忆是按租户落盘的兄弟目录,
// 必须由 deleteMemoryEntriesByProject 显式级联,否则项目级记忆永久泄漏。
describe('deleteMemoryEntriesByProject', () => {
  it('removes only the entries scoped to the deleted project', async () => {
    await upsertMemoryEntry(
      dataDir,
      { name: 'Doomed fact', type: 'project', body: '- scoped to p1', projectId: 'p1' },
      { silent: true },
    );
    await upsertMemoryEntry(
      dataDir,
      { name: 'Other project fact', type: 'project', body: '- scoped to p2', projectId: 'p2' },
      { silent: true },
    );
    await upsertMemoryEntry(
      dataDir,
      { name: 'Global fact', type: 'user', body: '- no project' },
      { silent: true },
    );

    const deleted = await deleteMemoryEntriesByProject(dataDir, 'p1');

    expect(deleted).toBe(1);
    const remaining = await listMemoryEntries(dataDir);
    expect(remaining.map((e) => e.projectId).sort()).toEqual([null, 'p2'].sort());
  });

  it('is a no-op for blank project ids (never nukes global memory)', async () => {
    await upsertMemoryEntry(
      dataDir,
      { name: 'Global fact', type: 'user', body: '- no project' },
      { silent: true },
    );

    expect(await deleteMemoryEntriesByProject(dataDir, '')).toBe(0);
    expect(await deleteMemoryEntriesByProject(dataDir, undefined as any)).toBe(0);
    expect(await listMemoryEntries(dataDir)).toHaveLength(1);
  });
});

// sync/<projectId>.json 状态文件同样在项目目录之外;冷淘汰只回收"已同步"
// 项目,显式删除必须走 dropState,否则状态文件成为孤儿。
describe('sync engine dropState', () => {
  it('removes the per-project sync state file on explicit delete', async () => {
    const projectsDir = path.join(dataDir, 'projects');
    await fsp.mkdir(projectsDir, { recursive: true });
    initSyncEngine({ runtimeDataDir: dataDir, projectsDir });

    const stateFile = path.join(dataDir, 'sync', 'p1.json');
    await fsp.mkdir(path.dirname(stateFile), { recursive: true });
    await fsp.writeFile(stateFile, JSON.stringify({ baseVersion: 3 }));

    await dropState('p1');

    await expect(fsp.access(stateFile)).rejects.toThrow();
  });

  it('ignores unsafe project ids', async () => {
    const projectsDir = path.join(dataDir, 'projects');
    await fsp.mkdir(projectsDir, { recursive: true });
    initSyncEngine({ runtimeDataDir: dataDir, projectsDir });

    // Must not throw or touch anything outside the sync dir.
    await dropState('../escape');
    await dropState('');
  });
});
