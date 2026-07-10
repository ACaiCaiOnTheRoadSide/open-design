// Sandbox-side CLI contract (`od sync pull|push`, `od file get`): a pull must
// eagerly restore only files under the prefetch threshold and record the pull
// base; a push must diff against that base (deletes included), and without a
// base it must fall back to a puts-only conservative merge — never deleting
// on a guess; `file get` must materialize a skipped large file on demand.
import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runFile, runSync } from '../src/sync/cli-run.js';
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

  it('push diffs against the pull base: puts, deletes, untouched-large kept', async () => {
    await fsp.writeFile(join(projectDir(), 'index.html'), '<html>agent</html>');
    await fsp.writeFile(join(projectDir(), 'report.md'), '# out');
    await fsp.rm(join(projectDir(), 'assets', 'big.mp4')); // agent never needed it locally… but
    // deleting a file that was RESTORED then removed is a real delete. To keep
    // the untouched-large case honest, re-pull state says big.mp4 was skipped,
    // so its absence must NOT delete it remotely (it was never materialized).
    await runSync(['push', '--json']);

    const remote = backend.manifests.get(projectId)!;
    expect(remote.files['index.html']!.sha256).toBe(sha('<html>agent</html>'));
    expect(remote.files['report.md']!.sha256).toBe(sha('# out'));
    expect(backend.blobs.has(sha('<html>agent</html>'))).toBe(true);
    // Recorded as skipped-large at pull time → its local absence is not a
    // deletion, the remote entry must survive.
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
