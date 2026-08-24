import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  deleteProject,
  getProject,
  insertProject,
  updateProject,
  openDatabase,
  setBusinessProjectFactsSink,
} from '../../src/db.js';
import { runWithRequestContext } from '../../src/request-context.js';
import { createBusinessFactsOutbox } from '../../src/storage/business-facts-outbox.js';
import type { BusinessFactsStore } from '../../src/storage/business-facts.js';

const roots: string[] = [];
afterEach(async () => {
  setBusinessProjectFactsSink(null);
  closeDatabase();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('project business fact persistence boundary', () => {
  it('guards every production project SQL insert behind db.insertProject', async () => {
    const src = path.resolve(import.meta.dirname, '../../src');
    const bypasses: string[] = [];
    const deleteBypasses: string[] = [];
    const updateBypasses: string[] = [];
    const producers: string[] = [];
    const legacyImporter = 'storage/legacy-metadata-import.ts';
    for (const file of await tsFiles(src)) {
      const source = await readFile(file, 'utf8');
      const relative = path.relative(src, file);
      const isAllowedPersistence = file.endsWith('/db.ts') || file.endsWith('/storage/business-facts.ts');
      // The one-shot legacy full-schema importer is an upgrade boundary, not a
      // production project writer. Keep that exception exact; all ordinary
      // producers must still pass through db.insertProject and its facts sink.
      const isLegacyImporter = relative === legacyImporter;
      if (!isAllowedPersistence && !isLegacyImporter && source.includes('INSERT INTO projects')) bypasses.push(relative);
      if (!isAllowedPersistence && !isLegacyImporter && source.includes('DELETE FROM projects')) deleteBypasses.push(relative);
      if (!isAllowedPersistence && !isLegacyImporter && /UPDATE\s+projects\s+SET/u.test(source)) updateBypasses.push(relative);
      if (!file.endsWith('/db.ts') && /(?:\.|\b)insertProject\s*\(/u.test(source)) {
        producers.push(path.relative(src, file));
      }
    }
    expect(bypasses).toEqual([]);
    expect(deleteBypasses).toEqual([]);
    // Snapshot linkage changes no projected fact column (name/updatedAt/counters).
    expect(updateBypasses).toEqual(['plugins/snapshots.ts']);
    expect(await readFile(path.join(src, 'plugins/snapshots.ts'), 'utf8'))
      .toMatch(/UPDATE\s+projects\s+SET\s+applied_plugin_snapshot_id/u);

    const importerSource = await readFile(path.join(src, legacyImporter), 'utf8');
    // Pin the allowlisted importer to its narrow upgrade contract: recognize a
    // historical full schema, merge once in one SQLite transaction, ignore
    // existing rows, and only backfill the two project fact-owner columns.
    expect(importerSource).toMatch(/const FINGERPRINT:[\s\S]*metadata_json[\s\S]*session_mode[\s\S]*events_json/u);
    expect(importerSource).toMatch(/external_metadata_imports[\s\S]*already-imported/u);
    expect(importerSource).toMatch(/BEGIN IMMEDIATE[\s\S]*INSERT OR IGNORE INTO[\s\S]*COMMIT/u);
    expect(importerSource).toMatch(/UPDATE projects SET\s+fact_tenant_id[\s\S]*fact_creator_id[\s\S]*WHERE id = \?/u);
    expect(importerSource).not.toMatch(/DELETE\s+FROM\s+projects/u);
    expect(producers.sort()).toEqual([
      'brands/index.ts',
      'collab/team-mirror-materializer.ts',
      'design-systems/server-services.ts',
      'import-export-routes.ts',
      'routes/library.ts',
      'routes/plugins/index.ts',
      'routes/project/index.ts',
      'server.ts',
    ]);
    const dbSource = await readFile(path.join(src, 'db.ts'), 'utf8');
    expect(dbSource).toMatch(/export function insertProject[\s\S]*businessProjectFactsSink\?\.projectCreated/);
    expect(dbSource).toMatch(/export function updateProject[\s\S]*businessProjectFactsSink\?\.projectUpdated/);
  });

  it('atomically enqueues all insertProject callers and fails closed without an owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-project-facts-'));
    roots.push(root);
    const db = openDatabase(root, { dataDir: root });
    const store = {
      enabled: true,
      async createProject() { throw new Error('pg unavailable'); },
      async updateProjectProjection() { throw new Error('pg unavailable'); },
    } as unknown as BusinessFactsStore;
    const outbox = createBusinessFactsOutbox(db, store, { intervalMs: 60_000 });
    setBusinessProjectFactsSink({
      projectCreated: (_db, project) => outbox.enqueueProjectCreate({
        id: String(project.id), name: String(project.name),
        createdAt: Number(project.createdAt), updatedAt: Number(project.updatedAt),
      }, project.factPrincipal),
      projectUpdated: (_db, project) => outbox.enqueueProjectUpdate({
        id: String(project.id), name: String(project.name),
        createdAt: Number(project.createdAt), updatedAt: Number(project.updatedAt),
      }),
      projectDeleted: (_db, project) => outbox.enqueueProjectDelete(
        String(project.id), Date.now(),
        project.factTenantId && project.factCreatorId
          ? { tenantId: project.factTenantId, userId: project.factCreatorId } : undefined,
      ),
      projectDiscarded: (_db, project) => outbox.enqueueProjectDiscard(
        String(project.id),
        project.factTenantId && project.factCreatorId
          ? { tenantId: project.factTenantId, userId: project.factCreatorId } : undefined,
      ),
    });

    const input = { id: 'p-http', name: 'HTTP', createdAt: 1, updatedAt: 1 };
    runWithRequestContext({ tenantId: 'tenant-a', userId: 'user-a' }, () => insertProject(db, input));
    const payload = db.prepare(`SELECT payload_json AS payloadJson FROM business_fact_outbox WHERE id = 'project:create:p-http'`)
      .get() as { payloadJson: string };
    expect(JSON.parse(payload.payloadJson).principal).toEqual({ tenantId: 'tenant-a', userId: 'user-a' });

    expect(() => insertProject(db, { id: 'p-ownerless', name: 'No owner', createdAt: 2, updatedAt: 2 }))
      .toThrow('verified principal');
    expect(getProject(db, 'p-ownerless')).toBeNull();

    insertProject(db, {
      id: 'p-background', name: 'Background', createdAt: 3, updatedAt: 3,
      factPrincipal: { tenantId: 'tenant-b', userId: 'user-b' },
    });
    const background = db.prepare(`SELECT payload_json AS payloadJson FROM business_fact_outbox WHERE id = 'project:create:p-background'`)
      .get() as { payloadJson: string };
    expect(JSON.parse(background.payloadJson).principal).toEqual({ tenantId: 'tenant-b', userId: 'user-b' });

    updateProject(db, 'p-background', { name: 'Updated', updatedAt: 4 });
    expect(db.prepare(`SELECT 1 FROM business_fact_outbox WHERE id = 'project:update:p-background'`).get())
      .toBeTruthy();
    deleteProject(db, 'p-background', { facts: 'delete' });
    const deletion = db.prepare(`SELECT payload_json AS payloadJson FROM business_fact_outbox WHERE id = 'project:delete:p-background'`)
      .get() as { payloadJson: string };
    expect(JSON.parse(deletion.payloadJson).principal).toEqual({ tenantId: 'tenant-b', userId: 'user-b' });
    outbox.stop();
  });
});
