import * as fs from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  diffManifests,
  hashFileSha256,
  isValidManifestPath,
  mapWithConcurrency,
  walkProjectFiles,
  type Manifest,
  type ManifestFiles,
  type ManifestOp,
} from './core.js';
import {
  checkBlobs,
  getBlobToFile,
  getManifest,
  getManifestHistory,
  putBlobFromFile,
  submitDiff,
  syncTargetFromEnv,
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
const BLOB_TRANSFER_CONCURRENCY = 4;

let projectsDir = '';
let stateDir = '';
let hasActiveRun: (projectId: string) => boolean = () => false;
const runtimes = new Map<string, ProjectRuntime>();
// 按 sync id 前缀路由到 PROJECTS_DIR 之外的目录根(如用户设计体系
// `dsys--<dirId>` → USER_DESIGN_SYSTEMS_DIR/<dirId>)。manifest/blob 通道对
// "这是不是项目"无感知,复用即得同一套 OSS 持久化;前缀命名空间只需与真实
// 项目 id 不冲突。evictColdProjects 只扫 projectsDir,额外命名空间不参与
// 冷淘汰(设计体系目录小、被 list 直接读盘,淘汰会让列表短暂缺项)。
const extraSyncRoots: Array<{ prefix: string; root: string }> = [];

/** Wire the engine to the daemon's resolved data roots. Call once at startup. */
export function initSyncEngine(opts: {
  runtimeDataDir: string;
  projectsDir: string;
  hasActiveRun?: (projectId: string) => boolean;
}): void {
  stateDir = path.join(opts.runtimeDataDir, 'sync');
  projectsDir = opts.projectsDir;
  if (opts.hasActiveRun) hasActiveRun = opts.hasActiveRun;
}

/** Route sync ids beginning with `prefix` to `root` instead of projectsDir.
 *  Call after initSyncEngine, before any markDirty/hydrate for that prefix. */
export function registerSyncNamespace(prefix: string, root: string): void {
  if (!prefix || !root) return;
  const existing = extraSyncRoots.find((ns) => ns.prefix === prefix);
  if (existing) {
    existing.root = root;
    return;
  }
  extraSyncRoots.push({ prefix, root });
}

export function syncEnabled(): boolean {
  return Boolean(stateDir) && syncTargetFromEnv() !== null;
}

function requireTarget(): SyncTarget {
  const target = syncTargetFromEnv();
  if (!target) throw new Error('sync engine used without OD_BACKEND_URL/OD_API_TOKEN');
  return target;
}

function projectDirOf(projectId: string): string {
  for (const ns of extraSyncRoots) {
    if (projectId.startsWith(ns.prefix)) {
      return path.join(ns.root, projectId.slice(ns.prefix.length));
    }
  }
  return path.join(projectsDir, projectId);
}

function stateFileOf(projectId: string): string {
  return path.join(stateDir, `${projectId}.json`);
}

function runtimeOf(projectId: string): ProjectRuntime {
  let rt = runtimes.get(projectId);
  if (!rt) {
    rt = { state: null, dirty: false, debounce: null, chain: Promise.resolve() };
    runtimes.set(projectId, rt);
  }
  return rt;
}

/** Serialize project work on the runtime's promise chain (see module doc). */
function enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const rt = runtimeOf(projectId);
  const next = rt.chain.then(fn, fn);
  rt.chain = next.catch(() => {});
  return next;
}

