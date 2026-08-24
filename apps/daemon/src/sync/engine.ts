import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  diffManifests,
  hashFileSha256,
  isSyncIgnoredPath,
  isValidManifestPath,
  mapWithConcurrency,
  normalizeManifestFiles,
  walkProjectFiles,
  type Manifest,
  type ManifestFiles,
  type ManifestOp,
} from './core.js';
import { runProjectActiveOperation } from '../project-lifecycle-gate.js';
import {
  checkBlobs,
  getBlobToFile,
  getManifest,
  getManifestHistory,
  putBlobFromFile,
  submitDiff,
  syncTargetFromEnv,
  type SyncClientOptions,
  type SyncTarget,
} from './client.js';

/**
 * Daemon-side sync engine: keeps managed project directories reconciled with
 * the backend manifest + blob store, treating the local disk as an evictable
 * cache over OSS.
 *
 * Write path: file-mutating primitives call markDirty(projectId); a debounced
 * background scan hashes changed files (size+mtime hash cache), uploads
 * missing blobs, and commits a manifest diff under CAS. flush(projectId) is
 * the pre-run barrier — it runs one final scan and resolves only when the
 * manifest reflects the local disk, so a sandbox restore sees everything
 * including attachments uploaded moments ago.
 *
 * Read path: hydrate(projectId) diffs the local base against the remote
 * manifest and downloads/deletes only what changed (round-end backfill and
 * open-a-project rehydration after an eviction or pod rebuild).
 *
 * Because pushes are per-file diffs (unchanged files emit no op) a stale
 * daemon can never clobber a sandbox's round-end save — the CAS rebase in
 * submitDiff merges per file. That property retires the old tar channel's
 * etag ledger and run-start baseline machinery.
 *
 * All work for one project runs on one promise chain: concurrent flushes,
 * hydrates and evictions serialize per project and never overlap on disk.
 *
 * Everything is a no-op when no backend is configured (local deployments)
 * and for imported (metadata.baseDir) projects, whose directories the daemon
 * does not own — callers guard the latter via markDirty's metadata param.
 */

interface ProjectSyncState {
  baseVersion: number;
  baseFiles: ManifestFiles;
  hashCache: Record<string, { size: number; mtimeMs: number; sha256: string }>;
  lastAccessAt: number;
}

interface ProjectRuntime {
  state: ProjectSyncState | null; // null until loaded
  dirty: boolean;
  debounce: NodeJS.Timeout | null;
  chain: Promise<unknown>;
  revision: number;
}

export interface HydrateResult {
  updated: boolean;
  version: number;
  reason?: string;
}

export interface FlushResult {
  enabled: boolean;
  manifest: Manifest | null;
}

const PUSH_DEBOUNCE_MS = 2_000;
const PUSH_RETRY_MS = 5_000;
const BLOB_TRANSFER_CONCURRENCY = 4;
const SHUTDOWN_MAX_DRAIN_PASSES = 1_000;

let projectsDir = '';
let stateDir = '';
let hasActiveRun: (projectId: string) => boolean = () => false;

export type SyncResourceNamespace = 'design-system' | 'brand';
export interface SyncResourceNamespaceConfig {
  /** Wire identifier sent to the existing manifest/blob backend. */
  prefix: 'dsys--' | 'brnd--';
  /** Directory containing one child directory per logical resource id. */
  rootDir: string;
}
const resourceNamespaces = new Map<SyncResourceNamespace, SyncResourceNamespaceConfig>();

export function resourceSyncId(namespace: SyncResourceNamespace, resourceId: string): string {
  const config = resourceNamespaces.get(namespace);
  if (!config) throw new Error(`sync namespace not registered: ${namespace}`);
  if (!resourceId || !isValidManifestPath(resourceId) || resourceId.includes('/')) {
    throw new Error(`unsafe managed resource id: ${JSON.stringify(resourceId)}`);
  }
  return `${config.prefix}${encodeURIComponent(resourceId)}`;
}

function resourceMapping(syncId: string): { rootDir: string; resourceId: string } | null {
  for (const config of resourceNamespaces.values()) {
    if (!syncId.startsWith(config.prefix)) continue;
    const encoded = syncId.slice(config.prefix.length);
    try {
      const resourceId = decodeURIComponent(encoded);
      if (!resourceId || !isValidManifestPath(resourceId) || resourceId.includes('/')) return null;
      return { rootDir: config.rootDir, resourceId };
    } catch {
      return null;
    }
  }
  return null;
}
const runtimes = new Map<string, ProjectRuntime>();
let syncShuttingDown = false;
let syncShutdownPromise: Promise<void> | null = null;
let syncInflightController = new AbortController();
let syncShutdownAbortReason: Error | null = null;
let syncClientDeadlines: Pick<SyncClientOptions, 'requestDeadlineMs' | 'blobTransferDeadlineMs'> = {};
// A mutation admitted before shutdown may enqueue descendant work from one of
// its async continuations. AsyncLocalStorage distinguishes that accepted
// lineage from a genuinely new mutation arriving after the admission gate was
// closed.
const admittedMutation = new AsyncLocalStorage<{ active: boolean }>();

