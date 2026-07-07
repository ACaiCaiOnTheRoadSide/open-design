import * as fs from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c as tarCreate, x as tarExtract } from 'tar';

/**
 * Project-file sync between the daemon disk and the OSS archive
 * (`projects/<id>/files.tar.gz`) — the ONLY daemon ⇄ sandbox file channel.
 *
 * Invariant: the daemon disk is authoritative at round start, the sandbox is
 * authoritative at round end. The pre-run push (syncProjectToOSS) makes the
 * archive mirror the daemon disk; the round-end restore-archive (server.ts)
 * makes the daemon disk mirror the sandbox's merge-save.
 *
 * Because the pre-run push OVERWRITES the archive, it must never run while
 * the archive holds a round-end save the daemon has not restored yet — that
 * would permanently discard agent output. The guard is etag bookkeeping:
 * this module persists the etag of the last archive version the daemon
 * pushed or restored, and a pre-run push that sees a different etag on OSS
 * first pulls that archive into the daemon disk (additive merge), then
 * packs and pushes. This self-heals every missed round-end restore: a
 * dispatcher restore-archive failure, a daemon restart mid-round, or an
 * execution backend that never issues the restore call.
 */

// Dependency/VCS trees excluded from the archive in BOTH directions (pack
// filter here, extraction filter in server.ts restore-archive). They are
// regenerable, can be enormous (a Vite project's node_modules), and the
// Design Files panel never shows them. Deliberately NARROWER than the
// panel's IGNORED_PROJECT_DIR_NAMES: dist/build/out may hold real design
// artifacts the next round needs, so they stay synced.
export const SYNC_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

export function isSyncIgnoredRelPath(relPath: string): boolean {
  return relPath
    .split('/')
    .some((segment) => SYNC_IGNORED_DIR_NAMES.has(segment.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Archive etag bookkeeping (persisted so daemon restarts keep the ledger).

let syncStateFile: string | null = null;
let syncStateLoaded = false;
const syncedArchiveEtags = new Map<string, string>();

/** Point the etag ledger at its backing file (under RUNTIME_DATA_DIR). */
export function initArchiveSyncState(filePath: string): void {
  syncStateFile = filePath;
  syncStateLoaded = false;
}

async function ensureSyncStateLoaded(): Promise<void> {
  if (syncStateLoaded) return;
  syncStateLoaded = true;
  if (!syncStateFile) return;
  try {
    const raw = JSON.parse(await readFile(syncStateFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') syncedArchiveEtags.set(k, v);
      }
    }
  } catch {
    // Missing/corrupt ledger — start empty; the first round per project
    // re-establishes it.
  }
}

function persistSyncState(): void {
  if (!syncStateFile) return;
  const snapshot = Object.fromEntries(syncedArchiveEtags);
  void writeFile(syncStateFile, JSON.stringify(snapshot)).catch((err) => {
    console.error(`[project-sync] persist etag ledger failed: ${err?.message || err}`);
  });
}

/** S3 ETag headers arrive quoted (`"abc"`), SDK listings unquoted. Normalize. */
function normalizeEtag(etag: string | null | undefined): string | null {
  const trimmed = typeof etag === 'string' ? etag.trim().replace(/^"|"$/g, '') : '';
  return trimmed || null;
}

/**
 * Record that the daemon disk now reflects the archive version with this
 * etag. Called after a successful pre-run push (with the PUT result's etag)
 * and after every successful restore-archive extraction (server.ts).
 */
export function recordSyncedArchiveEtag(projectId: string, etag: string | null | undefined): void {
  const normalized = normalizeEtag(etag);
  if (!normalized) return;
  void ensureSyncStateLoaded().then(() => {
    syncedArchiveEtags.set(projectId, normalized);
    persistSyncState();
  });
}

// ---------------------------------------------------------------------------
// Run-start baselines for mid-round deletion protection (see server.ts
// restore-archive). Recorded at the pre-run push, consumed by the first
// non-ifMissing restore for that project — a 1:1 pairing with the round.
// Concurrent rounds on one project can overwrite each other's baseline; the
// failure mode is a resurrected file, never data loss.

const runStartBaselines = new Map<string, Set<string>>();

export function rememberRunStartBaseline(projectId: string, paths: Set<string>): void {
  runStartBaselines.set(projectId, paths);
}

export function takeRunStartBaseline(projectId: string): Set<string> | null {
  const baseline = runStartBaselines.get(projectId);
  if (!baseline) return null;
  runStartBaselines.delete(projectId);
  return baseline;
}

/**
 * snapshotProjectFilePaths lists every synced file under projectDir as
 * forward-slash relative paths — no extension filter (deletion protection
 * must cover anything the user can delete), but pruning the same
 * SYNC_IGNORED_DIR_NAMES trees the archive pack skips, so the baseline and
 * the archive describe the same universe.
 */
export async function snapshotProjectFilePaths(projectDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    let entries: fs.Dirent[];
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
        out.add(rel);
      }
    }
  };
  await walk(projectDir, '');
  return out;
}

