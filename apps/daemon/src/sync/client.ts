import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  applyOps,
  rebaseOps,
  type Manifest,
  type ManifestFiles,
  type ManifestOp,
} from './core.js';

/**
 * HTTP client for the backend's manifest/blob endpoints
 * (`/api/internal/sync/*`). Used identically by the daemon process and by
 * `od sync` inside sandboxes, so the only inputs are a base URL and a bearer
 * token — no daemon internals.
 */

export interface SyncTarget {
  backendUrl: string;
  apiToken: string;
}

/** Sync is enabled only when a backend is configured (SaaS deployments). */
export function syncTargetFromEnv(env: NodeJS.ProcessEnv = process.env): SyncTarget | null {
  const backendUrl = env.OD_BACKEND_URL;
  const apiToken = env.OD_API_TOKEN;
  if (!backendUrl || !apiToken) return null;
  return { backendUrl: backendUrl.replace(/\/$/, ''), apiToken };
}

function authHeaders(target: SyncTarget): Record<string, string> {
  return { authorization: `Bearer ${target.apiToken}` };
}

/** One retry on transport errors; HTTP error statuses are NOT retried here. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return fetch(url, init);
  }
}

export async function getManifest(target: SyncTarget, projectId: string): Promise<Manifest> {
  const url = `${target.backendUrl}/api/internal/sync/manifest?projectId=${encodeURIComponent(projectId)}`;
  const resp = await fetchWithRetry(url, { headers: authHeaders(target) });
  if (!resp.ok) throw new Error(`sync manifest: HTTP ${resp.status}`);
  const body = (await resp.json()) as { version?: number; files?: ManifestFiles };
  return { version: body.version ?? 0, files: body.files ?? {} };
}

export async function getManifestHistory(target: SyncTarget, projectId: string): Promise<Manifest[]> {
  const url = `${target.backendUrl}/api/internal/sync/manifest/history?projectId=${encodeURIComponent(projectId)}`;
  const resp = await fetchWithRetry(url, { headers: authHeaders(target) });
  if (!resp.ok) throw new Error(`sync manifest/history: HTTP ${resp.status}`);
  const body = (await resp.json()) as Array<{ version?: number; files?: ManifestFiles }>;
  return body.map((entry) => ({ version: entry.version ?? 0, files: entry.files ?? {} }));
}

export async function getManifestVersion(
  target: SyncTarget,
  projectId: string,
  version: number,
): Promise<Manifest | null> {
  const url = `${target.backendUrl}/api/internal/sync/manifest/version?projectId=${encodeURIComponent(projectId)}&version=${version}`;
  const resp = await fetchWithRetry(url, { headers: authHeaders(target) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`sync manifest/version: HTTP ${resp.status}`);
  const body = (await resp.json()) as { version?: number; files?: ManifestFiles };
  return { version: body.version ?? 0, files: body.files ?? {} };
}

export async function checkBlobs(
  target: SyncTarget,
  projectId: string,
  sha256s: string[],
): Promise<Set<string>> {
  if (sha256s.length === 0) return new Set();
  const url = `${target.backendUrl}/api/internal/sync/blobs/check`;
  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { ...authHeaders(target), 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, sha256s }),
  });
  if (!resp.ok) throw new Error(`sync blobs/check: HTTP ${resp.status}`);
  const body = (await resp.json()) as { missing?: string[] };
  return new Set(body.missing ?? []);
}

/** Stream a file to the blob store. Idempotent: the backend 200s on re-upload. */
export async function putBlobFromFile(
  target: SyncTarget,
  projectId: string,
  sha256: string,
  absPath: string,
): Promise<void> {
  const { size } = await stat(absPath);
  const url = `${target.backendUrl}/api/internal/sync/blob?projectId=${encodeURIComponent(projectId)}&sha256=${encodeURIComponent(sha256)}`;
  const attempt = async (): Promise<Response> =>
    fetch(url, {
      method: 'PUT',
      headers: {
        ...authHeaders(target),
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      body: Readable.toWeb(createReadStream(absPath)) as unknown as RequestInit['body'],
      // Node fetch requires half-duplex for streamed request bodies.
      duplex: 'half',
    } as RequestInit);
  let resp = await attempt().catch(() => null);
  if (!resp || !resp.ok) resp = await attempt();
  if (!resp.ok) throw new Error(`sync blob put ${sha256.slice(0, 12)}: HTTP ${resp.status}`);
}

/**
 * Download a blob to `destPath`, verifying its content hash in-stream.
 * Writes via a temp file + rename so a torn download never leaves a corrupt
 * file at the destination. Restores mtime when given (hash-cache hint).
 */
export async function getBlobToFile(
  target: SyncTarget,
  projectId: string,
  sha256: string,
  destPath: string,
  mtimeMs?: number,
): Promise<void> {
  const url = `${target.backendUrl}/api/internal/sync/blob?projectId=${encodeURIComponent(projectId)}&sha256=${encodeURIComponent(sha256)}`;
  const resp = await fetchWithRetry(url, { headers: authHeaders(target) });
  if (!resp.ok || !resp.body) throw new Error(`sync blob get ${sha256.slice(0, 12)}: HTTP ${resp.status}`);

  await mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(destPath),
    `.od-blob-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk as Buffer);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream),
      hasher,
      createWriteStream(tmpPath),
    );
    const actual = hash.digest('hex');
    if (actual !== sha256) {
      throw new Error(`sync blob get ${sha256.slice(0, 12)}: content hash mismatch (${actual.slice(0, 12)})`);
    }
    await rename(tmpPath, destPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  if (mtimeMs && mtimeMs > 0) {
    await utimes(destPath, new Date(), new Date(mtimeMs)).catch(() => {});
  }
}

export interface DiffSubmitResult {
  version: number;
  /** files as accepted by the backend after our ops (client-side projection) */
  files: ManifestFiles;
  /** ops actually committed after conflict rebasing (subset of the input) */
  committedOps: ManifestOp[];
}

const CAS_MAX_ATTEMPTS = 5;

/**
 * Submit a manifest diff under CAS. On a 409 the backend returns the current
 * manifest; our ops are rebased onto it (puts win per-file, deletes survive
 * only while the entry still matches `base`) and resubmitted. `base` must be
 * the manifest the ops were computed against.
 */
export async function submitDiff(
  target: SyncTarget,
  projectId: string,
  base: Manifest,
  ops: ManifestOp[],
): Promise<DiffSubmitResult> {
  let baseVersion = base.version;
  let currentFiles = base.files;
  let pendingOps = ops;

  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    if (pendingOps.length === 0) {
      return { version: baseVersion, files: currentFiles, committedOps: [] };
    }
    const url = `${target.backendUrl}/api/internal/sync/manifest/diff`;
    const resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { ...authHeaders(target), 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, baseVersion, ops: pendingOps }),
    });
    if (resp.ok) {
      const body = (await resp.json()) as { version?: number };
      return {
        version: body.version ?? baseVersion + 1,
        files: applyOps(currentFiles, pendingOps),
        committedOps: pendingOps,
      };
    }
    if (resp.status !== 409) throw new Error(`sync manifest/diff: HTTP ${resp.status}`);
    const conflict = (await resp.json()) as { version?: number; files?: ManifestFiles };
    baseVersion = conflict.version ?? 0;
    currentFiles = conflict.files ?? {};
    pendingOps = rebaseOps(pendingOps, base.files, currentFiles);
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  throw new Error(`sync manifest/diff: CAS conflict persisted after ${CAS_MAX_ATTEMPTS} attempts`);
}
