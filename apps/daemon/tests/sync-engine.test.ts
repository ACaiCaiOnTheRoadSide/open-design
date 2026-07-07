// Daemon sync engine against an in-memory manifest/blob backend: flush must
// make the store mirror the local disk (upload blobs, commit a CAS diff),
// re-flush with no changes must commit nothing, hydrate must apply only the
// remote diff (download changed files, delete dropped ones) and the eviction
// sweep must reclaim only cold, fully-synced projects — the next hydrate
// rebuilds the directory from the manifest.
import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('markDirty on an imported (baseDir) project is ignored', async () => {
    engine.markDirty('proj-imported', { baseDir: '/home/user/own-folder' });
    // No runtime chain work should have been scheduled; flushing finds an
    // empty/never-created dir and commits nothing.
    const result = await engine.flush('proj-imported');
    expect(result.manifest?.version).toBe(0);
    expect(backend.manifests.get('proj-imported')).toBeUndefined();
  });
});
