import { requireRequestContext, type VerifiedPrincipal } from '../request-context.js';
import { transaction, type PgPoolLike, type PgQueryable } from './pg.js';

export type SaaSResourceKind =
  | 'library_asset'
  | 'library_task'
  | 'library_token'
  | 'library_embedding'
  | 'plugin'
  | 'plugin_marketplace'
  | 'plugin_snapshot';

export type ResourceSourceKind = 'local' | 'upload' | 'github' | 'http' | 'generated' | 'backend';

export interface ResourceOwnershipInput {
  kind: SaaSResourceKind;
  id: string;
  sourceKind?: ResourceSourceKind;
  retrievalUrl?: string | null;
  localPath?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  teamId?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ResourceOwnerRegistry {
  registerUser(input: ResourceOwnershipInput, principal?: Readonly<VerifiedPrincipal>): Promise<void>;
  registerBackend(input: ResourceOwnershipInput): Promise<void>;
  isVisible(kind: SaaSResourceKind, id: string, principal?: Readonly<VerifiedPrincipal>): Promise<boolean>;
  filterVisibleIds(kind: SaaSResourceKind, ids: readonly string[], principal?: Readonly<VerifiedPrincipal>): Promise<Set<string>>;
  softDelete(kind: SaaSResourceKind, id: string, principal?: Readonly<VerifiedPrincipal>): Promise<boolean>;
  hasOtherActiveOwners(kind: SaaSResourceKind, id: string, principal?: Readonly<VerifiedPrincipal>): Promise<boolean>;
  release(
    kind: SaaSResourceKind,
    id: string,
    principal?: Readonly<VerifiedPrincipal>,
    onLastOwner?: () => void | Promise<void>,
  ): Promise<{ deleted: boolean; hasActiveOwners: boolean }>;
  isBackendManaged(kind: SaaSResourceKind, id: string): Promise<boolean>;
  listRecoverablePlugins?(): Promise<Array<{
    id: string; tenantId: string; creatorId: string; retrievalUrl: string;
  }>>;
}

function validatePersistence(input: ResourceOwnershipInput): void {
  if (!input.id) throw new Error('resource id is required');
  if ((input.sourceKind === 'local' || input.sourceKind === 'upload') && !input.localPath) {
    throw new Error(`${input.sourceKind} resources require a PVC localPath`);
  }
  if ((input.sourceKind === 'github' || input.sourceKind === 'http') && !input.retrievalUrl) {
    throw new Error(`${input.sourceKind} resources require a retrievalUrl`);
  }
  if ((input.sourceKind === 'local' || input.sourceKind === 'upload') && input.retrievalUrl) {
    throw new Error(`${input.sourceKind} resources are not remotely retrievable`);
  }
}

function principalOrThrow(principal?: Readonly<VerifiedPrincipal>): Readonly<VerifiedPrincipal> {
  return principal ?? requireRequestContext();
}

export function createResourceOwnerRegistry(pg: PgQueryable): ResourceOwnerRegistry {
  const pool = 'connect' in pg ? pg as PgPoolLike : undefined;
  const withResourceLock = async <T>(
    kind: SaaSResourceKind,
    id: string,
    work: (db: PgQueryable) => Promise<T>,
  ): Promise<T> => {
    if (!pool) return work(pg); // query-only test doubles
    return transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [kind, id]);
      return work(client);
    }, pool);
  };
  return {
    async registerUser(input, suppliedPrincipal) {
      validatePersistence(input);
      const principal = principalOrThrow(suppliedPrincipal);
      const now = Date.now();
      await withResourceLock(input.kind, input.id, (db) => db.query(
        `INSERT INTO saas_resource_owners
           (resource_kind, resource_id, tenant_id, creator_id, management_domain,
            source_kind, retrieval_url, local_path, project_id, workspace_id, team_id,
            metadata_json, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,'user',$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12,NULL)
         ON CONFLICT (resource_kind, tenant_id, resource_id) DO UPDATE SET
           source_kind = EXCLUDED.source_kind,
           retrieval_url = EXCLUDED.retrieval_url,
           local_path = EXCLUDED.local_path,
           project_id = EXCLUDED.project_id,
           workspace_id = EXCLUDED.workspace_id,
           team_id = EXCLUDED.team_id,
           metadata_json = EXCLUDED.metadata_json,
           updated_at = EXCLUDED.updated_at,
           deleted_at = NULL
         WHERE saas_resource_owners.management_domain = 'user'
           AND saas_resource_owners.creator_id = EXCLUDED.creator_id`,
        [input.kind, input.id, principal.tenantId, principal.userId,
          input.sourceKind ?? null, input.retrievalUrl ?? null, input.localPath ?? null,
          input.projectId ?? null, input.workspaceId ?? principal.workspaceId ?? null,
          input.teamId ?? null, JSON.stringify(input.metadata ?? {}), now],
      ));
    },

    async registerBackend(input) {
      validatePersistence(input);
      const now = Date.now();
      await withResourceLock(input.kind, input.id, (db) => db.query(
        `INSERT INTO saas_resource_owners
           (resource_kind, resource_id, tenant_id, creator_id, management_domain,
            source_kind, retrieval_url, local_path, project_id, workspace_id, team_id,
            metadata_json, created_at, updated_at, deleted_at)
         VALUES ($1,$2,'__backend__','__backend__','backend',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10,NULL)
         ON CONFLICT (resource_kind, tenant_id, resource_id) DO UPDATE SET
           source_kind = EXCLUDED.source_kind,
           retrieval_url = EXCLUDED.retrieval_url,
           local_path = EXCLUDED.local_path,
           metadata_json = EXCLUDED.metadata_json,
           updated_at = EXCLUDED.updated_at,
           deleted_at = NULL
         WHERE saas_resource_owners.management_domain = 'backend'`,
        [input.kind, input.id, input.sourceKind ?? 'backend', input.retrievalUrl ?? null,
          input.localPath ?? null, input.projectId ?? null, input.workspaceId ?? null,
          input.teamId ?? null, JSON.stringify(input.metadata ?? {}), now],
      ));
    },

    async isVisible(kind, id, suppliedPrincipal) {
      const principal = principalOrThrow(suppliedPrincipal);
      const result = await pg.query(
        `SELECT 1 FROM saas_resource_owners
          WHERE resource_kind = $1 AND resource_id = $2 AND deleted_at IS NULL
            AND ((management_domain = 'user' AND tenant_id = $3)
              OR management_domain = 'backend')
          LIMIT 1`,
        [kind, id, principal.tenantId],
      );
      return (result.rowCount ?? result.rows.length) > 0;
    },

    async filterVisibleIds(kind, ids, suppliedPrincipal) {
      if (ids.length === 0) return new Set();
      const principal = principalOrThrow(suppliedPrincipal);
      const result = await pg.query<{ resource_id: string }>(
        `SELECT resource_id FROM saas_resource_owners
          WHERE resource_kind = $1 AND resource_id = ANY($2::text[]) AND deleted_at IS NULL
            AND ((management_domain = 'user' AND tenant_id = $3)
              OR management_domain = 'backend')`,
        [kind, [...ids], principal.tenantId],
      );
      return new Set(result.rows.map((row) => row.resource_id));
    },

    async softDelete(kind, id, suppliedPrincipal) {
      const principal = principalOrThrow(suppliedPrincipal);
      const result = await pg.query(
        `UPDATE saas_resource_owners SET deleted_at = $4, updated_at = $4
          WHERE resource_kind = $1 AND resource_id = $2 AND tenant_id = $3
            AND management_domain = 'user' AND deleted_at IS NULL`,
        [kind, id, principal.tenantId, Date.now()],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async hasOtherActiveOwners(kind, id, suppliedPrincipal) {
      const principal = principalOrThrow(suppliedPrincipal);
      const result = await pg.query(
        `SELECT 1 FROM saas_resource_owners
          WHERE resource_kind = $1 AND resource_id = $2 AND deleted_at IS NULL
            AND (tenant_id <> $3 OR management_domain = 'backend') LIMIT 1`,
        [kind, id, principal.tenantId],
      );
      return (result.rowCount ?? result.rows.length) > 0;
    },

    async release(kind, id, suppliedPrincipal, onLastOwner) {
      const principal = principalOrThrow(suppliedPrincipal);
      return withResourceLock(kind, id, async (db) => {
        const deleted = await db.query(
          `UPDATE saas_resource_owners SET deleted_at = $4, updated_at = $4
            WHERE resource_kind = $1 AND resource_id = $2 AND tenant_id = $3
              AND management_domain = 'user' AND deleted_at IS NULL`,
          [kind, id, principal.tenantId, Date.now()],
        );
        if ((deleted.rowCount ?? 0) === 0) return { deleted: false, hasActiveOwners: false };
        const remaining = await db.query(
          `SELECT 1 FROM saas_resource_owners
            WHERE resource_kind = $1 AND resource_id = $2 AND deleted_at IS NULL
            LIMIT 1`,
          [kind, id],
        );
        const hasActiveOwners = (remaining.rowCount ?? remaining.rows.length) > 0;
        if (!hasActiveOwners) await onLastOwner?.();
        return { deleted: true, hasActiveOwners };
      });
    },

    async isBackendManaged(kind, id) {
      const result = await pg.query(
        `SELECT 1 FROM saas_resource_owners
          WHERE resource_kind = $1 AND resource_id = $2
            AND management_domain = 'backend' AND deleted_at IS NULL
          LIMIT 1`,
        [kind, id],
      );
      return (result.rowCount ?? result.rows.length) > 0;
    },

    async listRecoverablePlugins() {
      const result = await pg.query<{
        resource_id: string; tenant_id: string; creator_id: string; retrieval_url: string;
      }>(
        `SELECT resource_id, tenant_id, creator_id, retrieval_url
           FROM saas_resource_owners
          WHERE resource_kind = 'plugin' AND management_domain = 'user'
            AND source_kind IN ('github', 'http') AND retrieval_url IS NOT NULL
            AND deleted_at IS NULL
          ORDER BY created_at ASC`,
      );
      return result.rows.map((row) => ({
        id: row.resource_id,
        tenantId: row.tenant_id,
        creatorId: row.creator_id,
        retrievalUrl: row.retrieval_url,
      }));
    },
  };
}
