// Wire contract of the sync HTTP client against a scripted backend: CAS
// conflicts must be rebased and resubmitted (not surfaced as errors), blob
// downloads must reject content whose hash does not match the addressed
// sha256 (a corrupt store must never materialize as a project file), and
// uploads must stream with an explicit content-length.
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBlobs,
  getBlobToFile,
  getManifest,
  putBlobFromFile,
  submitDiff,
  syncTargetFromEnv,
  type SyncTarget,
} from '../src/sync/client.js';
import type { Manifest } from '../src/sync/core.js';

interface Scripted {
  method: string;
  path: string;
  status: number;
  body: Buffer | string;
  contentType?: string;
}

describe('sync client', () => {
  let server: http.Server;
  let target: SyncTarget;
  let dir: string;
  let script: Scripted[] = [];
  let seen: Array<{
    method: string;
    path: string;
    auth: string | undefined;
    contentLength: string | undefined;
    body: Buffer;
  }> = [];

  beforeAll(async () => {
    dir = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-client-'));
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        seen.push({
          method: req.method!,
          path: req.url!,
          auth: req.headers.authorization,
          contentLength: req.headers['content-length'] as string | undefined,
          body: Buffer.concat(chunks),
        });
        const next = script.shift();
        if (!next) {
          res.statusCode = 500;
          res.end('unscripted request');
          return;
        }
        res.statusCode = next.status;
        res.setHeader('content-type', next.contentType ?? 'application/json');
        res.end(next.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    target = { backendUrl: `http://127.0.0.1:${port}`, apiToken: 'tok' };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    script = [];
    seen = [];
  });

  it('syncTargetFromEnv requires both url and token, trims trailing slash', () => {
    expect(syncTargetFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(syncTargetFromEnv({ OD_BACKEND_URL: 'http://b/' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      syncTargetFromEnv({ OD_BACKEND_URL: 'http://b/', OD_API_TOKEN: 't' } as NodeJS.ProcessEnv),
    ).toEqual({ backendUrl: 'http://b', apiToken: 't' });
  });

  it('times out a half-open manifest request and retries only once', async () => {
    let requests = 0;
    const halfOpen = createServer((_req, _res) => { requests += 1; });
    await new Promise<void>((resolve) => halfOpen.listen(0, '127.0.0.1', resolve));
    const port = (halfOpen.address() as AddressInfo).port;
    try {
      await expect(getManifest(
        { backendUrl: `http://127.0.0.1:${port}`, apiToken: 'tok' },
        'p-timeout',
        { requestDeadlineMs: 20 },
      )).rejects.toMatchObject({ code: 'SYNC_REQUEST_TIMEOUT' });
      expect(requests).toBe(2);
    } finally {
      halfOpen.closeAllConnections();
      await new Promise<void>((resolve) => halfOpen.close(() => resolve()));
    }
  });

  it('combines caller cancellation with its deadline and does not retry shutdown aborts', async () => {
    let requests = 0;
    const halfOpen = createServer((_req, _res) => { requests += 1; });
    await new Promise<void>((resolve) => halfOpen.listen(0, '127.0.0.1', resolve));
    const port = (halfOpen.address() as AddressInfo).port;
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    try {
      const pending = getManifest(
        { backendUrl: `http://127.0.0.1:${port}`, apiToken: 'tok' },
        'p-abort',
        { requestDeadlineMs: 60_000, signal: controller.signal },
      );
      await expect.poll(() => requests).toBe(1);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(requests).toBe(1);
    } finally {
      halfOpen.closeAllConnections();
      await new Promise<void>((resolve) => halfOpen.close(() => resolve()));
    }
  });

  it('getManifest sends bearer auth and defaults empty manifests', async () => {
    script.push({ method: 'GET', path: '', status: 200, body: JSON.stringify({}) });
    const manifest = await getManifest(target, 'p1');
    expect(manifest).toEqual({ version: 0, files: {} });
    expect(seen[0]!.auth).toBe('Bearer tok');
    expect(seen[0]!.path).toBe('/api/internal/sync/manifest?projectId=p1');
  });

  it('normalizes network manifest maps and preserves an own __proto__ entry', async () => {
    script.push({
      method: 'GET', path: '', status: 200,
      body: '{"version":1,"files":{"__proto__":{"sha256":"x","size":1,"mtime":2}}}',
    });
    const manifest = await getManifest(target, 'p1');
    expect(Object.getPrototypeOf(manifest.files)).toBeNull();
    expect(Object.hasOwn(manifest.files, '__proto__')).toBe(true);
  });

  it('checkBlobs short-circuits empty input without a request', async () => {
    await expect(checkBlobs(target, 'p1', [])).resolves.toEqual(new Set());
    expect(seen).toHaveLength(0);
  });

  it('submitDiff commits on 200', async () => {
    script.push({ method: 'POST', path: '', status: 200, body: JSON.stringify({ version: 7 }) });
    const base: Manifest = { version: 6, files: {} };
    const result = await submitDiff(target, 'p1', base, [
      { op: 'put', path: 'a.txt', sha256: 'f'.repeat(64), size: 3, mtime: 1 },
    ]);
    expect(result.version).toBe(7);
    expect(result.files['a.txt']?.sha256).toBe('f'.repeat(64));
    const sent = JSON.parse(seen[0]!.body.toString());
    expect(sent.baseVersion).toBe(6);
    expect(sent.ops).toHaveLength(1);
  });

  it('submitDiff rebases onto the 409 manifest and resubmits', async () => {
    const mySha = 'a'.repeat(64);
    const theirSha = 'b'.repeat(64);
    // Conflict: someone bumped version and rewrote 'rewritten' since our base.
    script.push({
      method: 'POST',
      path: '',
      status: 409,
      body: JSON.stringify({
        version: 10,
        files: { rewritten: { sha256: theirSha, size: 1, mtime: 1 }, untouched: { sha256: 'c'.repeat(64), size: 1, mtime: 1 } },
      }),
    });
    script.push({ method: 'POST', path: '', status: 200, body: JSON.stringify({ version: 11 }) });

    const base: Manifest = {
      version: 9,
      files: {
        rewritten: { sha256: 'd'.repeat(64), size: 1, mtime: 1 },
        untouched: { sha256: 'c'.repeat(64), size: 1, mtime: 1 },
      },
    };
    const result = await submitDiff(target, 'p1', base, [
      { op: 'put', path: 'mine.txt', sha256: mySha, size: 2, mtime: 1 },
      { op: 'delete', path: 'rewritten' }, // must be dropped: entry changed since base
      { op: 'delete', path: 'untouched' }, // must survive: entry matches base
    ]);
    expect(result.version).toBe(11);
    expect(result.committedOps).toEqual([
      { op: 'put', path: 'mine.txt', sha256: mySha, size: 2, mtime: 1 },
      { op: 'delete', path: 'untouched' },
    ]);
    const retry = JSON.parse(seen[1]!.body.toString());
    expect(retry.baseVersion).toBe(10);
  });

  it('submitDiff returns without a request when the rebase empties the ops', async () => {
    const sha = 'a'.repeat(64);
    script.push({
      method: 'POST',
      path: '',
      status: 409,
      body: JSON.stringify({ version: 3, files: { 'a.txt': { sha256: sha, size: 1, mtime: 1 } } }),
    });
    const result = await submitDiff(target, 'p1', { version: 2, files: {} }, [
      { op: 'put', path: 'a.txt', sha256: sha, size: 1, mtime: 1 },
    ]);
    expect(result.version).toBe(3);
    expect(result.committedOps).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('putBlobFromFile streams with explicit content-length', async () => {
    const filePath = join(dir, 'up.bin');
    await fsp.writeFile(filePath, 'stream-me');
    const sha = createHash('sha256').update('stream-me').digest('hex');
    script.push({ method: 'PUT', path: '', status: 200, body: JSON.stringify({ key: 'k' }) });
    await putBlobFromFile(target, 'p1', sha, filePath);
    expect(seen[0]!.contentLength).toBe('9');
    expect(seen[0]!.body.toString()).toBe('stream-me');
    expect(seen[0]!.path).toContain(`sha256=${sha}`);
  });

  it('putBlobFromFile sends Content-Length: 0 for an empty blob', async () => {
    const filePath = join(dir, 'empty.bin');
    await fsp.writeFile(filePath, '');
    const sha = createHash('sha256').update('').digest('hex');
    script.push({ method: 'PUT', path: '', status: 200, body: '{}' });
    await putBlobFromFile(target, 'p1', sha, filePath);
    expect(seen[0]!.contentLength).toBe('0');
    expect(seen[0]!.body).toHaveLength(0);
  });

  it('getBlobToFile verifies the content hash and restores mtime', async () => {
    const payload = Buffer.from('blob-bytes');
    const sha = createHash('sha256').update(payload).digest('hex');
    script.push({ method: 'GET', path: '', status: 200, body: payload, contentType: 'application/octet-stream' });
    const dest = join(dir, 'nested', 'out.bin');
    const mtimeMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    await getBlobToFile(target, 'p1', sha, dest, mtimeMs);
    await expect(fsp.readFile(dest, 'utf8')).resolves.toBe('blob-bytes');
    const st = await fsp.stat(dest);
    expect(Math.abs(st.mtimeMs - mtimeMs)).toBeLessThan(1000);
  });

  it('getBlobToFile rejects mismatched content and leaves no file behind', async () => {
    const sha = createHash('sha256').update('expected').digest('hex');
    script.push({ method: 'GET', path: '', status: 200, body: 'tampered', contentType: 'application/octet-stream' });
    const dest = join(dir, 'bad.bin');
    await expect(getBlobToFile(target, 'p1', sha, dest)).rejects.toThrow(/hash mismatch/);
    await expect(fsp.access(dest)).rejects.toThrow();
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('.od-blob-'));
    expect(leftovers).toEqual([]);
  });
});
