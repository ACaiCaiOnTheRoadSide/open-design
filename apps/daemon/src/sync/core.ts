import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Pure primitives for the manifest + content-addressed blob sync between
 * project directories and OSS (`projects/<id>/blobs/<sha256>`).
 *
 * The manifest — `{version, files: {relPath: {sha256, size, mtime}}}` — lives
 * in the backend's Postgres and is the single source of truth for a project's
 * file set. Every party (daemon disk, sandbox working copy) reconciles by
 * diffing its local state against a base manifest and submitting the diff as
 * an op list under compare-and-swap on `version`. Blobs are immutable and
 * idempotent to upload, so only the manifest needs coordination.
 *
 * This module is dependency-free on daemon internals so it can be bundled
 * into od-cli.mjs and run inside sandboxes.
 */

// Dependency/VCS trees excluded from sync in BOTH directions. They are
// regenerable, can be enormous (a Vite project's node_modules), and the
// Design Files panel never shows them. `.od` is sync-internal state (the
// sandbox keeps its pull base under it) and must never sync itself.
const SYNC_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.od',
  'node_modules',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

export interface ManifestFileEntry {
  sha256: string;
  size: number;
  /** Milliseconds since epoch. A hint for hash caches, never a consistency input. */
  mtime: number;
}

export type ManifestFiles = Record<string, ManifestFileEntry>;

export interface Manifest {
  version: number;
  files: ManifestFiles;
}

export type ManifestOp =
  | { op: 'put'; path: string; sha256: string; size: number; mtime: number }
  | { op: 'delete'; path: string };

export interface LocalFileStat {
  size: number;
  mtimeMs: number;
}

// Sync ids share one keyspace with project ids on the backend (manifest key =
// projectId verbatim, no tenant column). Design systems and brands ride that
// same channel under a reserved prefix so their OSS blobs live beside project
// blobs. Because a project id is client-chosen, these prefixes MUST be refused
// by project-id validation (see isSafeId) — otherwise a tenant could create a
// project literally named `dsys--<victim>` and drive the project-sync APIs to
// read/overwrite another tenant's design-system blobs. Single source of truth:
// the daemon derives its namespace prefixes from here, and isSafeId rejects them.
export const DESIGN_SYSTEM_SYNC_PREFIX = 'dsys--';
export const BRAND_SYNC_PREFIX = 'brnd--';
export const RESERVED_SYNC_ID_PREFIXES: readonly string[] = [
  DESIGN_SYSTEM_SYNC_PREFIX,
  BRAND_SYNC_PREFIX,
];

/** True when `id` begins with a reserved sync-namespace prefix. Project-id
 *  validation rejects these so project ids can never collide with the
 *  design-system / brand sync keyspace. */
export function isReservedSyncId(id: string): boolean {
  return RESERVED_SYNC_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Manifest paths are clean forward-slash relatives. The backend enforces the
 * same rule; validating here keeps bad paths from ever reaching the wire.
 */
export function isValidManifestPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\')) return false;
  return relPath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Stat-walk of every synced file under projectDir, as forward-slash relative
 * paths. Pruning SYNC_IGNORED_DIR_NAMES trees keeps the walk and the manifest
 * describing the same universe. Unreadable directories are skipped — sync
 * must degrade to "file missing" rather than fail the whole scan.
 */
export async function walkProjectFiles(projectDir: string): Promise<Map<string, LocalFileStat>> {
  const out = new Map<string, LocalFileStat>();
  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SYNC_IGNORED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        try {
          const st = await stat(path.join(dir, entry.name));
          out.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // Deleted between readdir and stat — treat as absent.
        }
      }
    }
  };
  await walk(projectDir, '');
  return out;
}

/** Streaming sha256 of a file on disk (lowercase hex). */
export function hashFileSha256(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(absPath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Ops that turn `base` into `local`. Unchanged files produce NO op — that is
 * the property that lets concurrent writers merge per-file and that makes a
 * mid-round user deletion stick (the old tar channel needed a run-start
 * baseline to avoid resurrecting deleted files; a diff never mentions them).
 */
export function diffManifests(base: ManifestFiles, local: ManifestFiles): ManifestOp[] {
  const ops: ManifestOp[] = [];
  for (const [relPath, entry] of Object.entries(local)) {
    const before = base[relPath];
    if (!before || before.sha256 !== entry.sha256) {
      ops.push({ op: 'put', path: relPath, sha256: entry.sha256, size: entry.size, mtime: entry.mtime });
    }
  }
  for (const relPath of Object.keys(base)) {
    if (!(relPath in local)) ops.push({ op: 'delete', path: relPath });
  }
  return ops;
}

/**
 * Rebase our ops onto a newer manifest after a CAS conflict. Puts survive —
 * they carry our file content and per-file last-writer-wins is the merge
 * rule — unless the current manifest already has the identical entry.
 * Deletes survive only while the current entry still matches what we based
 * the delete on; if someone rewrote the file since, deleting it would throw
 * away their work, so the delete is dropped.
 */
export function rebaseOps(
  ops: ManifestOp[],
  baseFiles: ManifestFiles,
  currentFiles: ManifestFiles,
): ManifestOp[] {
  const rebased: ManifestOp[] = [];
  for (const op of ops) {
    const current = currentFiles[op.path];
    if (op.op === 'put') {
      if (current && current.sha256 === op.sha256) continue; // already there
      rebased.push(op);
    } else {
      if (!current) continue; // already gone
      const basedOn = baseFiles[op.path];
      if (basedOn && current.sha256 === basedOn.sha256) rebased.push(op);
    }
  }
  return rebased;
}

/** Apply an op list to a files map (pure; returns a new map). */
export function applyOps(files: ManifestFiles, ops: ManifestOp[]): ManifestFiles {
  const next: ManifestFiles = { ...files };
  for (const op of ops) {
    if (op.op === 'put') {
      next[op.path] = { sha256: op.sha256, size: op.size, mtime: op.mtime };
    } else {
      delete next[op.path];
    }
  }
  return next;
}

/** Run `fn` over `items` with at most `limit` in flight. Rejects on first error. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
