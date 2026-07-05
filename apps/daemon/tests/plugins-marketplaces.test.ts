// Plan §3.B4 — marketplaces add / list / refresh / remove / trust unit tests.
//
// Locks the storage half of the federated catalog story. The Phase 3
// follow-up will layer on `od plugin install <name>` resolution +
// trust UI, but the storage layout here is the contract that lookup
// will read against.
//
// 本 fork 的 openDatabase 连的是共享 PG 测试库(忽略传入路径),不是每测一个
// 临时 sqlite 文件;plugin_marketplaces 行跨测试、跨运行残留。因此:
//  - 行 id / 插件名每个测试用 randomUUID 前缀铸唯一;列表/解析断言只看本测试
//    铸的行,不假设表为空;
//  - 内置源(official/community)测试保留固定 id —— ensureMarketplaceManifest
//    是 upsert 语义,断言以返回值为准、容忍行已存在;
//  - schema 由 migrations/0001_init.sql 建好,不再走 sqlite 时代的 migratePlugins。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import {
  addMarketplace,
  ensureMarketplaceManifest,
  getMarketplace,
  listMarketplaces,
  marketplaceManifestUrlForRegistry,
  refreshMarketplace,
  removeMarketplace,
  resolvePluginInMarketplaces,
  resolveMarketplaceFetchUrl,
  setMarketplaceTrust,
} from '../src/plugins/marketplaces.js';

let db: Awaited<ReturnType<typeof openDatabase>>;
let tmpDir: string;
let run: string;
let samplePlugin: string;
let validManifest: string;