/** Wire the engine to the daemon's resolved data roots. Call once at startup. */
export function initSyncEngine(opts: {
  runtimeDataDir: string;
  projectsDir: string;
  hasActiveRun?: (projectId: string) => boolean;
  resourceNamespaces?: Partial<Record<SyncResourceNamespace, SyncResourceNamespaceConfig>>;
  requestDeadlineMs?: number;
  blobTransferDeadlineMs?: number;
}): void {
  for (const runtime of runtimes.values()) {
    if (runtime.debounce) clearTimeout(runtime.debounce);
  }
  syncInflightController.abort(new Error('sync engine reinitialized'));
  syncInflightController = new AbortController();
  syncShutdownAbortReason = null;
  syncClientDeadlines = {
    ...(opts.requestDeadlineMs == null ? {} : { requestDeadlineMs: opts.requestDeadlineMs }),
    ...(opts.blobTransferDeadlineMs == null ? {} : { blobTransferDeadlineMs: opts.blobTransferDeadlineMs }),
  };
  runtimes.clear();
  droppedAt.clear();
  syncShuttingDown = false;
  syncShutdownPromise = null;
  stateDir = path.join(opts.runtimeDataDir, 'sync');
  projectsDir = opts.projectsDir;
  hasActiveRun = opts.hasActiveRun ?? (() => false);
  resourceNamespaces.clear();
  for (const [namespace, config] of Object.entries(opts.resourceNamespaces ?? {})) {
    if (config) resourceNamespaces.set(namespace as SyncResourceNamespace, config);
  }
}

export function syncEnabled(): boolean {
  return Boolean(stateDir) && syncTargetFromEnv() !== null;
}

function requireTarget(): SyncTarget {
  const target = syncTargetFromEnv();
  if (!target) throw new Error('sync engine used without OD_BACKEND_URL/OD_API_TOKEN');
  return target;
}

function clientOptions(): SyncClientOptions {
  return { ...syncClientDeadlines, signal: syncInflightController.signal };
}

function isValidProjectId(projectId: string): boolean {
  return isValidManifestPath(projectId) && !projectId.includes('/');
}

function projectDirOf(projectId: string): string {
  if (!isValidProjectId(projectId)) {
    throw new Error(`unsafe managed sync id: ${JSON.stringify(projectId)}`);
  }
  const mapped = resourceMapping(projectId);
  return mapped
    ? path.join(path.resolve(mapped.rootDir), mapped.resourceId)
    : path.join(path.resolve(projectsDir), projectId);
}

function rootDirOf(syncId: string): string {
  return resourceMapping(syncId)?.rootDir ?? projectsDir;
}

function withLifecycleGate<T>(syncId: string, work: () => Promise<T>): Promise<T> {
  return resourceMapping(syncId) ? work() : runProjectActiveOperation(syncId, work);
}

class UnsafeSyncPathError extends Error {}

async function lstatIfPresent(absPath: string): Promise<fs.Stats | null> {
  try {
    return await lstat(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Reject every existing symlink from the managed project root through relPath. */
async function assertManagedPathSafe(
  projectId: string,
  relPath?: string,
  opts?: { finalMustBeFile?: boolean; allowPathShapeConflict?: boolean },
): Promise<string> {
  if (relPath != null && (!isValidManifestPath(relPath) || isSyncIgnoredPath(relPath))) {
    throw new UnsafeSyncPathError(`unsafe sync path: ${JSON.stringify(relPath)}`);
  }
  const projectDir = projectDirOf(projectId);
  const parts = relPath == null ? [] : relPath.split('/');
  const candidates = [projectDir];
  let current = projectDir;
  for (const part of parts) {
    current = path.join(current, part);
    candidates.push(current);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const st = await lstatIfPresent(candidate);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      throw new UnsafeSyncPathError(`sync path contains symlink: ${candidate}`);
    }
    const isFinal = index === candidates.length - 1;
    if (!isFinal && !st.isDirectory()) {
      if (opts?.allowPathShapeConflict) break;
      throw new UnsafeSyncPathError(`sync path ancestor is not a directory: ${candidate}`);
    }
    if (isFinal && opts?.finalMustBeFile && st.isDirectory()) {
      if (opts.allowPathShapeConflict) break;
      throw new UnsafeSyncPathError(`sync file path is an existing directory: ${candidate}`);
    }
  }
  return current;
}

async function baseFilesPresent(projectId: string, files: ManifestFiles): Promise<boolean> {
  for (const relPath of Object.keys(files)) {
    const absPath = await assertManagedPathSafe(projectId, relPath, { finalMustBeFile: true });
    const st = await lstatIfPresent(absPath);
    if (!st?.isFile()) return false;
  }
  return true;
}

/** mkdir -p without traversing a pre-existing symlink or non-directory. */
async function ensureManagedParent(projectId: string, relPath: string): Promise<void> {
  const parentParts = relPath.split('/').slice(0, -1);
  const managedRoot = rootDirOf(projectId);
  await mkdir(managedRoot, { recursive: true });
  const projectSegments = resourceMapping(projectId)?.resourceId.split('/') ?? projectId.split('/');
  let current = path.resolve(managedRoot);
  for (const segment of [...projectSegments, ...parentParts]) {
    current = path.join(current, segment);
    const before = await lstatIfPresent(current);
    if (!before) {
      await mkdir(current);
    }
    const after = await lstat(current);
    if (after.isSymbolicLink() || !after.isDirectory()) {
      throw new UnsafeSyncPathError(`sync path ancestor is not a safe directory: ${current}`);
    }
  }
}

function validateRemoteManifest(manifest: Manifest): void {
  const paths = Object.keys(manifest.files);
  const allPaths = new Set(paths);
  for (const relPath of paths) {
    if (!isValidManifestPath(relPath) || isSyncIgnoredPath(relPath)) {
      throw new UnsafeSyncPathError(`remote manifest contains unsafe or ignored path: ${JSON.stringify(relPath)}`);
    }
    const segments = relPath.split('/');
    let ancestor = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      ancestor = ancestor ? `${ancestor}/${segments[index]}` : segments[index]!;
      if (allPaths.has(ancestor)) {
        throw new UnsafeSyncPathError(
          `remote manifest path-shape conflict: ${JSON.stringify(ancestor)} and ${JSON.stringify(relPath)}`,
        );
      }
    }
  }
}

function stateFileOf(projectId: string): string {
  return path.join(stateDir, `${projectId}.json`);
}

function runtimeOf(projectId: string): ProjectRuntime {
  let rt = runtimes.get(projectId);
  if (!rt) {
    rt = { state: null, dirty: false, debounce: null, chain: Promise.resolve(), revision: 0 };
    runtimes.set(projectId, rt);
  }
  return rt;
}

/** Serialize project work on the runtime's promise chain (see module doc). */
function enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const rt = runtimeOf(projectId);
  const next = rt.chain.then(fn, fn);
  rt.revision += 1;
  rt.chain = next.catch(() => {});
  return next;
}

