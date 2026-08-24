import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePgMigrationsDirectory } from '../../src/storage/pg-migrations.js';

describe('PostgreSQL Memory capability migration', () => {
  it('creates principal-scoped, page-indexed extraction and verification histories', async () => {
    const sql = await readFile(path.join(resolvePgMigrationsDirectory(), '008_memory_capabilities.sql'), 'utf8');
    for (const table of ['memory_extractions', 'memory_verifications']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(sql).toMatch(new RegExp(`${table} \\([\\s\\S]*tenant_id text NOT NULL[\\s\\S]*user_id text NOT NULL`));
    }
    expect(sql).toContain('memory_extractions_principal_page_idx');
    expect(sql).toContain('memory_verifications_principal_page_idx');
  });
});
