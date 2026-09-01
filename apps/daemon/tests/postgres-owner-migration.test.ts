import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { runPgMigrations } from '../src/storage/pg-migrations.js';
import { createResourceOwnerRegistry } from '../src/storage/resource-owner-registry.js';
import type { PgPoolLike } from '../src/storage/pg.js';

const url = process.env.OD_TEST_POSTGRES_URL;
const schema = `od_owner_test_${process.pid}_${Date.now()}`;
let client: Client | null = null;
const packagedMigrations = [
  '001_core_memory.sql',
  '002_project_memory_scope.sql',
  '003_plugin_install_intents.sql',
  '004_business_facts.sql',
  '005_run_queue.sql',
  '006_brand_design_system_registry.sql',
  '007_library_plugin_registry.sql',
  '008_memory_capabilities.sql',
  '009_business_fact_dimensions.sql',
] as const;

describe.skipIf(!url)('real PostgreSQL owner migration', () => {
  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it('applies packaged migrations 001-009 in order and keeps schema plus ledger atomic', async () => {
    const atomicSchema = `${schema}_atomic`;
    const directory = await mkdtemp(path.join(tmpdir(), 'od-real-pg-atomic-'));
    const admin = new Client({ connectionString: url });
    const pool = new Pool({ connectionString: url, options: `-c search_path=${atomicSchema}` });
    let adminConnected = false;
    try {
      await admin.connect();
      adminConnected = true;
      await admin.query(`CREATE SCHEMA "${atomicSchema}"`);
      for (const filename of packagedMigrations) {
        const sql = await readFile(path.resolve(import.meta.dirname, '../migrations/postgres', filename), 'utf8');
        await writeFile(path.join(directory, filename), sql);
      }
      await writeFile(path.join(directory, '010_forced_failure.sql'), 'CREATE TABLE migration_failure_probe(id text); SELECT 1/0;');

      await expect(runPgMigrations({ pool, directory, schema: atomicSchema }))
        .rejects.toMatchObject({ code: '22012' });
      const rolledBack = await admin.query(
        'SELECT to_regclass($1) AS memory, to_regclass($2) AS owners, to_regclass($3) AS ledger, to_regclass($4) AS probe',
        [
          `${atomicSchema}.memory_entries`,
          `${atomicSchema}.saas_resource_owners`,
          `${atomicSchema}.schema_migrations`,
          `${atomicSchema}.migration_failure_probe`,
        ],
      );
      expect(rolledBack.rows[0]).toEqual({ memory: null, owners: null, ledger: null, probe: null });

      await rm(path.join(directory, '010_forced_failure.sql'));
      await expect(runPgMigrations({ pool, directory, schema: atomicSchema }))
        .resolves.toEqual(packagedMigrations);
      const marker = await admin.query(
        `SELECT filename FROM "${atomicSchema}".schema_migrations ORDER BY filename`,
      );
      expect(marker.rows.map((row) => row.filename)).toEqual(packagedMigrations);
      const committed = await admin.query(
        'SELECT to_regclass($1) AS memory, to_regclass($2) AS owners',
        [`${atomicSchema}.memory_entries`, `${atomicSchema}.saas_resource_owners`],
      );
      expect(committed.rows[0]).toEqual({
        memory: `${atomicSchema}.memory_entries`,
        owners: `${atomicSchema}.saas_resource_owners`,
      });
    } finally {
      await pool.end();
      if (adminConnected) {
        await admin.query(`DROP SCHEMA IF EXISTS "${atomicSchema}" CASCADE`);
        await admin.end();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers only synthetic project owners with one durable usage principal', async () => {
    const recoverySchema = `${schema}_recovery`;
    const recovery = new Client({ connectionString: url });
    let recoveryConnected = false;
    try {
      await recovery.connect();
      recoveryConnected = true;
      await recovery.query(`CREATE SCHEMA "${recoverySchema}"`);
      await recovery.query(`SET search_path TO "${recoverySchema}"`);
      for (const filename of ['004_business_facts.sql', '017_recover_legacy_project_owners.sql']) {
        if (filename.startsWith('017')) {
          await recovery.query(`INSERT INTO projects (id,name,tenant_id,creator_id,created_at,updated_at) VALUES
            ('unique','Unique','__legacy__','__legacy__',1,1),
            ('ambiguous','Ambiguous','__legacy__','__legacy__',1,1),
            ('owned','Owned','tenant-real','user-real',1,1),
            ('synthetic','Synthetic','tenant-synthetic','tenant-synthetic',1,1)`);
          await recovery.query(`INSERT INTO conversations (id,project_id) VALUES
            ('c1','unique'), ('c2','ambiguous'), ('c3','owned'), ('c4','synthetic')`);
          await recovery.query(`INSERT INTO messages (id,conversation_id,created_at,updated_at) VALUES
            ('m1','c1',1,1), ('m2','c2',1,1), ('m3','c2',1,1), ('m4','c3',1,1), ('m5','c4',1,1)`);
          await recovery.query(`INSERT INTO message_token_usage
            (event_key,user_id,tenant_id,project_id,conversation_id,message_id,model,created_at) VALUES
            ('u1','user-a','tenant-a','unique','c1','m1','test',1),
            ('a1','user-a','tenant-a','ambiguous','c2','m2','test',1),
            ('a2','user-b','tenant-a','ambiguous','c2','m3','test',1),
            ('o1','other-user','other-tenant','owned','c3','m4','test',1),
            ('s1','user-s','tenant-synthetic','synthetic','c4','m5','test',1)`);
        }
        const sql = await readFile(path.resolve(import.meta.dirname, '../migrations/postgres', filename), 'utf8');
        await recovery.query(sql);
      }
      const result = await recovery.query('SELECT id, tenant_id, creator_id FROM projects ORDER BY id');
      expect(result.rows).toEqual([
        { id: 'ambiguous', tenant_id: '__legacy__', creator_id: '__legacy__' },
        { id: 'owned', tenant_id: 'tenant-real', creator_id: 'user-real' },
        { id: 'synthetic', tenant_id: 'tenant-synthetic', creator_id: 'user-s' },
        { id: 'unique', tenant_id: 'tenant-a', creator_id: 'user-a' },
      ]);
    } finally {
      if (recoveryConnected) {
        await recovery.query(`DROP SCHEMA IF EXISTS "${recoverySchema}" CASCADE`);
        await recovery.end();
      }
    }
  });

  it('applies 007 and enforces tenant-scoped identity plus backend uniqueness', async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const sql = await readFile(path.resolve(import.meta.dirname, '../migrations/postgres/007_library_plugin_registry.sql'), 'utf8');
    await client.query(sql);
    await client.query(`INSERT INTO saas_resource_owners
      (resource_kind,resource_id,tenant_id,creator_id,management_domain,created_at,updated_at)
      VALUES ('plugin','same-slug','tenant-a','a','user',1,1),
             ('plugin','same-slug','tenant-b','b','user',1,1)`);
    const rows = await client.query(`SELECT tenant_id FROM saas_resource_owners WHERE resource_id='same-slug' ORDER BY tenant_id`);
    expect(rows.rows.map((row) => row.tenant_id)).toEqual(['tenant-a', 'tenant-b']);
    await client.query(`INSERT INTO saas_resource_owners
      (resource_kind,resource_id,tenant_id,creator_id,management_domain,created_at,updated_at)
      VALUES ('plugin','global','__backend__','__backend__','backend',1,1)`);
    await expect(client.query(`INSERT INTO saas_resource_owners
      (resource_kind,resource_id,tenant_id,creator_id,management_domain,created_at,updated_at)
      VALUES ('plugin','global','other-backend','__backend__','backend',1,1)`)).rejects.toMatchObject({ code: '23505' });
  });

  it('serializes a final-owner release callback against a concurrent owner claim', async () => {
    const lockSchema = `${schema}_lock`;
    const admin = new Client({ connectionString: url });
    const pool = new Pool({ connectionString: url, options: `-c search_path=${lockSchema}` });
    try {
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${lockSchema}"`);
      const sql = await readFile(path.resolve(import.meta.dirname, '../migrations/postgres/007_library_plugin_registry.sql'), 'utf8');
      await admin.query(`SET search_path TO "${lockSchema}"`);
      await admin.query(sql);
      const registry = createResourceOwnerRegistry(pool as unknown as PgPoolLike);
      await registry.registerUser(
        { kind: 'library_asset', id: 'shared-asset' },
        { tenantId: 'tenant-a', userId: 'alice' },
      );

      let enterDelete!: () => void;
      const deleteStarted = new Promise<void>((resolve) => { enterDelete = resolve; });
      let finishDelete!: () => void;
      const deleteBarrier = new Promise<void>((resolve) => { finishDelete = resolve; });
      const finalRelease = registry.release(
        'library_asset',
        'shared-asset',
        { tenantId: 'tenant-a', userId: 'alice' },
        async () => {
          enterDelete();
          await deleteBarrier;
        },
      );
      await deleteStarted;

      let claimFinished = false;
      const concurrentClaim = registry.registerUser(
        { kind: 'library_asset', id: 'shared-asset' },
        { tenantId: 'tenant-b', userId: 'bob' },
      ).then(() => { claimFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(claimFinished).toBe(false);

      finishDelete();
      await expect(finalRelease).resolves.toEqual({ deleted: true, hasActiveOwners: false });
      await concurrentClaim;
      await expect(registry.isVisible(
        'library_asset',
        'shared-asset',
        { tenantId: 'tenant-b', userId: 'bob' },
      )).resolves.toBe(true);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${lockSchema}" CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
