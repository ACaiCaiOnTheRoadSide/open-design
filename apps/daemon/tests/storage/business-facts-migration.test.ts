import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePgMigrationsDirectory } from '../../src/storage/pg-migrations.js';

describe('business facts PostgreSQL migration contract', () => {
  it('defines every non-media backend fact table with Unix-millisecond columns and idempotency keys', async () => {
    const sql = await readFile(path.join(resolvePgMigrationsDirectory(), '004_business_facts.sql'), 'utf8');
    for (const table of ['projects', 'deleted_projects', 'conversations', 'messages', 'message_token_usage']) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    }
    expect(sql).toContain('event_key text PRIMARY KEY');
    expect(sql).toContain('created_at bigint NOT NULL');
    expect(sql).toContain('idx_messages_conversation_updated');
    expect(sql).toContain('ALTER TABLE message_token_usage ADD COLUMN IF NOT EXISTS event_key text');
    expect(sql).toContain('ALTER TABLE message_token_usage ADD COLUMN IF NOT EXISTS total_tokens bigint');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_message_token_usage_event_key');
    expect(sql).not.toContain('media_usage');
    expect(sql).not.toContain('monkeycode_count');
  });

  it('adds project dimensions and optional cost/duration without rewriting old rows', async () => {
    const sql = await readFile(path.join(resolvePgMigrationsDirectory(), '009_business_fact_dimensions.sql'), 'utf8');
    expect(sql).toContain('projects ADD COLUMN IF NOT EXISTS skill_id');
    expect(sql).toContain('projects ADD COLUMN IF NOT EXISTS design_system_id');
    expect(sql).toContain('message_token_usage ADD COLUMN IF NOT EXISTS cost_usd');
    expect(sql).toContain('message_token_usage ADD COLUMN IF NOT EXISTS duration_ms');
    expect(sql).not.toMatch(/UPDATE message_token_usage/);
    expect(sql).not.toContain('media_usage');
    expect(sql).not.toContain('monkeycode');
  });

  it('supplies timestamps required by legacy conversations tables', async () => {
    const sql = await readFile(
      path.join(resolvePgMigrationsDirectory(), '012_legacy_conversation_timestamps.sql'),
      'utf8',
    );
    expect(sql).toContain("table_name = 'conversations'");
    expect(sql).toContain("column_name = 'created_at'");
    expect(sql).toContain('ALTER COLUMN created_at SET DEFAULT');
    expect(sql).toContain("column_name = 'updated_at'");
    expect(sql).toContain('ALTER COLUMN updated_at SET DEFAULT');
    expect(sql).toContain('EXTRACT(EPOCH FROM clock_timestamp()) * 1000');
  });
});
