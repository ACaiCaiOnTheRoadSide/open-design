import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  diffManifests,
  hashFileSha256,
  isValidManifestPath,
  mapWithConcurrency,
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

/**
 * `od sync pull|push` and `od file get` — the sandbox side of the manifest +
 * blob sync. A round's bootstrap runs `sync pull` before the agent starts
 * (small files eagerly, large files skipped for on-demand `file get`) and
 * `sync push` after it exits (hash diff → upload new blobs → CAS commit).
 *
 * Everything is driven by env the dispatcher injects: OD_BACKEND_URL,
 * OD_API_TOKEN, OD_PROJECT_ID, OD_DATA_DIR. The pull base (manifest version
 * plus files) is recorded under $OD_DATA_DIR/.od/sync/<projectId>.json so the
 * round-end push can diff against exactly what it restored. When that record
 * is missing the push falls back to a conservative merge — puts only, no
 * deletes — because without a base, an absent file is indistinguishable from
 * a file that never restored, and deleting on a guess destroys remote work.
 */

const DEFAULT_PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
const PULL_CONCURRENCY = 8;

interface PullState {
  baseVersion: number;
  baseFiles: ManifestFiles;
  skippedLarge: Array<{ path: string; size: number }>;
}

interface CliContext {
  target: SyncTarget;
  projectId: string;
  projectDir: string;
  dataDir: string;
  json: boolean;
}

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
  if (!target) fail('OD_BACKEND_URL and OD_API_TOKEN must be set');
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
    dataDir: dataDir || path.dirname(path.dirname(projectDir)),
    json: flags.get('json') === true,
  };
}

/**
 * Pull-state location. `OD_SYNC_STATE_DIR` moves it off the default
 * `$OD_DATA_DIR/.od/sync` — sandboxed runs set it to a path outside the
 * agent-visible workspace, because the state is a single-line JSON of the
 * whole project manifest and an agent that wanders into it and reads it
 * floods its own model context. Losing the state is always safe: push
 * degrades to the conservative no-deletes merge (see module docblock).
 */
function stateFileOf(ctx: CliContext): string {
  const override = process.env.OD_SYNC_STATE_DIR?.trim();
  const dir = override || path.join(ctx.dataDir, '.od', 'sync');
  return path.join(dir, `${ctx.projectId}.json`);
}

