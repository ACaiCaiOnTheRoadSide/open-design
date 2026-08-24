import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createPluginInstallIntentStore, type PluginInstallIntent, type PluginInstallIntentStore } from '../src/storage/plugin-install-intents.js';
import { resolvePgMigrationsDirectory } from '../src/storage/pg-migrations.js';
import { createPluginIntentReconciler } from '../src/plugins/plugin-intent-reconciler.js';

const now = new Date('2026-01-01T00:00:00Z');
const installed = (id: string, revision = 1): PluginInstallIntent => ({
  pluginId: id, desiredState: 'installed', source: `github:owner/repo/${id}`,
  sourceKind: 'github', revision, lastAttemptAt: null, lastSuccessAt: null,
  lastErrorAt: null, lastError: null, updatedAt: now,
});

class MemoryIntentStore implements PluginInstallIntentStore {
  rows = new Map<string, PluginInstallIntent>();
  async putInstalled(id: string, source: string, sourceKind: 'github' | 'https') {
    const prior = this.rows.get(id);
    const row = { ...installed(id, (prior?.revision ?? 0) + 1), source, sourceKind };
    this.rows.set(id, row); return row;
  }
  async putAbsent(id: string) {
    const prior = this.rows.get(id);
    const row: PluginInstallIntent = { ...installed(id, (prior?.revision ?? 0) + 1), desiredState: 'absent', source: null, sourceKind: null };
    this.rows.set(id, row); return row;
  }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async list() { return [...this.rows.values()]; }
  async markAttempt(id: string, revision: number) { return this.rows.get(id)?.revision === revision; }
  async markSuccess(id: string, revision: number) {
    const row = this.rows.get(id); if (!row || row.revision !== revision) return false;
    this.rows.set(id, { ...row, lastSuccessAt: now, lastError: null }); return true;
  }
  async markError(id: string, revision: number, error: string) {
    const row = this.rows.get(id); if (!row || row.revision !== revision) return false;
    this.rows.set(id, { ...row, lastError: error }); return true;
  }
}

describe('plugin install intent persistence and reconciliation', () => {
  it('migration defines durable desired state and revision fencing', async () => {
    const sql = await readFile(`${resolvePgMigrationsDirectory()}/003_plugin_install_intents.sql`, 'utf8');
    expect(sql).toMatch(/plugin_id text PRIMARY KEY/);
    expect(sql).toMatch(/desired_state IN \('installed', 'absent'\)/);
    expect(sql).toMatch(/revision bigint NOT NULL/);
    expect(sql).toContain('last_attempt_at');
    expect(sql).toContain('last_success_at');
    expect(sql).toContain('last_error_at');
    expect(sql).toContain('last_error');
  });

  it('typed PG store increments revisions and fences status writes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ plugin_id: 'p', desired_state: 'installed', source: 'github:o/r', source_kind: 'github', revision: '7', last_attempt_at: null, last_success_at: null, last_error_at: null, last_error: null, updated_at: now }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const store = createPluginInstallIntentStore({ query });
    await expect(store.putInstalled('p', 'github:o/r', 'github')).resolves.toMatchObject({ pluginId: 'p', revision: 7 });
    await expect(store.markSuccess('p', 6)).resolves.toBe(false);
    expect(query.mock.calls[0]![0]).toContain('revision = plugin_install_intents.revision + 1');
    expect(query.mock.calls[1]![0]).toContain('revision = $2');
  });

  it('restores an installed intent into an empty cache after restart', async () => {
    const store = new MemoryIntentStore(); store.rows.set('p', installed('p'));
    const install = vi.fn(async () => ({ pluginId: 'p' }));
    const reconciler = createPluginIntentReconciler({ store, materializer: { install, uninstall: vi.fn() } });
    await reconciler.reconcileNow();
    expect(install).toHaveBeenCalledWith('p', 'github:owner/repo/p', expect.any(AbortSignal));
    expect(store.rows.get('p')?.lastSuccessAt).toEqual(now);
  });

  it('does not redownload an already materialized matching source on periodic passes', async () => {
    const store = new MemoryIntentStore(); store.rows.set('p', installed('p'));
    const install = vi.fn(async () => ({ pluginId: 'p' }));
    const reconciler = createPluginIntentReconciler({ store, materializer: {
      isMaterialized: vi.fn(async () => true), install, uninstall: vi.fn(),
    } });
    await reconciler.reconcileNow();
    await reconciler.reconcileNow();
    expect(install).not.toHaveBeenCalled();
  });

  it('continues after one failure and retries it later', async () => {
    const store = new MemoryIntentStore(); store.rows.set('bad', installed('bad')); store.rows.set('good', installed('good'));
    let badAttempts = 0;
    const install = vi.fn(async (_expectedPluginId: string, source: string) => {
      const id = source.endsWith('/bad') ? 'bad' : 'good';
      if (id === 'bad' && badAttempts++ === 0) throw new Error('network down');
      return { pluginId: id };
    });
    const reconciler = createPluginIntentReconciler({ store, materializer: { install, uninstall: vi.fn() }, logger: { warn: vi.fn(), info: vi.fn() } });
    await reconciler.reconcileNow();
    expect(store.rows.get('bad')?.lastError).toBe('network down');
    expect(store.rows.get('good')?.lastSuccessAt).toEqual(now);
    await reconciler.reconcileNow();
    expect(store.rows.get('bad')?.lastSuccessAt).toEqual(now);
  });

  it('honors absent tombstones and never installs them', async () => {
    const store = new MemoryIntentStore(); await store.putAbsent('p');
    const install = vi.fn(); const uninstall = vi.fn(async () => undefined);
    const reconciler = createPluginIntentReconciler({ store, materializer: { install, uninstall } });
    await reconciler.reconcileNow();
    expect(install).not.toHaveBeenCalled(); expect(uninstall).toHaveBeenCalledWith('p', expect.any(AbortSignal));
  });

  it('removes stale bytes when DELETE increments revision during install', async () => {
    const store = new MemoryIntentStore(); store.rows.set('p', installed('p'));
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void; const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const uninstall = vi.fn(async () => undefined);
    const reconciler = createPluginIntentReconciler({ store, materializer: { install: async () => { markStarted(); await blocked; return { pluginId: 'p' }; }, uninstall } });
    const running = reconciler.reconcileNow();
    await started; await store.putAbsent('p'); release(); await running;
    expect(uninstall).toHaveBeenCalledWith('p', expect.any(AbortSignal));
    expect(store.rows.get('p')?.desiredState).toBe('absent');
  });

  it('fails closed without uninstalling another plugin on a defensive id mismatch', async () => {
    const store = new MemoryIntentStore(); store.rows.set('expected', installed('expected'));
    const uninstall = vi.fn(async () => undefined);
    const reconciler = createPluginIntentReconciler({ store, materializer: { install: async () => ({ pluginId: 'other' }), uninstall }, logger: { warn: vi.fn(), info: vi.fn() } });
    await reconciler.reconcileNow();
    expect(uninstall).not.toHaveBeenCalled();
    expect(store.rows.get('expected')?.lastError).toMatch(/does not match/);
  });
});

