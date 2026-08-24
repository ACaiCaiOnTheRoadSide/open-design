import { requireRequestContext, type VerifiedPrincipal } from '../request-context.js';
import { resolveDaemonDbConfig } from './daemon-db.js';
import { query, transaction, type PgQueryable } from './pg.js';

export type RegistryResourceType = 'brand' | 'design_system';
export const LEGACY_QUARANTINE_TENANT = '__legacy_quarantine__';

export interface RegistryResource {
  resourceType: RegistryResourceType;
  resourceId: string;
  slug: string;
  name: string;
  tenantId: string;
  creatorId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  quarantineReason: string | null;
}

export interface RegistryBackfillCandidate {
  resourceType: RegistryResourceType;
  resourceId: string;
  slug: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  /** A tenant/user resolved from an authoritative project fact or trusted SQLite owner. */
  owner?: Pick<VerifiedPrincipal, 'tenantId' | 'userId'> | null;
  quarantineReason?: string;
}

type TransactionRunner = <T>(work: (client: PgQueryable) => Promise<T>) => Promise<T>;

export interface BrandDesignSystemRegistry {
  readonly enabled: boolean;
  register(input: Omit<RegistryBackfillCandidate, 'owner' | 'quarantineReason'>, principal?: Readonly<VerifiedPrincipal>): Promise<void>;
  rename(resourceType: RegistryResourceType, resourceId: string, name: string, principal?: Readonly<VerifiedPrincipal>): Promise<boolean>;
  owns(resourceType: RegistryResourceType, resourceId: string, principal?: Readonly<VerifiedPrincipal>): Promise<boolean>;
  listOwned(resourceType: RegistryResourceType, principal?: Readonly<VerifiedPrincipal>): Promise<RegistryResource[]>;
  softDelete(resourceType: RegistryResourceType, resourceId: string, principal?: Readonly<VerifiedPrincipal>, deletedAt?: number): Promise<boolean>;
  allocateSlug(resourceType: RegistryResourceType, requested: string, principal?: Readonly<VerifiedPrincipal>): Promise<string>;
  backfill(candidates: RegistryBackfillCandidate[]): Promise<void>;
}

export interface RegistryOptions {
  enabled: boolean;
  query?: PgQueryable['query'];
  transaction?: TransactionRunner;
  principal?: () => Readonly<VerifiedPrincipal>;
}

function validatePrincipal(value: Readonly<VerifiedPrincipal>): Readonly<VerifiedPrincipal> {
  if (!value.tenantId || !value.userId || value.tenantId === LEGACY_QUARANTINE_TENANT) {
    throw new Error('Brand/design-system registry requires a verified principal');
  }
  return value;
}

