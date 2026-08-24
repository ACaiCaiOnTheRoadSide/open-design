import path from 'node:path';
import type Database from 'better-sqlite3';
import type { QueryResult, QueryResultRow } from 'pg';
import { quotePgIdentifier } from './pg-migrations.js';

export interface LegacyMetadataPgSource {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface LegacyMetadataImportOptions {
  sqlite: Database.Database;
  pg: LegacyMetadataPgSource;
  schema?: string;
  pageSize?: number;
  /** Absolute PVC roots. Local/upload rows outside these roots are quarantined. */
  pvcRoots?: readonly string[];
}

export interface LegacyMetadataImportResult {
  status: 'imported' | 'already-imported' | 'not-legacy-full-schema';
  importedRows: number;
  discardedRows?: Readonly<Record<string, number>>;
  retainedRows?: Readonly<Record<string, number>>;
  quarantinedRows?: number;
}

type Row = Record<string, unknown>;
export type LegacyMetadataParent = { column: string; table: string; targetColumn: string; nullable?: boolean };
export type LegacyMetadataTableSpec = { name: string; columns: readonly string[]; key: readonly string[]; parents?: readonly LegacyMetadataParent[] };
type Parent = LegacyMetadataParent;
type TableSpec = LegacyMetadataTableSpec;
type OwnerKind = 'library_asset' | 'library_task' | 'library_token' | 'library_embedding'
  | 'plugin' | 'plugin_marketplace' | 'plugin_snapshot';

const IMPORT_VERSION = 2;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUARANTINE_TENANT = '__legacy_quarantine__';
const FINGERPRINT: Record<string, readonly string[]> = {
  projects: ['metadata_json'], conversations: ['title', 'session_mode'], messages: ['role', 'content', 'position', 'events_json'],
};
const p = (column: string, table: string, targetColumn = 'id', nullable = false): Parent => ({ column, table, targetColumn, nullable });
const table = (name: string, key: readonly string[], columns: string, parents?: readonly Parent[]): TableSpec =>
  parents === undefined
    ? { name, key, columns: columns.split(/\s+/) }
    : { name, key, columns: columns.split(/\s+/), parents };

// Closed, versioned preservation manifest. Every source column is explicitly named;
// schema inspection only intersects this allow-list with historical release drift.
export const LEGACY_METADATA_TABLES_V2: readonly TableSpec[] = [
  table('projects', ['id'], 'id name skill_id design_system_id pending_prompt metadata_json custom_instructions created_at updated_at'),
  table('conversations', ['id'], 'id project_id title session_mode intent_signals_json created_at updated_at', [p('project_id', 'projects')]),
  table('messages', ['id'], 'id conversation_id role content agent_id agent_name run_id run_status result_delivery_state last_run_event_id events_json attachments_json comment_attachments_json produced_files_json trace_object_files_json feedback_json pre_turn_file_names_json session_mode run_context_json task_analytics_json applied_plugin_snapshot_json telemetry_finalized_at started_at ended_at position created_at', [p('conversation_id', 'conversations')]),
  table('agent_sessions', ['conversation_id', 'agent_id'], 'conversation_id agent_id session_id stable_prompt_hash stable_prompt_sections model cwd last_message_id updated_at', [p('conversation_id', 'conversations')]),
  table('tabs', ['project_id', 'name'], 'project_id name position is_active', [p('project_id', 'projects')]),
  table('tabs_state', ['project_id'], 'project_id updated_at state_json', [p('project_id', 'projects')]),
  table('preview_comments', ['id'], 'id project_id conversation_id file_path element_id selector label text position_json html_hint selection_kind member_count pod_members_json style_json attachments_json slide_index slide_key note status created_at updated_at anchor_state anchored_version author_member_id last_good_position_json pin_seq pin_seq_confirmed sort_key', [p('project_id', 'projects'), p('conversation_id', 'conversations')]),
  table('templates', ['id'], 'id name description source_project_id files_json created_at', [p('source_project_id', 'projects', 'id', true)]),
  table('deployments', ['id'], 'id project_id file_name provider_id url deployment_id deployment_count target status status_message reachable_at provider_metadata_json created_at updated_at', [p('project_id', 'projects')]),
  table('routines', ['id'], 'id name prompt schedule_kind schedule_value schedule_json project_mode project_id skill_id agent_id context_json enabled created_at updated_at', [p('project_id', 'projects', 'id', true)]),
  table('routine_runs', ['id'], 'id routine_id trigger status project_id conversation_id agent_run_id started_at completed_at summary error error_code', [p('routine_id', 'routines'), p('project_id', 'projects'), p('conversation_id', 'conversations')]),
  table('routine_schedule_claims', ['routine_id', 'slot_at'], 'routine_id slot_at claimed_at', [p('routine_id', 'routines')]),
  table('critique_runs', ['id'], 'id project_id conversation_id artifact_path status score rounds_json transcript_path protocol_version created_at updated_at', [p('project_id', 'projects'), p('conversation_id', 'conversations', 'id', true)]),
  table('installed_plugins', ['id'], 'id public_id title version source_kind source pinned_ref source_digest source_marketplace_id source_marketplace_entry_name source_marketplace_entry_version marketplace_trust resolved_source resolved_ref manifest_digest archive_integrity trust capabilities_granted manifest_json fs_path installed_at updated_at enabled bundled_content_digest'),
  table('plugin_marketplaces', ['id'], 'id url spec_version version trust manifest_json added_at refreshed_at'),
  table('applied_plugin_snapshots', ['id'], 'id project_id conversation_id run_id plugin_id plugin_spec_version plugin_version manifest_source_digest source_marketplace_id source_marketplace_entry_name source_marketplace_entry_version marketplace_trust resolved_source resolved_ref archive_integrity pinned_ref task_kind inputs_json resolved_context_json craft_requires_json pipeline_json genui_surfaces_json capabilities_granted capabilities_required assets_staged_json connectors_required_json connectors_resolved_json mcp_servers_json plugin_title plugin_description query_text status applied_at expires_at', [p('project_id', 'projects'), p('conversation_id', 'conversations', 'id', true)]),
  table('run_devloop_iterations', ['id'], 'id run_id stage_id iteration artifact_diff_summary critique_summary tokens_used ended_at'),
  table('genui_surfaces', ['id'], 'id project_id conversation_id run_id plugin_snapshot_id surface_id kind persist schema_digest value_json status responded_by requested_at responded_at expires_at', [p('project_id', 'projects'), p('conversation_id', 'conversations', 'id', true), p('plugin_snapshot_id', 'applied_plugin_snapshots')]),
  table('skill_plugin_candidates', ['id'], 'id project_id run_id conversation_id assistant_message_id fingerprint status title description confidence source_refs_json provenance_json draft_path created_at updated_at dismissed_at', [p('project_id', 'projects'), p('conversation_id', 'conversations', 'id', true), p('assistant_message_id', 'messages', 'id', true)]),
  table('registry_entries', ['backend_id', 'name'], 'backend_id name version entry_json updated_at'),
  table('library_assets', ['id'], 'id kind storage source_url source_title source_domain captured_at archived_date file_path origin_project_id rel_path mime width height size content_hash caption ocr_text palette_json tags_json metadata_json created_at updated_at', [p('origin_project_id', 'projects', 'id', true)]),
  table('library_asset_sources', ['id'], 'id asset_id source_kind project_id conversation_id run_id design_system_id rel_path created_at', [p('asset_id', 'library_assets'), p('project_id', 'projects', 'id', true), p('conversation_id', 'conversations', 'id', true)]),
  table('library_embeddings', ['asset_id'], 'asset_id model dim vector indexed_text created_at', [p('asset_id', 'library_assets')]),
  table('library_tasks', ['id'], 'id asset_id status progress_json error_json started_at ended_at', [p('asset_id', 'library_assets')]),
  table('library_tokens', ['token_hash'], 'token_hash label extension_origin created_at last_used_at'),
];

/** Rebuildable/operational or already-authoritative PG facts, never silently dropped. */
export const LEGACY_DISPOSITION_V2 = Object.freeze({
  library_digests: 'discard:rebuildable-cache',
  task_queue: 'retain-in-postgres:operational-queue-not-valid-after-upgrade',
  message_token_usage: 'retain-in-postgres:business-fact',
  deleted_projects: 'retain-in-postgres:business-fact-tombstone',
  media_tasks: 'exclude:media-domain',
  media_usage: 'exclude:media-domain',
} as const);
const OWNER_TABLES: Record<string, { kind: OwnerKind; id: string; project?: string; path?: string; source?: string; created: string; updated: string }> = {
  library_assets: { kind: 'library_asset', id: 'id', project: 'origin_project_id', path: 'file_path', source: 'storage', created: 'created_at', updated: 'updated_at' },
  library_tasks: { kind: 'library_task', id: 'id', created: 'started_at', updated: 'ended_at' },
  library_tokens: { kind: 'library_token', id: 'token_hash', created: 'created_at', updated: 'last_used_at' },
  library_embeddings: { kind: 'library_embedding', id: 'asset_id', created: 'created_at', updated: 'created_at' },
  installed_plugins: { kind: 'plugin', id: 'id', path: 'fs_path', source: 'source_kind', created: 'installed_at', updated: 'updated_at' },
  plugin_marketplaces: { kind: 'plugin_marketplace', id: 'id', source: 'url', created: 'added_at', updated: 'refreshed_at' },
  applied_plugin_snapshots: { kind: 'plugin_snapshot', id: 'id', project: 'project_id', created: 'applied_at', updated: 'applied_at' },
};

function quoteSqliteIdentifier(identifier: string): string { if (!IDENTIFIER.test(identifier)) throw new Error('SQLite identifier is not valid'); return `"${identifier}"`; }
function sqliteColumns(db: Database.Database, name: string): Set<string> { return new Set((db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(name)})`).all() as Array<{ name: string }>).map((x) => x.name)); }
function markerId(schema: string): string { return `legacy-postgres-full-metadata:${schema}:v${IMPORT_VERSION}`; }
function createMarkerTable(db: Database.Database): void { db.exec('CREATE TABLE IF NOT EXISTS external_metadata_imports (source_id TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)'); }
function assertParentExists(db: Database.Database, spec: TableSpec, row: Row): void {
  for (const parent of spec.parents ?? []) {
    const value = row[parent.column];
    if (value == null && parent.nullable) continue;
    if (value == null || db.prepare(`SELECT 1 FROM ${quoteSqliteIdentifier(parent.table)} WHERE ${quoteSqliteIdentifier(parent.targetColumn)} = ?`).get(value) == null) throw new Error(`Legacy metadata import rejected orphan ${spec.name}.${parent.column}`);
  }
}
function validOwner(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value !== '__legacy__' && value !== QUARANTINE_TENANT; }
function pathInsideRoots(value: unknown, roots: readonly string[]): boolean {
  if (typeof value !== 'string' || !path.isAbsolute(value) || roots.length === 0) return false;
  const resolved = path.resolve(value);
  return roots.some((root) => resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`));
}