async function loadState(projectId: string): Promise<ProjectSyncState> {
  const rt = runtimeOf(projectId);
  if (rt.state) return rt.state;
  try {
    const raw = JSON.parse(await readFile(stateFileOf(projectId), 'utf8')) as ProjectSyncState;
    const hashCache = Object.create(null) as ProjectSyncState['hashCache'];
    if (raw.hashCache && typeof raw.hashCache === 'object' && !Array.isArray(raw.hashCache)) {
      for (const [relPath, entry] of Object.entries(raw.hashCache)) {
        if (!isValidManifestPath(relPath) || isSyncIgnoredPath(relPath) || !entry || typeof entry !== 'object') continue;
        const value = entry as { size?: unknown; mtimeMs?: unknown; sha256?: unknown };
        if (typeof value.size === 'number' && typeof value.mtimeMs === 'number' && typeof value.sha256 === 'string') {
          hashCache[relPath] = { size: value.size, mtimeMs: value.mtimeMs, sha256: value.sha256 };
        }
      }
    }
    const baseFiles = normalizeManifestFiles(raw.baseFiles);
    for (const relPath of Object.keys(baseFiles)) {
      if (!isValidManifestPath(relPath) || isSyncIgnoredPath(relPath)) delete baseFiles[relPath];
    }
    rt.state = {
      baseVersion: typeof raw.baseVersion === 'number' ? raw.baseVersion : 0,
      baseFiles,
      hashCache,
      lastAccessAt: typeof raw.lastAccessAt === 'number' ? raw.lastAccessAt : Date.now(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    rt.state = {
      baseVersion: 0,
      baseFiles: normalizeManifestFiles(null),
      hashCache: Object.create(null) as ProjectSyncState['hashCache'],
      lastAccessAt: Date.now(),
    };
  }
  return rt.state;
}

async function persistState(projectId: string): Promise<void> {
  const rt = runtimeOf(projectId);
  if (!rt.state) return;
  await mkdir(stateDir, { recursive: true });
  const tmp = stateFileOf(projectId) + '.tmp';
  await writeFile(tmp, JSON.stringify(rt.state));
  await rename(tmp, stateFileOf(projectId));
}

/**
 * Compute the local manifest view of the project directory, reusing cached
 * hashes for files whose size+mtime did not move. The cache is pruned to the
 * current file set so deletions do not leak stale entries.
 */
async function scanLocalManifest(projectId: string): Promise<ManifestFiles> {
  const state = await loadState(projectId);
  const projectDir = await assertManagedPathSafe(projectId);
  const stats = await walkProjectFiles(projectDir);
  const files = normalizeManifestFiles(null);
  const nextCache = Object.create(null) as ProjectSyncState['hashCache'];
  for (const [relPath, st] of stats) {
    if (!isValidManifestPath(relPath) || isSyncIgnoredPath(relPath)) continue;
    const cached = state.hashCache[relPath];
    let sha256: string;
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      sha256 = cached.sha256;
    } else {
      const absPath = await assertManagedPathSafe(projectId, relPath, { finalMustBeFile: true });
      const fileStat = await lstat(absPath);
      if (!fileStat.isFile()) throw new UnsafeSyncPathError(`sync scan path is not a regular file: ${absPath}`);
      sha256 = await hashFileSha256(absPath);
    }
    nextCache[relPath] = { size: st.size, mtimeMs: st.mtimeMs, sha256 };
    files[relPath] = { sha256, size: st.size, mtime: Math.round(st.mtimeMs) };
  }
  state.hashCache = nextCache;
  return files;
}

/** Upload every blob the store is missing for the given put ops. */
async function uploadMissingBlobs(
  target: SyncTarget,
  projectId: string,
  ops: ManifestOp[],
  requestOptions: SyncClientOptions,
): Promise<void> {
  const puts = ops.filter((op): op is Extract<ManifestOp, { op: 'put' }> => op.op === 'put');
  const byHash = new Map(puts.map((op) => [op.sha256, op.path]));
  const missing = await checkBlobs(target, projectId, [...byHash.keys()], requestOptions);
  await mapWithConcurrency([...missing], BLOB_TRANSFER_CONCURRENCY, async (sha256) => {
    const relPath = byHash.get(sha256)!;
    const absPath = await assertManagedPathSafe(projectId, relPath, { finalMustBeFile: true });
    const st = await lstat(absPath);
    if (!st.isFile()) throw new UnsafeSyncPathError(`sync upload source is not a regular file: ${absPath}`);
    await putBlobFromFile(target, projectId, sha256, absPath, requestOptions);
  });
}

/**
 * One scan-and-push cycle: local scan → diff vs base → upload blobs → CAS
 * commit → advance base. Runs on the project chain. No-ops (a bare stat-walk)
 * when nothing changed, which is what makes the pre-run flush cheap.
 */
async function scanAndPush(
  projectId: string,
  requestOptions: SyncClientOptions = clientOptions(),
): Promise<Manifest> {
  const target = requireTarget();
  const rt = runtimeOf(projectId);
  const state = await loadState(projectId);
  state.lastAccessAt = Date.now();
  rt.dirty = false;

  // Cold-cache guard: base v0 with a non-empty remote manifest means this
  // disk never held the project (pod rebuild or eviction lost the state
  // file) and a write raced ahead of any hydrate. Pushing from that state
  // would eventually read "never downloaded" as "locally deleted" and emit
  // destructive deletes — reconcile from the remote first so the diff below
  // runs against a base the disk truly matches. Local-only files survive the
  // pull (empty baseFiles → nothing qualifies for deletion) and are pushed
  // as ordinary puts right after.
  if (state.baseVersion === 0) {
    const remote = await getManifest(target, projectId, requestOptions);
    validateRemoteManifest(remote);
    if (remote.version > 0) {
      await pullRemoteLocked(projectId, target, state, remote, requestOptions, { preserveUnbasedLocal: true });
    }
  }

  const localFiles = await scanLocalManifest(projectId);
  const base: Manifest = { version: state.baseVersion, files: state.baseFiles };
  // A based path missing from the regular-file walk may have been replaced by
  // a symlink. Reject it instead of interpreting that replacement as deletion.
  for (const relPath of Object.keys(base.files)) {
    if (!Object.hasOwn(localFiles, relPath)) {
      await assertManagedPathSafe(projectId, relPath, {
        finalMustBeFile: true,
        allowPathShapeConflict: true,
      });
    }
  }
  const ops = diffManifests(base.files, localFiles);
  if (ops.length === 0) {
    await persistState(projectId);
    return base;
  }
  try {
    await uploadMissingBlobs(target, projectId, ops, requestOptions);
    const result = await submitDiff(target, projectId, base, ops, requestOptions);
    validateRemoteManifest({ version: result.version, files: result.files });
    state.baseVersion = result.version;
    state.baseFiles = retainAccountableBase(result.files, base.files, localFiles);
    await persistState(projectId);
    console.error(
      `[sync] pushed ${result.committedOps.length}/${ops.length} ops for project ${projectId} (v${result.version})`,
    );
    if (Object.keys(state.baseFiles).length !== Object.keys(result.files).length) {
      // The conflict rebase accepted files this disk never held; materialize
      // them now so the directory, the base and the remote agree again. The
      // base version is already current, so the pull must be forced.
      await pullRemoteLocked(projectId, target, state, undefined, requestOptions, { force: true });
    }
    return { version: state.baseVersion, files: state.baseFiles };
  } catch (err) {
    // Shutdown deliberately cancels the currently executing request. Do not
    // immediately recreate that same half-open request from the drain loop;
    // ordinary failures remain dirty for the existing debounce/flush retry.
    rt.dirty = !(syncShuttingDown && err === syncShutdownAbortReason);
    throw err;
  }
}

/**
 * A base entry may only claim files this disk can account for: present in
 * the local scan or carried over from the previous base. A conflict-rebased
 * commit adopts the server's full file map, which can reference files never
 * downloaded here (cold cache, concurrent sandbox round-end); keeping those
 * in the base would make the next scan read "never downloaded" as "locally
 * deleted" and push destructive deletes. Dropped entries leave the remote
 * files untouched — a diff never mentions files absent from its base.
 */
function retainAccountableBase(
  accepted: ManifestFiles,
  previousBase: ManifestFiles,
  localFiles: ManifestFiles,
): ManifestFiles {
  const out = normalizeManifestFiles(null);
  for (const [relPath, entry] of Object.entries(accepted)) {
    if (Object.hasOwn(localFiles, relPath) || Object.hasOwn(previousBase, relPath)) out[relPath] = entry;
  }
  return out;
}

/**
 * Mark a managed project as having local changes. Callers that know the
 * project is an imported (baseDir) workspace must pass its metadata so the
 * engine can skip it — those directories belong to the user, not the cache.
 */
function schedulePush(projectId: string, delayMs: number): void {
  if (syncShuttingDown) return;
  const rt = runtimeOf(projectId);
  if (rt.debounce) clearTimeout(rt.debounce);
  rt.debounce = setTimeout(() => {
    rt.debounce = null;
    if (syncShuttingDown) return;
    void withLifecycleGate(
      projectId,
      () => enqueue(projectId, () => scanAndPush(projectId)),
    ).catch((err) => {
      console.error(`[sync] background push failed for project ${projectId}: ${err?.message || err}`);
      rt.dirty = true;
      if (!isRecentlyDropped(projectId)) schedulePush(projectId, PUSH_RETRY_MS);
    });
  }, delayMs);
  rt.debounce.unref?.();
}

export function markDirty(projectId: string, metadata?: unknown): void {
  if (!syncEnabled()) return;
  if (!projectId || !isValidProjectId(projectId)) return;
  // A write landing after dropState (in-flight request racing the delete)
  // must not resurrect the state file / push a scan of the deleted dir.
  if (isRecentlyDropped(projectId)) return;
  const meta = metadata as { baseDir?: unknown } | null | undefined;
  if (meta && typeof meta.baseDir === 'string' && meta.baseDir) return;
  const rt = runtimeOf(projectId);
  rt.dirty = true;
  rt.revision += 1;
  if (!syncShuttingDown) schedulePush(projectId, PUSH_DEBOUNCE_MS);
}

export async function runProjectMutation<T>(
  projectId: string,
  metadata: unknown,
  mutation: () => Promise<T>,
): Promise<T> {
  const meta = metadata as { baseDir?: unknown } | null | undefined;
  if (!projectId || !isValidProjectId(projectId)) return mutation();
  return withLifecycleGate(projectId, () => {
    if (
      !syncEnabled()
      || isRecentlyDropped(projectId)
      || (meta && typeof meta.baseDir === 'string' && meta.baseDir)
    ) {
      return mutation();
    }
    if (syncShuttingDown && !admittedMutation.getStore()?.active) {
      throw new Error('sync engine is shutting down; new project mutations are not accepted');
    }
    return enqueue(projectId, async () => {
      const admission = { active: true };
      return admittedMutation.run(admission, async () => {
        try {
          return await mutation();
        } finally {
          // Detached timers retain AsyncLocalStorage, so explicitly expire the
          // admission when this mutation settles. Only descendants registered
          // while their accepted ancestor is actually active may join shutdown.
          admission.active = false;
        }
      });
    });
  });
}

export function reviveProject(projectId: string): void {
  if (!projectId || !isValidProjectId(projectId)) return;
  droppedAt.delete(projectId);
}

/** Namespace-safe lifecycle helpers for filesystem-backed SaaS resources. */
export function markResourceDirty(namespace: SyncResourceNamespace, resourceId: string): void {
  markDirty(resourceSyncId(namespace, resourceId));
}

export function runResourceMutation<T>(
  namespace: SyncResourceNamespace,
  resourceId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  return runProjectMutation(resourceSyncId(namespace, resourceId), null, mutation);
}

export function hydrateResource(
  namespace: SyncResourceNamespace,
  resourceId: string,
  opts?: { ifMissing?: boolean },
): Promise<HydrateResult> {
  return hydrate(resourceSyncId(namespace, resourceId), opts);
}

export function dropResourceState(namespace: SyncResourceNamespace, resourceId: string): Promise<void> {
  return dropState(resourceSyncId(namespace, resourceId));
}

/**
 * Boot repair for the PVC cache. Existing directories are treated as local
 * backfill and pushed; registry-known missing directories are hydrated on
 * demand by callers through hydrateResource(..., { ifMissing: true }).
 */
export async function backfillRegisteredResourceNamespaces(): Promise<string[]> {
  if (!syncEnabled()) return [];
  const scheduled: string[] = [];
  for (const [namespace, config] of resourceNamespaces) {
    let entries: fs.Dirent[] = [];
    try {
      entries = await readdir(config.rootDir, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const syncId = resourceSyncId(namespace, entry.name);
        markDirty(syncId);
        scheduled.push(syncId);
      } catch {}
    }
  }
  return scheduled;
}

/**
 * Pre-run barrier: make the manifest reflect the local disk right now.
 * Cancels any pending debounce and runs a final scan on the chain, so
 * in-flight background pushes finish first. Throws on failure — the caller
 * must fail the round rather than start a sandbox against a stale manifest.
 */
export async function flush(projectId: string): Promise<FlushResult> {
  if (!syncEnabled()) return { enabled: false, manifest: null };
  if (!projectId || !isValidProjectId(projectId) || isRecentlyDropped(projectId)) {
    return { enabled: true, manifest: null };
  }
  const rt = runtimeOf(projectId);
  if (rt.debounce) {
    clearTimeout(rt.debounce);
    rt.debounce = null;
  }
  const manifest = await withLifecycleGate(
    projectId,
    () => enqueue(projectId, () => scanAndPush(projectId)),
  );
  return { enabled: true, manifest };
}

/**
 * Terminal daemon barrier. It first disables every debounce/retry and clears
 * their timers, then joins each per-project chain and immediately pushes any
 * dirty work left behind it. Required resources must stay alive until this
 * promise settles; failures are aggregated so one project cannot prevent the
 * remaining dirty projects from being attempted.
 */
export function shutdownSyncEngine(): Promise<void> {
  if (syncShutdownPromise) return syncShutdownPromise;
  syncShuttingDown = true;
  // Do not let a half-open backend pin process shutdown until the configured
  // deadline. Cancel every request already in flight. A fresh controller is
  // used only by the bounded dirty-drain below, so writes accepted before the
  // admission gate closed still get their final immediate push.
  syncShutdownAbortReason = new Error('sync engine shutting down');
  syncInflightController.abort(syncShutdownAbortReason);
  const shutdownDrainOptions: SyncClientOptions = {
    ...syncClientDeadlines,
    signal: new AbortController().signal,
  };

  for (const rt of runtimes.values()) {
    if (rt.debounce) {
      clearTimeout(rt.debounce);
      rt.debounce = null;
    }
  }

  syncShutdownPromise = (async () => {
    if (!syncEnabled()) {
      await Promise.all([...runtimes.values()].map((rt) => rt.chain));
      return;
    }

    const failures: Array<{ projectId: string; error: unknown }> = [];
    // An admitted mutation can append descendant work after this barrier has
    // already observed its runtime. Drain a project until its chain identity,
    // dirty bit and revision all remain stable for a microtask turn. A failed
    // push deliberately stops that project's loop (scanAndPush leaves it dirty)
    // so shutdown cannot retry forever; other projects still drain in parallel.
    const visited = new Set<string>();
    let runtimePasses = 0;
    while (true) {
      const batch = [...runtimes.entries()].filter(([projectId]) => !visited.has(projectId));
      if (batch.length === 0) break;
      runtimePasses += 1;
      if (runtimePasses > SHUTDOWN_MAX_DRAIN_PASSES) {
        failures.push({
          projectId: '<runtime-registry>',
          error: new Error('sync shutdown did not quiesce: project runtimes kept being registered'),
        });
        break;
      }
      for (const [projectId] of batch) visited.add(projectId);
      const settled = await Promise.allSettled(batch.map(async ([projectId, rt]) => {
        for (let pass = 0; pass < SHUTDOWN_MAX_DRAIN_PASSES; pass += 1) {
          const observedChain = rt.chain;
          await observedChain;
          if (!isRecentlyDropped(projectId) && rt.dirty) {
            await withLifecycleGate(
              projectId,
              () => enqueue(projectId, () => scanAndPush(projectId, shutdownDrainOptions)),
            );
          }

          // Capture and join again after the dirty flush: an accepted mutation
          // may have appended behind the chain we awaited at the top of this
          // pass. Chain identity alone is not quiescence until that latest
          // snapshot has itself settled.
          const stableChain = rt.chain;
          await stableChain;
          const stableRevision = rt.revision;
          await Promise.resolve();
          if (rt.chain === stableChain && rt.revision === stableRevision && !rt.dirty) return;
        }
        throw new Error(`sync shutdown did not quiesce for project ${projectId}`);
      }));
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          failures.push({ projectId: batch[index]![0], error: result.reason });
        }
      });
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ error }) => error),
        `sync shutdown failed for projects: ${failures.map(({ projectId }) => projectId).join(', ')}`,
      );
    }
  })();
  return syncShutdownPromise;
}

