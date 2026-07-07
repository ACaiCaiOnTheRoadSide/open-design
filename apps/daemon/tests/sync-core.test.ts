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
  isValidManifestPath,
  mapWithConcurrency,
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
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('walk skips ignored trees including .od and reports size+mtime', async () => {
    const files = await walkProjectFiles(dir);
    expect([...files.keys()].sort()).toEqual(['assets/a.txt', 'index.html']);
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
    expect(isValidManifestPath('')).toBe(false);
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