// ---------------------------------------------------------------------------
// Pre-run push.

interface BackendTarget {
  backendUrl: string;
  daemonToken: string;
}

function backendTarget(): BackendTarget | null {
  const backendUrl = process.env.OD_BACKEND_URL;
  const daemonToken = process.env.OD_API_TOKEN;
  if (!backendUrl || !daemonToken) return null;
  return { backendUrl: backendUrl.replace(/\/$/, ''), daemonToken };
}

function archiveKey(projectId: string): string {
  return `projects/${projectId}/files.tar.gz`;
}

/**
 * Current etag of the project archive on OSS, or null when no archive
 * exists. Throws on transport/HTTP failure — the caller must not treat
 * "could not check" as "safe to overwrite".
 */
async function fetchArchiveEtag(target: BackendTarget, projectId: string): Promise<string | null> {
  const key = archiveKey(projectId);
  const url = `${target.backendUrl}/api/internal/media/list?prefix=${encodeURIComponent(key)}`;
  const resp = await fetch(url, { headers: { authorization: `Bearer ${target.daemonToken}` } });
  if (!resp.ok) throw new Error(`archive etag lookup: HTTP ${resp.status}`);
  const body = (await resp.json()) as { objects?: Array<{ key: string; etag: string }> };
  const match = body.objects?.find((obj) => obj.key === key);
  return normalizeEtag(match?.etag);
}

/**
 * Pull the OSS archive and extract it over the project directory (additive
 * merge — mirrors the restore-archive route's semantics and prefix guard).
 * Used when the pre-run push finds an archive version the daemon has not
 * restored yet.
 */
async function pullArchiveIntoProject(
  target: BackendTarget,
  projectId: string,
  projectDir: string,
): Promise<void> {
  const fetchUrl = `${target.backendUrl}/api/internal/media/fetch?key=${encodeURIComponent(archiveKey(projectId))}`;
  const resp = await fetch(fetchUrl, {
    headers: { authorization: `Bearer ${target.daemonToken}` },
  });
  if (!resp.ok || !resp.body) throw new Error(`archive pull: HTTP ${resp.status}`);
  const prefix = `${projectId}/`;
  await pipeline(
    Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream),
    tarExtract({
      cwd: path.dirname(projectDir),
      filter: (p) => {
        const entry = p.replace(/^\.\//, '');
        if (entry !== projectId && !entry.startsWith(prefix)) return false;
        return !isSyncIgnoredRelPath(entry.slice(prefix.length));
      },
    }),
  );
}

