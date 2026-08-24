import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../../src/request-context.js';
import {
  PostgresMemoryStore,
  type PgMemoryTransactionRunner,
  type PostgresMemoryConfig,
  type PostgresMemoryEntry,
} from '../../src/storage/postgres-memory-store.js';
import type { PgQueryable } from '../../src/storage/pg.js';

interface StoredEntry {
  id: string;
  name: string;
  description: string;
  type: string;
  source: string | null;
  project_id: string | null;
  body: string;
  created_at: Date;
  updated_at: Date;
}

interface StoredSettings {
  index: string | null;
  config: PostgresMemoryConfig | null;
}

function result<R extends QueryResultRow>(rows: R[] = [], rowCount = rows.length): QueryResult<R> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

class FakePgQueryable implements PgQueryable {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  private readonly entries = new Map<string, StoredEntry>();
  private readonly settings = new Map<string, StoredSettings>();

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const normalized = text.replace(/\s+/g, ' ').trim();
    const principal = `${String(values[0])}\0${String(values[1])}`;

    if (normalized.startsWith('INSERT INTO memory_entries')) {
      const key = `${principal}\0${String(values[2])}`;
      const previous = this.entries.get(key);
      const preserveScope = values[10] === true;
      const requireGlobalExisting = values[11] === true;
      if (previous?.project_id != null && requireGlobalExisting) return result<R>();
      const entry: StoredEntry = {
        id: String(values[2]),
        name: String(values[3]),
        description: String(values[4]),
        type: String(values[5]),
        source: values[6] === null ? null : String(values[6]),
        project_id: preserveScope && previous
          ? previous.project_id
          : values[7] === null ? null : String(values[7]),
        body: String(values[8]),
        created_at: previous?.created_at ?? new Date(values[9] as Date),
        updated_at: new Date(Date.now() + this.calls.length),
      };
      this.entries.set(key, entry);
      return result([entry as unknown as R]);
    }

    if (normalized.startsWith('SELECT') && normalized.includes('LEFT JOIN memory_entries')) {
      const setting = this.settings.get(principal);
      const projectId = values[2] === null ? null : String(values[2]);
      const scopedEntries = [...this.entries.entries()]
        .filter(([key, stored]) => key.startsWith(`${principal}\0`)
          && (stored.project_id === null || stored.project_id === projectId))
        .map(([, stored]) => ({
          ...stored,
          index_body: setting?.index ?? null,
          config: setting?.config ?? null,
        }));
      return result((scopedEntries.length > 0 ? scopedEntries : [{
        id: null,
        index_body: setting?.index ?? null,
        config: setting?.config ?? null,
      }]) as unknown as R[]);
    }

    if (normalized.startsWith('SELECT') && normalized.includes('FROM memory_entries')) {
      if (values.length === 3) {
        const entry = this.entries.get(`${principal}\0${String(values[2])}`);
        return result(entry === undefined ? [] : [entry as unknown as R]);
      }
      const rows = [...this.entries.entries()]
        .filter(([key]) => key.startsWith(`${principal}\0`))
        .map(([, entry]) => entry)
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      return result(rows as unknown as R[]);
    }

    if (normalized.startsWith('DELETE FROM memory_entries')) {
      if (normalized.includes('project_id = ANY')) {
        const projectIds = new Set((values[2] as string[]).map(String));
        const deleted: Array<{ id: string }> = [];
        for (const [key, stored] of this.entries) {
          if (key.startsWith(`${principal}\0`) && stored.project_id !== null && projectIds.has(stored.project_id)) {
            this.entries.delete(key);
            deleted.push({ id: stored.id });
          }
        }
        return result(deleted as unknown as R[]);
      }
      const key = `${principal}\0${String(values[2])}`;
      const current = this.entries.get(key);
      if (values[3] === true && current?.project_id != null) return result<R>();
      const deleted = this.entries.delete(key);
      return result<R>([], deleted ? 1 : 0);
    }

    if (normalized.startsWith('INSERT INTO memory_settings')) {
      const existing = this.settings.get(principal);
      if (normalized.includes('DO NOTHING') && existing) return result<R>();
      const current = existing ?? { index: null, config: null };
      if (normalized.includes('(tenant_id, user_id, index_body)')) {
        current.index = String(values[2]);
      } else {
        current.config = JSON.parse(String(values[2])) as PostgresMemoryConfig;
      }
      this.settings.set(principal, current);
      return result<R>();
    }

