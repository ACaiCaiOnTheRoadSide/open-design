import type { Server } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setPostgresMemoryStoreForTests,
  buildMemoryTree,
  composeMemoryBody,
  configureMemoryHistoryOutbox,
  deleteMemoryEntry,
  deleteProjectMemoryForCurrentPrincipal,
  drainMemoryHistoryWrites,
  extractFromMessage,
  listMemoryEntries,
  readMemoryConfig,
  readMemoryEntry,
  readMemoryIndex,
  stopMemoryHistoryOutbox,
  upsertMemoryEntry,
  writeMemoryConfig,
  writeMemoryIndex,
  TrustedMemoryScope,
} from '../src/memory.js';
import { __resetExtractionsForTests, recordHeuristic } from '../src/memory-extractions.js';
import { __resetVerificationsForTests, recordVerify } from '../src/memory-verify.js';
import { extractWithLLM, __resetMemoryTurnDedupeForTests } from '../src/memory-llm.js';
import { registerMemoryRoutes } from '../src/routes/memory.js';
import { requireRequestContext, runWithRequestContext } from '../src/request-context.js';
import type { PostgresMemoryConfig, PostgresMemoryEntry } from '../src/storage/postgres-memory-store.js';
import { ProjectMemoryScopeUnverifiedError } from '../src/memory-errors.js';
import {
  __resetProjectLifecycleGateForTests,
  beginProjectDeletion,
} from '../src/project-lifecycle-gate.js';

const DEFAULT_INDEX_PREFIX = '# Memory';

class FakePrincipalMemoryStore {
  upsertFailure: Error | undefined;
  readFailure: Error | undefined;
  indexFailure: Error | undefined;
  configFailure: Error | undefined;
  deleteFailure: Error | undefined;
  moveToProjectAfterNextRead: string | undefined;
  projectCleanupCalls: readonly string[][] = [];
  extractionWrites: Array<Record<string, unknown>> = [];
  verificationWrites: Array<Record<string, unknown>> = [];
  historyWriteBarrier: Promise<void> | undefined;
  private entries = new Map<string, Map<string, PostgresMemoryEntry>>();
  private indexes = new Map<string, string>();
  private configs = new Map<string, PostgresMemoryConfig>();

  private key(): string {
    const { tenantId, userId } = requireRequestContext();
    return `${tenantId}\0${userId}`;
  }

  private bucket(): Map<string, PostgresMemoryEntry> {
    const key = this.key();
    let bucket = this.entries.get(key);
    if (!bucket) this.entries.set(key, bucket = new Map());
    return bucket;
  }

