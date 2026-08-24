import type { PgQueryable } from './pg.js';

export type PluginIntentDesiredState = 'installed' | 'absent';
export type RefetchablePluginSourceKind = 'github' | 'https';

export interface PluginInstallIntent {
  pluginId: string;
  desiredState: PluginIntentDesiredState;
  source: string | null;
  sourceKind: RefetchablePluginSourceKind | null;
  revision: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}

interface IntentRow {
  plugin_id: string;
  desired_state: PluginIntentDesiredState;
  source: string | null;
  source_kind: RefetchablePluginSourceKind | null;
  revision: string | number;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

function mapRow(row: IntentRow): PluginInstallIntent {
  return {
    pluginId: row.plugin_id,
    desiredState: row.desired_state,
    source: row.source,
    sourceKind: row.source_kind,
    revision: Number(row.revision),
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function classifyRefetchablePluginSource(source: string): RefetchablePluginSourceKind | null {
  if (source.startsWith('github:')) return 'github';
  if (/^https:\/\//i.test(source)) return 'https';
  return null;
}

export interface PluginInstallIntentStore {
  putInstalled(pluginId: string, source: string, sourceKind: RefetchablePluginSourceKind): Promise<PluginInstallIntent>;
  putAbsent(pluginId: string): Promise<PluginInstallIntent>;
  get(pluginId: string): Promise<PluginInstallIntent | null>;
  list(): Promise<PluginInstallIntent[]>;
  markAttempt(pluginId: string, revision: number): Promise<boolean>;
  markSuccess(pluginId: string, revision: number): Promise<boolean>;
  markError(pluginId: string, revision: number, error: string): Promise<boolean>;
}

export function createPluginInstallIntentStore(pg: PgQueryable): PluginInstallIntentStore {
  const returning = `plugin_id, desired_state, source, source_kind, revision,
    last_attempt_at, last_success_at, last_error_at, last_error, updated_at`;
  return {
    async putInstalled(pluginId, source, sourceKind) {
      const result = await pg.query<IntentRow>(`INSERT INTO plugin_install_intents
        (plugin_id, desired_state, source, source_kind)
        VALUES ($1, 'installed', $2, $3)
        ON CONFLICT (plugin_id) DO UPDATE SET
          desired_state = 'installed', source = EXCLUDED.source, source_kind = EXCLUDED.source_kind,
          revision = plugin_install_intents.revision + 1, last_error_at = NULL, last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        RETURNING ${returning}`, [pluginId, source, sourceKind]);
      return mapRow(result.rows[0]!);
    },
    async putAbsent(pluginId) {
      const result = await pg.query<IntentRow>(`INSERT INTO plugin_install_intents
        (plugin_id, desired_state, source, source_kind)
        VALUES ($1, 'absent', NULL, NULL)
        ON CONFLICT (plugin_id) DO UPDATE SET
          desired_state = 'absent', source = NULL, source_kind = NULL,
          revision = plugin_install_intents.revision + 1, last_error_at = NULL, last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        RETURNING ${returning}`, [pluginId]);
      return mapRow(result.rows[0]!);
    },
    async get(pluginId) {
      const result = await pg.query<IntentRow>(
        `SELECT ${returning} FROM plugin_install_intents WHERE plugin_id = $1`, [pluginId],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },
    async list() {
      const result = await pg.query<IntentRow>(
        `SELECT ${returning} FROM plugin_install_intents ORDER BY plugin_id`,
      );
      return result.rows.map(mapRow);
    },
    async markAttempt(pluginId, revision) {
      const result = await pg.query(`UPDATE plugin_install_intents SET
        last_attempt_at = CURRENT_TIMESTAMP, last_error_at = NULL, last_error = NULL
        WHERE plugin_id = $1 AND revision = $2`, [pluginId, revision]);
      return (result.rowCount ?? 0) > 0;
    },
    async markSuccess(pluginId, revision) {
      const result = await pg.query(`UPDATE plugin_install_intents SET
        last_success_at = CURRENT_TIMESTAMP, last_error_at = NULL, last_error = NULL
        WHERE plugin_id = $1 AND revision = $2`, [pluginId, revision]);
      return (result.rowCount ?? 0) > 0;
    },
    async markError(pluginId, revision, error) {
      const result = await pg.query(`UPDATE plugin_install_intents SET
        last_error_at = CURRENT_TIMESTAMP, last_error = $3
        WHERE plugin_id = $1 AND revision = $2`, [pluginId, revision, error.slice(0, 4000)]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

