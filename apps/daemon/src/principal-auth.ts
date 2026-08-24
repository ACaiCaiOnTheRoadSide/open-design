import type { Request, RequestHandler } from 'express';
import { apiTokenAuthorizationMatches, apiTokenFromEnv, isApiAuthDisabled } from './api-token-auth.js';
import { runWithRequestContext, type VerifiedPrincipal } from './request-context.js';
import { PROVIDER_CONFIG_HEADER, sanitizeProviderConfig } from './runtime-provider-config.js';

export type PrincipalSource = 'static' | 'trusted-proxy';

export type PrincipalAuthConfig =
  | { enabled: false }
  | { enabled: true; source: 'static'; principal: VerifiedPrincipal }
  | { enabled: true; source: 'trusted-proxy'; apiToken: string };

export class PrincipalAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalAuthConfigError';
  }
}

const PRINCIPAL_HEADERS = ['x-tenant-id', 'x-od-user-id'] as const;
const TRUSTED_RUNTIME_HEADERS = [...PRINCIPAL_HEADERS, PROVIDER_CONFIG_HEADER] as const;
const OPEN_PROBE_PATHS = new Set(['/health', '/ready', '/version', '/api/health', '/api/ready', '/api/version']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function principalId(value: string | undefined, envName: string): string {
  if (
    value === undefined
    || value.trim().length < 1
    || value.length > 128
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new PrincipalAuthConfigError(`${envName} must be 1-128 characters with no control characters`);
  }
  return value;
}

/** Parses startup configuration without retaining any PostgreSQL credentials. */
export function resolvePrincipalAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): PrincipalAuthConfig {
  if ((env.OD_DAEMON_DB ?? 'sqlite').trim().toLowerCase() !== 'postgres') {
    return { enabled: false };
  }

  const source: string | undefined = env.OD_PRINCIPAL_SOURCE?.trim().toLowerCase();
  if (source !== 'static' && source !== 'trusted-proxy') {
    throw new PrincipalAuthConfigError(
      'OD_PRINCIPAL_SOURCE must be static or trusted-proxy when OD_DAEMON_DB=postgres',
    );
  }

  if (source === 'static') {
    return {
      enabled: true,
      source,
      principal: {
        tenantId: principalId(env.OD_PRINCIPAL_TENANT_ID, 'OD_PRINCIPAL_TENANT_ID'),
        userId: principalId(env.OD_PRINCIPAL_USER_ID, 'OD_PRINCIPAL_USER_ID'),
      },
    };
  }

  if (isApiAuthDisabled(env)) {
    throw new PrincipalAuthConfigError(
      'OD_DISABLE_API_AUTH cannot be enabled with OD_PRINCIPAL_SOURCE=trusted-proxy',
    );
  }
  const apiToken = apiTokenFromEnv(env);
  if (!apiToken) {
    throw new PrincipalAuthConfigError(
      'OD_API_TOKEN is required with OD_PRINCIPAL_SOURCE=trusted-proxy',
    );
  }
  return { enabled: true, source, apiToken };
}