  async listEntries() { return [...this.bucket().values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  async readEntry(id: string) {
    if (this.readFailure) throw this.readFailure;
    const current = this.bucket().get(id);
    const snapshot = current ? { ...current } : null;
    if (current && this.moveToProjectAfterNextRead) {
      this.bucket().set(id, { ...current, projectId: this.moveToProjectAfterNextRead });
      this.moveToProjectAfterNextRead = undefined;
    }
    return snapshot;
  }
  async readIndex() { return this.indexes.get(this.key()) ?? null; }
  async writeIndex(value: string) {
    if (this.indexFailure) throw this.indexFailure;
    this.indexes.set(this.key(), value);
  }
  async readConfig() { return this.configs.get(this.key()) ?? null; }
  async writeConfig(value: PostgresMemoryConfig) { this.configs.set(this.key(), structuredClone(value)); }
  async patchConfig(patch: PostgresMemoryConfig, defaults: PostgresMemoryConfig) {
    if (this.configFailure) throw this.configFailure;
    const previous = { ...defaults, ...(await this.readConfig() ?? {}) };
    const config = { ...previous, ...patch };
    await this.writeConfig(config);
    return { previous, config };
  }
  async readCompositionSnapshot(options: { projectId?: string } = {}) {
    const entries = (await this.listEntries()).filter((entry) =>
      entry.projectId == null || entry.projectId === options.projectId);
    return { entries, index: await this.readIndex(), config: await this.readConfig() };
  }

  async listExtractions() { return { records: [], nextCursor: null }; }
  async listVerifications() { return { records: [], nextCursor: null }; }
  async clearExtractions() { return 0; }
  async clearVerifications() { return 0; }
  async removeExtraction() { return 0; }
  async removeVerification() { return 0; }
  async upsertExtraction(record: Record<string, unknown>) {
    this.extractionWrites.push(structuredClone(record));
    await this.historyWriteBarrier;
  }
  async upsertVerification(record: Record<string, unknown>) {
    this.verificationWrites.push(structuredClone(record));
    await this.historyWriteBarrier;
  }

  async upsertEntryAndIndex(
    entry: PostgresMemoryEntry,
    line: string,
    defaultIndex: string,
    options: { preserveScope?: boolean; requireGlobalExisting?: boolean } = {},
  ) {
    if (this.upsertFailure) throw this.upsertFailure;
    const previous = this.bucket().get(entry.id);
    if (previous?.projectId != null && options.requireGlobalExisting) {
      throw new ProjectMemoryScopeUnverifiedError();
    }
    const saved = {
      ...entry,
      projectId: options.preserveScope && previous ? previous.projectId ?? null : entry.projectId ?? null,
      createdAt: previous?.createdAt ?? entry.createdAt,
    };
    this.bucket().set(entry.id, saved);
    const lines = (await this.readIndex() ?? defaultIndex).split(/\r?\n/);
    const target = `](${entry.id}.md)`;
    const position = lines.findIndex((candidate) => candidate.includes(target));
    if (position >= 0) lines[position] = line;
    else {
      if (lines.at(-1) !== '') lines.push('');
      lines.push(line);
    }
    await this.writeIndex(lines.join('\n'));
    return saved;
  }

  async deleteProjectEntriesAndIndexForCurrentPrincipal(projectIds: readonly string[]) {
    this.projectCleanupCalls = [...this.projectCleanupCalls, [...projectIds]];
    return 0;
  }

  async deleteEntryAndIndex(id: string, defaultIndex: string, options: { requireGlobal?: boolean } = {}) {
    if (this.deleteFailure) throw this.deleteFailure;
    const current = this.bucket().get(id);
    if (current?.projectId != null && options.requireGlobal) throw new ProjectMemoryScopeUnverifiedError();
    const removed = this.bucket().delete(id);
    const target = `](${id}.md)`;
    const lines = (await this.readIndex() ?? defaultIndex).split(/\r?\n/)
      .filter((candidate) => !candidate.includes(target));
    await this.writeIndex(lines.join('\n'));
    return removed;
  }
}

const originalDb = process.env.OD_DAEMON_DB;
let store: FakePrincipalMemoryStore;
let historyDb: Database.Database;

beforeEach(() => {
  __resetProjectLifecycleGateForTests();
  __resetExtractionsForTests();
  __resetVerificationsForTests();
  process.env.OD_DAEMON_DB = 'postgres';
  store = new FakePrincipalMemoryStore();
  __setPostgresMemoryStoreForTests(store as never);
  historyDb = new Database(':memory:');
  historyDb.exec(`CREATE TABLE memory_history_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, projection_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
  configureMemoryHistoryOutbox(historyDb);
});

afterEach(() => {
  stopMemoryHistoryOutbox();
  historyDb.close();
  if (originalDb === undefined) delete process.env.OD_DAEMON_DB;
  else process.env.OD_DAEMON_DB = originalDb;
  __setPostgresMemoryStoreForTests(undefined);
});

function scoped<T>(tenantId: string, userId: string, work: () => T): T {
  return runWithRequestContext({ tenantId, userId }, work);
}

describe('PostgreSQL memory exported boundary', () => {
  it('persists each history phase once and drains accepted writes before shutdown', async () => {
    let release!: () => void;
    store.historyWriteBarrier = new Promise<void>((resolve) => { release = resolve; });

    scoped('tenant', 'alice', () => {
      recordHeuristic({ userMessage: 'use blue', writtenCount: 1, writtenIds: ['m1'] });
      recordVerify({
        status: 'pass', rulesActive: 1, rulesCovered: 1, uncoveredRules: [],
        rowsTotal: 1, rowsFailed: 0, hadArtifact: true,
      }, { runId: 'run-1' });
    });

    let drained = false;
    const drain = drainMemoryHistoryWrites().then(() => { drained = true; });
    await Promise.resolve();
    expect(store.extractionWrites).toHaveLength(1);
    expect(store.verificationWrites).toHaveLength(0); // global FIFO blocks behind extraction
    expect(drained).toBe(false);
    release();
    await drain;
    expect(store.verificationWrites).toHaveLength(1);
    expect(drained).toBe(true);
  });

  it('maps CRUD to the existing contract, isolates principals, and never lists bodies', async () => {
    const alice = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored-a', {
      name: 'Preferred grid', description: 'Use eight pixels', type: 'user', body: 'Always use an 8px grid.',
    }, undefined));
    expect(alice).toMatchObject({ id: 'user_preferred_grid', source: 'manual', body: 'Always use an 8px grid.' });
    expect(alice).not.toHaveProperty('createdAt');

    const list = await scoped('tenant', 'alice', () => listMemoryEntries('/different-ignored-dir'));
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('body');
    expect(list[0]).not.toHaveProperty('createdAt');
    expect(await scoped('tenant', 'bob', () => listMemoryEntries('/ignored'))).toEqual([]);

    await scoped('tenant', 'bob', () => upsertMemoryEntry('/ignored', {
      id: alice.id, name: 'Other fact', description: '', type: 'project', body: 'Bob only',
    }, undefined));
    expect((await scoped('tenant', 'alice', () => readMemoryEntry('/ignored', alice.id)))?.body)
      .toBe('Always use an 8px grid.');
    expect((await scoped('tenant', 'bob', () => readMemoryEntry('/ignored', alice.id)))?.body).toBe('Bob only');

    await scoped('tenant', 'alice', () => deleteMemoryEntry('/ignored', alice.id));
    expect(await scoped('tenant', 'alice', () => readMemoryEntry('/ignored', alice.id))).toBeNull();
    expect(await scoped('tenant', 'bob', () => readMemoryEntry('/ignored', alice.id))).not.toBeNull();
  });

  it('preserves omitted update scope and gives implicit project ids stable scope hashes', async () => {
    const p1 = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: 'Same fact', description: 'p1', type: 'project', body: 'p1 body', projectId: 'p1',
    }, undefined));
    const p2 = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: 'Same fact', description: 'p2', type: 'project', body: 'p2 body', projectId: 'p2',
    }, undefined));
    expect(p1.id).not.toBe(p2.id);
    expect(p1.id).toMatch(/^[a-z0-9_]{1,96}$/);
    const p1Again = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: 'Same fact', description: 'p1 again', type: 'project', body: 'p1 again', projectId: 'p1',
    }, undefined));
    expect(p1Again.id).toBe(p1.id);

    const sharedPrefix = 'a'.repeat(60);
    const longNameA = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: `${sharedPrefix}-first`, description: '', type: 'project', body: 'first', projectId: 'p1',
    }, undefined));
    const longNameB = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: `${sharedPrefix}-second`, description: '', type: 'project', body: 'second', projectId: 'p1',
    }, undefined));
    expect(longNameA.id).not.toBe(longNameB.id);
    expect(longNameA.id).toMatch(/^[a-z0-9_]{1,96}$/);
    expect(longNameB.id).toMatch(/^[a-z0-9_]{1,96}$/);

    const updated = await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      id: p1.id, name: 'Same fact updated', description: 'still p1', type: 'project', body: 'updated',
    }, undefined));
    expect(updated.projectId).toBe('p1');
    expect(await scoped('tenant', 'alice', () => listMemoryEntries('/ignored'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: p1.id, projectId: 'p1' }),
      expect.objectContaining({ id: p2.id, projectId: 'p2' }),
    ]));
  });

  it('maps heuristic project facts to trusted projects while leaving other types global', async () => {
    await scoped('tenant', 'alice', () => writeMemoryConfig('/ignored', {
      enabled: true, chatExtractionEnabled: true,
    }));
    const scopeA = TrustedMemoryScope.fromLoadedProject({ id: 'project-a' });
    const scopeB = TrustedMemoryScope.fromLoadedProject({ id: 'project-b' });
    await scoped('tenant', 'alice', () => extractFromMessage('/ignored', 'I want to build the alpha dashboard', scopeA));
    await scoped('tenant', 'alice', () => extractFromMessage('/ignored', 'I want to build the beta dashboard', scopeB));
    await scoped('tenant', 'alice', () => extractFromMessage('/ignored', 'Remember: keep copy concise', scopeA));
    const entries = await scoped('tenant', 'alice', () => listMemoryEntries('/ignored'));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'project', projectId: 'project-a' }),
      expect.objectContaining({ type: 'project', projectId: 'project-b' }),
      expect.objectContaining({ type: 'feedback', projectId: null }),
    ]));
    const bodyA = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored', scopeA));
    const bodyB = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored', scopeB));
    expect(bodyA).toContain('alpha dashboard');
    expect(bodyA).not.toContain('beta dashboard');
    expect(bodyB).toContain('beta dashboard');
    expect(bodyB).not.toContain('alpha dashboard');
  });

  it('preserves config/index defaults and patch merge semantics', async () => {
    const defaults = await scoped('tenant', 'alice', () => readMemoryConfig('/ignored'));
    expect(defaults).toMatchObject({ enabled: true, chatExtractionEnabled: false, profileEnabled: true });
    expect(await scoped('tenant', 'alice', () => readMemoryIndex('/ignored'))).toContain(DEFAULT_INDEX_PREFIX);

    await scoped('tenant', 'alice', () => writeMemoryConfig('/ignored', {
      enabled: false, extraction: { provider: 'openai', model: 'gpt-4.1-mini' },
    }));
    const patched = await scoped('tenant', 'alice', () => writeMemoryConfig('/ignored', { verifyEnabled: false }));
    expect(patched).toMatchObject({ enabled: false, verifyEnabled: false });
    expect(patched.extraction).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' });
    await scoped('tenant', 'alice', () => writeMemoryIndex('/ignored', '# Custom\n', undefined));
    expect(await scoped('tenant', 'alice', () => readMemoryIndex('/ignored'))).toBe('# Custom\n');
  });

  it('composes prompt and tree through PostgreSQL-backed exports', async () => {
    await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: 'Accessibility', description: 'Keyboard first', type: 'rule', body: 'Verify keyboard navigation.',
    }, undefined));
    const prompt = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored'));
    expect(prompt).toContain('Verify keyboard navigation.');
    await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      id: 'project_global', name: 'Global project type', description: '', type: 'project', body: 'global', projectId: null,
    }, undefined));
    await scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      id: 'user_scoped', name: 'Scoped user type', description: '', type: 'user', body: 'scoped', projectId: 'p1',
    }, undefined));
    const tree = await scoped('tenant', 'alice', () => buildMemoryTree('/ignored'));
    expect(tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'folder:rule', childrenCount: 1 }),
      expect.objectContaining({ id: 'rule_accessibility', kind: 'entry' }),
      expect.objectContaining({ id: 'project_global', scope: 'global' }),
      expect.objectContaining({ id: 'user_scoped', scope: 'project' }),
    ]));
  });

  it('composes global plus only the trusted current project before applying the principal index', async () => {
    await scoped('tenant', 'alice', async () => {
      await upsertMemoryEntry('/ignored', { id: 'global', name: 'Global', description: '', type: 'user', body: 'global body' }, undefined);
      await upsertMemoryEntry('/ignored', { id: 'p1', name: 'P1', description: '', type: 'project', body: 'p1 body', projectId: 'p1' }, undefined);
      await upsertMemoryEntry('/ignored', { id: 'p2', name: 'P2', description: '', type: 'project', body: 'p2 body', projectId: 'p2' }, undefined);
    });
    const p1Scope = TrustedMemoryScope.fromLoadedProject({ id: 'p1' });
    const p2Scope = TrustedMemoryScope.fromLoadedProject({ id: 'p2' });
    const global = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored'));
    const p1 = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored', p1Scope));
    const p2 = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored', p2Scope));
    expect(global).toContain('global body');
    expect(global).not.toContain('p1 body');
    expect(global).not.toContain('p2 body');
    expect(p1).toContain('global body');
    expect(p1).toContain('p1 body');
    expect(p1).not.toContain('p2 body');
    expect(p2).toContain('global body');
    expect(p2).toContain('p2 body');
    expect(p2).not.toContain('p1 body');
  });

  it('maps model-selected project scope from the trusted run scope in asynchronous extraction', async () => {
    const originalFetch = globalThis.fetch;
    __resetMemoryTurnDedupeForTests();
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      entries: [{ type: 'project', scope: 'project', name: 'P1 constraint', description: 'Only p1', body: 'Use the p1 grid.' }],
    }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      await scoped('tenant', 'alice', () => writeMemoryConfig('/ignored', {
        enabled: true,
        chatExtractionEnabled: true,
        extraction: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
      }));
      const scope = TrustedMemoryScope.fromLoadedProject({ id: 'p1' });
      const written = await scoped('tenant', 'alice', () => extractWithLLM('/ignored', {
        userMessage: 'Remember this only for this project.', assistantMessage: 'Understood.',
      }, { conversationId: 'project-p1', trustedMemoryScope: scope }));
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ projectId: 'p1', name: 'P1 constraint' });
      __resetMemoryTurnDedupeForTests();
      const untrusted = await scoped('tenant', 'alice', () => extractWithLLM('/ignored', {
        userMessage: 'A different project-only fact.', assistantMessage: 'Understood.',
      }, { conversationId: 'project-untrusted' }));
      expect(untrusted).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('composes config, index, summaries, and bodies from one store snapshot', async () => {
    const now = Date.now();
    store.readCompositionSnapshot = async () => ({
      config: { enabled: true },
      index: '# Memory\n\n- [Stable](user_stable.md)\n',
      entries: [{
        id: 'user_stable', name: 'Stable', description: 'snapshot', type: 'user', source: 'manual',
        body: 'body from the same snapshot', createdAt: now, updatedAt: now,
      }],
    });
    store.readEntry = async () => ({
      id: 'user_stable', name: 'Changed', description: 'newer', type: 'user', source: 'manual',
      body: 'body from a later read', createdAt: now, updatedAt: now + 1,
    });
    const prompt = await scoped('tenant', 'alice', () => composeMemoryBody('/ignored'));
    expect(prompt).toContain('body from the same snapshot');
    expect(prompt).not.toContain('body from a later read');
  });

  it('uses the unified project cleanup facade in PostgreSQL and is a strict SQLite no-op', async () => {
    await scoped('tenant', 'alice', () => deleteProjectMemoryForCurrentPrincipal(['p1', 'p2']));
    expect(store.projectCleanupCalls).toEqual([['p1', 'p2']]);

    process.env.OD_DAEMON_DB = 'sqlite';
    await expect(deleteProjectMemoryForCurrentPrincipal(['', 'bad\nproject'])).resolves.toBeUndefined();
    expect(store.projectCleanupCalls).toEqual([['p1', 'p2']]);
  });

  it('centrally gates every explicit project upsert and drains an active facade write', async () => {
    const deleted = await beginProjectDeletion(['deleted-project']);
    deleted.commit();
    await expect(scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: 'stale', type: 'project', body: 'must not persist', projectId: 'deleted-project',
    }))).rejects.toMatchObject({ code: 'PROJECT_DELETED' });
    expect(await scoped('tenant', 'alice', () => listMemoryEntries('/ignored'))).toEqual([]);

    let release!: () => void;
    const originalUpsert = store.upsertEntryAndIndex.bind(store);
    store.upsertEntryAndIndex = async (...args: Parameters<typeof originalUpsert>) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalUpsert(...args);
    };
    const activeWrite = scoped('tenant', 'alice', () => upsertMemoryEntry('/ignored', {
      name: 'active', type: 'project', body: 'persist', projectId: 'active-project',
    }));
    const deleting = beginProjectDeletion(['active-project']);
    let drained = false;
    void deleting.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await activeWrite;
    const handle = await deleting;
    expect(drained).toBe(true);
    handle.rollback();
  });

  it('fails closed outside principal scope instead of touching dataDir', async () => {
    await expect(readMemoryIndex('/definitely/not/a/real/path')).rejects.toThrow(/Missing principal/);
    await expect(listMemoryEntries('/definitely/not/a/real/path')).rejects.toThrow(/Missing principal/);
  });
});

describe('PostgreSQL memory route capability boundary', () => {
  it('allows static project mutations, rejects trusted-proxy scope, validates format, and keeps system prompt global', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.locals.principalSource = req.headers['x-test-principal-source'] ?? 'static';
      runWithRequestContext({ tenantId: 'tenant', userId: 'alice' }, next);
    });
    registerMemoryRoutes(app, {
      paths: { RUNTIME_DATA_DIR: '/ignored', PROJECT_ROOT: '/ignored', PROJECTS_DIR: '/ignored' },
      http: {
        createSseResponse: () => { throw new Error('not used'); },
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      },
      appConfig: { readAppConfig: async () => ({}) },
    } as never);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    try {
      const create = await fetch(`${base}/api/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'P1', type: 'project', body: 'secret p1', projectId: 'p1' }),
      });
      expect(create.status).toBe(200);
      const createdEntry = (await create.json() as { entry: PostgresMemoryEntry }).entry;
      expect(createdEntry.projectId).toBe('p1');

