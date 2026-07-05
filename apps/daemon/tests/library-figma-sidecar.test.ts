// Daemon-side core of the clipper page → Figma export: an `html` asset can
// carry a `metadata.figmaCapture` marker (which the web "Download Figma" action
// and `od library figma` gate on), and the OD Figma capture IR round-trips
// through the content-addressed sidecar next to the owned HTML object.
//
// 本 fork 的数据层是共享 PG 测试库(openDatabase 忽略传入路径),不再有上游的
// `new Database(':memory:')` + migrateLibrary(schema 全部由 migrations/*.sql
// 走 openDatabase 里的 runPgMigrations 应用)。library_assets 有全局
// UNIQUE(content_hash),上游固定字节(相同 PNG magic / 相同 html)第二次运行
// 会被内容哈希去重、`deduped` 断言翻车——所以每个测试把 run id 揉进资产字节,
// 保证 content hash 唯一。sidecar 文件本身仍落在每测独立的 mkdtemp libraryDir。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase } from '../src/db.js';
import {
  registerLibraryAsset,
  resolveAssetElementSidecarPath,
  resolveAssetFigmaSidecarPath,
  writeElementSidecar,
  writeFigmaSidecar,
} from '../src/library.js';

let db: Awaited<ReturnType<typeof openDatabase>>;
let libraryDir: string;
let run: string;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(async () => {
  run = randomUUID().slice(0, 8);
  libraryDir = await mkdtemp(path.join(os.tmpdir(), 'od-library-figma-'));
  db = await openDatabase(libraryDir, { dataDir: libraryDir });
});

afterEach(async () => {
  await closeDatabase();
  await rm(libraryDir, { recursive: true, force: true });
});

const IR = JSON.stringify({
  version: 1,
  source: { url: 'https://example.com/', title: 'Example', viewport: { width: 1280, height: 800 } },
  fonts: [{ family: 'Inter', styles: ['Regular'] }],
  root: { type: 'FRAME', name: 'body', x: 0, y: 0, width: 1280, height: 600 },
});

describe('library figma capture sidecar', () => {
  it('persists the figmaCapture marker on an html asset and round-trips the IR sidecar', async () => {
    const figmaMeta = { version: 1, size: Buffer.byteLength(IR, 'utf8'), nodeCount: 1 };
    const { asset, deduped } = await registerLibraryAsset({
      db,
      libraryDir,
      storage: 'owned',
      kind: 'html',
      mime: 'text/html',
      text: `<!doctype html><html><body><h1>Example ${run}</h1></body></html>`,
      sourceUrl: 'https://example.com/',
      sourceTitle: 'Example',
      tags: ['page-capture'],
      metadata: { figmaCapture: figmaMeta },
      source: { sourceKind: 'clipper' },
    });

    expect(deduped).toBe(false);
    expect(asset.kind).toBe('html');
    expect(asset.metadata?.figmaCapture).toEqual(figmaMeta);

    // The IR sidecar lives next to the owned object and reads back verbatim.
    const wrote = await writeFigmaSidecar(libraryDir, asset.contentHash, IR);
    expect(wrote).toBe(true);
    const sidecar = resolveAssetFigmaSidecarPath(asset, libraryDir);
    expect(sidecar).toBeTruthy();
    expect(sidecar!.endsWith('.od-figma.json')).toBe(true);
    await expect(readFile(sidecar!, 'utf8')).resolves.toBe(IR);
  });

  it('round-trips the element-pick markup sidecar on a screenshot asset', async () => {
    const html = '<section class="hero"><h1>Title</h1></section>';
    const { asset } = await registerLibraryAsset({
      db,
      libraryDir,
      storage: 'owned',
      kind: 'image',
      mime: 'image/png',
      // Trailing tag bytes keep the content hash unique per test in the shared DB.
      bytes: Buffer.concat([PNG_MAGIC, Buffer.from(`\n<!-- element-${run} -->`)]),
      tags: ['element', 'section'],
      metadata: { element: { tag: 'section', selector: 'section.hero', width: 800, height: 400, hasHtml: true } },
      source: { sourceKind: 'clipper' },
    });

    expect((asset.metadata?.element as { selector?: string } | undefined)?.selector).toBe('section.hero');
    expect(await writeElementSidecar(libraryDir, asset.contentHash, html)).toBe(true);
    const sidecar = resolveAssetElementSidecarPath(asset, libraryDir);
    expect(sidecar).toBeTruthy();
    expect(sidecar!.endsWith('.element.html')).toBe(true);
    await expect(readFile(sidecar!, 'utf8')).resolves.toBe(html);
    // The figma + element sidecars are distinct files for the same hash.
    expect(resolveAssetFigmaSidecarPath(asset, libraryDir)).not.toBe(sidecar);
  });

  it('has no sidecar path for a referenced (non-owned) asset', async () => {
    const { asset } = await registerLibraryAsset({
      db,
      libraryDir,
      storage: 'referenced',
      kind: 'image',
      mime: 'image/png',
      absPath: path.join(libraryDir, 'nope.png'),
      // referenced assets only need bytes for hashing; supply them inline
      // (unique per test so the shared-DB content-hash dedup can't kick in).
      bytes: Buffer.concat([PNG_MAGIC, Buffer.from(`\n<!-- referenced-${run} -->`)]),
      source: { sourceKind: 'manual-upload' },
    });
    expect(resolveAssetFigmaSidecarPath(asset, libraryDir)).toBeNull();
  });
});