export async function importLegacyPostgresMetadata(options: LegacyMetadataImportOptions): Promise<LegacyMetadataImportResult> {
  const schema = options.schema ?? 'public'; const quotedSchema = quotePgIdentifier(schema); const pageSize = options.pageSize ?? 250;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 5_000) throw new Error('Legacy metadata import pageSize must be between 1 and 5000');
  createMarkerTable(options.sqlite); const sourceId = markerId(schema);
  if (options.sqlite.prepare('SELECT 1 FROM external_metadata_imports WHERE source_id = ?').get(sourceId)) return { status: 'already-imported', importedRows: 0 };
  const allNames = [...LEGACY_METADATA_TABLES_V2.map((x) => x.name), ...Object.keys(LEGACY_DISPOSITION_V2), 'brands', 'design_systems'];
  const inspected = await options.pg.query<{ table_name: string; column_name: string }>('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])', [schema, allNames]);
  const sourceColumns = new Map<string, Set<string>>();
  for (const item of inspected.rows) { const cols = sourceColumns.get(item.table_name) ?? new Set<string>(); cols.add(item.column_name); sourceColumns.set(item.table_name, cols); }
  if (!Object.entries(FINGERPRINT).every(([name, cols]) => cols.every((col) => sourceColumns.get(name)?.has(col)))) return { status: 'not-legacy-full-schema', importedRows: 0 };

  let importedRows = 0; let quarantinedRows = 0; const discardedRows: Record<string, number> = {};
  const retainedRows: Record<string, number> = {};
  const projectOwners = new Map<string, { tenant: unknown; creator: unknown }>();
  const assetOwners = new Map<string, { tenant: unknown; creator: unknown }>();
  const roots = (options.pvcRoots ?? []).filter(path.isAbsolute);
  const hasResourceOwnerDomain = Object.keys(OWNER_TABLES).some((name) => sourceColumns.has(name));
  const hasBrandDomain = sourceColumns.has('brands') || sourceColumns.has('design_systems');
  const completedDomains = new Set<string>();
  if (hasResourceOwnerDomain || hasBrandDomain) {
    await options.pg.query(`CREATE TABLE IF NOT EXISTS ${quotedSchema}."legacy_metadata_import_domains" (source_id text NOT NULL, domain text NOT NULL, completed_at bigint NOT NULL, PRIMARY KEY(source_id,domain))`);
    const completed = await options.pg.query<{ domain: string }>(`SELECT domain FROM ${quotedSchema}."legacy_metadata_import_domains" WHERE source_id=$1`, [sourceId]);
    completed.rows.forEach((row) => completedDomains.add(row.domain));
  }
  const registerOwner = async (tableName: string, row: Row): Promise<void> => {
    const descriptor = OWNER_TABLES[tableName]; if (!descriptor || completedDomains.has('resource-owner-registry')) return;
    const projectOwner = descriptor.project && row[descriptor.project] != null ? projectOwners.get(String(row[descriptor.project])) : undefined;
    const assetOwner = (tableName === 'library_tasks' || tableName === 'library_embeddings')
      ? assetOwners.get(String(row.asset_id)) : undefined;
    let tenant = row.tenant_id ?? projectOwner?.tenant ?? assetOwner?.tenant;
    let creator = row.creator_id ?? projectOwner?.creator ?? assetOwner?.creator;
    let reason: string | null = null;
    const source = descriptor.source ? row[descriptor.source] : null; const local = descriptor.path ? row[descriptor.path] : null;
    const requiresLocal = descriptor.path != null && (tableName === 'library_assets' ? row.storage === 'owned' : source === 'local' || source === 'upload');
    if (!validOwner(tenant) || !validOwner(creator)) reason = 'legacy-owner-not-authoritative';
    if (requiresLocal && !pathInsideRoots(local, roots)) reason = 'legacy-local-path-outside-pvc';
    if (reason) { tenant = QUARANTINE_TENANT; creator = QUARANTINE_TENANT; quarantinedRows += 1; }
    if (tableName === 'library_assets') assetOwners.set(String(row.id), { tenant, creator });
    const now = Date.now();
    const retrievalUrl = tableName === 'plugin_marketplaces' ? String(source)
      : (source === 'github' || source === 'http') ? String(row.resolved_source ?? row.source ?? '') || null : null;
    // The NOT EXISTS guard is intentionally cross-tenant: upgraded data wins
    // even when its new owner key differs from the legacy/quarantine tenant.
    await options.pg.query(`INSERT INTO ${quotedSchema}."saas_resource_owners" (resource_kind,resource_id,tenant_id,creator_id,management_domain,source_kind,retrieval_url,local_path,project_id,metadata_json,created_at,updated_at) SELECT $1,$2,$3,$4,'user',$5,$6,$7,$8,$9::jsonb,$10,$11 WHERE NOT EXISTS (SELECT 1 FROM ${quotedSchema}."saas_resource_owners" WHERE resource_kind=$1 AND resource_id=$2) ON CONFLICT DO NOTHING`, [descriptor.kind, String(row[descriptor.id]), tenant, creator, source == null ? null : String(source), retrievalUrl, requiresLocal ? local : null, descriptor.project ? row[descriptor.project] ?? null : null, JSON.stringify(reason ? { quarantineReason: reason, importVersion: IMPORT_VERSION } : { importVersion: IMPORT_VERSION }), Number(row[descriptor.created] ?? now), Number(row[descriptor.updated] ?? row[descriptor.created] ?? now)]);
  };
  const registerBrand = async (name: 'brands' | 'design_systems', row: Row): Promise<void> => {
    if (completedDomains.has('brand-design-system-registry')) return;
    const owned = validOwner(row.tenant_id) && validOwner(row.creator_id); if (!owned) quarantinedRows += 1;
    const type = name === 'brands' ? 'brand' : 'design_system'; const reason = owned ? null : 'legacy-owner-not-authoritative';
    await options.pg.query(`INSERT INTO ${quotedSchema}."brand_design_system_registry" (resource_type,resource_id,slug,name,tenant_id,creator_id,created_at,updated_at,deleted_at,quarantine_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [type, String(row.id), String(row.id), String(row.name ?? row.id), owned ? row.tenant_id : QUARANTINE_TENANT, owned ? row.creator_id : QUARANTINE_TENANT, Number(row.created_at), Number(row.updated_at), row.deleted_at ?? null, reason]);
  };

  options.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const unavailableTargets = new Set<string>();
    for (const spec of LEGACY_METADATA_TABLES_V2) {
      const source = sourceColumns.get(spec.name); if (!source) continue;
      const target = sqliteColumns(options.sqlite, spec.name);
      const unavailable = target.size === 0 || (spec.parents ?? []).some((parent) => unavailableTargets.has(parent.table));
      if (unavailable) {
        unavailableTargets.add(spec.name);
        const selected = [
          ...spec.columns.filter((column) => source.has(column)),
          ...['tenant_id', 'creator_id'].filter((column) => source.has(column) && !spec.columns.includes(column)),
        ];
        if (!spec.key.every((column) => selected.includes(column))) throw new Error(`Legacy metadata import missing key columns for ${spec.name}`);
        let count = 0;
        for (let offset = 0; ; offset += pageSize) {
          const page = await options.pg.query<Row>(`SELECT ${selected.map(quotePgIdentifier).join(', ')} FROM ${quotedSchema}.${quotePgIdentifier(spec.name)} ORDER BY ${spec.key.map(quotePgIdentifier).join(', ')} LIMIT $1 OFFSET $2`, [pageSize, offset]);
          for (const row of page.rows) await registerOwner(spec.name, row);
          count += page.rows.length;
          if (page.rows.length < pageSize) break;
        }
        retainedRows[spec.name] = count;
        console.info(`[metadata-import] retain-in-postgres:target-table-unavailable: ${count} row(s) in ${spec.name}`);
        continue;
      }
      const columns = spec.columns.filter((column) => source.has(column) && target.has(column));
      if (!spec.key.every((column) => columns.includes(column))) throw new Error(`Legacy metadata import missing key columns for ${spec.name}`);
      const selected = [...columns, ...['tenant_id', 'creator_id'].filter((x) => source.has(x) && !columns.includes(x))];
      const selectList = selected.map(quotePgIdentifier).join(', '); const orderBy = spec.key.map(quotePgIdentifier).join(', ');
      const insert = options.sqlite.prepare(`INSERT OR IGNORE INTO ${quoteSqliteIdentifier(spec.name)} (${columns.map(quoteSqliteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      // Keep project ownership repair as an explicit, narrow statement. Project
      // business-fact boundary checks deliberately distinguish this one-shot
      // upgrade repair from ordinary project UPDATE producers.
      const fillOwner = spec.name === 'projects'
        ? options.sqlite.prepare(`UPDATE projects SET
            fact_tenant_id=CASE WHEN fact_tenant_id IS NULL OR fact_tenant_id='' THEN ? ELSE fact_tenant_id END,
            fact_creator_id=CASE WHEN fact_creator_id IS NULL OR fact_creator_id='' THEN ? ELSE fact_creator_id END
          WHERE id = ?`)
        : spec.name === 'routines'
          ? options.sqlite.prepare(`UPDATE routines SET
              fact_tenant_id=CASE WHEN fact_tenant_id IS NULL OR fact_tenant_id='' THEN ? ELSE fact_tenant_id END,
              fact_creator_id=CASE WHEN fact_creator_id IS NULL OR fact_creator_id='' THEN ? ELSE fact_creator_id END
            WHERE id = ?`)
          : null;
      for (let offset = 0; ; offset += pageSize) {
        const page = await options.pg.query<Row>(`SELECT ${selectList} FROM ${quotedSchema}.${quotePgIdentifier(spec.name)} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`, [pageSize, offset]);
        for (const sourceRow of page.rows) {
          const targetRow = Object.fromEntries(columns.map((column) => [column, sourceRow[column]])); assertParentExists(options.sqlite, spec, targetRow);
          importedRows += insert.run(...columns.map((column) => sourceRow[column])).changes;
          if (spec.name === 'projects') {
            const owner = validOwner(sourceRow.tenant_id) && validOwner(sourceRow.creator_id)
              ? { tenant: sourceRow.tenant_id, creator: sourceRow.creator_id }
              : { tenant: QUARANTINE_TENANT, creator: QUARANTINE_TENANT };
            projectOwners.set(String(sourceRow.id), owner);
            fillOwner?.run(owner.tenant, owner.creator, sourceRow.id);
          } else if (spec.name === 'routines') {
            const inherited = sourceRow.project_id == null ? undefined : projectOwners.get(String(sourceRow.project_id));
            const tenant = validOwner(sourceRow.tenant_id) ? sourceRow.tenant_id : inherited?.tenant;
            const creator = validOwner(sourceRow.creator_id) ? sourceRow.creator_id : inherited?.creator;
            fillOwner?.run(validOwner(tenant) ? tenant : QUARANTINE_TENANT, validOwner(creator) ? creator : QUARANTINE_TENANT, sourceRow.id);
          }
          await registerOwner(spec.name, sourceRow);
        }
        if (page.rows.length < pageSize) break;
      }
    }
    for (const name of ['brands', 'design_systems'] as const) {
      const source = sourceColumns.get(name); if (!source?.has('id')) continue;
      for (let offset = 0; ; offset += pageSize) { const page = await options.pg.query<Row>(`SELECT "id", "name", "tenant_id", "creator_id", "created_at", "updated_at", "deleted_at" FROM ${quotedSchema}.${quotePgIdentifier(name)} ORDER BY "id" LIMIT $1 OFFSET $2`, [pageSize, offset]); for (const row of page.rows) await registerBrand(name, row); if (page.rows.length < pageSize) break; }
    }
    if (hasResourceOwnerDomain && !completedDomains.has('resource-owner-registry')) {
      await options.pg.query(`INSERT INTO ${quotedSchema}."legacy_metadata_import_domains" (source_id,domain,completed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [sourceId, 'resource-owner-registry', Date.now()]);
    }
    if (hasBrandDomain && !completedDomains.has('brand-design-system-registry')) {
      await options.pg.query(`INSERT INTO ${quotedSchema}."legacy_metadata_import_domains" (source_id,domain,completed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [sourceId, 'brand-design-system-registry', Date.now()]);
    }
    for (const [name, disposition] of Object.entries(LEGACY_DISPOSITION_V2)) {
      const source = sourceColumns.get(name); if (!source) continue; const key = [...source].find((x) => x === 'id' || x === 'date' || x === 'task_id') ?? [...source][0]; if (!key) continue;
      let count = 0; for (let offset = 0; ; offset += pageSize) { const page = await options.pg.query<Row>(`SELECT ${quotePgIdentifier(key)} FROM ${quotedSchema}.${quotePgIdentifier(name)} ORDER BY ${quotePgIdentifier(key)} LIMIT $1 OFFSET $2`, [pageSize, offset]); count += page.rows.length; if (page.rows.length < pageSize) break; }
      if (disposition.startsWith('discard:')) discardedRows[name] = count;
      console.info(`[metadata-import] ${disposition}: ${count} row(s) in ${name}`);
    }
    options.sqlite.prepare('INSERT INTO external_metadata_imports (source_id, imported_at) VALUES (?, ?)').run(sourceId, Date.now()); options.sqlite.exec('COMMIT');
  } catch (error) { try { options.sqlite.exec('ROLLBACK'); } catch {} throw error; }
  console.info(`[metadata-import] v${IMPORT_VERSION} merged ${importedRows} row(s), quarantined ${quarantinedRows}`);
  return {
    status: 'imported', importedRows, discardedRows,
    ...(Object.keys(retainedRows).length > 0 ? { retainedRows } : {}),
    quarantinedRows,
  };
}