      for (const [projectId, expectedCode, settle] of [
        ['deleted-static', 'PROJECT_DELETED', 'commit'],
        ['deleting-static', 'PROJECT_DELETING', 'rollback'],
      ] as const) {
        const lifecycle = await beginProjectDeletion([projectId]);
        if (settle === 'commit') lifecycle.commit();
        const blockedLifecycleWrite = await fetch(`${base}/api/memory`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: projectId, type: 'project', body: 'orphan', projectId }),
        });
        expect(blockedLifecycleWrite.status).toBe(409);
        expect(await blockedLifecycleWrite.json()).toEqual({ error: {
          code: expectedCode,
          message: expect.any(String),
        } });
        expect(await scoped('tenant', 'alice', () => listMemoryEntries('/ignored')))
          .not.toEqual(expect.arrayContaining([expect.objectContaining({ projectId })]));
        if (settle === 'rollback') lifecycle.rollback();
      }

      const missingUpdate = await fetch(`${base}/api/memory/missing_put_target`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Missing', type: 'user', body: 'must not be created' }),
      });
      expect(missingUpdate.status).toBe(404);
      expect(await scoped('tenant', 'alice', () => readMemoryEntry('/ignored', 'missing_put_target'))).toBeNull();

      const staticUpdate = await fetch(`${base}/api/memory/${createdEntry.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'P1 updated', type: 'project', body: 'updated p1' }),
      });
      expect(staticUpdate.status).toBe(200);
      expect((await staticUpdate.json() as { entry: PostgresMemoryEntry }).entry.projectId).toBe('p1');

      for (const [path, method, body] of [
        [`/api/memory/${createdEntry.id}`, 'PUT', { name: 'Omitted', type: 'project', body: 'blocked' }],
        [`/api/memory/${createdEntry.id}`, 'PUT', { name: 'Global', type: 'project', body: 'blocked', projectId: null }],
        [`/api/memory/${createdEntry.id}`, 'PUT', { name: 'Explicit', type: 'project', body: 'blocked', projectId: 'p1' }],
        [`/api/memory/tree/${createdEntry.id}`, 'PATCH', { name: 'Tree blocked' }],
      ] as const) {
        const deletion = await beginProjectDeletion(['p1']);
        const blocked = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(blocked.status, `${method} ${path}`).toBe(409);
        expect(await blocked.json()).toMatchObject({ error: { code: 'PROJECT_DELETING' } });
        deletion.rollback();
      }
      expect(await scoped('tenant', 'alice', () => readMemoryEntry('/ignored', createdEntry.id)))
        .toMatchObject({ projectId: 'p1', body: 'updated p1' });

      for (const [method, path, body] of [
        ['PUT', `/api/memory/${createdEntry.id}`, { name: 'Blocked', type: 'project', body: 'blocked' }],
        ['PATCH', `/api/memory/tree/${createdEntry.id}`, { name: 'Blocked tree' }],
        ['DELETE', `/api/memory/${createdEntry.id}`, undefined],
      ] as const) {
        const blocked = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-test-principal-source': 'trusted-proxy' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(blocked.status, `${method} ${path}`).toBe(409);
        expect(await blocked.json()).toEqual({ error: {
          code: 'PROJECT_MEMORY_SCOPE_UNVERIFIED',
          message: 'Project-scoped memory mutations require a server-verified static principal',
        } });
      }

      const rejected = await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-principal-source': 'trusted-proxy' },
        body: JSON.stringify({ name: 'P2', type: 'project', body: 'secret p2', projectId: 'p2' }),
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: {
        code: 'PROJECT_MEMORY_SCOPE_UNVERIFIED',
        message: 'Project-scoped memory mutations require a server-verified static principal',
      } });

      // The route precheck sees global, then a simulated internal chat moves the
      // row to project scope before each store mutation. Store conditions, not
      // the stale precheck, must reject without changing/deleting content.
      const globalCreate = await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-principal-source': 'trusted-proxy' },
        body: JSON.stringify({ id: 'user_race', name: 'Race', type: 'user', body: 'original' }),
      });
      expect(globalCreate.status).toBe(200);

      for (const [method, path, body] of [
        ['PUT', '/api/memory/user_race', { name: 'Overwritten', type: 'user', body: 'put changed' }],
        ['PATCH', '/api/memory/tree/user_race', { name: 'Patched', body: 'patch changed' }],
        ['DELETE', '/api/memory/user_race', undefined],
      ] as const) {
        await fetch(`${base}/api/memory/user_race`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Race', type: 'user', body: 'original', projectId: null }),
        });
        store.moveToProjectAfterNextRead = 'chat-project';
        const raced = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-test-principal-source': 'trusted-proxy' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(raced.status, `raced ${method}`).toBe(409);
        expect((await raced.json() as any).error.code).toBe('PROJECT_MEMORY_SCOPE_UNVERIFIED');
        const unchanged = await scoped('tenant', 'alice', () => store.readEntry('user_race'));
        expect(unchanged).toMatchObject({ body: 'original', projectId: 'chat-project' });
      }

      // Static principals retain ordinary scope-moving and mutation behavior.
      const staticMove = await fetch(`${base}/api/memory/user_race`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Static', type: 'user', body: 'static changed', projectId: null }),
      });
      expect(staticMove.status).toBe(200);
      expect((await staticMove.json() as any).entry).toMatchObject({ body: 'static changed', projectId: null });

      const invalid = await fetch(`${base}/api/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bad', type: 'project', projectId: '' }),
      });
      expect(invalid.status).toBe(400);

      const prompt = await fetch(`${base}/api/memory/system-prompt?projectId=p1`);
      expect(prompt.status).toBe(200);
      expect((await prompt.json() as { body: string }).body).not.toContain('secret p1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns 500 with stable JSON for a valid mutation when PostgreSQL fails, while validation remains 400', async () => {
    store.upsertFailure = new Error('connect ECONNREFUSED db.internal:5432');
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithRequestContext({ tenantId: 'tenant', userId: 'alice' }, next));
    registerMemoryRoutes(app, {
      paths: { RUNTIME_DATA_DIR: '/ignored', PROJECT_ROOT: '/ignored', PROJECTS_DIR: '/ignored' },
      http: {
        createSseResponse: () => { throw new Error('not used'); },
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      },
      appConfig: { readAppConfig: async () => ({}) },
    } as never);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const failed = await fetch(`${base}/api/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Valid', type: 'user', body: 'body' }),
      });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'Memory storage unavailable' });

      const invalid = await fetch(`${base}/api/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Invalid', type: 'not-a-type' }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'memory entry requires `name` and a valid `type`' });

      store.readFailure = new Error('query failed');
      const detailFailure = await fetch(`${base}/api/memory/valid_id`);
      expect(detailFailure.status).toBe(500);
      expect(await detailFailure.json()).toEqual({ error: 'Memory storage unavailable' });
      store.readFailure = undefined;
      const missing = await fetch(`${base}/api/memory/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'memory not found' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('maps infrastructure failures for every basic PostgreSQL mutation to stable 500 responses', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithRequestContext({ tenantId: 'tenant', userId: 'alice' }, next));
    registerMemoryRoutes(app, {
      paths: { RUNTIME_DATA_DIR: '/ignored', PROJECT_ROOT: '/ignored', PROJECTS_DIR: '/ignored' },
      http: {
        createSseResponse: () => { throw new Error('not used'); },
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      },
      appConfig: { readAppConfig: async () => ({}) },
    } as never);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const expectStorageFailure = async (path: string, method: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      });
      expect(response.status, `${method} ${path}`).toBe(500);
      expect(await response.json()).toEqual({ error: 'Memory storage unavailable' });
    };
    try {
      store.indexFailure = new Error('index connection lost');
      await expectStorageFailure('/api/memory/index', 'PUT', { index: '# Changed' });
      store.indexFailure = undefined;

      store.configFailure = new Error('config query timeout');
      await expectStorageFailure('/api/memory/config', 'PATCH', { enabled: false });
      store.configFailure = undefined;

      store.deleteFailure = new Error('delete connection reset');
      await expectStorageFailure('/api/memory/user_entry', 'DELETE');
      store.deleteFailure = undefined;

      store.readFailure = new Error('tree query unavailable');
      await expectStorageFailure('/api/memory/tree/user_entry', 'PATCH', { name: 'Changed' });
      store.readFailure = undefined;

      const invalidTree = await fetch(`${base}/api/memory/tree/folder:user`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(invalidTree.status).toBe(400);

      const invalidConfig = await fetch(`${base}/api/memory/config`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extraction: { provider: 'invalid' } }),
      });
      expect(invalidConfig.status).toBe(400);
      expect(await invalidConfig.json()).toEqual({ error: 'invalid extraction provider' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not misreport a missing verified principal as invalid input', async () => {
    const app = express();
    app.use(express.json());
    registerMemoryRoutes(app, {
      paths: { RUNTIME_DATA_DIR: '/ignored', PROJECT_ROOT: '/ignored', PROJECTS_DIR: '/ignored' },
      http: {
        createSseResponse: () => { throw new Error('not used'); },
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      },
      appConfig: { readAppConfig: async () => ({}) },
    } as never);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Valid', type: 'user', body: 'body' }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Memory storage unavailable' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('enables principal-scoped capability routes in PostgreSQL mode', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithRequestContext({ tenantId: 'tenant', userId: 'alice' }, next));
    registerMemoryRoutes(app, {
      paths: { RUNTIME_DATA_DIR: '/ignored', PROJECT_ROOT: '/ignored', PROJECTS_DIR: '/ignored' },
      http: {
        createSseResponse: () => ({ send: () => {} }),
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      },
      appConfig: { readAppConfig: async () => ({}) },
    } as never);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const base = `http://127.0.0.1:${address.port}`;
      const extractions = await fetch(`${base}/api/memory/extractions`);
      expect(extractions.status).toBe(200);
      expect(await extractions.json()).toEqual({ extractions: [], nextCursor: null });
      const verifications = await fetch(`${base}/api/memory/verifications`);
      expect(verifications.status).toBe(200);
      expect(await verifications.json()).toEqual({ verifications: [], nextCursor: null });
      for (const path of ['extract', 'rules/suggest', 'connectors/suggest', 'connectors/extract']) {
        const response = await fetch(`${base}/api/memory/${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        expect(response.status, path).not.toBe(501);
      }
      const basic = await fetch(`${base}/api/memory`);
      expect(basic.status).toBe(200);
      expect((await basic.json() as any).entries).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