// Recently-dropped project ids. Blocks markDirty/hydrate stragglers (an
// in-flight request that read the project row just before deletion, a
// debounced push scheduled pre-delete, a late watcher callback) from
// resurrecting sync/<projectId>.json or re-downloading the project dir right
// after an explicit delete. TTL rather than permanent so a project recreated
// under the same id later syncs normally.
const droppedAt = new Map<string, number>();
const DROP_TOMBSTONE_MS = 60_000;

function isRecentlyDropped(projectId: string): boolean {
  const at = droppedAt.get(projectId);
  if (at == null) return false;
  if (Date.now() - at > DROP_TOMBSTONE_MS) {
    droppedAt.delete(projectId);
    return false;
  }
  return true;
}

/**
 * Explicit project delete: discard the per-project sync state file and any
 * pending background push. The project dir itself is removed by the delete
 * handler; without this, sync/<projectId>.json would outlive the project —
 * cold eviction never reclaims it because eviction requires a synced base
 * state, which a deleted project no longer accumulates.
 */
export async function dropState(projectId: string): Promise<void> {
  if (!stateDir) return;
  if (!projectId || !isValidProjectId(projectId)) return;
  droppedAt.set(projectId, Date.now());
  const rt = runtimeOf(projectId);
  if (rt.debounce) {
    clearTimeout(rt.debounce);
    rt.debounce = null;
  }
  // Serialize on the project's chain so an in-flight push can't recreate the
  // state file after we remove it. force:true makes a missing file a no-op;
  // a real failure (EACCES/EBUSY) propagates to the caller, which owns the
  // logging — swallowing it here would leave the leak with zero diagnostics.
  await enqueue(projectId, async () => {
    await rm(stateFileOf(projectId), { force: true });
  });
  // Remove the runtime entry so deleted projects don't accumulate forever in
  // the module-level map (the chain closure keeps its own reference, so
  // serialization is unaffected). A straggler can mint at most one fresh
  // entry, which the tombstone above keeps inert.
  if (runtimes.get(projectId) === rt) runtimes.delete(projectId);
}