function rowToResource(row: Record<string, unknown>): RegistryResource {
  return {
    resourceType: row.resource_type as RegistryResourceType,
    resourceId: String(row.resource_id),
    slug: String(row.slug),
    name: String(row.name ?? ''),
    tenantId: String(row.tenant_id),
    creatorId: String(row.creator_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    quarantineReason: row.quarantine_reason == null ? null : String(row.quarantine_reason),
  };
}

/** Capture this at request admission and pass it into every deferred/background callback. */
export function captureVerifiedPrincipal(): Readonly<VerifiedPrincipal> {
  return Object.freeze({ ...validatePrincipal(requireRequestContext()) });
}

export function createBrandDesignSystemRegistry(
  options?: Partial<RegistryOptions>,
): BrandDesignSystemRegistry {
  const enabled = options?.enabled ?? resolveDaemonDbConfig().kind === 'postgres';
  if (!enabled) {
    const noop = async (): Promise<void> => {};
    return {
      enabled: false,
      register: noop,
      rename: async () => true,
      owns: async () => true,
      listOwned: async () => [],
      softDelete: async () => true,
      allocateSlug: async (_type, requested) => requested,
      backfill: noop,
    };
  }

  const runQuery = options?.query ?? query;
  const runTransaction: TransactionRunner = options?.transaction
    ?? ((work) => transaction((client) => work(client)));
  const ambientPrincipal = options?.principal ?? requireRequestContext;
  const actor = (explicit?: Readonly<VerifiedPrincipal>) => validatePrincipal(explicit ?? ambientPrincipal());

  return {
    enabled: true,
    async register(input, explicitPrincipal) {
      const principal = actor(explicitPrincipal);
      const now = input.updatedAt ?? Date.now();
      const createdAt = input.createdAt ?? now;
      const result = await runQuery(
        `INSERT INTO brand_design_system_registry
           (resource_type, resource_id, slug, name, tenant_id, creator_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (resource_type, resource_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = GREATEST(brand_design_system_registry.updated_at, EXCLUDED.updated_at)
         WHERE brand_design_system_registry.tenant_id = EXCLUDED.tenant_id
           AND brand_design_system_registry.deleted_at IS NULL
         RETURNING resource_id`,
        [input.resourceType, input.resourceId, input.slug, input.name ?? '', principal.tenantId,
          principal.userId, createdAt, now],
      );
      // A tombstone can never be revived and a globally colliding physical id can
      // never be claimed by another tenant.
      if (result.rowCount !== 1) throw new Error('Registry identity conflict or deleted resource');
    },

    async rename(resourceType, resourceId, name, explicitPrincipal) {
      const principal = actor(explicitPrincipal);
      const result = await runQuery(
        `UPDATE brand_design_system_registry SET name = $4, updated_at = $5
          WHERE resource_type = $1 AND resource_id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
        [resourceType, resourceId, principal.tenantId, name, Date.now()],
      );
      return result.rowCount === 1;
    },

    async owns(resourceType, resourceId, explicitPrincipal) {
      const principal = actor(explicitPrincipal);
      const result = await runQuery(
        `SELECT 1 FROM brand_design_system_registry
          WHERE resource_type = $1 AND resource_id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
        [resourceType, resourceId, principal.tenantId],
      );
      return result.rowCount === 1;
    },

    async listOwned(resourceType, explicitPrincipal) {
      const principal = actor(explicitPrincipal);
      const result = await runQuery<Record<string, unknown>>(
        `SELECT resource_type, resource_id, slug, name, tenant_id, creator_id,
                created_at, updated_at, deleted_at, quarantine_reason
           FROM brand_design_system_registry
          WHERE resource_type = $1 AND tenant_id = $2 AND deleted_at IS NULL
          ORDER BY updated_at DESC, resource_id`,
        [resourceType, principal.tenantId],
      );
      return result.rows.map(rowToResource);
    },

    async softDelete(resourceType, resourceId, explicitPrincipal, deletedAt = Date.now()) {
      const principal = actor(explicitPrincipal);
      return runTransaction(async (client) => {
        const result = await client.query(
          `UPDATE brand_design_system_registry
              SET deleted_at = $4, updated_at = GREATEST(updated_at, $4)
            WHERE resource_type = $1 AND resource_id = $2 AND tenant_id = $3
              AND deleted_at IS NULL
            RETURNING resource_id`,
          [resourceType, resourceId, principal.tenantId, deletedAt],
        );
        return result.rowCount === 1;
      });
    },

    async allocateSlug(resourceType, requested, explicitPrincipal) {
      const principal = actor(explicitPrincipal);
      const base = requested.trim() || 'untitled';
      for (let suffix = 0; suffix < 10_000; suffix += 1) {
        const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
        const result = await runQuery(
          `SELECT 1 FROM brand_design_system_registry
            WHERE resource_type = $1 AND tenant_id = $2 AND slug = $3 AND deleted_at IS NULL`,
          [resourceType, principal.tenantId, candidate],
        );
        if (result.rowCount === 0) return candidate;
      }
      throw new Error('Unable to allocate tenant-local resource slug');
    },

    async backfill(candidates) {
      await runTransaction(async (client) => {
        for (const candidate of candidates) {
          const now = candidate.updatedAt ?? candidate.createdAt ?? Date.now();
          const owner = candidate.owner;
          const tenantId = owner?.tenantId || LEGACY_QUARANTINE_TENANT;
          const creatorId = owner?.userId || LEGACY_QUARANTINE_TENANT;
          const reason = owner ? null : (candidate.quarantineReason ?? 'ownership-unverifiable');
          await client.query(
            `INSERT INTO brand_design_system_registry
               (resource_type, resource_id, slug, name, tenant_id, creator_id,
                created_at, updated_at, quarantine_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (resource_type, resource_id) DO NOTHING`,
            [candidate.resourceType, candidate.resourceId, candidate.slug, candidate.name ?? '',
              tenantId, creatorId, candidate.createdAt ?? now, now, reason],
          );
        }
      });
    },
  };
}