function fixtureFetcher(text: string, ok = true) {
  return async () => ({
    ok,
    status: ok ? 200 : 502,
    text: async () => text,
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-mp-'));
  db = await openDatabase(tmpDir, { dataDir: path.join(tmpDir, '.od') });
  run = randomUUID().slice(0, 8);
  samplePlugin = `sample-plugin-${run}`;
  validManifest = JSON.stringify({
    specVersion: '1.0.0',
    name: 'test-marketplace',
    version: '1.0.0',
    metadata: { description: 'fixture', version: '1.0.0' },
    plugins: [
      { name: samplePlugin, source: 'github:open-design/sample-plugin', version: '0.1.0' },
    ],
  });
});

afterEach(async () => {
  await closeDatabase();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('marketplaces', () => {
  it('addMarketplace fetches, validates, stores, and returns the row', async () => {
    const result = await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    if (!result.ok) {
      throw new Error(`expected ok: ${JSON.stringify(result)}`);
    }
    expect(result.row.url).toBe('https://example.com/marketplace.json');
    expect(result.row.specVersion).toBe('1.0.0');
    expect(result.row.version).toBe('1.0.0');
    expect(result.row.trust).toBe('restricted');
    expect(result.row.manifest.plugins).toHaveLength(1);
    // 共享库不为空:只断言本测试铸的行落了库。
    const stored = (await listMarketplaces(db)).filter((row) => row.id === result.row.id);
    expect(stored).toHaveLength(1);
  });

  it('resolves marketplace names with exact versions, dist-tags, ranges, and yanks', async () => {
    const ranged = `vendor/ranged-${run}`;
    const manifest = JSON.stringify({
      specVersion: '1.0.0',
      name: 'versions',
      version: '1.0.0',
      plugins: [
        {
          name: ranged,
          source: 'github:vendor/ranged@v1.2.0/plugin',
          version: '1.2.0',
          distTags: { latest: '1.2.0', beta: '2.0.0' },
          versions: [
            { version: '1.0.0', source: 'github:vendor/ranged@v1.0.0/plugin', integrity: 'sha256:one' },
            { version: '1.1.0', source: 'github:vendor/ranged@v1.1.0/plugin', integrity: 'sha256:two' },
            { version: '1.2.0', source: 'github:vendor/ranged@v1.2.0/plugin', integrity: 'sha256:three' },
            { version: '2.0.0', source: 'github:vendor/ranged@v2.0.0/plugin', yanked: true },
          ],
        },
      ],
    });
    const seeded = await ensureMarketplaceManifest(db, {
      id: `versions-${run}`,
      url: 'https://example.com/versions.json',
      trust: 'trusted',
      manifestText: manifest,
    });
    if (!seeded.ok) throw new Error('seed failed');

    expect((await resolvePluginInMarketplaces(db, ranged))?.pluginVersion).toBe('1.2.0');
    expect(await resolvePluginInMarketplaces(db, `${ranged}@1.0.0`)).toMatchObject({
      pluginVersion: '1.0.0',
      source: 'github:vendor/ranged@v1.0.0/plugin',
      archiveIntegrity: 'sha256:one',
    });
    expect((await resolvePluginInMarketplaces(db, `${ranged}@^1.0.0`))?.pluginVersion).toBe('1.2.0');
    expect(await resolvePluginInMarketplaces(db, `${ranged}@beta`)).toBeNull();
  });

  it('addMarketplace rejects non-https urls', async () => {
    const result = await addMarketplace(db, {
      url: 'http://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toMatch(/https/);
    }
  });

  it('addMarketplace surfaces parse failures', async () => {
    const result = await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher('{}'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  it('normalizes public marketplace urls to the canonical raw registry', async () => {
    const seenUrls: string[] = [];
    const result = await addMarketplace(db, {
      url: 'https://open-design.ai/marketplace/community/open-design-marketplace.json',
      fetcher: async (url) => {
        seenUrls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => validManifest,
        };
      },
    });

    if (!result.ok) throw new Error('add failed');
    const expectedUrl = marketplaceManifestUrlForRegistry('community');
    expect(seenUrls).toEqual([expectedUrl]);
    expect(result.row.url).toBe(expectedUrl);
  });

  it('normalizes legacy branch raw urls to the canonical raw registry', () => {
    expect(resolveMarketplaceFetchUrl(
      'https://raw.githubusercontent.com/nexu-io/open-design/garnet-hemisphere/plugins/registry/community/open-design-marketplace.json',
    )).toBe(marketplaceManifestUrlForRegistry('community'));
  });

  it('requires a raw open-design-marketplace.json document, not a GitHub tree page', async () => {
    const result = await addMarketplace(db, {
      url: 'https://github.com/nexu-io/open-design/tree/garnet-hemisphere/plugins/registry/community',
      fetcher: fixtureFetcher('<!doctype html><html><body>GitHub tree page</body></html>'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.message).toMatch(/validation/i);
    }
  });

  it('refresh re-fetches and updates refreshed_at', async () => {
    const added = await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    if (!added.ok) throw new Error('add failed');
    const updatedManifest = JSON.parse(validManifest);
    updatedManifest.plugins.push({
      name: `new-plugin-${run}`,
      source: 'github:open-design/new-plugin',
      version: '0.2.0',
    });
    updatedManifest.version = '1.0.1';
    const refreshed = await refreshMarketplace(
      db,
      added.row.id,
      fixtureFetcher(JSON.stringify(updatedManifest)),
    );
    if (!refreshed.ok) throw new Error('refresh failed');
    expect(refreshed.row.version).toBe('1.0.1');
    expect(refreshed.row.manifest.plugins).toHaveLength(2);
    expect(refreshed.row.refreshedAt).toBeGreaterThanOrEqual(added.row.refreshedAt);
  });

  it('refresh normalizes legacy public urls before fetching', async () => {
    // 归一化由 url 驱动、与行 id 无关;用唯一 id 免得动到共享库里真正的
    // 'community' 内置行。
    const id = `community-${run}`;
    const seeded = await ensureMarketplaceManifest(db, {
      id,
      url: 'https://open-design.ai/marketplace/community/open-design-marketplace.json',
      trust: 'restricted',
      manifestText: validManifest,
    });
    if (!seeded.ok) throw new Error('seed failed');
    const updatedManifest = JSON.parse(validManifest);
    updatedManifest.version = '1.0.1';
    const seenUrls: string[] = [];

    const refreshed = await refreshMarketplace(
      db,
      id,
      async (url) => {
        seenUrls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(updatedManifest),
        };
      },
    );

    if (!refreshed.ok) throw new Error('refresh failed');
    const expectedUrl = marketplaceManifestUrlForRegistry('community');
    expect(seenUrls).toEqual([expectedUrl]);
    expect(refreshed.row.url).toBe(expectedUrl);
    expect((await getMarketplace(db, id))?.url).toBe(expectedUrl);
  });

  it('setMarketplaceTrust updates the trust tier and remove deletes the row', async () => {
    const added = await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    if (!added.ok) throw new Error('add failed');
    const trusted = await setMarketplaceTrust(db, added.row.id, 'trusted');
    expect(trusted?.trust).toBe('trusted');
    expect(await removeMarketplace(db, added.row.id)).toBe(true);
    expect(await getMarketplace(db, added.row.id)).toBeNull();
  });

  it('upserts a fixed built-in marketplace manifest', async () => {
    // upsert 语义与 id 字面量无关;共享库里真 'official' 行的 added_at 由
    // 首次写入者决定、不可控,固定 now:123/456 断言只有在唯一 id 上才成立。
    const id = `official-${run}`;
    const result = await ensureMarketplaceManifest(db, {
      id,
      url: 'https://open-design.ai/marketplace/open-design-marketplace.json',
      trust: 'official',
      manifestText: validManifest,
      now: 123,
    });
    if (!result.ok) throw new Error('seed failed');
    expect(result.row.id).toBe(id);
    expect(result.row.trust).toBe('official');

    const updatedManifest = JSON.stringify({
      specVersion: '1.0.0',
      name: 'test-marketplace',
      version: '1.0.1',
      plugins: [],
    });
    const updated = await ensureMarketplaceManifest(db, {
      id,
      url: 'https://open-design.ai/marketplace/open-design-marketplace.json',
      trust: 'official',
      manifestText: updatedManifest,
      now: 456,
    });
    if (!updated.ok) throw new Error('update failed');
    // upsert 而非再插一行:共享库里该 id 仍只有一行。
    expect((await listMarketplaces(db)).filter((row) => row.id === id)).toHaveLength(1);
    expect(updated.row.addedAt).toBe(123);
    expect(updated.row.refreshedAt).toBe(456);
    expect(updated.row.version).toBe('1.0.1');
  });

  it('seeds the checked-in default community registry as restricted and resolvable', async () => {
    const communityManifest = await readFile(
      new URL('../../../plugins/registry/community/open-design-marketplace.json', import.meta.url),
      'utf8',
    );

    // 固定 id 'community' 是内置源的 upsert 行:行可能已存在,断言以本次
    // ensure 的返回值和 resolve 结果为准。
    const seeded = await ensureMarketplaceManifest(db, {
      id: 'community',
      url: 'https://open-design.ai/marketplace/community/open-design-marketplace.json',
      trust: 'restricted',
      manifestText: communityManifest,
      now: 123,
    });
    if (!seeded.ok) throw new Error('community seed failed');

    expect(seeded.row.trust).toBe('restricted');
    const resolved = await resolvePluginInMarketplaces(db, 'community/registry-starter');
    expect(resolved?.marketplaceId).toBe('community');
    expect(resolved?.marketplaceTrust).toBe('restricted');
    expect(resolved?.source).toMatch(
      /^github:nexu-io\/open-design(?:@[^/]+)?\/plugins\/community\/registry-starter$/,
    );
  });

  it('keeps the checked-in official registry populated from bundled plugins', async () => {
    const officialManifestText = await readFile(
      new URL('../../../plugins/registry/official/open-design-marketplace.json', import.meta.url),
      'utf8',
    );
    const officialManifest = JSON.parse(officialManifestText) as {
      trust?: string;
      metadata?: { bundledPreinstallCount?: number };
      plugins?: Array<{ name?: string; source?: string }>;
    };

    expect(officialManifest.trust).toBe('official');
    expect(officialManifest.plugins?.length).toBeGreaterThan(100);
    expect(officialManifest.metadata?.bundledPreinstallCount).toBe(
      officialManifest.plugins?.length,
    );
    expect(officialManifest.plugins?.some((plugin) => plugin.name === 'open-design/build-test')).toBe(true);
    expect(officialManifest.plugins?.every((plugin) =>
      /^github:nexu-io\/open-design(?:@[^/]+)?\/plugins\/_official\//.test(plugin.source ?? ''),
    )).toBe(true);

    // 固定 id 'official' 同上:upsert 行,断言容忍已存在。
    const seeded = await ensureMarketplaceManifest(db, {
      id: 'official',
      url: 'https://open-design.ai/marketplace/open-design-marketplace.json',
      trust: 'official',
      manifestText: officialManifestText,
      now: 123,
    });
    if (!seeded.ok) throw new Error('official seed failed');

    const resolved = await resolvePluginInMarketplaces(db, 'open-design/build-test');
    expect(resolved?.marketplaceId).toBe('official');
    expect(resolved?.marketplaceTrust).toBe('official');
  });

  it('keeps checked-in community registry entries pointed at source folders that can pack', async () => {
    const communityManifest = JSON.parse(await readFile(
      new URL('../../../plugins/registry/community/open-design-marketplace.json', import.meta.url),
      'utf8',
    )) as {
      plugins?: Array<{ name?: string; source?: string }>;
    };
    const entry = communityManifest.plugins?.find((plugin) => plugin.name === 'community/registry-starter');
    expect(entry?.source).toBeTruthy();

    const sourceSubpath = entry!.source!.replace(/^github:nexu-io\/open-design(?:@[^/]+)?\//, '');
    expect(sourceSubpath).toBe('plugins/community/registry-starter');

    const sourceManifest = await readFile(
      new URL(`../../../${sourceSubpath}/open-design.json`, import.meta.url),
      'utf8',
    );
    expect(JSON.parse(sourceManifest)).toMatchObject({
      name: 'community-registry-starter',
      plugin: {
        repo: expect.stringContaining('github.com/nexu-io/open-design'),
      },
    });
  });
});

describe('resolvePluginInMarketplaces', () => {
  it('returns the canonical source string for a known plugin name', async () => {
    await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    const resolved = await resolvePluginInMarketplaces(db, samplePlugin);
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('github:open-design/sample-plugin');
    expect(resolved!.pluginVersion).toBe('0.1.0');
    expect(resolved!.marketplaceVersion).toBe('1.0.0');
    expect(resolved!.marketplaceTrust).toBe('restricted');
  });

  it('matches case-insensitively', async () => {
    await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    const resolved = await resolvePluginInMarketplaces(db, samplePlugin.toUpperCase());
    expect(resolved?.pluginName).toBe(samplePlugin);
  });

  it('returns null when no marketplace knows the name', async () => {
    const mystery = `mystery-${run}`;
    expect(await resolvePluginInMarketplaces(db, mystery)).toBeNull();
    await addMarketplace(db, {
      url: 'https://example.com/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    expect(await resolvePluginInMarketplaces(db, mystery)).toBeNull();
  });

  it('walks marketplaces in registration order, first hit wins', async () => {
    const otherManifest = JSON.stringify({
      specVersion: '1.0.0',
      name: 'other',
      version: '1.0.0',
      plugins: [{ name: samplePlugin, source: 'github:other/sample', version: '0.9.0' }],
    });
    const first = await addMarketplace(db, {
      url: 'https://first.example/marketplace.json',
      fetcher: fixtureFetcher(otherManifest),
    });
    // added_at 取 Date.now():同毫秒时 PG 的 ORDER BY added_at ASC 无稳定
    // 次序,隔开两次注册让"注册顺序"可断言。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await addMarketplace(db, {
      url: 'https://second.example/marketplace.json',
      fetcher: fixtureFetcher(validManifest),
    });
    if (!first.ok || !second.ok) throw new Error('setup failed');
    const resolved = await resolvePluginInMarketplaces(db, samplePlugin);
    expect(resolved?.source).toBe('github:other/sample');
  });
});
