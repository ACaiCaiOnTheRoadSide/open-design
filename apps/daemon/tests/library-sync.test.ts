// Daemon-side core of "see everything in the Library": reconcileLibrary mirrors
// user design systems and agent-produced project deliverables into the Library
// as *referenced* rows, classified into the Agent / Generated / Upload / Design
// system buckets the grid filters on. This pins:
//   - design systems become one `design-system` card (linking to /design-systems/:id),
//   - agent-authored pages → agent-task, generated media → generated, files the
//     user dropped in → manual-upload, and scaffolding (css/js) is excluded,
//   - the timeline buckets by the artifact's own mtime (not sync time), and
//   - the pass is idempotent (re-running indexes nothing new).
//
// 本 fork 的 openDatabase 连的是共享 PG 测试库(忽略传入路径),不是每测一个
// 临时 sqlite 文件。projects/conversations/messages/library_assets 的 id 是全局
// 主键,library_assets 还有 UNIQUE(content_hash)。上游那种固定 id('proj-1')
// 和固定字节(相同 png / html)在共享库里会跨测试、跨运行撞主键或被内容哈希
// 去重(把 result.projectAssets/designSystems 计数拉低)——所以每个测试用
// randomUUID 铸唯一 id,并把 run id 揉进文件内容让 content hash 也唯一;断言
// 一律经 projectId / designSystemId 过滤(legacy 租户是共享的,不假设库为空)。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import { listLibraryAssets } from '../src/library-store.js';
import { reconcileLibrary } from '../src/library-sync.js';

let db: Awaited<ReturnType<typeof openDatabase>>;
let dataDir: string;
let projectsDir: string;
let designSystemsDir: string;
let libraryDir: string;

// Per-test unique ids/content (see header comment): minted in beforeEach.
let run: string;
let projectId: string;
let convId: string;
let msgId: string;
let dsDir: string;
let dsId: string;

// A fixed past day so we can assert the timeline buckets by file mtime.
const ARTIFACT_DATE = '2021-04-08';
const ARTIFACT_TS = new Date(`${ARTIFACT_DATE}T12:00:00`).getTime();

beforeEach(async () => {
  run = randomUUID().slice(0, 8);
  projectId = `proj-${run}`;
  convId = `conv-${run}`;
  msgId = `msg-${run}`;
  dsDir = `acme-${run}`;
  dsId = `user:${dsDir}`;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'od-library-sync-'));
  projectsDir = path.join(dataDir, 'projects');
  designSystemsDir = path.join(dataDir, 'design-systems');
  libraryDir = path.join(dataDir, 'library');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(designSystemsDir, { recursive: true });
  db = await openDatabase(dataDir, { dataDir });
});