async function writeState(ctx: CliContext, state: PullState): Promise<void> {
  const file = stateFileOf(ctx);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

async function readState(ctx: CliContext): Promise<PullState | null> {
  try {
    const raw = JSON.parse(await readFile(stateFileOf(ctx), 'utf8')) as PullState;
    if (typeof raw?.baseVersion !== 'number' || typeof raw?.baseFiles !== 'object') return null;
    return {
      baseVersion: raw.baseVersion,
      baseFiles: raw.baseFiles ?? {},
      skippedLarge: Array.isArray(raw.skippedLarge) ? raw.skippedLarge : [],
    };
  } catch {
    return null;
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

async function runPull(ctx: CliContext): Promise<void> {
  const manifest = await getManifest(ctx.target, ctx.projectId);
  const maxBytes = prefetchMaxBytes();
  const entries = Object.entries(manifest.files).filter(([relPath]) => isValidManifestPath(relPath));
  const eager = entries.filter(([, entry]) => entry.size < maxBytes);
  const skippedLarge = entries
    .filter(([, entry]) => entry.size >= maxBytes)
    .map(([relPath, entry]) => ({ path: relPath, size: entry.size }));

  await mapWithConcurrency(eager, PULL_CONCURRENCY, async ([relPath, entry]) => {
    await getBlobToFile(ctx.target, ctx.projectId, entry.sha256, path.join(ctx.projectDir, relPath), entry.mtime);
  });
  await mkdir(ctx.projectDir, { recursive: true });
  await writeState(ctx, { baseVersion: manifest.version, baseFiles: manifest.files, skippedLarge });

  emit(
    ctx,
    { version: manifest.version, downloaded: eager.length, skippedLarge },
    `pulled v${manifest.version}: ${eager.length} files, ${skippedLarge.length} large skipped`,
  );
}

/**
 * Hash the working tree, reusing the pull base for files whose size+mtime
 * still match what the restore wrote (getBlobToFile stamps the manifest
 * mtime, so untouched files skip re-hashing).
 */
async function scanWorkingTree(ctx: CliContext, base: ManifestFiles): Promise<ManifestFiles> {
  const stats = await walkProjectFiles(ctx.projectDir);
  const files: ManifestFiles = {};
  for (const [relPath, st] of stats) {
    if (!isValidManifestPath(relPath)) continue;
    const known = base[relPath];
    const sha256 =
      known && known.size === st.size && Math.abs(known.mtime - st.mtimeMs) < 1
        ? known.sha256
        : await hashFileSha256(path.join(ctx.projectDir, relPath));
    files[relPath] = { sha256, size: st.size, mtime: Math.round(st.mtimeMs) };
  }
  return files;
}

async function runPush(ctx: CliContext): Promise<void> {
  const state = await readState(ctx);
  let base: Manifest;
  let allowDeletes = true;
  if (state) {
    base = { version: state.baseVersion, files: state.baseFiles };
  } else {
    base = await getManifest(ctx.target, ctx.projectId);
    allowDeletes = false;
  }

  const local = await scanWorkingTree(ctx, base.files);
  let ops = diffManifests(base.files, local);
  if (!allowDeletes) ops = ops.filter((op) => op.op !== 'delete');
  // Large files the pull skipped were never materialized locally — their
  // absence is not a deletion. (A file the agent explicitly `od file get`-ed
  // and then removed also survives remotely; conservative by design.)
  const neverMaterialized = new Set((state?.skippedLarge ?? []).map((f) => f.path));
  ops = ops.filter((op) => !(op.op === 'delete' && neverMaterialized.has(op.path)));
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
  await writeState(ctx, { baseVersion: result.version, baseFiles: result.files, skippedLarge: [] });
  const deleted = result.committedOps.filter((op) => op.op === 'delete').length;
  emit(
    ctx,
    { version: result.version, pushed: result.committedOps.length - deleted, deleted },
    `pushed v${result.version}: ${result.committedOps.length - deleted} files, ${deleted} deleted`,
  );
}

export async function runSync(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od sync pull [--project <id>] [--dir <projectDir>] [--json]
      Restore the project from the manifest: small files eagerly, large files
      recorded for on-demand \`od file get\`.
  od sync push [--project <id>] [--dir <projectDir>] [--json]
      Diff the working tree against the pull base, upload new blobs and
      commit the manifest diff.

Environment: OD_BACKEND_URL, OD_API_TOKEN, OD_PROJECT_ID, OD_DATA_DIR,
OD_SYNC_PREFETCH_MAX_BYTES (default ${DEFAULT_PREFETCH_MAX_BYTES}).`);
    process.exit(sub ? 0 : 2);
  }
  const { flags } = parseArgs(args.slice(1));
  const ctx = resolveContext(flags);
  if (sub === 'pull') return runPull(ctx);
  if (sub === 'push') return runPush(ctx);
  fail(`unknown subcommand '${sub}' (expected pull or push)`);
}

export async function runFile(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od file get <relPath> [--project <id>] [--dir <projectDir>] [--json]
      Download one tracked project file from the blob store (used for large
      files that \`od sync pull\` skipped).`);
    process.exit(sub ? 0 : 2);
  }
  if (sub !== 'get') fail(`unknown subcommand '${sub}' (expected get)`);
  const { positional, flags } = parseArgs(args.slice(1));
  const relPath = positional[0];
  if (!relPath || !isValidManifestPath(relPath)) fail('a valid project-relative path is required');
  const ctx = resolveContext(flags);

  const state = await readState(ctx);
  const files = state?.baseFiles ?? (await getManifest(ctx.target, ctx.projectId)).files;
  const entry = files[relPath];
  if (!entry) fail(`'${relPath}' is not in the project manifest`);
  const dest = path.join(ctx.projectDir, relPath);
  await getBlobToFile(ctx.target, ctx.projectId, entry.sha256, dest, entry.mtime);
  const st = await stat(dest);
  emit(ctx, { path: relPath, size: st.size }, `fetched ${relPath} (${st.size} bytes)`);
}