function rawHeaderValues(req: Request, headerName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(req.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function uniqueHeader(req: Request, headerName: string): string | undefined {
  const values = rawHeaderValues(req, headerName);
  return values.length === 1 ? values[0] : undefined;
}

function singleHeader(req: Request, headerName: string): string | undefined {
  const value = uniqueHeader(req, headerName);
  if (value === undefined || value.includes(',')) return undefined;
  return value;
}

function hasHeader(req: Request, headerName: string): boolean {
  return rawHeaderValues(req, headerName).length > 0;
}

function requestPrincipalId(value: string | undefined): string | null {
  if (
    value === undefined
    || value.trim().length < 1
    || value.length > 128
    || CONTROL_CHARACTER.test(value)
  ) {
    return null;
  }
  return value;
}

function isOpenProbe(req: Request): boolean {
  return req.method === 'GET' && OPEN_PROBE_PATHS.has(req.path);
}

export type PrincipalContextMode = 'required' | 'optional';

/** Pure route policy used by the server before installing principal ALS. */
export function principalContextModeForApiRequest(
  method: string,
  path: string,
  options: { backend?: 'sqlite' | 'postgres' } = {},
): PrincipalContextMode {
  const withoutApiPrefix = path.toLowerCase().startsWith('/api/') ? path.slice(4) : path;
  const normalizedPath = (withoutApiPrefix.replace(/\/+$/u, '') || '/').toLowerCase();
  if (normalizedPath === '/memory' || normalizedPath.startsWith('/memory/')) return 'required';
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'POST' && (normalizedPath === '/runs' || normalizedPath === '/chat')) {
    return 'required';
  }
  if (options.backend === 'postgres') {
    // Filesystem-backed SaaS resources are tenant-scoped by the PostgreSQL
    // registry. Every read and write must therefore enter VerifiedPrincipal ALS;
    // optional mode would let a preview/tool token bypass the ownership gate.
    if (normalizedPath === '/app-config') return 'required';
    if (normalizedPath === '/analytics' || normalizedPath.startsWith('/analytics/')) return 'required';
    if (normalizedPath === '/brands' || normalizedPath.startsWith('/brands/')) return 'required';
    if (normalizedPath === '/design-systems' || normalizedPath.startsWith('/design-systems/')) return 'required';
    if (normalizedPath === '/library' || normalizedPath.startsWith('/library/')) return 'required';
    if (normalizedPath === '/plugins' || normalizedPath.startsWith('/plugins/')) return 'required';
    if (normalizedPath === '/marketplaces' || normalizedPath.startsWith('/marketplaces/')) return 'required';
    if (normalizedPath === '/applied-plugins' || normalizedPath.startsWith('/applied-plugins/')) return 'required';
    // Every hosted project data-plane route needs principal ALS; the central
    // project authorizer then applies either owner or Workspace authority.
    if (normalizedPath === '/projects' || normalizedPath.startsWith('/projects/')) return 'required';
    if (normalizedMethod === 'DELETE' && /^\/projects\/[^/]+$/u.test(normalizedPath)) return 'required';
    if (normalizedMethod === 'POST' && /^\/projects\/[^/]+\/stats-events$/u.test(normalizedPath)) return 'required';
    if (normalizedMethod === 'POST' && /^\/workspaces\/[^/]+\/projects\/batch-delete$/u.test(normalizedPath)) {
      return 'required';
    }
  }
  return 'optional';
}

export function createPrincipalAuthMiddleware(
  config: PrincipalAuthConfig,
  contextMode: PrincipalContextMode = 'required',
): RequestHandler {
  if (!config.enabled) return (_req, _res, next) => next();

  return (req, res, next) => {
    if (isOpenProbe(req)) return next();

    if (config.source === 'static') {
      if (TRUSTED_RUNTIME_HEADERS.some((name) => hasHeader(req, name))) {
        return res.status(400).json({
          error: {
            code: 'PRINCIPAL_HEADERS_FORBIDDEN',
            message: 'Client principal headers are not accepted in static principal mode',
          },
        });
      }
      res.locals.principalSource = 'static' satisfies PrincipalSource;
      return runWithRequestContext(config.principal, next);
    }

    // Optional mode exists for ordinary API routes that may authenticate with a
    // narrower server-minted preview/tool token. Such a token is not allowed to
    // assert a principal, but it must not be rejected merely because no
    // principal context is needed by that route.
    const hasPrincipalHeader = PRINCIPAL_HEADERS.some((name) => hasHeader(req, name));
    if (contextMode === 'optional' && !hasPrincipalHeader) return next();

    const authorizationValues = rawHeaderValues(req, 'authorization');
    const authorization = authorizationValues.length === 1 ? authorizationValues[0] : undefined;
    if (!apiTokenAuthorizationMatches(authorization, config.apiToken)) {
      return res.status(401).json({
        error: {
          code: 'API_TOKEN_REQUIRED',
          message: 'A valid API authorization token is required',
        },
      });
    }

    const tenantId = requestPrincipalId(singleHeader(req, 'x-tenant-id'));
    const userId = requestPrincipalId(singleHeader(req, 'x-od-user-id'));
    if (!tenantId || !userId) {
      return res.status(400).json({
        error: {
          code: 'INVALID_PRINCIPAL_HEADERS',
          message: 'Exactly one valid x-tenant-id and x-od-user-id header is required',
        },
      });
    }

    const hasProviderConfig = hasHeader(req, PROVIDER_CONFIG_HEADER);
    // JSON legitimately contains commas; duplicate protection comes from the
    // raw-header cardinality check rather than comma rejection.
    const providerConfig = sanitizeProviderConfig(uniqueHeader(req, PROVIDER_CONFIG_HEADER));
    if (hasProviderConfig && !providerConfig) {
      return res.status(400).json({
        error: {
          code: 'INVALID_PROVIDER_CONFIG',
          message: 'Exactly one valid x-od-provider-config header is required',
        },
      });
    }

    res.locals.principalSource = 'trusted-proxy' satisfies PrincipalSource;
    return runWithRequestContext({
      tenantId,
      userId,
      ...(providerConfig ? { providerConfig } : {}),
    }, next);
  };
}

/**
 * Runs daemon-initiated work with the only principal source that is valid
 * outside HTTP: the principal already validated from static startup config.
 * Trusted-proxy mode deliberately receives no fallback identity.
 */
export function runWithStaticPrincipalContext<T>(
  config: PrincipalAuthConfig,
  work: () => T,
): T {
  if (config.enabled && config.source === 'static') {
    return runWithRequestContext(config.principal, work);
  }
  return work();
}

export function principalAuthMiddleware(
  env: NodeJS.ProcessEnv = process.env,
  contextMode: PrincipalContextMode = 'required',
): RequestHandler {
  return createPrincipalAuthMiddleware(resolvePrincipalAuthConfig(env), contextMode);
}
