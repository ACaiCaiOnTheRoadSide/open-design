import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  businessToolCallEventKey,
  businessUsageEventKey,
  createBusinessFactsStore,
  type UsageFact,
} from '../../src/storage/business-facts.js';

function result<R extends QueryResultRow>(rows: R[] = [], rowCount = rows.length): QueryResult<R> {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

describe('BusinessFactsStore', () => {
  it('is a true no-op in SQLite mode and does not request a principal', async () => {
    const store = createBusinessFactsStore({
      enabled: false,
      principal: () => { throw new Error('must not run'); },
    });
    await store.createProject({ id: 'p', name: 'P', createdAt: 1, updatedAt: 1 }, 'c');
    await store.upsertMessage({
      id: 'm', conversationId: 'c', projectId: 'p', runStatus: 'running', createdAt: 1, updatedAt: 1,
    });
    expect(store.enabled).toBe(false);
  });

  it('fails closed before any PG write when no verified principal exists', async () => {
    let writes = 0;
    const store = createBusinessFactsStore({
      enabled: true,
      query: async () => { writes += 1; return result(); },
      principal: () => { throw new Error('Missing principal'); },
    });
    await expect(store.upsertProject({ id: 'p', name: 'P', createdAt: 1, updatedAt: 1 }))
      .rejects.toThrow('Missing principal');
    expect(writes).toBe(0);
  });

  it('moves a project to a tombstone in one transaction and preserves counters', async () => {
    const sql: string[] = [];
    const store = createBusinessFactsStore({
      enabled: true,
      principal: () => ({ tenantId: 't1', userId: 'u1' }),
      transaction: async (work) => work({
        query: async <R extends QueryResultRow>(text: string) => {
          sql.push(text);
          if (text.startsWith('SELECT tenant_id')) {
            return result([{ tenant_id: 't1', creator_id: 'u1' }] as unknown as R[]);
          }
          return result<R>();
        },
      }),
    });
    await store.deleteProject('p1', 99);
    expect(sql.join('\n')).toContain('download_count, published_count');
    expect(sql).toEqual(expect.arrayContaining([
      expect.stringContaining('DELETE FROM message_token_usage'),
      expect.stringContaining('DELETE FROM messages'),
      expect.stringContaining('DELETE FROM conversations'),
    ]));
    expect(sql.at(-1)).toContain('DELETE FROM projects');
  });

  it('rejects a colliding project id owned by another tenant', async () => {
    const store = createBusinessFactsStore({
      enabled: true,
      principal: () => ({ tenantId: 'tenant-a', userId: 'user-a' }),
      query: async () => result([], 0),
    });
    await expect(store.upsertProject({ id: 'shared-id', name: 'P', createdAt: 1, updatedAt: 2 }))
      .rejects.toThrow('identity conflict');
  });

  it('uses one stable message usage key and merges richer retries', async () => {
    const usage: UsageFact = {
      model: 'm', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3,
      costUsd: 0.25, durationMs: 1200, createdAt: 50,
    };
    expect(businessUsageEventKey('msg', usage)).toBe(businessUsageEventKey('msg', { ...usage, inputTokens: 99 }));
    const sql: string[] = [];
    const values: unknown[][] = [];
    const store = createBusinessFactsStore({
      enabled: true,
      principal: () => ({ tenantId: 't', userId: 'u' }),
      transaction: async (work) => work({
        query: async <R extends QueryResultRow>(text: string, params?: readonly unknown[]) => {
          sql.push(text);
          values.push([...(params ?? [])]);
          return result<R>();
        },
      }),
    });
    await store.upsertMessage({
      id: 'msg', conversationId: 'c', projectId: 'p', runStatus: 'succeeded', createdAt: 1, updatedAt: 2,
    }, usage);
    expect(sql.at(-1)).toContain('ON CONFLICT (event_key) DO UPDATE');
    expect(sql.at(-1)).toContain('GREATEST(message_token_usage.input_tokens');
    expect(sql.at(-1)).toContain('cost_usd = COALESCE(EXCLUDED.cost_usd');
    expect(values.at(-1)?.slice(13, 15)).toEqual([0.25, 1200]);
  });

  it('persists tool metadata with a hashed stable key', async () => {
    const sql: string[] = [];
    const values: unknown[][] = [];
    const store = createBusinessFactsStore({
      enabled: true,
      principal: () => ({ tenantId: 't', userId: 'u' }),
      transaction: async (work) => work({
        query: async <R extends QueryResultRow>(text: string, params?: readonly unknown[]) => {
          sql.push(text);
          values.push([...(params ?? [])]);
          return result<R>();
        },
      }),
    });
    const eventKey = businessToolCallEventKey('run-1', 'provider-call-id');
    expect(eventKey).toBe(businessToolCallEventKey('run-1', 'provider-call-id'));
    expect(eventKey).not.toContain('provider-call-id');
    await store.upsertMessage({
      id: 'msg', conversationId: 'c', projectId: 'p', runStatus: 'succeeded', createdAt: 1, updatedAt: 2,
    }, undefined, [{
      eventKey, runId: 'run-1', name: 'image_generate', result: 'success',
      startedAt: 10, completedAt: 40,
    }]);
    expect(sql.at(-1)).toContain('INSERT INTO tool_call_facts');
    expect(values.at(-1)?.slice(0, 3)).toEqual([eventKey, 'run-1', 'u']);
    expect(values.at(-1)?.at(11)).toBe(30);
  });

  it('increments a project outcome only when its event key is first inserted', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = createBusinessFactsStore({
      enabled: true,
      principal: () => ({ tenantId: 'tenant-a', userId: 'user-a' }),
      query: async (text, values) => {
        calls.push({ text, ...(values ? { values } : {}) });
        return result([], 1);
      },
    });
    await store.recordProjectEvent('p1', 'publish', 'event-1');
    expect(calls[0]?.text).toContain('published_count = published_count + 1');
    expect(calls[0]?.values?.at(-1)).toBe('tenant-a');
  });

  it('inserts an agent run result with a stable idempotency key', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = createBusinessFactsStore({
      enabled: true,
      query: async (text, values) => {
        calls.push({ text, ...(values ? { values } : {}) });
        return result([], 1);
      },
    });
    const fact = {
      eventKey: 'agent-run:run-1:2', runId: 'run-1', attempt: 2,
      accessMode: 'online' as const, feature: 'agent.run' as const,
      result: 'success' as const, completedAt: 123,
    };
    await store.recordAgentRunResult(fact, { tenantId: 'tenant-a', userId: 'user-a' });
    expect(calls[0]?.text).toContain('ON CONFLICT (event_key) DO NOTHING');
    expect(calls[0]?.values).toEqual([
      'agent-run:run-1:2', 'run-1', 2, 'user-a', 'tenant-a',
      'online', 'agent.run', 'success', 123,
    ]);
  });
});
