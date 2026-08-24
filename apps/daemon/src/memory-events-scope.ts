import { getRequestContext, type VerifiedPrincipal } from './request-context.js';

const eventPrincipals = new WeakMap<object, Readonly<VerifiedPrincipal>>();

/** Tags an in-process event without adding tenant/user fields to its public JSON. */
export function scopeMemoryEvent<T extends object>(event: T): T {
  const principal = getRequestContext();
  if (principal) eventPrincipals.set(event, principal);
  return event;
}

export function memoryEventBelongsTo(event: unknown, principal: Readonly<VerifiedPrincipal> | undefined): boolean {
  if (!event || typeof event !== 'object') return principal === undefined;
  const owner = eventPrincipals.get(event);
  // Local SQLite events are intentionally process-local and unscoped. Hosted PG
  // requests always have a verified principal and must match both dimensions.
  if (!owner) return process.env.OD_DAEMON_DB !== 'postgres';
  return !!principal && owner.tenantId === principal.tenantId && owner.userId === principal.userId;
}
