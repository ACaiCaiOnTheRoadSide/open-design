import { createHash } from 'node:crypto';
import type { PluginSourceKind } from '@open-design/contracts';
import { getRequestContext } from '../request-context.js';

function tenantPluginStoragePrefix(tenantId: string): string {
  return `tenant_${createHash('sha256').update(tenantId).digest('hex').slice(0, 24)}__`;
}

/** Internal SQLite/filesystem identity; never returned over the API. */
export function tenantPluginStorageId(tenantId: string, publicId: string): string {
  return `${tenantPluginStoragePrefix(tenantId)}${publicId}`;
}

export function currentPluginStoragePrefix(): string | null {
  const principal = getRequestContext();
  return principal ? tenantPluginStoragePrefix(principal.tenantId) : null;
}

export function currentPluginStorageId(publicId: string, sourceKind?: PluginSourceKind): string {
  const principal = getRequestContext();
  return principal && sourceKind !== 'bundled'
    ? tenantPluginStorageId(principal.tenantId, publicId)
    : publicId;
}