async function packProjectArchive(projectDir: string, projectId: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = tarCreate(
    {
      gzip: true,
      cwd: projectDir,
      prefix: projectId,
      portable: true,
      // Pack paths look like './sub/file'; pruning a directory prunes its
      // whole subtree.
      filter: (p) => !isSyncIgnoredRelPath(p.replace(/^\.\//, '')),
    },
    ['.'],
  );
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function pushArchive(
  target: BackendTarget,
  projectId: string,
  body: Buffer,
): Promise<string | null> {
  const url = `${target.backendUrl}/api/internal/media/store-archive?projectId=${encodeURIComponent(projectId)}`;
  const attempt = () =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.daemonToken}`,
        'content-type': 'application/gzip',
      },
      body,
    });
  let resp = await attempt().catch(() => null);
  if (!resp || !resp.ok) {
    resp = await attempt();
  }
  if (!resp.ok) throw new Error(`store-archive: HTTP ${resp.status}`);
  const result = (await resp.json().catch(() => null)) as { etag?: string } | null;
  return normalizeEtag(result?.etag);
}

/**
 * syncProjectToOSS makes `projects/<id>/files.tar.gz` mirror the daemon's
 * project directory. Runs before every agent round; the sandbox restores
 * this exact key at round start, so the archive must already contain
 * everything on the daemon disk — including attachments uploaded seconds
 * ago.
 *
 * Ordering guard (see module docblock): when the archive on OSS is a
 * version this daemon never pushed nor restored, it is pulled and merged
 * into the project directory FIRST, so an unrestored round-end save is
 * never clobbered.
 *
 * Returns 1 when an archive was pushed, 0 when skipped (no backend
 * configured, or nothing meaningful to push). Throws on failure — the
 * caller should fail the round rather than let the sandbox restore a stale
 * archive.
 */
export async function syncProjectToOSS(
  projectDir: string,
  projectId: string,
): Promise<number> {
  const target = backendTarget();
  if (!target) return 0;
  await ensureSyncStateLoaded();

  const remoteEtag = await fetchArchiveEtag(target, projectId);
  const knownEtag = syncedArchiveEtags.get(projectId);

  const dirEntries = async () => {
    try {
      return await readdir(projectDir);
    } catch {
      return [] as string[];
    }
  };

  if (remoteEtag && remoteEtag !== knownEtag) {
    const empty = (await dirEntries()).length === 0;
    if (knownEtag !== undefined || empty) {
      // The archive moved past what this daemon has seen (a round-end save
      // whose restore never landed, or a fresh/empty daemon disk). Merge it
      // in before packing, so the push below cannot discard it.
      if (path.basename(projectDir) === projectId) {
        await pullArchiveIntoProject(target, projectId, projectDir);
        syncedArchiveEtags.set(projectId, remoteEtag);
        persistSyncState();
        console.error(
          `[project-sync] merged unrestored archive ${remoteEtag} for project ${projectId} before push`,
        );
      } else {
        // Imported (baseDir) project layout — archive root and directory
        // name disagree; refuse to guess and keep the archive untouched.
        console.error(
          `[project-sync] skip push for project ${projectId}: unrestored archive present and project dir is not archive-shaped`,
        );
        return 0;
      }
    }
    // knownEtag undefined + non-empty dir: first contact with a legacy
    // archive — the daemon disk is the user-visible truth, overwrite below.
  }

  const entries = await dirEntries();
  if (entries.length === 0) {
    // Distinguish "user cleared the project" (ledger current → push the
    // emptiness) from "nothing known about this project" (fresh dir, no
    // archive → nothing to do; unknown provenance → do not clobber).
    const inSync = remoteEtag !== null && syncedArchiveEtags.get(projectId) === remoteEtag;
    if (!inSync) return 0;
  }

  const body = await packProjectArchive(projectDir, projectId);
  const pushedEtag = await pushArchive(target, projectId, body);
  if (pushedEtag) {
    syncedArchiveEtags.set(projectId, pushedEtag);
    persistSyncState();
  }
  console.error(
    `[project-sync] pushed archive for project ${projectId} (${body.length} bytes, ${entries.length} top-level entries)`,
  );
  return 1;
}
