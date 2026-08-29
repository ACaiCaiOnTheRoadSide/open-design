import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
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
} from './core.js';
import {
  checkBlobs,
  getBlobToFile,
  getManifest,
  putBlobFromFile,
  submitDiff,
  syncTargetFromEnv,
  type SyncTarget,
} from './client.js';

/** Sandbox-only `od sync pull|push` and `od file get`. */
const DEFAULT_PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
const PULL_CONCURRENCY = 8;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 10 * 60_000;

interface ValidPullState {
  status: 'valid';
  baseVersion: number;
  baseFiles: ManifestFiles;
  skippedLarge: Array<{ path: string; size: number }>;
}
interface InProgressPullState {
  status: 'in-progress';
  previousValid: ValidPullState | null;
  /** Every manifest a failed pull may have partially materialized. */
  attemptedFiles: ManifestFiles;
}
type LoadedState =
  | { kind: 'missing' }
  | { kind: 'invalid'; previousValid: ValidPullState | null; attemptedFiles: ManifestFiles }
  | { kind: 'valid'; value: ValidPullState };

interface CliContext {
  target: SyncTarget;
  projectId: string;
  projectDir: string;
  dataDir: string;
  json: boolean;
}

interface LockOwner {
  pid: number;
  token: string;
  at: number;
  processStart: string | null;
}

const execFileAsync = promisify(execFile);

function fail(message: string): never {
  console.error(`od sync: ${message}`);
  process.exit(2);
}

function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'project' || name === 'dir') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) fail(`--${name} requires a value`);
      flags.set(name, value);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function resolveContext(flags: Map<string, string | boolean>): CliContext {
  const target = syncTargetFromEnv();
  if (!target) fail('OD_BACKEND_URL and OD_SYNC_TOKEN (or daemon-side OD_API_TOKEN) must be set');
  const projectId =
    (typeof flags.get('project') === 'string' ? (flags.get('project') as string) : '') ||
    process.env.OD_PROJECT_ID ||
    '';
  if (!projectId || !isValidManifestPath(projectId) || projectId.includes('/')) {
    fail('a project id is required (--project or OD_PROJECT_ID)');
  }
  const dataDir = process.env.OD_DATA_DIR || '';
  const dirFlag = typeof flags.get('dir') === 'string' ? (flags.get('dir') as string) : '';
  const projectDir = dirFlag || (dataDir ? path.join(dataDir, 'projects', projectId) : '');
  if (!projectDir) fail('a project directory is required (--dir or OD_DATA_DIR)');
  return {
    target,
    projectId,
    projectDir,
    dataDir,
    json: flags.get('json') === true,
  };
}

function stateFileOf(ctx: CliContext): string {
  const override = process.env.OD_SYNC_STATE_DIR?.trim();
  const dir = override || (ctx.dataDir
    ? path.join(ctx.dataDir, '.od', 'sync')
    : path.join(process.env.HOME || homedir(), '.od', 'sync'));
  return path.join(dir, `${ctx.projectId}.json`);
}

function validStateFrom(raw: unknown): ValidPullState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.status !== undefined && value.status !== 'valid') return null;
  if (typeof value.baseVersion !== 'number' || !value.baseFiles || typeof value.baseFiles !== 'object') return null;
  const skipped = Array.isArray(value.skippedLarge)
    ? value.skippedLarge.filter((item): item is { path: string; size: number } =>
      Boolean(item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string' && typeof (item as { size?: unknown }).size === 'number'))
    : [];
  return {
    status: 'valid',
    baseVersion: value.baseVersion,
    baseFiles: normalizeManifestFiles(value.baseFiles),
    skippedLarge: skipped,
  };
}

async function readState(ctx: CliContext): Promise<LoadedState> {
  try {
    const raw = JSON.parse(await readFile(stateFileOf(ctx), 'utf8')) as unknown;
    const valid = validStateFrom(raw);
    if (valid) return { kind: 'valid', value: valid };
    if (raw && typeof raw === 'object' && (raw as { status?: unknown }).status === 'in-progress') {
      return {
        kind: 'invalid',
        previousValid: validStateFrom((raw as { previousValid?: unknown }).previousValid),
        attemptedFiles: normalizeManifestFiles((raw as { attemptedFiles?: unknown }).attemptedFiles),
      };
    }
    return { kind: 'invalid', previousValid: null, attemptedFiles: normalizeManifestFiles(null) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', previousValid: null, attemptedFiles: normalizeManifestFiles(null) };
  }
}

async function writeState(ctx: CliContext, state: ValidPullState | InProgressPullState): Promise<void> {
  const file = stateFileOf(ctx);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state), { flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function readLockOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as Partial<LockOwner>;
    return typeof value.pid === 'number' && typeof value.token === 'string' && typeof value.at === 'number'
      ? {
        pid: value.pid,
        token: value.token,
        at: value.at,
        processStart: typeof value.processStart === 'string' ? value.processStart : null,
      }
      : null;
  } catch {
    return null;
  }
}

async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    const identity = stdout.trim();
    return identity || null;
  } catch {
    return null;
  }
}