afterEach(async () => {
  await closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

async function seedProject(): Promise<void> {
  const now = Date.now();
  await insertProject(db, { id: projectId, name: 'Proj', createdAt: now, updatedAt: now });
  await insertConversation(db, {
    id: convId,
    projectId,
    title: 'C',
    createdAt: now,
    updatedAt: now,
  });

  const dir = path.join(projectsDir, projectId);
  await mkdir(dir, { recursive: true });
  // index.html + render.png are agent-produced; logo.png is a user drop-in;
  // styles.css is scaffolding (must be excluded). Content embeds the run id so
  // content hashes stay unique in the shared library table.
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><h1>Deck ${run}</h1>`);
  // Distinct bytes per png so content-hash dedup keeps them separate assets.
  await writeFile(path.join(dir, 'render.png'), pngBytes(`render-${run}`));
  await writeFile(path.join(dir, 'logo.png'), pngBytes(`logo-${run}`));
  await writeFile(path.join(dir, 'styles.css'), 'h1{color:red}');
  // Stamp the deliverables with a known past mtime to assert timeline bucketing.
  const stamp = new Date(ARTIFACT_TS);
  for (const f of ['index.html', 'render.png', 'logo.png']) {
    await utimes(path.join(dir, f), stamp, stamp);
  }

  await upsertMessage(db, convId, {
    id: msgId,
    role: 'assistant',
    content: 'made a deck',
    producedFiles: [
      { path: 'index.html', name: 'index.html', kind: 'html', size: 24, mtime: ARTIFACT_TS },
      { path: 'render.png', name: 'render.png', kind: 'image', size: 70, mtime: ARTIFACT_TS },
    ],
  });
}

async function seedDesignSystem(): Promise<void> {
  const root = path.join(designSystemsDir, dsDir);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'DESIGN.md'),
    '---\nname: Acme\ncategory: Brand\n---\n\n# Acme\n\nAcme brand system.\n',
  );
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 'od-design-system-project/v1',
      id: dsDir,
      name: 'Acme',
      category: 'Brand',
      files: { design: 'DESIGN.md', tokens: 'tokens.css', components: 'components.html' },
    }),
  );
  await writeFile(
    path.join(root, 'components.html'),
    `<!doctype html><button>Acme ${run}</button>`,
  );
}

// A tiny valid 1x1 PNG so dimension sniffing / mime detection have real bytes.
// `tag` trailing bytes (ignored by decoders, magic bytes intact) make otherwise
// identical pngs hash differently so they stay distinct Library assets.
function pngBytes(tag: string): Buffer {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  return Buffer.concat([base, Buffer.from(`\n<!-- ${tag} -->`)]);
}

function paths() {
  return {
    LIBRARY_DIR: libraryDir,
    PROJECTS_DIR: projectsDir,
    USER_DESIGN_SYSTEMS_DIR: designSystemsDir,
  };
}

describe('reconcileLibrary', () => {
  it('mirrors design systems + agent deliverables, classifies sources, excludes scaffolding', async () => {
    await seedProject();
    await seedDesignSystem();

    const result = await reconcileLibrary(db, paths());

    expect(result.designSystems).toBe(1);
    // index.html + render.png + logo.png; styles.css excluded.
    expect(result.projectAssets).toBe(3);
    expect(result.total).toBe(4);

    // Scope to this test's project — the shared legacy tenant may hold assets
    // from other tests/runs.
    const assets = await listLibraryAssets(db, { projectId });
    const byRel = new Map(assets.map((a) => [a.relPath, a]));

    // No scaffolding leaked in.
    expect([...byRel.keys()]).not.toContain('styles.css');

    const sourceKindFor = (rel: string) => byRel.get(rel)?.sources?.[0]?.sourceKind;
    expect(sourceKindFor('index.html')).toBe('agent-task'); // authored page
    expect(sourceKindFor('render.png')).toBe('generated'); // agent media
    expect(sourceKindFor('logo.png')).toBe('manual-upload'); // user drop-in

    // The design system is one `design-system` card linking back to itself.
    const ds = (await listLibraryAssets(db, { designSystemId: dsId })).find(
      (a) => a.kind === 'design-system',
    );
    expect(ds).toBeTruthy();
    expect(ds?.sources?.[0]?.sourceKind).toBe('design-system');
    expect(ds?.sources?.[0]?.designSystemId).toBe(dsId);

    // Project assets are referenced (bytes stay in the project) and back-link it.
    const html = byRel.get('index.html')!;
    expect(html.storage).toBe('referenced');
    expect(html.originProjectId).toBe(projectId);
    expect(html.sources?.[0]?.projectId).toBe(projectId);

    // Timeline buckets by the artifact's own mtime, not the sync time.
    expect(html.archivedDate).toBe(ARTIFACT_DATE);
  });

  it('is idempotent — a second pass indexes nothing new', async () => {
    await seedProject();
    await seedDesignSystem();

    const first = await reconcileLibrary(db, paths());
    expect(first.total).toBe(4);
    const projCountAfterFirst = (await listLibraryAssets(db, { projectId })).length;
    const dsCountAfterFirst = (await listLibraryAssets(db, { designSystemId: dsId })).length;
    expect(projCountAfterFirst).toBe(3);
    expect(dsCountAfterFirst).toBe(1);

    const second = await reconcileLibrary(db, paths());
    expect(second.total).toBe(0);
    expect(second.deduped).toBeGreaterThanOrEqual(4);
    expect((await listLibraryAssets(db, { projectId })).length).toBe(projCountAfterFirst);
    expect((await listLibraryAssets(db, { designSystemId: dsId })).length).toBe(dsCountAfterFirst);
  });

  it('skips manifest preview paths that escape the design-system root', async () => {
    const root = path.join(designSystemsDir, dsDir);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(designSystemsDir, 'outside.html'), '<!doctype html><h1>Secret</h1>');
    await writeFile(
      path.join(root, 'DESIGN.md'),
      '---\nname: Acme\ncategory: Brand\n---\n\n# Acme\n',
    );
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 'od-design-system-project/v1',
        id: dsDir,
        name: 'Acme',
        preview: { pages: [{ path: '../outside.html', role: 'overview' }] },
      }),
    );
    await writeFile(
      path.join(root, 'components.html'),
      `<!doctype html><button>Safe ${run}</button>`,
    );

    const result = await reconcileLibrary(db, paths());

    expect(result.designSystems).toBe(1);
    const ds = (await listLibraryAssets(db, { designSystemId: dsId })).find(
      (asset) => asset.kind === 'design-system',
    );
    expect(ds?.relPath).toBe('components.html');
    expect(await realpath(path.resolve(ds?.filePath ?? ''))).toBe(
      await realpath(path.join(root, 'components.html')),
    );
  });

  it('does not register a design-system preview that is a symlink', async () => {
    const root = path.join(designSystemsDir, dsDir);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(designSystemsDir, 'outside.html'), '<!doctype html><h1>Secret</h1>');
    await writeFile(
      path.join(root, 'DESIGN.md'),
      '---\nname: Acme\ncategory: Brand\n---\n\n# Acme\n',
    );
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 'od-design-system-project/v1',
        id: dsDir,
        name: 'Acme',
        preview: { pages: [{ path: 'components.html', role: 'overview' }] },
      }),
    );
    await symlink(path.join(designSystemsDir, 'outside.html'), path.join(root, 'components.html'));

    const result = await reconcileLibrary(db, paths());

    expect(result.designSystems).toBe(0);
    expect(
      (await listLibraryAssets(db, { designSystemId: dsId })).filter(
        (asset) => asset.kind === 'design-system',
      ),
    ).toEqual([]);
  });
});
