import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  applyOps,
  normalizeManifestFiles,
  rebaseOps,
  type Manifest,
  type ManifestFiles,
  type ManifestOp,
} from './core.js';

/** HTTP client for the backend manifest/blob endpoints. */
export interface SyncTarget {
  backendUrl: string;
  apiToken: string;
}

export interface SyncClientOptions {
  /** Cancels the complete operation, including retry backoff and response bodies. */
  signal?: AbortSignal;
  /** Per-attempt deadline for manifest/check/diff requests. */
  requestDeadlineMs?: number;
  /** Per-attempt deadline for potentially large blob transfers. */
  blobTransferDeadlineMs?: number;
}

export const DEFAULT_SYNC_REQUEST_DEADLINE_MS = 30_000;
// Blob transfers are streamed and can legitimately be large. Keep their default
// substantially longer than metadata requests while allowing deployments to
// tune it independently.
export const DEFAULT_SYNC_BLOB_TRANSFER_DEADLINE_MS = 10 * 60_000;
// Every attempt owns a total deadline that covers headers and response-body
// consumption. The caller signal lets engine shutdown abort immediately rather
// than waiting for that deadline.
const TRANSPORT_MAX_ATTEMPTS = 2;
const TRANSPORT_RETRY_DELAY_MS = 500;

export class SyncRequestTimeoutError extends Error {
  readonly code = 'SYNC_REQUEST_TIMEOUT';
  constructor(deadlineMs: number) {
    super(`sync request exceeded ${deadlineMs}ms deadline`);
    this.name = 'SyncRequestTimeoutError';
  }
}

class NonRetryableHttpError extends Error {}

/** Sync is enabled only when a backend is configured (SaaS deployments). */
export function syncTargetFromEnv(env: NodeJS.ProcessEnv = process.env): SyncTarget | null {
  const backendUrl = env.OD_BACKEND_URL;
  const apiToken = env.OD_API_TOKEN;
  if (!backendUrl || !apiToken) return null;
  return { backendUrl: backendUrl.replace(/\/$/, ''), apiToken };
}

function configuredDeadline(value: number | undefined, envName: string, fallback: number): number {
  if (value != null && Number.isFinite(value) && value > 0) return value;
  const fromEnv = Number(process.env[envName]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : fallback;
}

function authHeaders(target: SyncTarget): Record<string, string> {
  return { authorization: `Bearer ${target.apiToken}` };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}

async function requestWithRetry<T>(
  options: SyncClientOptions | undefined,
  blobTransfer: boolean,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const callerSignal = options?.signal;
  const deadlineMs = configuredDeadline(
    blobTransfer ? options?.blobTransferDeadlineMs : options?.requestDeadlineMs,
    blobTransfer ? 'OD_SYNC_BLOB_TRANSFER_DEADLINE_MS' : 'OD_SYNC_REQUEST_DEADLINE_MS',
    blobTransfer ? DEFAULT_SYNC_BLOB_TRANSFER_DEADLINE_MS : DEFAULT_SYNC_REQUEST_DEADLINE_MS,
  );

  for (let attempt = 0; attempt < TRANSPORT_MAX_ATTEMPTS; attempt += 1) {
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    const deadlineController = new AbortController();
    const timer = setTimeout(
      () => deadlineController.abort(new SyncRequestTimeoutError(deadlineMs)),
      deadlineMs,
    );
    timer.unref?.();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineController.signal])
      : deadlineController.signal;
    try {
      return await operation(signal);
    } catch (error) {
      if (callerSignal?.aborted) throw abortReason(callerSignal);
      if (error instanceof NonRetryableHttpError || attempt + 1 >= TRANSPORT_MAX_ATTEMPTS) throw error;
    } finally {
      clearTimeout(timer);
    }
    await abortableDelay(TRANSPORT_RETRY_DELAY_MS, callerSignal);
  }
  throw new Error('unreachable sync retry state');
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  options?: SyncClientOptions,
): Promise<T> {
  return requestWithRetry(options, false, async (signal) => {
    const resp = await fetch(url, { ...init, signal });
    if (!resp.ok) throw new NonRetryableHttpError(`HTTP ${resp.status}`);
    return await resp.json() as T;
  });
}

export async function getManifest(target: SyncTarget, projectId: string, options?: SyncClientOptions): Promise<Manifest> {
  const url = `${target.backendUrl}/api/internal/sync/manifest?projectId=${encodeURIComponent(projectId)}`;
  try {
    const body = await jsonRequest<{ version?: number; files?: ManifestFiles }>(url, { headers: authHeaders(target) }, options);
    return { version: body.version ?? 0, files: normalizeManifestFiles(body.files) };
  } catch (error) {
    if (error instanceof NonRetryableHttpError) throw new Error(`sync manifest: ${error.message}`, { cause: error });
    throw error;
  }
}

export async function getManifestHistory(target: SyncTarget, projectId: string, options?: SyncClientOptions): Promise<Manifest[]> {
  const url = `${target.backendUrl}/api/internal/sync/manifest/history?projectId=${encodeURIComponent(projectId)}`;
  try {
    const body = await jsonRequest<Array<{ version?: number; files?: ManifestFiles }>>(url, { headers: authHeaders(target) }, options);
    return body.map((entry) => ({ version: entry.version ?? 0, files: normalizeManifestFiles(entry.files) }));
  } catch (error) {
    if (error instanceof NonRetryableHttpError) throw new Error(`sync manifest/history: ${error.message}`, { cause: error });
    throw error;
  }
}