async function lockOwnerIsAlive(owner: LockOwner, lockAge: number): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (!owner.processStart) return lockAge <= LOCK_STALE_MS;
  return (await processStartIdentity(owner.pid)) === owner.processStart;
}

async function lockIsOwnedBy(lockDir: string, token: string): Promise<boolean> {
  return (await readLockOwner(lockDir))?.token === token;
}

async function reapAbandonedLock(lockDir: string): Promise<boolean> {
  const reapDir = `${lockDir}.reap`;
  try {
    await mkdir(reapDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = await stat(reapDir).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
    if (age > LOCK_STALE_MS) await rm(reapDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
  try {
    const owner = await readLockOwner(lockDir);
    const age = await stat(lockDir).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
    if (owner ? await lockOwnerIsAlive(owner, age) : age <= LOCK_STALE_MS) return false;
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(reapDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function withProjectLock<T>(ctx: CliContext, fn: () => Promise<T>): Promise<T> {
  ctx.projectDir = await safeRoot(ctx);
  const lockDir = `${stateFileOf(ctx)}.lock`;
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    at: Date.now(),
    processStart: await processStartIdentity(process.pid),
  };
  await mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reapAbandonedLock(lockDir)) continue;
      if (Date.now() >= deadline) throw new Error(`sync state lock timed out for project ${ctx.projectId}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const heartbeat = setInterval(() => {
    void lockIsOwnedBy(lockDir, owner.token).then((owned) => {
      if (!owned) return;
      const now = new Date();
      return utimes(lockDir, now, now);
    }).catch(() => {});
  }, Math.max(1_000, Math.floor(LOCK_STALE_MS / 4)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    if (await lockIsOwnedBy(lockDir, owner.token)) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function isBeneath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function safeRoot(ctx: CliContext): Promise<string> {
  await mkdir(ctx.projectDir, { recursive: true });
  const configuredStat = await lstat(ctx.projectDir);
  if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink()) {
    throw new Error('sync project root is not a safe directory');
  }
  const root = await realpath(ctx.projectDir);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('sync project root is not a safe directory');
  return root;
}

async function safeParent(root: string, relPath: string, create: boolean): Promise<string> {
  if (!isValidManifestPath(relPath)) throw new Error(`unsafe manifest path: ${JSON.stringify(relPath)}`);
  const segments = relPath.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(current).catch((mkdirError) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe symlink/non-directory ancestor for ${relPath}`);
    const actual = await realpath(current);
    if (!isBeneath(root, actual)) throw new Error(`path escapes project root: ${relPath}`);
  }
  return current;
}

async function rejectFinalSymlink(absPath: string, relPath: string): Promise<void> {
  try {
    const info = await lstat(absPath);
    if (info.isSymbolicLink()) throw new Error(`unsafe final symlink for ${relPath}`);
    if (info.isDirectory()) throw new Error(`destination is a directory: ${relPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function cleanupSyncStaging(root: string): Promise<void> {
  const staging = path.join(root, '.od-sync-staging');
  try {
    const info = await lstat(staging);
    if (info.isSymbolicLink()) {
      await unlink(staging);
      return;
    }
    if (!info.isDirectory()) throw new Error('sync staging path is not a directory');
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function downloadSafely(
  ctx: CliContext,
  root: string,
  stageDir: string,
  relPath: string,
  entry: { sha256: string; mtime: number },
): Promise<void> {
  const checkedStageDir = await safeParent(root, '.od-sync-staging/blob', false);
  if (checkedStageDir !== stageDir) throw new Error('sync staging directory changed during pull');
  const stage = path.join(stageDir, `${process.pid}-${randomUUID()}`);
  try {
    await getBlobToFile(ctx.target, ctx.projectId, entry.sha256, stage, entry.mtime);
    const parent = await safeParent(root, relPath, true);
    const dest = path.join(parent, path.basename(relPath));
    await rejectFinalSymlink(dest, relPath);
    const actualParent = await realpath(parent);
    if (!isBeneath(root, actualParent)) throw new Error(`path escapes project root: ${relPath}`);
    await rename(stage, dest);
  } finally {
    await rm(stage, { force: true }).catch(() => {});
  }
}

async function deleteSafely(root: string, relPath: string): Promise<void> {
  const parent = await safeParent(root, relPath, false).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!parent) return;
  const target = path.join(parent, path.basename(relPath));
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`unsafe final symlink for ${relPath}`);
    if (!info.isFile()) throw new Error(`tracked path is not a file: ${relPath}`);
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let dir = parent;
  while (dir !== root && isBeneath(root, dir)) {
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe directory while cleaning ${relPath}`);
      await rmdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EEXIST') break;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    dir = path.dirname(dir);
  }
}

function prefetchMaxBytes(): number {
  const parsed = Number(process.env.OD_SYNC_PREFETCH_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PREFETCH_MAX_BYTES;
}

function emit(ctx: CliContext, payload: Record<string, unknown>, text: string): void {
  if (ctx.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else console.log(text);
}

async function runPullUnlocked(ctx: CliContext): Promise<void> {
  const loaded = await readState(ctx);
  const previousValid = loaded.kind === 'valid' ? loaded.value : loaded.kind === 'invalid' ? loaded.previousValid : null;
  const attemptedFiles = loaded.kind === 'invalid'
    ? normalizeManifestFiles(loaded.attemptedFiles)
    : normalizeManifestFiles(null);
  await writeState(ctx, { status: 'in-progress', previousValid, attemptedFiles });

  const manifest = await getManifest(ctx.target, ctx.projectId);
  const entries = Object.entries(manifest.files);
  const unsafe = entries.find(([relPath]) => !isValidManifestPath(relPath) || isSyncIgnoredPath(relPath));
  if (unsafe) throw new Error(`sync manifest contains an unsafe path: ${JSON.stringify(unsafe[0])}`);
  for (const [relPath, entry] of entries) attemptedFiles[relPath] = entry;
  // Persist the possible materialization set before the first project write.
  await writeState(ctx, { status: 'in-progress', previousValid, attemptedFiles });
  const root = await safeRoot(ctx);
  await cleanupSyncStaging(root);
  const stageDir = await safeParent(root, '.od-sync-staging/blob', true);
  const maxBytes = prefetchMaxBytes();
  const eager = entries.filter(([, entry]) => entry.size < maxBytes);
  const skippedLarge = entries
    .filter(([, entry]) => entry.size >= maxBytes)
    .map(([relPath, entry]) => ({ path: relPath, size: entry.size }));

  const previouslyTracked = normalizeManifestFiles(attemptedFiles);
  if (previousValid) {
    for (const [relPath, entry] of Object.entries(previousValid.baseFiles)) previouslyTracked[relPath] = entry;
  }
  // Remove tracked paths absent from the new manifest before downloads so
  // file↔directory shape changes can materialize safely.
  for (const relPath of Object.keys(previouslyTracked)) {
    const next = Object.hasOwn(manifest.files, relPath) ? manifest.files[relPath] : undefined;
    if (!next || (next.size >= maxBytes && next.sha256 !== previouslyTracked[relPath]?.sha256)) {
      await deleteSafely(root, relPath);
    }
  }

  try {
    await mapWithConcurrency(eager, PULL_CONCURRENCY, async ([relPath, entry]) => {
      await downloadSafely(ctx, root, stageDir, relPath, entry);
    });
  } finally {
    // Individual workers must not remove the shared staging directory: another
    // download may have validated it but not opened its temporary file yet.
    await cleanupSyncStaging(root);
  }

  await writeState(ctx, {
    status: 'valid',
    baseVersion: manifest.version,
    baseFiles: manifest.files,
    skippedLarge,
  });
  emit(ctx, { version: manifest.version, downloaded: eager.length, skippedLarge },
    `pulled v${manifest.version}: ${eager.length} files, ${skippedLarge.length} large skipped`);
}

/** Push hashes every file; size/mtime are never trusted as a content cache. */
async function scanWorkingTree(ctx: CliContext): Promise<ManifestFiles> {
  const stats = await walkProjectFiles(ctx.projectDir);
  const files = Object.create(null) as ManifestFiles;
  for (const [relPath, fileStat] of stats) {
    if (!isValidManifestPath(relPath) || isSyncIgnoredPath(relPath)) continue;
    const sha256 = await hashFileSha256(path.join(ctx.projectDir, relPath));
    files[relPath] = { sha256, size: fileStat.size, mtime: Math.round(fileStat.mtimeMs) };
  }
  return files;
}

async function runPushUnlocked(ctx: CliContext): Promise<void> {
  const state = await readState(ctx);
  if (state.kind === 'invalid') throw new Error('sync pull is incomplete; run `od sync pull` before pushing');
  const base: Manifest = state.kind === 'valid'
    ? { version: state.value.baseVersion, files: state.value.baseFiles }
    : await getManifest(ctx.target, ctx.projectId);

  const local = await scanWorkingTree(ctx);
  const ops = diffManifests(base.files, local).filter((op) => op.op !== 'delete');
  if (ops.length === 0) {
    emit(ctx, { version: base.version, pushed: 0, deleted: 0 }, `nothing to push (v${base.version})`);
    return;
  }

  const puts = ops.filter((op): op is Extract<typeof ops[number], { op: 'put' }> => op.op === 'put');
  const byHash = new Map(puts.map((op) => [op.sha256, op.path]));
  const missing = await checkBlobs(ctx.target, ctx.projectId, [...byHash.keys()]);
  await mapWithConcurrency([...missing], PULL_CONCURRENCY, async (sha256) => {
    await putBlobFromFile(ctx.target, ctx.projectId, sha256, path.join(ctx.projectDir, byHash.get(sha256)!));
  });

  const result = await submitDiff(ctx.target, ctx.projectId, base, ops);
  await writeState(ctx, {
    status: 'valid',
    baseVersion: result.version,
    baseFiles: result.files,
    skippedLarge: [],
  });
  emit(ctx, { version: result.version, pushed: result.committedOps.length, deleted: 0 },
    `pushed v${result.version}: ${result.committedOps.length} files, 0 deleted`);
}

export async function runSync(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od sync pull [--project <id>] [--dir <projectDir>] [--json]
      Restore small project files eagerly and record large files for on-demand get.
  od sync push [--project <id>] [--dir <projectDir>] [--json]
      Re-hash the working tree, upload new blobs and commit an append-only diff.

Environment: OD_BACKEND_URL, OD_SYNC_TOKEN (sandbox) or OD_API_TOKEN (daemon), OD_PROJECT_ID, OD_DATA_DIR,
OD_SYNC_STATE_DIR (default $OD_DATA_DIR/.od/sync, or $HOME/.od/sync with --dir),
OD_SYNC_PREFETCH_MAX_BYTES (default ${DEFAULT_PREFETCH_MAX_BYTES}).`);
    process.exit(sub ? 0 : 2);
  }
  const { flags } = parseArgs(args.slice(1));
  const ctx = resolveContext(flags);
  if (sub === 'pull') return withProjectLock(ctx, () => runPullUnlocked(ctx));
  if (sub === 'push') return withProjectLock(ctx, () => runPushUnlocked(ctx));
  fail(`unknown subcommand '${sub}' (expected pull or push)`);
}

export async function runFile(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od file get <relPath> [--project <id>] [--dir <projectDir>] [--json]
      Download one tracked project file from the blob store.`);
    process.exit(sub ? 0 : 2);
  }
  if (sub !== 'get') fail(`unknown subcommand '${sub}' (expected get)`);
  const { positional, flags } = parseArgs(args.slice(1));
  const relPath = positional[0];
  if (!relPath || !isValidManifestPath(relPath) || isSyncIgnoredPath(relPath)) fail('a valid project-relative path is required');
  const ctx = resolveContext(flags);

  await withProjectLock(ctx, async () => {
    const state = await readState(ctx);
    if (state.kind === 'invalid') throw new Error('sync pull is incomplete; retry pull before getting files');
    const files = state.kind === 'valid' ? state.value.baseFiles : (await getManifest(ctx.target, ctx.projectId)).files;
    if (!Object.hasOwn(files, relPath)) throw new Error(`'${relPath}' is not in the project manifest`);
    const entry = files[relPath]!;
    const root = await safeRoot(ctx);
    await cleanupSyncStaging(root);
    const stageDir = await safeParent(root, '.od-sync-staging/blob', true);
    try {
      await downloadSafely(ctx, root, stageDir, relPath, entry);
    } finally {
      await cleanupSyncStaging(root);
    }
    const fileStat = await stat(path.join(root, ...relPath.split('/')));
    emit(ctx, { path: relPath, size: fileStat.size }, `fetched ${relPath} (${fileStat.size} bytes)`);
  });
}
