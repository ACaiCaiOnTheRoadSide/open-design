// In-memory backend implementing the /api/internal/sync contract (manifest
// GET, diff with version CAS + 409 current-manifest response, blob
// check/put/get). Shared by the engine and CLI sync tests.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { applyOps, type ManifestFiles, type ManifestOp } from '../../src/sync/core.js';

export const sha = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export interface FakeSyncBackend {
  server: Server;
  manifests: Map<string, { version: number; files: ManifestFiles }>;
  blobs: Map<string, Buffer>;
  readonly diffCommits: number;
  failNextDiff: (count?: number) => void;
  failNextManifest: (count?: number) => void;
  delayBlobGet: (sha256: string, delayMs: number) => void;
}

export function createFakeSyncBackend(): FakeSyncBackend {
  const manifests = new Map<string, { version: number; files: ManifestFiles }>();
  const blobs = new Map<string, Buffer>();
  let diffCommits = 0;
  let pendingDiffFailures = 0;
  let pendingManifestFailures = 0;
  const blobGetDelays = new Map<string, number>();

  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      const projectId = url.searchParams.get('projectId') ?? '';
      if (url.pathname === '/api/internal/sync/manifest' && req.method === 'GET') {
        if (pendingManifestFailures > 0) {
          pendingManifestFailures -= 1;
          return json(503, { error: 'temporary failure' });
        }
        return json(200, manifests.get(projectId) ?? { version: 0, files: {} });
      }
      if (url.pathname === '/api/internal/sync/manifest/diff' && req.method === 'POST') {
        if (pendingDiffFailures > 0) {
          pendingDiffFailures -= 1;
          return json(503, { error: 'temporary failure' });
        }
        const payload = JSON.parse(body.toString()) as {
          projectId: string;
          baseVersion: number;
          ops: ManifestOp[];
        };
        const m = manifests.get(payload.projectId) ?? { version: 0, files: {} };
        if (m.version !== payload.baseVersion) {
          return json(409, { version: m.version, files: m.files });
        }
        const files = applyOps(m.files, payload.ops);
        const next = { version: m.version + 1, files };
        manifests.set(payload.projectId, next);
        diffCommits += 1;
        return json(200, { version: next.version });
      }
      if (url.pathname === '/api/internal/sync/blobs/check' && req.method === 'POST') {
        const payload = JSON.parse(body.toString()) as { sha256s: string[] };
        return json(200, { missing: payload.sha256s.filter((s) => !blobs.has(s)) });
      }
      if (url.pathname === '/api/internal/sync/blob' && req.method === 'PUT') {
        const digest = url.searchParams.get('sha256')!;
        if (sha(body) !== digest) return json(400, { error: 'hash mismatch' });
        blobs.set(digest, body);
        return json(200, { key: `projects/${projectId}/blobs/${digest}` });
      }
      if (url.pathname === '/api/internal/sync/blob' && req.method === 'GET') {
        const digest = url.searchParams.get('sha256')!;
        const blob = blobs.get(digest);
        if (!blob) return json(404, { error: 'not found' });
        const send = () => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/octet-stream');
          res.end(blob);
        };
        const delayMs = blobGetDelays.get(digest) ?? 0;
        if (delayMs > 0) {
          setTimeout(send, delayMs);
          return;
        }
        return send();
      }
      json(500, { error: `unexpected ${req.method} ${url.pathname}` });
    });
  });

  return {
    server,
    manifests,
    blobs,
    get diffCommits() {
      return diffCommits;
    },
    failNextDiff(count = 1) {
      pendingDiffFailures += count;
    },
    failNextManifest(count = 1) {
      pendingManifestFailures += count;
    },
    delayBlobGet(sha256, delayMs) {
      if (delayMs > 0) blobGetDelays.set(sha256, delayMs);
      else blobGetDelays.delete(sha256);
    },
  };
}
