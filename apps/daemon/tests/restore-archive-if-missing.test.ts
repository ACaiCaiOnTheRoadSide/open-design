// Lazy restore contract for POST /api/projects/:id/restore-archive.
//
// With `ifMissing: true` the daemon must fetch the archive ONLY when the
// project has no files on the local disk. This is the open-a-project hook:
// on k8s the daemon's data dir is an emptyDir wiped on every pod rebuild,
// and until this contract existed files only came back after a full agent
// round. The check must be cheap (a readdir) so the gateway can call it on
// every project-detail / file-tree GET, and concurrent calls for the same
// project must not extract twice (detail + files fire in parallel).
import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { create as tarCreate } from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

describe('restore-archive ifMissing', () => {
  let server: http.Server;
  let baseUrl: string;
  let archiveServer: http.Server;
  let archiveUrl: string;
  let archiveHits = 0;
  let archivePath: string;
  let stagingDir: string;
  const projectsDir = join(process.env.OD_DATA_DIR!, 'projects');

  // Serve one prepared tar.gz for any GET; /missing returns 404 like a
  // presigned URL for an object that does not exist.
  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;

    stagingDir = await fsp.mkdtemp(join(process.env.OD_DATA_DIR!, 'restore-staging-'));
    archivePath = join(stagingDir, 'archive.tar.gz');

    archiveServer = createServer((req, res) => {
      if (req.url === '/missing') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      archiveHits += 1;
      fsp.readFile(archivePath).then(
        (buf) => {
          res.setHeader('Content-Type', 'application/gzip');
          res.end(buf);
        },
        () => {
          res.statusCode = 500;
          res.end('read failed');
        },
      );
    });
    await new Promise<void>((resolve) => archiveServer.listen(0, '127.0.0.1', resolve));
    const addr = archiveServer.address() as AddressInfo;
    archiveUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => archiveServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function buildArchive(projectId: string, fileName: string, content: string) {
    const root = join(stagingDir, projectId);
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(join(root, fileName), content);
    await tarCreate({ gzip: true, file: archivePath, cwd: stagingDir }, [projectId]);
  }

  async function restore(projectId: string, body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/restore-archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(resp.ok).toBe(true);
    return resp.json() as Promise<{ restored: boolean; reason?: string }>;
  }

  it('restores when the project dir is missing, then skips while files exist', async () => {
    const projectId = `proj-${randomUUID()}`;
    await buildArchive(projectId, 'index.html', '<h1>restored</h1>');
    const hitsBefore = archiveHits;

    const first = await restore(projectId, { url: archiveUrl, ifMissing: true });
    expect(first).toEqual({ restored: true });
    expect(archiveHits).toBe(hitsBefore + 1);
    const restored = await fsp.readFile(join(projectsDir, projectId, 'index.html'), 'utf8');
    expect(restored).toBe('<h1>restored</h1>');

    // Files now on disk → second call must not touch the archive server.
    const second = await restore(projectId, { url: archiveUrl, ifMissing: true });
    expect(second).toEqual({ restored: false, reason: 'already present' });
    expect(archiveHits).toBe(hitsBefore + 1);
  });

  it('without ifMissing keeps the unconditional end-of-round semantics', async () => {
    const projectId = `proj-${randomUUID()}`;
    await buildArchive(projectId, 'index.html', 'v1');
    await restore(projectId, { url: archiveUrl });

    await buildArchive(projectId, 'index.html', 'v2');
    const hitsBefore = archiveHits;
    const again = await restore(projectId, { url: archiveUrl });
    expect(again).toEqual({ restored: true });
    expect(archiveHits).toBe(hitsBefore + 1);
    const content = await fsp.readFile(join(projectsDir, projectId, 'index.html'), 'utf8');
    expect(content).toBe('v2');
  });

  it('treats a 404 archive as a new project, not an error', async () => {
    const projectId = `proj-${randomUUID()}`;
    const result = await restore(projectId, { url: `${archiveUrl}/missing`, ifMissing: true });
    expect(result).toEqual({ restored: false, reason: 'archive not found' });
  });

  it('serializes concurrent ifMissing calls so the archive is fetched once', async () => {
    const projectId = `proj-${randomUUID()}`;
    await buildArchive(projectId, 'index.html', 'concurrent');
    const hitsBefore = archiveHits;

    const [a, b] = await Promise.all([
      restore(projectId, { url: archiveUrl, ifMissing: true }),
      restore(projectId, { url: archiveUrl, ifMissing: true }),
    ]);
    expect(archiveHits).toBe(hitsBefore + 1);
    const restoredFlags = [a.restored, b.restored].sort();
    expect(restoredFlags).toEqual([false, true]);
    const content = await fsp.readFile(join(projectsDir, projectId, 'index.html'), 'utf8');
    expect(content).toBe('concurrent');
  });
});
