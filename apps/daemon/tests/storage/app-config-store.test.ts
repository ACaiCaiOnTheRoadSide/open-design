import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient, QueryResult } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../../src/app-config.js';
import { runWithRequestContext } from '../../src/request-context.js';
import { createPostgresAppConfigStore } from '../../src/storage/postgres-app-config-store.js';
import type { PgQueryable } from '../../src/storage/pg.js';

const result = (rows: any[] = []): QueryResult<any> => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] });
function fakeStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const query = async (text: string, values: readonly unknown[] = []) => {
    const key = `${values[0]}:${values[1]}`;
    if (text.startsWith('SELECT config')) return result(rows.has(key) ? [{ config: rows.get(key) }] : []);
    if (text.startsWith('INSERT INTO app_configs')) rows.set(key, JSON.parse(String(values[2])));
    return result();
  };
  return createPostgresAppConfigStore({ query } as PgQueryable, async (work) => work({ query } as unknown as PoolClient));
}

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('app config persistence modes', () => {
  it('isolates hosted config by verified tenant and user and preserves merging/installationId', async () => {
    const store = fakeStore();
    const alice = { tenantId: 'tenant', userId: 'alice' };
    const bob = { tenantId: 'tenant', userId: 'bob' };
    await runWithRequestContext(alice, () => store.write({ installationId: 'alice-id', customInstructions: 'alice' }));
    await runWithRequestContext(bob, () => store.write({ installationId: 'bob-id', customInstructions: 'bob' }));
    await runWithRequestContext(alice, () => store.write({ agentId: 'claude' }));
    expect(await runWithRequestContext(alice, () => store.read())).toMatchObject({ installationId: 'alice-id', customInstructions: 'alice', agentId: 'claude' });
    expect(await runWithRequestContext(bob, () => store.read())).toMatchObject({ installationId: 'bob-id', customInstructions: 'bob' });
  });

  it('rejects hosted access without VerifiedPrincipal ALS', async () => {
    const store = fakeStore();
    await expect(store.read()).rejects.toThrow('Missing principal');
    await expect(store.write({ agentId: 'claude' })).rejects.toThrow('Missing principal');
  });

  it('keeps local file persistence compatible', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'od-app-config-'));
    dirs.push(dir);
    await writeAppConfig(dir, { installationId: 'local-id', customInstructions: 'local' });
    await writeAppConfig(dir, { agentId: 'claude' });
    expect(await readAppConfig(dir)).toMatchObject({ installationId: 'local-id', customInstructions: 'local', agentId: 'claude' });
    expect(JSON.parse(await readFile(path.join(dir, 'app-config.json'), 'utf8'))).toMatchObject({ installationId: 'local-id' });
  });
});