/**
 * Reconcile the local directory with the remote manifest, downloading only
 * changed/missing files and deleting files the manifest no longer contains.
 * Local dirty changes are pushed first (implicit flush), so after this the
 * disk, the base state and the remote manifest agree.
 *
 * ifMissing=true is the open-a-project fast path: checks the remote manifest
 * version against the local state version — cheap enough for the gateway to
 * call on every project-detail GET.
 *
 * If blob downloads fail for the current version (e.g. sandbox was killed
 * before uploading), automatically falls back to the most recent historical
 * version whose blobs are all available.
 */
export async function hydrate(projectId: string, opts?: { ifMissing?: boolean }): Promise<HydrateResult> {
  if (!syncEnabled()) return { updated: false, version: 0, reason: 'sync disabled' };
  if (!projectId || !isValidProjectId(projectId)) {
    return { updated: false, version: 0, reason: 'invalid project id' };
  }
  // A hydrate racing an explicit delete (e.g. the web UI still polling
  // project files) would re-download the whole project dir from the remote
  // manifest after removeProjectDir already ran — resurrecting the project
  // as an unevictable baseVersion-0 orphan. Tombstoned ids short-circuit.
  if (isRecentlyDropped(projectId)) {
    return { updated: false, version: 0, reason: 'project deleted' };
  }
  const ifMissing = opts?.ifMissing === true;
  // Snapshot the operation signal before entering the project queue. Shutdown
  // can then abort this whole accepted lineage without later stages observing a
  // replacement controller.
  const requestOptions = clientOptions();
  return withLifecycleGate(projectId, () => enqueue(projectId, async () => {
    const target = requireTarget();
    const state = await loadState(projectId);
    state.lastAccessAt = Date.now();
    const dir = projectDirOf(projectId);

    if (ifMissing) {
      // A successful local mutation may still be waiting on the debounce. Push
      // it before comparing remote versions so a read cannot overwrite it.
      if (runtimeOf(projectId).dirty) await scanAndPush(projectId, requestOptions);
      // Fast path: if the local state version matches, skip the HTTP call.
      // Only fetch remote manifest when versions might disagree or the
      // directory is empty — keeps the common case (project already present
      // and up-to-date) as cheap as a local readdir.
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        // ENOENT → treat as missing
      }
      let prefetchedRemote: Manifest | undefined;
      if (entries.length > 0 && state.baseVersion > 0) {
        // Directory has files and we have a baseline — check remote version.
        prefetchedRemote = await getManifest(target, projectId, requestOptions);
        validateRemoteManifest(prefetchedRemote);
        if (state.baseVersion === prefetchedRemote.version) {
          if (await baseFilesPresent(projectId, prefetchedRemote.files)) {
            await persistState(projectId);
            return { updated: false, version: state.baseVersion, reason: 'already present' };
          }
          return pullRemoteLocked(projectId, target, state, prefetchedRemote, requestOptions, { force: true });
        }
      }
      // An empty cache with persisted state must force a full rebuild even when
      // the remote version is unchanged. Keep a non-empty baseline on version
      // mismatch so pullRemoteLocked can safely reconcile deletes and path shapes.
      if (entries.length === 0 && (state.baseVersion > 0 || Object.keys(state.baseFiles).length > 0)) {
        state.baseVersion = 0;
        state.baseFiles = normalizeManifestFiles(null);
        state.hashCache = Object.create(null) as ProjectSyncState['hashCache'];
      }
      return pullRemoteLocked(projectId, target, state, prefetchedRemote, requestOptions);
    } else {
      // Push local changes first so the pull below cannot stomp them.
      await scanAndPush(projectId, requestOptions);
    }

    return pullRemoteLocked(projectId, target, state, undefined, requestOptions);
  }));
}

