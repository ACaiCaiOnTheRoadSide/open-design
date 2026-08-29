// Sandbox-side CLI contract (`od sync pull|push`, `od file get`): a pull must
// eagerly restore only files under the prefetch threshold and record the pull
// base; every sandbox push is append-only and re-hashes all materialized files;
// without a base it falls back to the same conservative merge. `file get`
// materializes a skipped large file on demand.
import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runFile, runSync } from '../src/sync/cli-run.js';
import type { ManifestFiles } from '../src/sync/core.js';
import { createFakeSyncBackend, sha } from './helpers/fake-sync-backend.js';

const BIG = 'x'.repeat(64); // with OD_SYNC_PREFETCH_MAX_BYTES=32 this is "large"

describe('od sync / od file CLI', () => {
  let backend: ReturnType<typeof createFakeSyncBackend>;
  let server: http.Server;
  let dataDir: string;
  const projectId = 'proj-cli';

  const projectDir = () => join(dataDir, 'projects', projectId);

  beforeAll(async () => {
    backend = createFakeSyncBackend();
    server = backend.server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    dataDir = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-cli-'));
    process.env.OD_BACKEND_URL = `http://127.0.0.1:${port}`;
    process.env.OD_API_TOKEN = 'tok';
    process.env.OD_PROJECT_ID = projectId;
    process.env.OD_DATA_DIR = dataDir;
    process.env.OD_SYNC_PREFETCH_MAX_BYTES = '32';

    // Remote state: one small file, one large file.
    backend.blobs.set(sha('small'), Buffer.from('small'));
    backend.blobs.set(sha(BIG), Buffer.from(BIG));
    backend.manifests.set(projectId, {
      version: 3,
      files: {
        'index.html': { sha256: sha('small'), size: 5, mtime: 1_730_000_000_000 },
        'assets/big.mp4': { sha256: sha(BIG), size: BIG.length, mtime: 1_730_000_000_000 },
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(dataDir, { recursive: true, force: true });
    for (const key of [
      'OD_BACKEND_URL',
      'OD_API_TOKEN',
      'OD_PROJECT_ID',
      'OD_DATA_DIR',
      'OD_SYNC_PREFETCH_MAX_BYTES',
    ]) {
      delete process.env[key];
    }
  });

  it('pull restores small files, skips large ones, records the base', async () => {
    await runSync(['pull', '--json']);
    await expect(fsp.readFile(join(projectDir(), 'index.html'), 'utf8')).resolves.toBe('small');
    await expect(fsp.access(join(projectDir(), 'assets', 'big.mp4'))).rejects.toThrow();
    const state = JSON.parse(
      await fsp.readFile(join(dataDir, '.od', 'sync', `${projectId}.json`), 'utf8'),
    );
    expect(state.baseVersion).toBe(3);
    expect(state.skippedLarge).toEqual([{ path: 'assets/big.mp4', size: BIG.length }]);
  });

  it('file get materializes a skipped large file', async () => {
    await runFile(['get', 'assets/big.mp4', '--json']);
    await expect(fsp.readFile(join(projectDir(), 'assets', 'big.mp4'), 'utf8')).resolves.toBe(BIG);
  });

  it('pull removes a stale materialized large file when its remote hash changes', async () => {
    const id = 'proj-large-change';
    const oldLarge = 'o'.repeat(64);
    const newLarge = 'n'.repeat(64);
    backend.blobs.set(sha(oldLarge), Buffer.from(oldLarge));
    backend.blobs.set(sha(newLarge), Buffer.from(newLarge));
    const remote = {
      version: 1,
      files: { 'large.bin': { sha256: sha(oldLarge), size: oldLarge.length, mtime: 1 } },
    };
    backend.manifests.set(id, remote);
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      await runFile(['get', 'large.bin', '--json']);
      remote.version = 2;
      remote.files['large.bin'] = { sha256: sha(newLarge), size: newLarge.length, mtime: 2 };
      await runSync(['pull', '--json']);
      await expect(fsp.access(join(dataDir, 'projects', id, 'large.bin'))).rejects.toThrow();
      await runSync(['push', '--json']);
      expect(backend.manifests.get(id)!.files['large.bin']!.sha256).toBe(sha(newLarge));
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('push re-hashes even when size and mtime match the pull base', async () => {
    const file = join(projectDir(), 'index.html');
    await fsp.writeFile(file, 'other'); // same five-byte size as "small"
    const baseMtime = new Date(1_730_000_000_000);
    await fsp.utimes(file, baseMtime, baseMtime);
    await runSync(['push', '--json']);
    expect(backend.manifests.get(projectId)!.files['index.html']!.sha256).toBe(sha('other'));
  });

  it('push diffs against the pull base: puts only, untouched-large kept', async () => {
    await fsp.writeFile(join(projectDir(), 'index.html'), '<html>agent</html>');
    await fsp.writeFile(join(projectDir(), 'report.md'), '# out');
    await fsp.rm(join(projectDir(), 'assets', 'big.mp4')); // agent never needed it locally… but
    // Sandbox push never sends deletes: an absent materialized or lazy file
    // cannot remove its remote manifest entry.
    await runSync(['push', '--json']);

    const remote = backend.manifests.get(projectId)!;
    expect(remote.files['index.html']!.sha256).toBe(sha('<html>agent</html>'));
    expect(remote.files['report.md']!.sha256).toBe(sha('# out'));
    expect(backend.blobs.has(sha('<html>agent</html>'))).toBe(true);
    // Sandbox push is append-only, so the remote entry must survive.
    expect(remote.files['assets/big.mp4']).toBeDefined();
  });

  it('push without a base is puts-only (conservative merge)', async () => {
    await fsp.rm(join(dataDir, '.od', 'sync', `${projectId}.json`));
    await fsp.rm(join(projectDir(), 'report.md'));
    await fsp.writeFile(join(projectDir(), 'new.txt'), 'fresh');
    await runSync(['push', '--json']);

    const remote = backend.manifests.get(projectId)!;
    expect(remote.files['new.txt']!.sha256).toBe(sha('fresh'));
    // report.md is locally absent but must survive remotely: no base, no deletes.
    expect(remote.files['report.md']).toBeDefined();
  });

  it('pull rejects an unsafe path from the remote manifest', async () => {
    const unsafeProjectId = 'proj-unsafe';
    backend.manifests.set(unsafeProjectId, {
      version: 1,
      files: { '../escape.txt': { sha256: sha('escape'), size: 6, mtime: 1 } },
    });
    process.env.OD_PROJECT_ID = unsafeProjectId;
    try {
      await expect(runSync(['pull', '--json'])).rejects.toThrow(/unsafe path/);
      await expect(fsp.access(join(dataDir, 'escape.txt'))).rejects.toThrow();
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('pull removes files dropped by the new manifest and cleans empty directories', async () => {
    const remote = backend.manifests.get(projectId)!;
    const staleSha = sha('stale');
    backend.blobs.set(staleSha, Buffer.from('stale'));
    remote.version += 1;
    remote.files['obsolete/nested/file.txt'] = { sha256: staleSha, size: 5, mtime: 1 };
    await runSync(['pull', '--json']);
    await expect(fsp.readFile(join(projectDir(), 'obsolete/nested/file.txt'), 'utf8')).resolves.toBe('stale');

    remote.version += 1;
    delete remote.files['obsolete/nested/file.txt'];
    await runSync(['pull', '--json']);
    await expect(fsp.access(join(projectDir(), 'obsolete'))).rejects.toThrow();
  });

  it('failed pull leaves invalid state, blocks push, and a later pull recovers', async () => {
    const id = 'proj-incomplete';
    const digest = sha('eventually');
    backend.manifests.set(id, {
      version: 1,
      files: { 'eventually.txt': { sha256: digest, size: 10, mtime: 1 } },
    });
    process.env.OD_PROJECT_ID = id;
    try {
      await expect(runSync(['pull', '--json'])).rejects.toThrow(/HTTP 404/);
      const statePath = join(dataDir, '.od', 'sync', `${id}.json`);
      expect(JSON.parse(await fsp.readFile(statePath, 'utf8')).status).toBe('in-progress');
      await fsp.mkdir(join(dataDir, 'projects', id), { recursive: true });
      await fsp.writeFile(join(dataDir, 'projects', id, 'local.txt'), 'do-not-push');
      await expect(runSync(['push', '--json'])).rejects.toThrow(/pull is incomplete/);
      expect(backend.manifests.get(id)!.files['local.txt']).toBeUndefined();

      backend.blobs.set(digest, Buffer.from('eventually'));
      await runSync(['pull', '--json']);
      expect(JSON.parse(await fsp.readFile(statePath, 'utf8')).status).toBe('valid');
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('rejects stable symlink ancestors and final symlinks without writing outside root', async () => {
    const outside = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-outside-'));
    const digest = sha('payload');
    backend.blobs.set(digest, Buffer.from('payload'));
    try {
      const rootLinkId = 'proj-link-root';
      backend.manifests.set(rootLinkId, { version: 1, files: { 'escape.txt': { sha256: digest, size: 7, mtime: 1 } } });
      const rootLink = join(dataDir, 'projects', rootLinkId);
      await fsp.mkdir(join(dataDir, 'projects'), { recursive: true });
      await fsp.symlink(outside, rootLink);
      process.env.OD_PROJECT_ID = rootLinkId;
      await expect(runSync(['pull', '--json'])).rejects.toThrow(/root is not a safe directory/);
      await expect(fsp.access(join(outside, 'escape.txt'))).rejects.toThrow();
      await expect(fsp.access(join(outside, '.od'))).rejects.toThrow();

      for (const [id, relPath, final] of [
        ['proj-link-parent', 'linked/escape.txt', false],
        ['proj-link-final', 'escape.txt', true],
      ] as const) {
        backend.manifests.set(id, { version: 1, files: { [relPath]: { sha256: digest, size: 7, mtime: 1 } } });
        const root = join(dataDir, 'projects', id);
        await fsp.mkdir(root, { recursive: true });
        if (final) await fsp.symlink(join(outside, 'outside.txt'), join(root, relPath));
        else await fsp.symlink(outside, join(root, 'linked'));
        process.env.OD_PROJECT_ID = id;
        await expect(runSync(['pull', '--json'])).rejects.toThrow(/symlink/);
        await expect(fsp.access(join(outside, final ? 'outside.txt' : 'escape.txt'))).rejects.toThrow();
      }

      const lazyId = 'proj-file-link';
      backend.manifests.set(lazyId, {
        version: 1,
        files: { 'linked/big.bin': { sha256: sha(BIG), size: BIG.length, mtime: 1 } },
      });
      const lazyRoot = join(dataDir, 'projects', lazyId);
      await fsp.mkdir(lazyRoot, { recursive: true });
      await fsp.symlink(outside, join(lazyRoot, 'linked'));
      process.env.OD_PROJECT_ID = lazyId;
      await runSync(['pull', '--json']); // lazy entry does not need its parent yet
      await expect(runFile(['get', 'linked/big.bin', '--json'])).rejects.toThrow(/symlink/);
      await expect(fsp.access(join(outside, 'big.bin'))).rejects.toThrow();

      const deleteId = 'proj-delete-link';
      const deleteRemote: { version: number; files: ManifestFiles } = {
        version: 1,
        files: { 'old.txt': { sha256: digest, size: 7, mtime: 1 } },
      };
      backend.manifests.set(deleteId, deleteRemote);
      process.env.OD_PROJECT_ID = deleteId;
      await runSync(['pull', '--json']);
      const tracked = join(dataDir, 'projects', deleteId, 'old.txt');
      const outsideVictim = join(outside, 'victim.txt');
      await fsp.writeFile(outsideVictim, 'preserve');
      await fsp.rm(tracked);
      await fsp.symlink(outsideVictim, tracked);
      deleteRemote.version += 1;
      delete deleteRemote.files['old.txt'];
      await expect(runSync(['pull', '--json'])).rejects.toThrow(/symlink/);
      await expect(fsp.readFile(outsideVictim, 'utf8')).resolves.toBe('preserve');
    } finally {
      process.env.OD_PROJECT_ID = projectId;
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('keeps shared staging alive until all concurrent pull downloads finish', async () => {
    const id = 'proj-concurrent-downloads';
    const contents = ['fast', 'slow-one', 'slow-two', 'slow-three'];
    const files: ManifestFiles = Object.create(null) as ManifestFiles;
    for (const [index, content] of contents.entries()) {
      const digest = sha(content);
      backend.blobs.set(digest, Buffer.from(content));
      files[`file-${index}.txt`] = { sha256: digest, size: content.length, mtime: index + 1 };
      if (index > 0) backend.delayBlobGet(digest, 75);
    }
    backend.manifests.set(id, { version: 1, files });
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      await Promise.all(contents.map((content, index) =>
        expect(fsp.readFile(join(dataDir, 'projects', id, `file-${index}.txt`), 'utf8')).resolves.toBe(content)));
      await expect(fsp.access(join(dataDir, 'projects', id, '.od-sync-staging'))).rejects.toThrow();
    } finally {
      process.env.OD_PROJECT_ID = projectId;
      for (const content of contents.slice(1)) backend.delayBlobGet(sha(content), 0);
    }
  });

  it('serializes concurrent same-project pulls and leaves one valid state', async () => {
    const id = 'proj-concurrent';
    const digest = sha('parallel');
    backend.blobs.set(digest, Buffer.from('parallel'));
    backend.manifests.set(id, { version: 1, files: { 'a.txt': { sha256: digest, size: 8, mtime: 1 } } });
    process.env.OD_PROJECT_ID = id;
    try {
      await Promise.all([runSync(['pull', '--json']), runSync(['pull', '--json']), runSync(['pull', '--json'])]);
      const state = JSON.parse(await fsp.readFile(join(dataDir, '.od', 'sync', `${id}.json`), 'utf8'));
      expect(state.status).toBe('valid');
      expect(state.baseVersion).toBe(1);
      await expect(fsp.readFile(join(dataDir, 'projects', id, 'a.txt'), 'utf8')).resolves.toBe('parallel');
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('round-trips a legitimate __proto__ file through network, state and push', async () => {
    const id = 'proj-proto';
    const digest = sha('proto');
    backend.blobs.set(digest, Buffer.from('proto'));
    const files = JSON.parse(`{"__proto__":{"sha256":"${digest}","size":5,"mtime":1}}`);
    backend.manifests.set(id, { version: 1, files });
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      const protoPath = join(dataDir, 'projects', id, '__proto__');
      await expect(fsp.readFile(protoPath, 'utf8')).resolves.toBe('proto');
      const state = JSON.parse(await fsp.readFile(join(dataDir, '.od', 'sync', `${id}.json`), 'utf8'));
      expect(Object.hasOwn(state.baseFiles, '__proto__')).toBe(true);
      await fsp.writeFile(protoPath, 'newer');
      await runSync(['push', '--json']);
      const remote = backend.manifests.get(id)!;
      expect(Object.hasOwn(remote.files, '__proto__')).toBe(true);
      expect(remote.files.__proto__!.sha256).toBe(sha('newer'));
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('--dir without OD_DATA_DIR keeps state in the writable home directory', async () => {
    const id = 'proj-explicit-dir';
    const explicitDir = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-explicit-'));
    const stateHome = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-home-'));
    const previousHome = process.env.HOME;
    backend.manifests.set(id, { version: 0, files: {} });
    delete process.env.OD_DATA_DIR;
    process.env.HOME = stateHome;
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--dir', explicitDir, '--json']);
      const state = JSON.parse(await fsp.readFile(join(stateHome, '.od', 'sync', `${id}.json`), 'utf8'));
      expect(state.status).toBe('valid');
      await expect(fsp.access(join(explicitDir, '.od'))).rejects.toThrow();
    } finally {
      process.env.OD_DATA_DIR = dataDir;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      process.env.OD_PROJECT_ID = projectId;
      await fsp.rm(explicitDir, { recursive: true, force: true });
      await fsp.rm(stateHome, { recursive: true, force: true });
    }
  });

  it('reaps a lock whose owner process is gone', async () => {
    const id = 'proj-abandoned-lock';
    backend.manifests.set(id, { version: 0, files: {} });
    const lockDir = join(dataDir, '.od', 'sync', `${id}.json.lock`);
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: 999_999_999, token: 'dead', at: Date.now() }));
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      await expect(fsp.access(lockDir)).rejects.toThrow();
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('reaps a stale lock after its PID has been reused', async () => {
    const id = 'proj-reused-pid-lock';
    backend.manifests.set(id, { version: 0, files: {} });
    const lockDir = join(dataDir, '.od', 'sync', `${id}.json.lock`);
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'previous-process',
      at: Date.now() - 60_000,
      processStart: 'Mon Jan  1 00:00:00 1990',
    }));
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      await expect(fsp.access(lockDir)).rejects.toThrow();
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('reaps a stale legacy lock after its PID has been reused', async () => {
    const id = 'proj-legacy-reused-lock';
    backend.manifests.set(id, { version: 0, files: {} });
    const lockDir = join(dataDir, '.od', 'sync', `${id}.json.lock`);
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'legacy-process',
      at: Date.now() - 11 * 60_000,
    }));
    const stale = new Date(Date.now() - 11 * 60_000);
    await fsp.utimes(lockDir, stale, stale);
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      await expect(fsp.access(lockDir)).rejects.toThrow();
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('cleans abandoned staging files before downloading', async () => {
    const id = 'proj-staging-cleanup';
    const digest = sha('clean');
    backend.blobs.set(digest, Buffer.from('clean'));
    backend.manifests.set(id, { version: 1, files: { 'clean.txt': { sha256: digest, size: 5, mtime: 1 } } });
    const staging = join(dataDir, 'projects', id, '.od-sync-staging');
    await fsp.mkdir(staging, { recursive: true });
    await fsp.writeFile(join(staging, 'orphan.tmp'), 'partial');
    process.env.OD_PROJECT_ID = id;
    try {
      await runSync(['pull', '--json']);
      await expect(fsp.access(join(staging, 'orphan.tmp'))).rejects.toThrow();
    } finally {
      process.env.OD_PROJECT_ID = projectId;
    }
  });

  it('OD_SYNC_STATE_DIR relocates the pull base off $OD_DATA_DIR/.od/sync', async () => {
    // Sandboxed runs point this outside the agent-visible workspace so an
    // agent cannot wander into the single-line whole-manifest JSON and flood
    // its own context by reading it.
    await fsp.rm(join(dataDir, '.od', 'sync', `${projectId}.json`), { force: true });
    const stateDir = join(dataDir, 'hidden-state');
    process.env.OD_SYNC_STATE_DIR = stateDir;
    try {
      await runSync(['pull', '--json']);
      const state = JSON.parse(
        await fsp.readFile(join(stateDir, `${projectId}.json`), 'utf8'),
      );
      expect(state.baseVersion).toBeGreaterThanOrEqual(3);
      await expect(
        fsp.access(join(dataDir, '.od', 'sync', `${projectId}.json`)),
      ).rejects.toThrow(); // default location must stay empty
      // Round-trip: push must read the same relocated base.
      await fsp.writeFile(join(projectDir(), 'relocated.txt'), 'via-state-dir');
      await runSync(['push', '--json']);
      expect(backend.manifests.get(projectId)!.files['relocated.txt']).toBeDefined();
    } finally {
      delete process.env.OD_SYNC_STATE_DIR;
    }
  });
});