async function loadState(projectId: string): Promise<ProjectSyncState> {
  const rt = runtimeOf(projectId);
  if (rt.state) return rt.state;
  try {
    const raw = JSON.parse(await readFile(stateFileOf(projectId), 'utf8')) as ProjectSyncState;
    rt.state = {
      baseVersion: typeof raw.baseVersion === 'number' ? raw.baseVersion : 0,
      baseFiles: raw.baseFiles && typeof raw.baseFiles === 'object' ? raw.baseFiles : {},
      hashCache: raw.hashCache && typeof raw.hashCache === 'object' ? raw.hashCache : {},
      lastAccessAt: typeof raw.lastAccessAt === 'number' ? raw.lastAccessAt : Date.now(),
    };
  } catch {
    rt.state = { baseVersion: 0, baseFiles: {}, hashCache: {}, lastAccessAt: Date.now() };
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
  const stats = await walkProjectFiles(projectDirOf(projectId));
  const files: ManifestFiles = {};
  const nextCache: ProjectSyncState['hashCache'] = {};
  for (const [relPath, st] of stats) {
    if (!isValidManifestPath(relPath)) continue;
    const cached = state.hashCache[relPath];
    let sha256: string;
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      sha256 = cached.sha256;
    } else {
      sha256 = await hashFileSha256(path.join(projectDirOf(projectId), relPath));
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
): Promise<void> {
  const puts = ops.filter((op): op is Extract<ManifestOp, { op: 'put' }> => op.op === 'put');
  const byHash = new Map(puts.map((op) => [op.sha256, op.path]));
  const missing = await checkBlobs(target, projectId, [...byHash.keys()]);
  await mapWithConcurrency([...missing], BLOB_TRANSFER_CONCURRENCY, async (sha256) => {
    const relPath = byHash.get(sha256)!;
    await putBlobFromFile(target, projectId, sha256, path.join(projectDirOf(projectId), relPath));
  });
}

/**
 * One scan-and-push cycle: local scan → diff vs base → upload blobs → CAS
 * commit → advance base. Runs on the project chain. No-ops (a bare stat-walk)
 * when nothing changed, which is what makes the pre-run flush cheap.
 */
async function scanAndPush(projectId: string): Promise<Manifest> {
  const target = requireTarget();
  const rt = runtimeOf(projectId);
  const state = await loadState(projectId);
  state.lastAccessAt = Date.now();
  rt.dirty = false;

  const localFiles = await scanLocalManifest(projectId);
  const base: Manifest = { version: state.baseVersion, files: state.baseFiles };
  const ops = diffManifests(base.files, localFiles);
  if (ops.length === 0) {
    await persistState(projectId);
    return base;
  }
  try {
    await uploadMissingBlobs(target, projectId, ops);
    const result = await submitDiff(target, projectId, base, ops);
    state.baseVersion = result.version;
    state.baseFiles = result.files;
    await persistState(projectId);
    console.error(
      `[sync] pushed ${result.committedOps.length}/${ops.length} ops for project ${projectId} (v${result.version})`,
    );
    return { version: state.baseVersion, files: state.baseFiles };
  } catch (err) {
    rt.dirty = true; // keep dirty so the next flush/debounce retries
    throw err;
  }
}

/**
 * Mark a managed project as having local changes. Callers that know the
 * project is an imported (baseDir) workspace must pass its metadata so the
 * engine can skip it — those directories belong to the user, not the cache.
 */
export function markDirty(projectId: string, metadata?: unknown): void {
  if (!syncEnabled()) return;
  if (!projectId || !isValidManifestPath(projectId)) return;
  const meta = metadata as { baseDir?: unknown } | null | undefined;
  if (meta && typeof meta.baseDir === 'string' && meta.baseDir) return;
  const rt = runtimeOf(projectId);
  rt.dirty = true;
  if (rt.debounce) clearTimeout(rt.debounce);
  rt.debounce = setTimeout(() => {
    rt.debounce = null;
    void enqueue(projectId, () => scanAndPush(projectId)).catch((err) => {
      console.error(`[sync] background push failed for project ${projectId}: ${err?.message || err}`);
    });
  }, PUSH_DEBOUNCE_MS);
  rt.debounce.unref?.();
}

/**
 * Pre-run barrier: make the manifest reflect the local disk right now.
 * Cancels any pending debounce and runs a final scan on the chain, so
 * in-flight background pushes finish first. Throws on failure — the caller
 * must fail the round rather than start a sandbox against a stale manifest.
 */
export async function flush(projectId: string): Promise<FlushResult> {
  if (!syncEnabled()) return { enabled: false, manifest: null };
  const rt = runtimeOf(projectId);
  if (rt.debounce) {
    clearTimeout(rt.debounce);
    rt.debounce = null;
  }
  const manifest = await enqueue(projectId, () => scanAndPush(projectId));
  return { enabled: true, manifest };
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
  if (!projectId || !isValidManifestPath(projectId)) {
    return { updated: false, version: 0, reason: 'invalid project id' };
  }
  const ifMissing = opts?.ifMissing === true;
  return enqueue(projectId, async () => {
    const target = requireTarget();
    const state = await loadState(projectId);
    state.lastAccessAt = Date.now();
    const dir = projectDirOf(projectId);

    if (ifMissing) {
      // Version-aware check: compare local state version against remote.
      // A readdir-only check is insufficient — a partial hydrate or file
      // deletion leaves the directory non-empty but incomplete.
      const remote = await getManifest(target, projectId);
      if (state.baseVersion === remote.version && state.baseVersion > 0) {
        let hasFiles = false;
        try {
          const entries = await readdir(dir);
          hasFiles = entries.length > 0;
        } catch {
          // ENOENT
        }
        if (hasFiles) {
          await persistState(projectId);
          return { updated: false, version: state.baseVersion, reason: 'already present' };
        }
      }
      // Version mismatch or empty directory — reset state for full hydration.
      if (state.baseVersion > 0 || Object.keys(state.baseFiles).length > 0) {
        state.baseVersion = 0;
        state.baseFiles = {};
        state.hashCache = {};
      }
    } else {
      // Push local changes first so the pull below cannot stomp them.
      await scanAndPush(projectId);
    }

    let remote = await getManifest(target, projectId);
    if (remote.version === state.baseVersion) {
      await persistState(projectId);
      return { updated: false, version: remote.version, reason: 'up to date' };
    }

    const localFiles = await scanLocalManifest(projectId);
    let toFetch = Object.entries(remote.files).filter(([relPath, entry]) => {
      if (!isValidManifestPath(relPath)) return false;
      return localFiles[relPath]?.sha256 !== entry.sha256;
    });

    try {
      await mapWithConcurrency(toFetch, BLOB_TRANSFER_CONCURRENCY, async ([relPath, entry]) => {
        await getBlobToFile(target, projectId, entry.sha256, path.join(dir, relPath), entry.mtime);
      });
    } catch (err) {
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
        const history = await getManifestHistory(target, projectId);
        const previous = history.find((h) => h.version < remote.version);
        if (previous && Object.keys(previous.files).length > 0) {
          const fallbackFetch = Object.entries(previous.files).filter(([relPath, entry]) => {
            if (!isValidManifestPath(relPath)) return false;
            return localFiles[relPath]?.sha256 !== entry.sha256;
          });
          await mapWithConcurrency(fallbackFetch, BLOB_TRANSFER_CONCURRENCY, async ([relPath, entry]) => {
            await getBlobToFile(target, projectId, entry.sha256, path.join(dir, relPath), entry.mtime);
          });
          remote = previous;
          toFetch = fallbackFetch;
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

    // Files the remote manifest dropped: delete locally unless the local copy
    // has unpushed edits (possible only on the ifMissing path, which skips the
    // implicit flush) — never discard local-only work.
    for (const relPath of Object.keys(localFiles)) {
      if (relPath in remote.files) continue;
      const basedOn = state.baseFiles[relPath];
      if (basedOn && localFiles[relPath]?.sha256 === basedOn.sha256) {
        await rm(path.join(dir, relPath), { force: true }).catch(() => {});
        delete state.hashCache[relPath];
      }
    }
    // Downloaded files now carry the manifest's mtime; refresh the cache from
    // disk so the next scan does not re-hash everything.
    const stats = await walkProjectFiles(dir);
    for (const [relPath, entry] of Object.entries(remote.files)) {
      const st = stats.get(relPath);
      if (st) state.hashCache[relPath] = { size: st.size, mtimeMs: st.mtimeMs, sha256: entry.sha256 };
    }
    state.baseVersion = remote.version;
    state.baseFiles = remote.files;
    await persistState(projectId);
    console.error(`[sync] hydrated project ${projectId} to v${remote.version} (${toFetch.length} blobs)`);
    return { updated: true, version: remote.version };
  });
}

/**
 * Evict cold managed projects: everything synced (not dirty), no active run,
 * untouched for ttlHours. The directory and the per-project sync state are
 * removed together — the next access rehydrates from the manifest via the
 * ifMissing hook. Only meaningful when a backend holds the source of truth.
 */
export async function evictColdProjects(ttlHours: number): Promise<string[]> {
  if (!syncEnabled() || !(ttlHours > 0)) return [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = Date.now() - ttlHours * 3_600_000;
  const evicted: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    if (!isValidManifestPath(projectId)) continue;
    // 撞上额外命名空间前缀的目录名会让 projectDirOf 路由到别的根,
    // rm 就删错树了 —— 一律不淘汰。
    if (extraSyncRoots.some((ns) => projectId.startsWith(ns.prefix))) continue;
    const rt = runtimeOf(projectId);
    if (rt.dirty || rt.debounce || hasActiveRun(projectId)) continue;
    const done = await enqueue(projectId, async () => {
      if (rt.dirty || hasActiveRun(projectId)) return false;
      const state = await loadState(projectId);
      if (state.lastAccessAt > cutoff) return false;
      // A directory that never synced (no base) is not safely rebuildable
      // from the manifest — leave it alone.
      if (state.baseVersion === 0) return false;
      await rm(projectDirOf(projectId), { recursive: true, force: true });
      await rm(stateFileOf(projectId), { force: true }).catch(() => {});
      rt.state = null;
      return true;
    }).catch(() => false);
    if (done) {
      evicted.push(projectId);
      console.error(`[sync] evicted cold project ${projectId}`);
    }
  }
  return evicted;
}