export async function getManifestVersion(
  target: SyncTarget,
  projectId: string,
  version: number,
  options?: SyncClientOptions,
): Promise<Manifest | null> {
  const url = `${target.backendUrl}/api/internal/sync/manifest/version?projectId=${encodeURIComponent(projectId)}&version=${version}`;
  return requestWithRetry(options, false, async (signal) => {
    const resp = await fetch(url, { headers: authHeaders(target), signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new NonRetryableHttpError(`sync manifest/version: HTTP ${resp.status}`);
    const body = await resp.json() as { version?: number; files?: ManifestFiles };
    return { version: body.version ?? 0, files: normalizeManifestFiles(body.files) };
  });
}

export async function checkBlobs(
  target: SyncTarget,
  projectId: string,
  sha256s: string[],
  options?: SyncClientOptions,
): Promise<Set<string>> {
  if (sha256s.length === 0) return new Set();
  const url = `${target.backendUrl}/api/internal/sync/blobs/check`;
  return requestWithRetry(options, false, async (signal) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(target), 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, sha256s }),
      signal,
    });
    if (!resp.ok) throw new NonRetryableHttpError(`sync blobs/check: HTTP ${resp.status}`);
    const body = await resp.json() as { missing?: string[] };
    return new Set(body.missing ?? []);
  });
}

/** Stream a file to the blob store. Idempotent: the backend 200s on re-upload. */
export async function putBlobFromFile(
  target: SyncTarget,
  projectId: string,
  sha256: string,
  absPath: string,
  options?: SyncClientOptions,
): Promise<void> {
  const { size } = await stat(absPath);
  const url = `${target.backendUrl}/api/internal/sync/blob?projectId=${encodeURIComponent(projectId)}&sha256=${encodeURIComponent(sha256)}`;
  const resp = await requestWithRetry(options, true, async (signal) => {
    const source = createReadStream(absPath);
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...authHeaders(target),
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        body: Readable.toWeb(source) as unknown as RequestInit['body'],
        signal,
        duplex: 'half',
      } as RequestInit);
      // Preserve the prior upload behaviour: a failed HTTP response gets one
      // fresh streamed attempt because PUT is content-addressed and idempotent.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } finally {
      if (!source.destroyed) source.destroy();
    }
  });
  if (!resp.ok) throw new Error(`sync blob put ${sha256.slice(0, 12)}: HTTP ${resp.status}`);
}

/** Download a blob to a verified temporary file before atomically installing it. */
export async function getBlobToFile(
  target: SyncTarget,
  projectId: string,
  sha256: string,
  destPath: string,
  mtimeMs?: number,
  options?: SyncClientOptions,
): Promise<void> {
  const url = `${target.backendUrl}/api/internal/sync/blob?projectId=${encodeURIComponent(projectId)}&sha256=${encodeURIComponent(sha256)}`;
  await mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = path.join(path.dirname(destPath), `.od-blob-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await requestWithRetry(options, true, async (signal) => {
      const resp = await fetch(url, { headers: authHeaders(target), signal });
      if (!resp.ok || !resp.body) throw new NonRetryableHttpError(`sync blob get ${sha256.slice(0, 12)}: HTTP ${resp.status}`);
      const hash = createHash('sha256');
      const hasher = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk as Buffer);
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream),
        hasher,
        createWriteStream(tmpPath),
        { signal },
      );
      const actual = hash.digest('hex');
      if (actual !== sha256) {
        throw new NonRetryableHttpError(`sync blob get ${sha256.slice(0, 12)}: content hash mismatch (${actual.slice(0, 12)})`);
      }
    });
    await rename(tmpPath, destPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  if (mtimeMs && mtimeMs > 0) await utimes(destPath, new Date(), new Date(mtimeMs)).catch(() => {});
}

export interface DiffSubmitResult {
  version: number;
  files: ManifestFiles;
  committedOps: ManifestOp[];
}

const CAS_MAX_ATTEMPTS = 5;

export async function submitDiff(
  target: SyncTarget,
  projectId: string,
  base: Manifest,
  ops: ManifestOp[],
  options?: SyncClientOptions,
): Promise<DiffSubmitResult> {
  let baseVersion = base.version;
  let currentFiles = base.files;
  let pendingOps = ops;

  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    if (pendingOps.length === 0) return { version: baseVersion, files: currentFiles, committedOps: [] };
    const url = `${target.backendUrl}/api/internal/sync/manifest/diff`;
    const result = await requestWithRetry(options, false, async (signal) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders(target), 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, baseVersion, ops: pendingOps }),
        signal,
      });
      if (resp.ok) return { kind: 'ok' as const, body: await resp.json() as { version?: number } };
      if (resp.status === 409) {
        return { kind: 'conflict' as const, body: await resp.json() as { version?: number; files?: ManifestFiles } };
      }
      throw new NonRetryableHttpError(`sync manifest/diff: HTTP ${resp.status}`);
    });
    if (result.kind === 'ok') {
      return {
        version: result.body.version ?? baseVersion + 1,
        files: applyOps(currentFiles, pendingOps),
        committedOps: pendingOps,
      };
    }
    baseVersion = result.body.version ?? 0;
    currentFiles = normalizeManifestFiles(result.body.files);
    pendingOps = rebaseOps(pendingOps, base.files, currentFiles);
    await abortableDelay(100 * 2 ** attempt, options?.signal);
  }
  throw new Error(`sync manifest/diff: CAS conflict persisted after ${CAS_MAX_ATTEMPTS} attempts`);
}