/**
 * The pull half of hydrate: reconcile the local directory with the remote
 * manifest. Must already run on the project chain (hydrate and the cold-cache
 * guard in scanAndPush call it there). Pass `prefetchedRemote` when the
 * caller just fetched the manifest to save the round trip. `force` skips the
 * version-equality short-circuit — needed when the base version is already
 * current but the directory is known to be missing files (conflict-adopted
 * entries retained on the server but never downloaded here).
 */
async function pullRemoteLocked(
  projectId: string,
  target: SyncTarget,
  state: ProjectSyncState,
  prefetchedRemote: Manifest | undefined,
  requestOptions: SyncClientOptions,
  opts?: { force?: boolean; preserveUnbasedLocal?: boolean },
): Promise<HydrateResult> {
  const dir = projectDirOf(projectId);
  const remote = prefetchedRemote ?? (await getManifest(target, projectId, requestOptions));
  validateRemoteManifest(remote);
  if (!opts?.force && remote.version === state.baseVersion) {
    await persistState(projectId);
    return { updated: false, version: remote.version, reason: 'up to date' };
  }

  const localFiles = await scanLocalManifest(projectId);
  // With no established base every existing local file is unpushed work. A
  // cold-cache flush may arrive after the agent has already written the same
  // path as the remote, or a path with the opposite file/directory shape. Do
  // not materialize those remote entries: adopting the full remote as the base
  // below makes the immediately following scan emit the required put/delete
  // pair while the local bytes remain authoritative.
  const protectedLocalPaths = opts?.preserveUnbasedLocal
    ? new Set(Object.keys(localFiles))
    : new Set<string>();
  let activeRemote = remote;
  let installedPaths = new Set<string>();
  try {
    await preflightDroppedPaths(projectId, state.baseFiles, remote.files);
    installedPaths = await stageAndInstall(
      target,
      projectId,
      remote,
      state.baseFiles,
      localFiles,
      protectedLocalPaths,
      requestOptions,
    );
  } catch (err) {
    if (!(err instanceof BlobDownloadError)) throw err;
    // Blob download failed — try falling back to the previous version.
    // This happens when a sandbox was killed before uploading its blobs:
    // the manifest advanced but the referenced blobs don't exist on OSS.
    console.error(
      `[sync] hydrate v${remote.version} blob download failed for project ${projectId}: ${
        err instanceof Error ? err.message : err
      }; attempting fallback to previous version`,
    );
    let fallbackUsed = false;
    try {
      const history = await getManifestHistory(target, projectId, requestOptions);
      const previous = history
        .filter((entry) => entry.version < remote.version)
        .sort((a, b) => b.version - a.version)[0];
      if (previous && Object.keys(previous.files).length > 0) {
        validateRemoteManifest(previous);
        await preflightDroppedPaths(projectId, state.baseFiles, previous.files);
        installedPaths = await stageAndInstall(
          target,
          projectId,
          previous,
          state.baseFiles,
          localFiles,
          protectedLocalPaths,
          requestOptions,
        );
        activeRemote = previous;
        fallbackUsed = true;
        console.error(`[sync] fell back to v${previous.version} for project ${projectId}`);
      }
    } catch (fallbackErr) {
      console.error(
        `[sync] fallback also failed for project ${projectId}: ${
          fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
        }`,
      );
    }
    if (!fallbackUsed) throw err;
  }

  // Never cache an installed path using a later stat: a file route can replace
  // it between rename and stat. Leaving it uncached makes the next push hash the
  // actual bytes. Unchanged paths can safely retain their known remote hash.
  const stats = await walkProjectFiles(dir);
  for (const relPath of installedPaths) delete state.hashCache[relPath];
  for (const [relPath, entry] of Object.entries(activeRemote.files)) {
    if (installedPaths.has(relPath)) continue;
    const st = stats.get(relPath);
    if (st && localFiles[relPath]?.sha256 === entry.sha256) {
      state.hashCache[relPath] = { size: st.size, mtimeMs: st.mtimeMs, sha256: entry.sha256 };
    }
  }
  state.baseVersion = activeRemote.version;
  state.baseFiles = activeRemote.files;
  await persistState(projectId);
  console.error(`[sync] hydrated project ${projectId} to v${activeRemote.version}`);
  return { updated: true, version: activeRemote.version };
}

