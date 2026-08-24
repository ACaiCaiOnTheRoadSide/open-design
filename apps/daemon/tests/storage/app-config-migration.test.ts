import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePgMigrationsDirectory } from '../../src/storage/pg-migrations.js';

describe('PostgreSQL app config migration', () => {
  it('creates tenant-and-user scoped config storage', async () => {
    const sql = await readFile(path.join(resolvePgMigrationsDirectory(), '011_app_configs.sql'), 'utf8');
    expect(sql).toMatch(/tenant_id text NOT NULL[\s\S]*user_id text NOT NULL/);
    expect(sql).toContain('PRIMARY KEY (tenant_id, user_id)');
    expect(sql).toContain('config jsonb NOT NULL');
  });
});
