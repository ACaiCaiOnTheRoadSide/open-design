import { AsyncLocalStorage } from 'node:async_hooks';

export interface VerifiedPrincipal {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  /** Backend-validated BYOK config; never sourced from an unauthenticated request. */
  providerConfig?: string;
}

const principalStorage = new AsyncLocalStorage<Readonly<VerifiedPrincipal>>();

/** Runs work under a principal that the caller has already authenticated. */
export function runWithRequestContext<T>(
  principal: VerifiedPrincipal,
  work: () => T,
): T {
  const context = Object.freeze({ ...principal });
  return principalStorage.run(context, work);
}

export function getRequestContext(): Readonly<VerifiedPrincipal> | undefined {
  return principalStorage.getStore();
}

/**
 * Captures authenticated request identity for work that may start after the
 * request's async chain has ended. Call this at the authenticated entry point,
 * before its first await; never reconstruct the result from request input.
 */
export function captureRequestPrincipal(): Readonly<VerifiedPrincipal> | undefined {
  const principal = getRequestContext();
  return principal ? Object.freeze({ ...principal }) : undefined;
}

/** Runs delayed work under a previously captured, trusted principal. */
export function runWithCapturedRequestContext<T>(
  principal: Readonly<VerifiedPrincipal> | undefined,
  work: () => T,
): T {
  return principal ? runWithRequestContext(principal, work) : work();
}

/**
 * Restores a principal that was authenticated by another trusted capability.
 * Tool callbacks use this only after validating the opaque server-minted token;
 * request headers are deliberately not consulted.
 */
export function enterRequestContext(principal: VerifiedPrincipal): void {
  principalStorage.enterWith(Object.freeze({ ...principal }));
}

/** Throws rather than guessing identity when called outside a request scope. */
export function requireRequestContext(): Readonly<VerifiedPrincipal> {
  const context = principalStorage.getStore();
  if (!context) throw new Error('Missing principal: No verified principal is active in this request context');
  return context;
}