async function preflightDroppedPaths(
  projectId: string,
  baseFiles: ManifestFiles,
  remoteFiles: ManifestFiles,
): Promise<void> {
  for (const relPath of Object.keys(baseFiles)) {
    if (!Object.hasOwn(remoteFiles, relPath)) {
      await assertManagedPathSafe(projectId, relPath, { finalMustBeFile: true });
    }
  }
}

class BlobDownloadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

async function removeDroppedBaseFiles(
  projectId: string,
  baseFiles: ManifestFiles,
  remoteFiles: ManifestFiles,
  localFiles: ManifestFiles,
): Promise<void> {
  for (const [relPath, basedOn] of Object.entries(baseFiles)) {
    if (Object.hasOwn(remoteFiles, relPath)) continue;
    if (localFiles[relPath]?.sha256 !== basedOn.sha256) continue;
    const absPath = await assertManagedPathSafe(projectId, relPath, { finalMustBeFile: true });
    await rm(absPath, { force: true });
    delete runtimeOf(projectId).state?.hashCache[relPath];
  }
}

async function prepareInstallDestination(projectId: string, relPath: string): Promise<string> {
  const destination = await assertManagedPathSafe(projectId, relPath, {
    finalMustBeFile: true,
    allowPathShapeConflict: true,
  });
  const existing = await lstatIfPresent(destination);
  if (existing?.isDirectory()) await rmdir(destination);
  await assertManagedPathSafe(projectId, relPath, { finalMustBeFile: true });
  return destination;
}