    if (normalized.includes('SELECT index_body')) {
      const setting = this.settings.get(principal);
      return result(setting === undefined ? [] : [{ index_body: setting.index } as unknown as R]);
    }

    if (normalized.startsWith('UPDATE memory_settings')) {
      const setting = this.settings.get(principal);
      if (setting) setting.index = String(values[2]);
      return result<R>([], setting ? 1 : 0);
    }

    if (normalized.includes('SELECT config')) {
      const setting = this.settings.get(principal);
      return result(setting === undefined ? [] : [{ config: setting.config } as unknown as R]);
    }

    throw new Error(`Unexpected SQL: ${normalized}`);
  }
}

const alice = { tenantId: 'tenant-a', userId: 'alice' };
const bob = { tenantId: 'tenant-b', userId: 'bob' };

function entry(overrides: Partial<PostgresMemoryEntry> = {}): PostgresMemoryEntry {
  return {
    id: 'user_role',
    name: 'Role',
    description: 'User role',
    type: 'user',
    source: 'manual',
    body: 'Designer',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    ...overrides,
  };
}

function scoped<T>(principal: typeof alice, work: () => T): T {
  return runWithRequestContext(principal, work);
}

describe('PostgresMemoryStore', () => {
  it('fails every public operation outside a verified request scope', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);
    const operations = [
      () => store.listEntries(),
      () => store.readEntry('user_role'),
      () => store.upsertEntry(entry()),
      () => store.deleteEntry('user_role'),
      () => store.readIndex(),
      () => store.writeIndex('# Memory'),
      () => store.readConfig(),
      () => store.writeConfig({ enabled: true }),
      () => store.upsertExtraction({ id: 'e1', phase: 'running', startedAt: 1 }),
      () => store.listExtractions(),
      () => store.removeExtraction('e1'),
      () => store.clearExtractions(),
      () => store.upsertVerification({ id: 'v1', status: 'pass', at: 1 }),
      () => store.listVerifications(),
      () => store.removeVerification('v1'),
      () => store.clearVerifications(),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(/No verified principal/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('isolates all entry CRUD by tenant and user and preserves createdAt on upsert', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);

    const first = await scoped(alice, () => store.upsertEntry(entry()));
    await scoped(bob, () => store.upsertEntry(entry({ body: 'Engineer' })));
    const updated = await scoped(alice, () => store.upsertEntry(entry({
      name: 'Updated role',
      body: 'Product designer',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    })));

    expect(first.createdAt).toBe(1_700_000_000_000);
    expect(updated).toMatchObject({ name: 'Updated role', body: 'Product designer' });
    expect(updated.createdAt).toBe(first.createdAt);
    await expect(scoped(alice, () => store.listEntries())).resolves.toEqual([updated]);
    await expect(scoped(bob, () => store.readEntry('user_role'))).resolves.toMatchObject({ body: 'Engineer' });
    await expect(scoped(alice, () => store.deleteEntry('user_role'))).resolves.toBe(true);
    await expect(scoped(alice, () => store.readEntry('user_role'))).resolves.toBeNull();
    await expect(scoped(bob, () => store.readEntry('user_role'))).resolves.toMatchObject({ body: 'Engineer' });
    await expect(scoped(alice, () => store.deleteEntry('missing'))).resolves.toBe(false);
  });

  it('resolves omitted scope in the conflict statement for either writer order', async () => {
    for (const omittedFirst of [false, true]) {
      const fake = new FakePgQueryable();
      const store = new PostgresMemoryStore(fake);
      await scoped(alice, () => store.upsertEntry(entry({ projectId: 'p1' })));
      const omitted = () => scoped(alice, () => store.upsertEntry(
        entry({ body: 'omitted writer', projectId: null }), { preserveScope: true },
      ));
      const explicit = () => scoped(alice, () => store.upsertEntry(entry({ body: 'explicit writer', projectId: 'p2' })));
      if (omittedFirst) {
        expect((await omitted()).projectId).toBe('p1');
        expect((await explicit()).projectId).toBe('p2');
      } else {
        expect((await explicit()).projectId).toBe('p2');
        expect((await omitted()).projectId).toBe('p2');
      }
      await expect(scoped(alice, () => store.readEntry('user_role')))
        .resolves.toMatchObject({ projectId: 'p2' });
      expect(fake.calls.find((call) => call.text.includes('INSERT INTO memory_entries'))!.text)
        .toContain('CASE WHEN $11::boolean THEN memory_entries.project_id');
    }
  });

  it('atomically rejects conditional updates/deletes after a project-scope move', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);
    await scoped(alice, () => store.upsertEntry(entry({ projectId: 'p2', body: 'unchanged' })));
    await expect(scoped(alice, () => store.upsertEntry(
      entry({ projectId: null, body: 'must not change' }), { requireGlobalExisting: true },
    ))).rejects.toMatchObject({ name: 'ProjectMemoryScopeUnverifiedError' });
    await expect(scoped(alice, () => store.deleteEntry('user_role', { requireGlobal: true })))
      .rejects.toMatchObject({ name: 'ProjectMemoryScopeUnverifiedError' });
    await expect(scoped(alice, () => store.readEntry('user_role')))
      .resolves.toMatchObject({ projectId: 'p2', body: 'unchanged' });
    expect([...fake.calls].reverse().find((call) => call.text.includes('INSERT INTO memory_entries'))!.text)
      .toContain('WHERE NOT $12::boolean OR memory_entries.project_id IS NULL');
    expect(fake.calls.find((call) => call.text.includes('DELETE FROM memory_entries'))!.text)
      .toContain('NOT $4::boolean OR project_id IS NULL');
  });

  it('composes global plus the current project, moves scope on upsert, and deletes one project scope', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);

    await scoped(alice, () => store.upsertEntry(entry({ id: 'global_fact', projectId: null })));
    await scoped(alice, () => store.upsertEntry(entry({ id: 'p1_fact', projectId: 'p1' })));
    await scoped(alice, () => store.upsertEntry(entry({ id: 'p2_fact', projectId: 'p2' })));
    await scoped(bob, () => store.upsertEntry(entry({ id: 'bob_fact', projectId: 'p1' })));

    await expect(scoped(alice, () => store.readCompositionSnapshot())).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ id: 'global_fact', projectId: null })]),
    });
    expect((await scoped(alice, () => store.readCompositionSnapshot())).entries.map((item) => item.id))
      .toEqual(['global_fact']);
    expect((await scoped(alice, () => store.readCompositionSnapshot({ projectId: 'p1' }))).entries.map((item) => item.id).sort())
      .toEqual(['global_fact', 'p1_fact']);
    expect((await scoped(alice, () => store.readCompositionSnapshot({ projectId: 'p2' }))).entries.map((item) => item.id).sort())
      .toEqual(['global_fact', 'p2_fact']);

    await scoped(alice, () => store.upsertEntry(entry({ id: 'p1_fact', projectId: 'p2' })));
    expect((await scoped(alice, () => store.readCompositionSnapshot({ projectId: 'p1' }))).entries.map((item) => item.id))
      .toEqual(['global_fact']);
    await scoped(alice, () => store.writeIndex([
      '# Memory',
      '- [Global](global_fact.md)',
      '- [P1 moved](p1_fact.md) — exact link',
      '- [P2](p2_fact.md)',
      'Keep this prose mentioning p2_fact.md intact.',
    ].join('\n')));
    await scoped(bob, () => store.writeIndex('- [Bob](bob_fact.md)'));

    await expect(scoped(alice, () => store.deleteProjectEntriesAndIndexForCurrentPrincipal(['p1', 'p2'])))
      .resolves.toBe(2);
    expect((await scoped(alice, () => store.listEntries())).map((item) => item.id)).toEqual(['global_fact']);
    expect(await scoped(alice, () => store.readIndex())).toBe([
      '# Memory',
      '- [Global](global_fact.md)',
      'Keep this prose mentioning p2_fact.md intact.',
    ].join('\n'));
    expect((await scoped(bob, () => store.listEntries())).map((item) => item.id)).toEqual(['bob_fact']);
    expect(await scoped(bob, () => store.readIndex())).toBe('- [Bob](bob_fact.md)');
    await expect(scoped(alice, () => store.deleteProjectEntriesAndIndexForCurrentPrincipal(['missing'])))
      .resolves.toBe(0);
    expect(await scoped(alice, () => store.readIndex())).toContain('Global');
  });

  it('rejects malformed project scopes as MemoryInputError input failures', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);
    await expect(scoped(alice, () => store.upsertEntry(entry({ projectId: '' })))).rejects.toMatchObject({
      name: 'MemoryInputError',
    });
    await expect(scoped(alice, () => store.readCompositionSnapshot({ projectId: 'bad\nproject' }))).rejects.toMatchObject({
      name: 'MemoryInputError',
    });
  });

  it('updates index and config independently and keeps settings principal-scoped', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);

    await scoped(alice, () => store.writeIndex('# Alice'));
    await scoped(alice, () => store.writeConfig({ enabled: true, extraction: null }));
    await expect(scoped(alice, () => store.readIndex())).resolves.toBe('# Alice');
    await expect(scoped(alice, () => store.readConfig())).resolves.toEqual({ enabled: true, extraction: null });

    await scoped(alice, () => store.writeIndex('# Alice 2'));
    await expect(scoped(alice, () => store.readConfig())).resolves.toEqual({ enabled: true, extraction: null });
    await scoped(alice, () => store.writeConfig({ enabled: false }));
    await expect(scoped(alice, () => store.readIndex())).resolves.toBe('# Alice 2');
    await expect(scoped(bob, () => store.readIndex())).resolves.toBeNull();
    await expect(scoped(bob, () => store.readConfig())).resolves.toBeNull();
  });

  it('rejects invalid names, entry types, and sources at the application boundary', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);

    await expect(scoped(alice, () => store.upsertEntry(entry({ name: '' }))))
      .rejects.toThrow(/requires a name/);
    await expect(scoped(alice, () => store.upsertEntry(entry({ type: 'media' as never }))))
      .rejects.toThrow(/invalid memory type/);
    await expect(scoped(alice, () => store.upsertEntry(entry({ source: 'legacy' as never }))))
      .rejects.toThrow(/invalid memory source/);
    expect(fake.calls).toHaveLength(0);
  });

  it('serializes concurrent config patches inside the injected transaction', async () => {
    const fake = new FakePgQueryable();
    let tail = Promise.resolve();
    const runner: PgMemoryTransactionRunner = async (work) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await work(fake); } finally { release(); }
    };
    const store = new PostgresMemoryStore(fake, runner);
    await Promise.all([
      scoped(alice, () => store.patchConfig({ enabled: false }, { enabled: true, verifyEnabled: true })),
      scoped(alice, () => store.patchConfig({ verifyEnabled: false }, { enabled: true, verifyEnabled: true })),
    ]);
    await expect(scoped(alice, () => store.readConfig())).resolves.toMatchObject({
      enabled: false, verifyEnabled: false,
    });
    expect(fake.calls.filter((call) => call.text.includes('SELECT config') && call.text.includes('FOR UPDATE')))
      .toHaveLength(2);
  });

  it('uses a row-lock-ordered database timestamp for upsert updates', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);
    const first = await scoped(alice, () => store.upsertEntry(entry({ updatedAt: 9_999_999_999_999 })));
    const second = await scoped(alice, () => store.upsertEntry(entry({ body: 'new', updatedAt: 1 })));
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    const sql = fake.calls.find((call) => call.text.includes('INSERT INTO memory_entries'))?.text ?? '';
    expect(sql).toContain('clock_timestamp()');
    expect(sql).not.toContain('updated_at = EXCLUDED.updated_at');
  });

  it('always parameterizes principals and scopes every SQL statement by both keys', async () => {
    const fake = new FakePgQueryable();
    const store = new PostgresMemoryStore(fake);
    const principal = { tenantId: "tenant-'quoted", userId: 'user-$1' };

    await scoped(principal, () => store.upsertEntry(entry()));
    await scoped(principal, () => store.listEntries());
    await scoped(principal, () => store.readEntry('user_role'));
    await scoped(principal, () => store.deleteEntry('user_role'));
    await scoped(principal, () => store.writeIndex('# index'));
    await scoped(principal, () => store.readIndex());
    await scoped(principal, () => store.writeConfig({ enabled: true }));
    await scoped(principal, () => store.readConfig());

    expect(fake.calls).toHaveLength(8);
    for (const call of fake.calls) {
      expect(call.text).toContain('tenant_id');
      expect(call.text).toContain('user_id');
      expect(call.text).not.toContain(principal.tenantId);
      expect(call.text).not.toContain(principal.userId);
      expect(call.values.slice(0, 2)).toEqual([principal.tenantId, principal.userId]);
    }
  });
});
