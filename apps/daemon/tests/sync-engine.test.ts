// Daemon sync engine against an in-memory manifest/blob backend: flush must
// make the store mirror the local disk (upload blobs, commit a CAS diff),
// re-flush with no changes must commit nothing, hydrate must apply only the
// remote diff (download changed files, delete dropped ones) and the eviction
// sweep must reclaim only cold, fully-synced projects — the next hydrate
// rebuilds the directory from the manifest.
import Database from 'better-sqlite3';
import { createHmac, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureWorkspaceProject } from '../src/db.js';
import { createFakeSyncBackend, sha } from './helpers/fake-sync-backend.js';

describe('sync engine', () => {
  let backend: ReturnType<typeof createFakeSyncBackend>;
  let server: http.Server;
  let dataDir: string;
  let projectsDir: string;
  let engine: typeof import('../src/sync/engine.js');
  const activeRuns = new Set<string>();

  beforeAll(async () => {
    backend = createFakeSyncBackend();
    server = backend.server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.OD_BACKEND_URL = `http://127.0.0.1:${port}`;
    process.env.OD_API_TOKEN = 'test-token';

    dataDir = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-engine-'));
    projectsDir = join(dataDir, 'projects');
    await fsp.mkdir(projectsDir, { recursive: true });

    engine = await import('../src/sync/engine.js');
    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      hasActiveRun: (id) => activeRuns.has(id),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(dataDir, { recursive: true, force: true });
    delete process.env.OD_BACKEND_URL;
    delete process.env.OD_API_TOKEN;
  });

  it('daemon routes hydrate missing managed files and debounce successful writes', async () => {
    process.env.OD_DATA_DIR = dataDir;
    const { startServer } = await import('../src/server.js');
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown: () => Promise<void>;
    };
    const projectId = `route-sync-${randomUUID()}`;
    let deleted = false;
    try {
      const cliResponse = await fetch(`${started.url}/api/od-cli.mjs`);
      expect([200, 404]).toContain(cliResponse.status);
      if (cliResponse.status === 404) {
        await expect(cliResponse.json()).resolves.toEqual({
          error: 'od-cli bundle not built; run `pnpm --filter @open-design/daemon build`',
        });
      }

      const createResponse = await fetch(`${started.url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: 'Route sync integration' }),
      });
      expect(createResponse.status).toBe(200);
      const sqlite = new Database(join(dataDir, 'app.sqlite'));
      try {
        ensureWorkspaceProject(sqlite as never, {
          projectId,
          workspaceId: 'workspace-owner',
          visibility: 'personal',
          createdByWorkspaceMemberId: 'member-owner',
        });
      } finally {
        sqlite.close();
      }

      const remoteContent = 'from-remote';
      const remoteHash = sha(remoteContent);
      backend.blobs.set(remoteHash, Buffer.from(remoteContent));
      backend.manifests.set(projectId, {
        version: 1,
        files: {
          'remote.txt': {
            sha256: remoteHash,
            size: Buffer.byteLength(remoteContent),
            mtime: Date.now(),
          },
        },
      });
      await fsp.rm(join(projectsDir, projectId), { recursive: true, force: true });

      const listResponse = await fetch(`${started.url}/api/projects/${projectId}/files`);
      expect(listResponse.status).toBe(200);
      const detailResponse = await fetch(`${started.url}/api/projects/${projectId}`);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json() as { resolvedDir: string };
      await expect(fsp.readFile(join(detail.resolvedDir, 'remote.txt'), 'utf8'))
        .resolves.toBe(remoteContent);

      const roundEndContent = 'from-sandbox-round';
      const roundEndHash = sha(roundEndContent);
      backend.blobs.set(roundEndHash, Buffer.from(roundEndContent));
      backend.manifests.set(projectId, {
        version: 2,
        files: {
          'remote.txt': {
            sha256: roundEndHash,
            size: Buffer.byteLength(roundEndContent),
            mtime: Date.now(),
          },
        },
      });
      const deniedPullResponse = await fetch(`${started.url}/api/projects/${projectId}/sync/pull`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-od-workspace-id': 'workspace-foreign',
          'x-od-workspace-member-id': 'member-foreign',
        },
        body: JSON.stringify({ ifMissing: false }),
      });
      expect(deniedPullResponse.status).toBe(403);
      await expect(fsp.readFile(join(detail.resolvedDir, 'remote.txt'), 'utf8'))
        .resolves.toBe(remoteContent);

      const unsignedPullResponse = await fetch(`${started.url}/api/projects/${projectId}/sync/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ifMissing: false }),
      });
      expect(unsignedPullResponse.status).toBe(401);

      // Headerless daemon callbacks remain compatible with Huskbox beforeExit
      // and backend lazy restore through a token-derived service signature.
      const syncSignature = createHmac('sha256', 'test-token').update(projectId).digest('hex');
      const pullResponse = await fetch(`${started.url}/api/projects/${projectId}/sync/pull`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-od-sync-signature': syncSignature,
        },
        body: JSON.stringify({ ifMissing: false }),
      });
      expect(pullResponse.status).toBe(200);
      await expect(fsp.readFile(join(detail.resolvedDir, 'remote.txt'), 'utf8'))
        .resolves.toBe(roundEndContent);

      const writeResponse = await fetch(`${started.url}/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'local.txt', content: 'from-route' }),
      });
      expect(writeResponse.status).toBe(200);

      await expect.poll(
        () => backend.manifests.get(projectId)?.files['local.txt']?.sha256,
        { timeout: 5_000 },
      ).toBe(sha('from-route'));
      await expect(fsp.stat(join(dataDir, 'sync', `${projectId}.json`))).resolves.toBeDefined();

      const deleteResponse = await fetch(`${started.url}/api/projects/${projectId}`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);
      deleted = true;
      await expect(fsp.stat(join(dataDir, 'sync', `${projectId}.json`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (!deleted) {
        await fetch(`${started.url}/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
      }
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      await started.shutdown();
      delete process.env.OD_DATA_DIR;
      engine.initSyncEngine({
        runtimeDataDir: dataDir,
        projectsDir,
        hasActiveRun: (id) => activeRuns.has(id),
      });
    }
  });

  it('backfills namespaced brand/design-system directories and hydrates them after restart', async () => {
    const brandsDir = join(dataDir, 'brands');
    const designSystemsDir = join(dataDir, 'design-systems');
    await fsp.mkdir(join(brandsDir, 'acme'), { recursive: true });
    await fsp.mkdir(join(designSystemsDir, 'kit'), { recursive: true });
    await fsp.writeFile(join(brandsDir, 'acme', 'meta.json'), '{"name":"Acme"}');
    await fsp.writeFile(join(designSystemsDir, 'kit', 'DESIGN.md'), '# Kit');
    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      resourceNamespaces: {
        brand: { prefix: 'brnd--', rootDir: brandsDir },
        'design-system': { prefix: 'dsys--', rootDir: designSystemsDir },
      },
    });
    const scheduled = await engine.backfillRegisteredResourceNamespaces();
    expect(scheduled).toEqual(expect.arrayContaining(['brnd--acme', 'dsys--kit']));
    await engine.shutdownSyncEngine();
    expect(backend.manifests.get('brnd--acme')?.files['meta.json']?.sha256).toBe(sha('{"name":"Acme"}'));
    expect(backend.manifests.get('dsys--kit')?.files['DESIGN.md']?.sha256).toBe(sha('# Kit'));

    await fsp.rm(join(brandsDir, 'acme'), { recursive: true, force: true });
    await fsp.rm(join(designSystemsDir, 'kit'), { recursive: true, force: true });
    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      resourceNamespaces: {
        brand: { prefix: 'brnd--', rootDir: brandsDir },
        'design-system': { prefix: 'dsys--', rootDir: designSystemsDir },
      },
    });
    await engine.hydrateResource('brand', 'acme', { ifMissing: true });
    await engine.hydrateResource('design-system', 'kit', { ifMissing: true });
    await expect(fsp.readFile(join(brandsDir, 'acme', 'meta.json'), 'utf8')).resolves.toBe('{"name":"Acme"}');
    await expect(fsp.readFile(join(designSystemsDir, 'kit', 'DESIGN.md'), 'utf8')).resolves.toBe('# Kit');

    engine.initSyncEngine({ runtimeDataDir: dataDir, projectsDir, hasActiveRun: (id) => activeRuns.has(id) });
  });

  it('shutdown clears a pending debounce and persists its dirty write immediately', async () => {
    const p = 'proj-shutdown-dirty';
    await fsp.mkdir(join(projectsDir, p), { recursive: true });
    await engine.runProjectMutation(p, undefined, async () => {
      await fsp.writeFile(join(projectsDir, p, 'shutdown.txt'), 'written-before-sigterm');
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    engine.markDirty(p);
    const debounceTimer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
    setTimeoutSpy.mockRestore();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await engine.shutdownSyncEngine();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(debounceTimer);
      expect(backend.manifests.get(p)?.files['shutdown.txt']?.sha256)
        .toBe(sha('written-before-sigterm'));
      expect(backend.blobs.get(sha('written-before-sigterm'))?.toString())
        .toBe('written-before-sigterm');
    } finally {
      clearTimeoutSpy.mockRestore();
      engine.initSyncEngine({
        runtimeDataDir: dataDir,
        projectsDir,
        hasActiveRun: (id) => activeRuns.has(id),
      });
    }
  });

  it('shutdown re-drains a visited runtime when an admitted mutation appends descendant work', async () => {
    const p = 'proj-shutdown-appended';
    await fsp.mkdir(join(projectsDir, p), { recursive: true });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let descendant: Promise<void> | undefined;

    const first = engine.runProjectMutation(p, undefined, async () => {
      await firstMayFinish;
      descendant = engine.runProjectMutation(p, undefined, async () => {
        await fsp.writeFile(join(projectsDir, p, 'late.txt'), 'late-admitted-write');
        engine.markDirty(p);
      });
    });
    // Let runProjectMutation synchronously register the first mutation before
    // shutdown closes admission and observes this runtime.
    await Promise.resolve();
    const shutdown = engine.shutdownSyncEngine();

    await expect(engine.runProjectMutation(p, undefined, async () => {
      throw new Error('must not run');
    })).rejects.toThrow('new project mutations are not accepted');

    releaseFirst();
    await first;
    await descendant;
    await shutdown;

    expect(backend.manifests.get(p)?.files['late.txt']?.sha256).toBe(sha('late-admitted-write'));
    expect(backend.blobs.get(sha('late-admitted-write'))?.toString()).toBe('late-admitted-write');

    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      hasActiveRun: (id) => activeRuns.has(id),
    });
  });

  it('shutdown actively aborts a half-open sync request instead of waiting for its deadline', async () => {
    let requests = 0;
    const halfOpen = (await import('node:http')).createServer((_req, _res) => { requests += 1; });
    await new Promise<void>((resolve) => halfOpen.listen(0, '127.0.0.1', resolve));
    const halfOpenPort = (halfOpen.address() as AddressInfo).port;
    const previousBackendUrl = process.env.OD_BACKEND_URL!;
    const p = 'proj-shutdown-half-open';
    await fsp.mkdir(join(projectsDir, p), { recursive: true });
    process.env.OD_BACKEND_URL = `http://127.0.0.1:${halfOpenPort}`;
    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      requestDeadlineMs: 60_000,
    });
    try {
      const hydration = engine.hydrate(p);
      // Attach the rejection assertion before shutdown aborts the request so
      // strict unhandled-rejection mode never observes a bare rejected promise.
      const hydrationResult = expect(hydration).rejects.toThrow('sync engine shutting down');
      await expect.poll(() => requests).toBe(1);
      const startedAt = Date.now();
      await engine.shutdownSyncEngine();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await hydrationResult;
      expect(requests).toBe(1);
    } finally {
      halfOpen.closeAllConnections();
      await new Promise<void>((resolve) => halfOpen.close(() => resolve()));
      process.env.OD_BACKEND_URL = previousBackendUrl;
      engine.initSyncEngine({
        runtimeDataDir: dataDir,
        projectsDir,
        hasActiveRun: (id) => activeRuns.has(id),
      });
    }
  });

  it('flush pushes local files as blobs + manifest diff', async () => {
    const p = 'proj-flush';
    await fsp.mkdir(join(projectsDir, p, 'assets'), { recursive: true });
    await fsp.writeFile(join(projectsDir, p, 'index.html'), '<html>1</html>');
    await fsp.writeFile(join(projectsDir, p, 'assets', 'v.mp4'), 'video-bytes');

    const result = await engine.flush(p);
    expect(result.enabled).toBe(true);
    expect(result.manifest?.version).toBe(1);

    const remote = backend.manifests.get(p)!;
    expect(Object.keys(remote.files).sort()).toEqual(['assets/v.mp4', 'index.html']);
    expect(backend.blobs.has(sha('video-bytes'))).toBe(true);
    expect(backend.blobs.has(sha('<html>1</html>'))).toBe(true);
  });

  it('flush with no changes commits nothing', async () => {
    const p = 'proj-flush';
    const commitsBefore = backend.diffCommits;
    const result = await engine.flush(p);
    expect(result.manifest?.version).toBe(1);
    expect(backend.diffCommits).toBe(commitsBefore);
  });

  it('flush ships only the changed file and unchanged blobs are not re-uploaded', async () => {
    const p = 'proj-flush';
    await fsp.writeFile(join(projectsDir, p, 'index.html'), '<html>2</html>');
    backend.blobs.delete(sha('video-bytes')); // would 404 if re-uploaded… prove we don't touch it
    const before = backend.diffCommits;
    await engine.flush(p);
    expect(backend.diffCommits).toBe(before + 1);
    expect(backend.blobs.has(sha('<html>2</html>'))).toBe(true);
    expect(backend.blobs.has(sha('video-bytes'))).toBe(false);
    backend.blobs.set(sha('video-bytes'), Buffer.from('video-bytes'));
  });

  it('local deletion propagates as a manifest delete', async () => {
    const p = 'proj-flush';
    await fsp.rm(join(projectsDir, p, 'assets', 'v.mp4'));
    await engine.flush(p);
    expect(backend.manifests.get(p)!.files['assets/v.mp4']).toBeUndefined();
  });

  it('hydrate applies the remote diff: downloads changes, deletes dropped files', async () => {
    const p = 'proj-flush';
    // Simulate a sandbox round-end save: rewrite index.html, add report.md,
    // delete nothing.
    const newIndex = '<html>from-sandbox</html>';
    const report = '# report';
    backend.blobs.set(sha(newIndex), Buffer.from(newIndex));
    backend.blobs.set(sha(report), Buffer.from(report));
    const current = backend.manifests.get(p)!;
    backend.manifests.set(p, {
      version: current.version + 1,
      files: {
        'index.html': { sha256: sha(newIndex), size: newIndex.length, mtime: 1_730_000_000_000 },
        'report.md': { sha256: sha(report), size: report.length, mtime: 1_730_000_000_000 },
      },
    });

    const result = await engine.hydrate(p);
    expect(result.updated).toBe(true);
    await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe(newIndex);
    await expect(fsp.readFile(join(projectsDir, p, 'report.md'), 'utf8')).resolves.toBe(report);
    await expect(fsp.access(join(projectsDir, p, '.od-sync-staging'))).rejects.toThrow();
  });

  it('hydrate deletes local files the remote manifest dropped', async () => {
    const p = 'proj-flush';
    const current = backend.manifests.get(p)!;
    const files = { ...current.files };
    delete files['report.md'];
    backend.manifests.set(p, { version: current.version + 1, files });

    const result = await engine.hydrate(p);
    expect(result.updated).toBe(true);
    await expect(fsp.access(join(projectsDir, p, 'report.md'))).rejects.toThrow();
  });

  it('hydrate ifMissing is a no-op when content is present', async () => {
    const p = 'proj-flush';
    const result = await engine.hydrate(p, { ifMissing: true });
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('already present');
  });

  it('hydrate ifMissing repairs a file missing from an otherwise populated cache', async () => {
    const p = 'proj-flush';
    const expected = await fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8');
    await fsp.rm(join(projectsDir, p, 'index.html'));

    const result = await engine.hydrate(p, { ifMissing: true });

    expect(result.updated).toBe(true);
    await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe(expected);
  });

  it('eviction reclaims cold synced projects and hydrate rebuilds them', async () => {
    const p = 'proj-flush';
    // Too fresh → not evicted.
    await expect(engine.evictColdProjects(72)).resolves.toEqual([]);
    // TTL 0 hours → everything cold… but active runs are protected.
    activeRuns.add(p);
    await expect(engine.evictColdProjects(-1)).resolves.toEqual([]);
    expect((await engine.evictColdProjects(0.000001)).includes(p)).toBe(false);
    activeRuns.delete(p);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const evicted = await engine.evictColdProjects(0.000001);
    expect(evicted).toContain(p);
    await expect(fsp.access(join(projectsDir, p))).rejects.toThrow();

    // Open-a-project path: empty dir → ifMissing hydrate pulls everything.
    const result = await engine.hydrate(p, { ifMissing: true });
    expect(result.updated).toBe(true);
    await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe(
      '<html>from-sandbox</html>',
    );
  });

  // 冷缓存写路径事故复现(2026-07-16 c264f832):pod 重建后项目目录与 sync
  // state 全空,agent spawn 先写文件(种技能)再 flush。第一次 push 撞 CAS 冲突
  // 后把远端完整清单收编为本地 base,但磁盘上并没有那些文件;第二次 flush 的
  // diff 就把"从未下载"当成"本地已删除",推 delete 清空远端 manifest。
  describe('cold-cache write path', () => {
    it('preserves and pushes a pre-hydration local write at the same remote path', async () => {
      const p = 'proj-cold-same-path';
      const remoteText = 'remote-before-pod-rebuild';
      const localText = 'local-unpushed-agent-write';
      backend.blobs.set(sha(remoteText), Buffer.from(remoteText));
      backend.manifests.set(p, {
        version: 1,
        files: {
          'index.html': { sha256: sha(remoteText), size: remoteText.length, mtime: 1_730_000_000_000 },
        },
      });
      await fsp.mkdir(join(projectsDir, p), { recursive: true });
      await fsp.writeFile(join(projectsDir, p, 'index.html'), localText);

      await engine.flush(p);

      await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe(localText);
      expect(backend.manifests.get(p)!.files['index.html']?.sha256).toBe(sha(localText));
      expect(backend.blobs.get(sha(localText))?.toString()).toBe(localText);
    });

    it('resolves a cold local-file/remote-directory shape conflict as delete + put', async () => {
      const p = 'proj-cold-path-shape';
      const logo = 'remote-logo';
      const localAsset = 'local-assets-file';
      const keep = 'remote-unrelated';
      backend.blobs.set(sha(logo), Buffer.from(logo));
      backend.blobs.set(sha(keep), Buffer.from(keep));
      backend.manifests.set(p, {
        version: 1,
        files: {
          'assets/logo.png': { sha256: sha(logo), size: logo.length, mtime: 1_730_000_000_000 },
          'keep.txt': { sha256: sha(keep), size: keep.length, mtime: 1_730_000_000_000 },
        },
      });
      await fsp.mkdir(join(projectsDir, p), { recursive: true });
      await fsp.writeFile(join(projectsDir, p, 'assets'), localAsset);

      await engine.flush(p);

      const remote = backend.manifests.get(p)!;
      expect(remote.files['assets/logo.png']).toBeUndefined();
      expect(remote.files['assets']?.sha256).toBe(sha(localAsset));
      expect(remote.files['keep.txt']?.sha256).toBe(sha(keep));
      await expect(fsp.readFile(join(projectsDir, p, 'assets'), 'utf8')).resolves.toBe(localAsset);
      await expect(fsp.readFile(join(projectsDir, p, 'keep.txt'), 'utf8')).resolves.toBe(keep);
    });

    it('flush on a never-hydrated project must not wipe the remote manifest', async () => {
      const p = 'proj-cold-write';
      const html = '<html>user-design</html>';
      const js = 'console.log(1)';
      backend.blobs.set(sha(html), Buffer.from(html));
      backend.blobs.set(sha(js), Buffer.from(js));
      backend.manifests.set(p, {
        version: 1,
        files: {
          'index.html': { sha256: sha(html), size: html.length, mtime: 1_730_000_000_000 },
          'app.js': { sha256: sha(js), size: js.length, mtime: 1_730_000_000_000 },
        },
      });

      // Pod rebuild: no project dir, no state file. The agent spawn seeds a
      // skill file and flushes (pre-run barrier) before any hydrate ran.
      await fsp.mkdir(join(projectsDir, p, '.od-skills'), { recursive: true });
      await fsp.writeFile(join(projectsDir, p, '.od-skills', 'SKILL.md'), '# seed');
      await engine.flush(p);

      // The agent keeps writing; the next debounced push follows.
      await fsp.writeFile(join(projectsDir, p, 'notes.md'), 'wip');
      await engine.flush(p);

      const remote = backend.manifests.get(p)!;
      expect(remote.files['index.html']).toBeDefined();
      expect(remote.files['app.js']).toBeDefined();
      expect(remote.files['.od-skills/SKILL.md']).toBeDefined();
      expect(remote.files['notes.md']).toBeDefined();
      // The cold guard also materializes the remote files locally.
      await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe(html);
    });

    it('a conflict-rebased push must not adopt never-downloaded files into the base', async () => {
      const p = 'proj-conflict-adopt';
      await fsp.mkdir(join(projectsDir, p), { recursive: true });
      await fsp.writeFile(join(projectsDir, p, 'a.txt'), 'aaa');
      await engine.flush(p); // v1, synced baseline

      // A sandbox commits v2 remotely, adding a file this daemon never saw.
      const bin = 'sandbox-bytes';
      backend.blobs.set(sha(bin), Buffer.from(bin));
      const current = backend.manifests.get(p)!;
      backend.manifests.set(p, {
        version: current.version + 1,
        files: {
          ...current.files,
          'sandbox.bin': { sha256: sha(bin), size: bin.length, mtime: 1_730_000_000_000 },
        },
      });

      // Daemon-side write → stale base → 409 → rebase commit.
      await fsp.writeFile(join(projectsDir, p, 'b.txt'), 'bbb');
      await engine.flush(p);
      // Another write + flush: the diff must not read the adopted-but-absent
      // sandbox.bin as a local deletion.
      await fsp.writeFile(join(projectsDir, p, 'c.txt'), 'ccc');
      await engine.flush(p);

      expect(backend.manifests.get(p)!.files['sandbox.bin']).toBeDefined();
      await expect(fsp.readFile(join(projectsDir, p, 'sandbox.bin'), 'utf8')).resolves.toBe(bin);
    });
  });

  it('pushes dirty local changes before ifMissing reconciles a newer remote version', async () => {
    const p = 'proj-dirty-hydrate';
    const oldContent = 'old';
    const localContent = 'local-new';
    const remoteExtra = 'remote-extra';
    backend.blobs.set(sha(oldContent), Buffer.from(oldContent));
    backend.manifests.set(p, {
      version: 1,
      files: {
        'index.html': { sha256: sha(oldContent), size: oldContent.length, mtime: Date.now() },
      },
    });
    await engine.hydrate(p);
    await engine.runProjectMutation(p, undefined, async () => {
      await fsp.writeFile(join(projectsDir, p, 'index.html'), localContent);
    });
    engine.markDirty(p);

    backend.blobs.set(sha(remoteExtra), Buffer.from(remoteExtra));
    backend.manifests.set(p, {
      version: 2,
      files: {
        'index.html': { sha256: sha(oldContent), size: oldContent.length, mtime: Date.now() },
        'remote.txt': { sha256: sha(remoteExtra), size: remoteExtra.length, mtime: Date.now() },
      },
    });

    await engine.hydrate(p, { ifMissing: true });

    await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe(localContent);
    expect(backend.manifests.get(p)?.files['index.html']?.sha256).toBe(sha(localContent));
    await expect(fsp.readFile(join(projectsDir, p, 'remote.txt'), 'utf8')).resolves.toBe(remoteExtra);
  });

  it('serializes managed mutations with hydrate work', async () => {
    const p = 'proj-mutation-chain';
    let releaseMutation!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = engine.runProjectMutation(p, undefined, async () => {
      await blocked;
      await fsp.mkdir(join(projectsDir, p), { recursive: true });
      await fsp.writeFile(join(projectsDir, p, 'local.txt'), 'serialized');
    });
    let hydrated = false;
    const hydration = engine.hydrate(p, { ifMissing: true }).then(() => { hydrated = true; });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(hydrated).toBe(false);
    releaseMutation();
    await mutation;
    await hydration;
    await expect(fsp.readFile(join(projectsDir, p, 'local.txt'), 'utf8')).resolves.toBe('serialized');
  });

  it('hydrates both file-to-directory and directory-to-file shape changes', async () => {
    const p = 'proj-remote-shape';
    backend.blobs.set(sha('flat'), Buffer.from('flat'));
    backend.manifests.set(p, {
      version: 1,
      files: { assets: { sha256: sha('flat'), size: 4, mtime: Date.now() } },
    });
    await engine.hydrate(p);

    backend.blobs.set(sha('nested'), Buffer.from('nested'));
    backend.manifests.set(p, {
      version: 2,
      files: { 'assets/logo.txt': { sha256: sha('nested'), size: 6, mtime: Date.now() } },
    });
    await engine.hydrate(p, { ifMissing: true });
    await expect(fsp.readFile(join(projectsDir, p, 'assets', 'logo.txt'), 'utf8')).resolves.toBe('nested');

    backend.blobs.set(sha('flat-again'), Buffer.from('flat-again'));
    backend.manifests.set(p, {
      version: 3,
      files: { assets: { sha256: sha('flat-again'), size: 10, mtime: Date.now() } },
    });
    await engine.hydrate(p, { ifMissing: true });
    await expect(fsp.readFile(join(projectsDir, p, 'assets'), 'utf8')).resolves.toBe('flat-again');
  });

  it('fails closed when an existing state file cannot be parsed', async () => {
    const p = 'proj-bad-state';
    const remote = 'remote';
    backend.blobs.set(sha(remote), Buffer.from(remote));
    backend.manifests.set(p, {
      version: 1,
      files: { 'index.html': { sha256: sha(remote), size: remote.length, mtime: Date.now() } },
    });
    await engine.hydrate(p);
    await fsp.writeFile(join(projectsDir, p, 'index.html'), 'local-unsynced');
    await fsp.writeFile(join(dataDir, 'sync', `${p}.json`), '{broken');
    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      hasActiveRun: (id) => activeRuns.has(id),
    });

    await expect(engine.hydrate(p, { ifMissing: true })).rejects.toBeInstanceOf(SyntaxError);
    await expect(fsp.readFile(join(projectsDir, p, 'index.html'), 'utf8')).resolves.toBe('local-unsynced');
    await fsp.rm(join(dataDir, 'sync', `${p}.json`), { force: true });
    engine.initSyncEngine({
      runtimeDataDir: dataDir,
      projectsDir,
      hasActiveRun: (id) => activeRuns.has(id),
    });
  });

  it('retries a failed debounced push without another local write', async () => {
    const p = 'proj-push-retry';
    await fsp.mkdir(join(projectsDir, p), { recursive: true });
    await fsp.writeFile(join(projectsDir, p, 'retry.txt'), 'retry-me');
    backend.failNextManifest();

    engine.markDirty(p);

    await expect.poll(
      () => backend.manifests.get(p)?.files['retry.txt']?.sha256,
      { timeout: 10_000 },
    ).toBe(sha('retry-me'));
  });

  it('revives sync immediately when a project id is recreated', async () => {
    const p = 'proj-recreated';
    await engine.dropState(p);
    engine.reviveProject(p);
    await fsp.mkdir(join(projectsDir, p), { recursive: true });
    await fsp.writeFile(join(projectsDir, p, 'new.txt'), 'new-project');

    const result = await engine.flush(p);

    expect(result.manifest?.files['new.txt']?.sha256).toBe(sha('new-project'));
  });

  it('markDirty on an imported (baseDir) project is ignored', async () => {
    engine.markDirty('proj-imported', { baseDir: '/home/user/own-folder' });
    // No runtime chain work should have been scheduled; flushing finds an
    // empty/never-created dir and commits nothing.
    const result = await engine.flush('proj-imported');
    expect(result.manifest?.version).toBe(0);
    expect(backend.manifests.get('proj-imported')).toBeUndefined();
  });

  it('rejects project ids containing path separators without creating nested state', async () => {
    const projectId = 'nested/project';
    engine.markDirty(projectId);
    expect((await engine.flush(projectId)).manifest).toBeNull();
    await expect(engine.hydrate(projectId)).resolves.toMatchObject({
      updated: false,
      reason: 'invalid project id',
    });
    await engine.dropState(projectId);

    expect(backend.manifests.has(projectId)).toBe(false);
    await expect(fsp.access(join(dataDir, 'sync', 'nested'))).rejects.toThrow();
    await expect(fsp.access(join(projectsDir, 'nested'))).rejects.toThrow();
  });

  it('rejects symlink escape attempts for both download and deletion', async () => {
    const outside = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-outside-'));
    try {
      const downloadProject = 'proj-symlink-download';
      await fsp.mkdir(join(projectsDir, downloadProject), { recursive: true });
      await fsp.symlink(outside, join(projectsDir, downloadProject, 'escape'));
      const payload = 'must-stay-inside';
      backend.blobs.set(sha(payload), Buffer.from(payload));
      backend.manifests.set(downloadProject, {
        version: 1,
        files: {
          'escape/pwned.txt': { sha256: sha(payload), size: payload.length, mtime: Date.now() },
        },
      });

      await expect(engine.hydrate(downloadProject, { ifMissing: true })).rejects.toThrow(/symlink/);
      await expect(fsp.access(join(outside, 'pwned.txt'))).rejects.toThrow();

      const deleteProject = 'proj-symlink-delete';
      await fsp.mkdir(join(projectsDir, deleteProject, 'owned'), { recursive: true });
      await fsp.writeFile(join(projectsDir, deleteProject, 'owned', 'file.txt'), 'base');
      await engine.flush(deleteProject);
      await fsp.rm(join(projectsDir, deleteProject, 'owned'), { recursive: true });
      await fsp.writeFile(join(outside, 'file.txt'), 'outside');
      await fsp.symlink(outside, join(projectsDir, deleteProject, 'owned'));
      const current = backend.manifests.get(deleteProject)!;
      backend.manifests.set(deleteProject, { version: current.version + 1, files: {} });

      await expect(engine.hydrate(deleteProject)).rejects.toThrow(/symlink/);
      await expect(fsp.readFile(join(outside, 'file.txt'), 'utf8')).resolves.toBe('outside');
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an entire remote manifest containing any unsafe, ignored, or path-shape-conflicting path', async () => {
    const safe = 'safe-content';
    backend.blobs.set(sha(safe), Buffer.from(safe));
    const invalidFiles = [
      {
        'safe.txt': { sha256: sha(safe), size: safe.length, mtime: 1 },
        '../escape.txt': { sha256: sha(safe), size: safe.length, mtime: 1 },
      },
      {
        'safe.txt': { sha256: sha(safe), size: safe.length, mtime: 1 },
        '.git/config': { sha256: sha(safe), size: safe.length, mtime: 1 },
      },
      {
        'safe.txt': { sha256: sha(safe), size: safe.length, mtime: 1 },
        node: { sha256: sha(safe), size: safe.length, mtime: 1 },
        'node/child.txt': { sha256: sha(safe), size: safe.length, mtime: 1 },
      },
    ];

    for (const [index, files] of invalidFiles.entries()) {
      const projectId = `proj-unsafe-manifest-${index}`;
      backend.manifests.set(projectId, { version: 1, files });
      await expect(engine.hydrate(projectId, { ifMissing: true })).rejects.toThrow();
      await expect(fsp.access(join(projectsDir, projectId, 'safe.txt'))).rejects.toThrow();
    }
    await expect(fsp.access(join(projectsDir, 'escape.txt'))).rejects.toThrow();
  });

  it('serializes dropState and leaves a tombstone that prevents concurrent resurrection', async () => {
    const projectId = 'proj-drop-race';
    const payload = 'remote';
    backend.blobs.set(sha(payload), Buffer.from(payload));
    backend.manifests.set(projectId, {
      version: 1,
      files: { 'index.txt': { sha256: sha(payload), size: payload.length, mtime: Date.now() } },
    });

    const hydration = engine.hydrate(projectId, { ifMissing: true });
    const dropping = engine.dropState(projectId);
    await Promise.all([hydration, dropping]);
    await fsp.rm(join(projectsDir, projectId), { recursive: true, force: true });

    expect(await engine.hydrate(projectId, { ifMissing: true })).toMatchObject({
      updated: false,
      reason: 'project deleted',
    });
    engine.markDirty(projectId);
    expect((await engine.flush(projectId)).manifest).toBeNull();
    await expect(fsp.access(join(dataDir, 'sync', `${projectId}.json`))).rejects.toThrow();
    await expect(fsp.access(join(projectsDir, projectId))).rejects.toThrow();
  });
});
