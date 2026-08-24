// Pure primitives of the manifest + content-addressed blob sync: the walk
// must skip the same ignored trees the manifest excludes, and the diff/rebase
// pair must implement per-file merge semantics — unchanged files produce no
// op (so a mid-round user deletion sticks without any baseline machinery),
// puts win last-writer per file, deletes survive only while the remote entry
// still matches the base the delete was computed from.
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyOps,
  diffManifests,
  hashFileSha256,
  isSyncIgnoredPath,
  isValidManifestPath,
  mapWithConcurrency,
  manifestPathShapeConflict,
  normalizeManifestFiles,
  rebaseOps,
  walkProjectFiles,
  type ManifestFiles,
} from '../src/sync/core.js';

const entry = (sha256: string, size = 1) => ({ sha256, size, mtime: 1_730_000_000_000 });

describe('sync core', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(join(os.tmpdir(), 'od-sync-core-'));
    await fsp.mkdir(join(dir, 'assets'), { recursive: true });
    await fsp.mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await fsp.mkdir(join(dir, '.od', 'sync'), { recursive: true });
    await fsp.mkdir(join(dir, '.git'), { recursive: true });
    await fsp.writeFile(join(dir, 'index.html'), '<html></html>');
    await fsp.writeFile(join(dir, 'assets', 'a.txt'), 'aaa');
    await fsp.writeFile(join(dir, 'node_modules', 'x', 'pkg.js'), 'ignored');
    await fsp.writeFile(join(dir, '.od', 'sync', 'state.json'), '{}');
    await fsp.writeFile(join(dir, '.git', 'HEAD'), 'ref');
    await fsp.writeFile(join(dir, '.od-sync-download-notes'), 'legitimate');
    await fsp.mkdir(join(dir, '.od-sync-staging'), { recursive: true });
    await fsp.writeFile(join(dir, '.od-sync-staging', 'interrupted'), 'ignored');
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('walk skips reserved staging but preserves similarly named user files', async () => {
    const files = await walkProjectFiles(dir);
    expect([...files.keys()].sort()).toEqual(['.od-sync-download-notes', 'assets/a.txt', 'index.html']);
    const st = files.get('assets/a.txt')!;
    expect(st.size).toBe(3);
    expect(st.mtimeMs).toBeGreaterThan(0);
  });

  it('hashFileSha256 matches crypto over the same bytes', async () => {
    const expected = createHash('sha256').update('aaa').digest('hex');
    await expect(hashFileSha256(join(dir, 'assets', 'a.txt'))).resolves.toBe(expected);
  });

  it('diff emits put for new/changed, delete for gone, nothing for unchanged', () => {
    const base: ManifestFiles = { keep: entry('k'), change: entry('old'), gone: entry('g') };
    const local: ManifestFiles = { keep: entry('k'), change: entry('new'), added: entry('a') };
    const ops = diffManifests(base, local);
    expect(ops).toContainEqual({ op: 'put', path: 'change', sha256: 'new', size: 1, mtime: 1_730_000_000_000 });
    expect(ops).toContainEqual({ op: 'put', path: 'added', sha256: 'a', size: 1, mtime: 1_730_000_000_000 });
    expect(ops).toContainEqual({ op: 'delete', path: 'gone' });
    expect(ops).toHaveLength(3);
  });

  it('rejects file-directory shape conflicts during CAS rebase', () => {
    expect(manifestPathShapeConflict('assets/logo.png', { assets: entry('file') })).toBe('assets');
    expect(() => rebaseOps(
      [{ op: 'put', path: 'assets/logo.png', sha256: 'nested', size: 1, mtime: 1 }],
      {},
      { assets: entry('file') },
    )).toThrow(/cannot both be materialized/);
    expect(rebaseOps(
      [
        { op: 'delete', path: 'assets' },
        { op: 'put', path: 'assets/logo.png', sha256: 'nested', size: 1, mtime: 1 },
      ],
      { assets: entry('file') },
      { assets: entry('file') },
    )).toContainEqual({ op: 'put', path: 'assets/logo.png', sha256: 'nested', size: 1, mtime: 1 });
  });

  it('rebase keeps puts, drops satisfied puts, guards deletes by base hash', () => {
    const base: ManifestFiles = { del: entry('v1'), rewritten: entry('v1') };
    const ops = [
      { op: 'put', path: 'mine', sha256: 'm', size: 1, mtime: 1 } as const,
      { op: 'put', path: 'already', sha256: 's', size: 1, mtime: 1 } as const,
      { op: 'delete', path: 'del' } as const,
      { op: 'delete', path: 'rewritten' } as const,
      { op: 'delete', path: 'alreadyGone' } as const,
    ];
    const current: ManifestFiles = {
      already: entry('s'), // identical content already present
      del: entry('v1'), // untouched since base → delete survives
      rewritten: entry('v2'), // rewritten since base → delete dropped
    };
    const rebased = rebaseOps(ops, base, current);
    expect(rebased).toEqual([
      { op: 'put', path: 'mine', sha256: 'm', size: 1, mtime: 1 },
      { op: 'delete', path: 'del' },
    ]);
  });

  it('applyOps projects ops onto a files map without mutating input', () => {
    const files: ManifestFiles = { a: entry('1') };
    const next = applyOps(files, [
      { op: 'put', path: 'b', sha256: '2', size: 1, mtime: 1 },
      { op: 'delete', path: 'a' },
    ]);
    expect(Object.keys(next).sort()).toEqual(['b']);
    expect(Object.keys(files)).toEqual(['a']);
  });

  it('path validation rejects traversal and malformed segments', () => {
    expect(isValidManifestPath('a/b.txt')).toBe(true);
    expect(isValidManifestPath('/abs')).toBe(false);
    expect(isValidManifestPath('a/../b')).toBe(false);
    expect(isValidManifestPath('a//b')).toBe(false);
    expect(isValidManifestPath('a\\b')).toBe(false);
    expect(isValidManifestPath('a\0b')).toBe(false);
    expect(isValidManifestPath('')).toBe(false);
    expect(isSyncIgnoredPath('.od-sync-staging/blob')).toBe(true);
    expect(isSyncIgnoredPath('.OD-SYNC-STAGING/blob')).toBe(true);
    expect(isSyncIgnoredPath('NODE_MODULES/pkg/index.js')).toBe(true);
    expect(isSyncIgnoredPath('.od-sync-download-notes')).toBe(false);
  });

  it('normalizes manifest maps with a null prototype and preserves __proto__', () => {
    const raw = JSON.parse('{"__proto__":{"sha256":"p","size":1,"mtime":2},"ok":{"sha256":"o","size":3,"mtime":4}}');
    const files = normalizeManifestFiles(raw);
    expect(Object.getPrototypeOf(files)).toBeNull();
    expect(Object.hasOwn(files, '__proto__')).toBe(true);
    expect(files.__proto__?.sha256).toBe('p');
    const next = applyOps(files, [{ op: 'put', path: '__proto__', sha256: 'n', size: 5, mtime: 6 }]);
    expect(Object.getPrototypeOf(next)).toBeNull();
    expect(next.__proto__?.sha256).toBe('n');
  });

  it('mapWithConcurrency waits for started work before rejecting', async () => {
    let slowFinished = false;
    await expect(mapWithConcurrency(['fail', 'slow'], 2, async (value) => {
      if (value === 'fail') throw new Error('boom');
      await new Promise((resolve) => setTimeout(resolve, 15));
      slowFinished = true;
    })).rejects.toThrow('boom');
    expect(slowFinished).toBe(true);
  });

  it('mapWithConcurrency preserves order and caps in-flight work', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
