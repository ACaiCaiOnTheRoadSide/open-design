import type { PoolClient, QueryResultRow } from 'pg';
import { applyTelemetryDefaults, mergeAppConfig, normalizeAppConfigForRead, type AppConfigPrefs } from '../app-config.js';
import { requireRequestContext } from '../request-context.js';
import { query as pgQuery, transaction as pgTransaction, type PgQueryable } from './pg.js';

interface AppConfigRow extends QueryResultRow { config: Record<string, unknown> | string }
type TransactionRunner = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
const defaultQueryable: PgQueryable = { query: (text, values) => pgQuery(text, values ? [...values] : undefined) };

function parseConfig(raw?: AppConfigRow['config']): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export interface AppConfigStore {
  read(): Promise<AppConfigPrefs>;
  write(partial: Record<string, unknown>): Promise<AppConfigPrefs>;
}

export function createPostgresAppConfigStore(
  queryable: PgQueryable = defaultQueryable,
  runTransaction: TransactionRunner = (work) => pgTransaction(work),
): AppConfigStore {
  return {
    async read() {
      const owner = requireRequestContext();
      const result = await queryable.query<AppConfigRow>(
        'SELECT config FROM app_configs WHERE tenant_id = $1 AND user_id = $2',
        [owner.tenantId, owner.userId],
      );
      return normalizeAppConfigForRead(parseConfig(result.rows[0]?.config));
    },
    async write(partial) {
      const owner = requireRequestContext();
      return runTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`app-config:${owner.tenantId}:${owner.userId}`]);
        const current = await client.query<AppConfigRow>(
          'SELECT config FROM app_configs WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
          [owner.tenantId, owner.userId],
        );
        const existing = normalizeAppConfigForRead(parseConfig(current.rows[0]?.config));
        const next = applyTelemetryDefaults(mergeAppConfig(existing, partial));
        await client.query(
          'INSERT INTO app_configs (tenant_id, user_id, config) VALUES ($1, $2, $3::jsonb) '
          + 'ON CONFLICT (tenant_id, user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP',
          [owner.tenantId, owner.userId, JSON.stringify(next)],
        );
        return next;
      });
    },
  };
}