/**
 * Download changed blobs into an ignored per-hydration staging directory, then
 * atomically rename each completed file into place. No destination is touched
 * until all downloads have passed hash verification.
 */
async function stageAndInstall(
  target: SyncTarget,
  projectId: string,
  manifest: Manifest,
  baseFiles: ManifestFiles,
  localFiles: ManifestFiles,
  protectedLocalPaths: ReadonlySet<string> = new Set(),
  requestOptions: SyncClientOptions,
): Promise<Set<string>> {
  validateRemoteManifest(manifest);
  const toFetch = Object.entries(manifest.files).filter(
    ([relPath, entry]) =>
      localFiles[relPath]?.sha256 !== entry.sha256 &&
      !hasProtectedPathConflict(relPath, protectedLocalPaths),
  );
  // Reject symlinks before making a request, while allowing a based file or
  // directory that the incoming manifest intentionally replaces.
  for (const [relPath] of toFetch) {
    await assertManagedPathSafe(projectId, relPath, {
      finalMustBeFile: true,
      allowPathShapeConflict: true,
    });
  }
  if (toFetch.length === 0) {
    await removeDroppedBaseFiles(projectId, baseFiles, manifest.files, localFiles);
    return new Set();
  }
  await ensureManagedParent(projectId, 'placeholder');
  const projectDir = projectDirOf(projectId);
  const stagingContainer = path.join(projectDir, '.od-sync-staging');
  const existingContainer = await lstatIfPresent(stagingContainer);
  if (existingContainer && (existingContainer.isSymbolicLink() || !existingContainer.isDirectory())) {
    throw new UnsafeSyncPathError(`unsafe sync staging directory: ${stagingContainer}`);
  }
  await mkdir(stagingContainer, { recursive: true });
  const stageDir = path.join(
    stagingContainer,
    `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(stageDir);

  try {
    try {
      await mapWithConcurrency(toFetch, BLOB_TRANSFER_CONCURRENCY, async ([relPath, entry]) => {
        await getBlobToFile(
          target,
          projectId,
          entry.sha256,
          path.join(stageDir, ...relPath.split('/')),
          entry.mtime,
          requestOptions,
        );
      });
    } catch (error) {
      throw new BlobDownloadError(error);
    }

    await removeDroppedBaseFiles(projectId, baseFiles, manifest.files, localFiles);
    for (const [relPath] of toFetch) {
      const destination = await prepareInstallDestination(projectId, relPath);
      await ensureManagedParent(projectId, relPath);
      const staged = path.join(stageDir, ...relPath.split('/'));
      const stagedStat = await lstat(staged);
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
        throw new UnsafeSyncPathError(`download staging path is not a regular file: ${staged}`);
      }
      await rename(staged, destination);
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    await rmdir(stagingContainer).catch(() => {});
  }
  return new Set(toFetch.map(([relPath]) => relPath));
}

function hasProtectedPathConflict(remotePath: string, protectedLocalPaths: ReadonlySet<string>): boolean {
  for (const localPath of protectedLocalPaths) {
    if (
      remotePath === localPath ||
      remotePath.startsWith(`${localPath}/`) ||
      localPath.startsWith(`${remotePath}/`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Evict cold managed projects: everything synced (not dirty), no active run,
 * untouched for ttlHours. The directory and the per-project sync state are
 * removed together — the next access rehydrates from the manifest via the
 * ifMissing hook. Only meaningful when a backend holds the source of truth.
 */
export async function evictColdProjects(ttlHours: number): Promise<string[]> {
  if (!syncEnabled() || !(ttlHours > 0)) return [];
  const roots: Array<{ root: string; namespace?: SyncResourceNamespace }> = [{ root: projectsDir }];
  for (const [namespace, config] of resourceNamespaces) roots.push({ root: config.rootDir, namespace });
  const cutoff = Date.now() - ttlHours * 3_600_000;
  const evicted: string[] = [];
  for (const managed of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = await readdir(managed.root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let projectId: string;
      try {
        projectId = managed.namespace ? resourceSyncId(managed.namespace, entry.name) : entry.name;
      } catch {
        continue;
      }
      if (!isValidManifestPath(projectId)) continue;
      const rt = runtimeOf(projectId);
      const active = !managed.namespace && hasActiveRun(projectId);
      if (rt.dirty || rt.debounce || active) continue;
      const done = await enqueue(projectId, async () => {
        if (rt.dirty || (!managed.namespace && hasActiveRun(projectId))) return false;
        const state = await loadState(projectId);
        if (state.lastAccessAt > cutoff || state.baseVersion === 0) return false;
        const projectDir = await assertManagedPathSafe(projectId);
        await rm(projectDir, { recursive: true, force: true });
        await rm(stateFileOf(projectId), { force: true }).catch(() => {});
        rt.state = null;
        return true;
      }).catch(() => false);
      if (done) {
        evicted.push(projectId);
        console.error(`[sync] evicted cold managed resource ${projectId}`);
      }
    }
  }
  return evicted;
}
