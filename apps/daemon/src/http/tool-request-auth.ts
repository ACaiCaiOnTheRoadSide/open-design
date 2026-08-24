import type { Request, Response } from 'express';
import type { ToolTokenGrant, ToolTokenRegistry } from '../tool-tokens.js';
import { sendApiError } from './api-errors.js';
import { enterRequestContext } from '../request-context.js';

export function bearerTokenFromRequest(req: Request): string | undefined {
  const header = req.get('authorization');
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function createToolRequestAuth(registry: ToolTokenRegistry): {
  authorizeToolRequest(
    req: Request,
    res: Response,
    operation: string,
    options?: { endpoint?: string },
  ): ToolTokenGrant | null;
  optionalToolGrantFromRequest(req: Request, options?: Parameters<ToolTokenRegistry['validate']>[1]): ToolTokenGrant | null;
  requestProjectOverride(projectId: string | null | undefined, tokenProjectId: string | null | undefined): boolean;
  requestRunOverride(runId: string | null | undefined, tokenRunId: string | null | undefined): boolean;
} {
  function authorizeToolRequest(
    req: Request,
    res: Response,
    operation: string,
    options: { endpoint?: string } = {},
  ): ToolTokenGrant | null {
    const endpoint = options.endpoint ?? req.path;
    const validation = registry.validate(bearerTokenFromRequest(req), { endpoint, operation });
    if (!validation.ok) {
      const status = validation.code === 'TOOL_ENDPOINT_DENIED' || validation.code === 'TOOL_OPERATION_DENIED' ? 403 : 401;
      sendApiError(res, status, validation.code, validation.message, {
        details: { endpoint, operation },
      });
      return null;
    }
    // Capability authentication is the principal source for agent callbacks.
    // Never accept x-tenant-id/x-od-user-id here: those headers may be absent or
    // attacker-controlled when the callback reaches the daemon directly.
    if (validation.grant.principal) enterRequestContext(validation.grant.principal);
    return validation.grant;
  }

  function optionalToolGrantFromRequest(
    req: Request,
    options: Parameters<ToolTokenRegistry['validate']>[1] = {},
  ): ToolTokenGrant | null {
    const validation = registry.validate(bearerTokenFromRequest(req), options);
    if (!validation.ok) return null;
    // Optional callbacks have the same identity rule as required callbacks:
    // only the principal captured when this capability was minted is restored.
    if (validation.grant.principal) enterRequestContext(validation.grant.principal);
    return validation.grant;
  }

  return {
    authorizeToolRequest,
    optionalToolGrantFromRequest,
    requestProjectOverride,
    requestRunOverride,
  };
}

export function requestProjectOverride(
  projectId: string | null | undefined,
  tokenProjectId: string | null | undefined,
): boolean {
  return typeof projectId === 'string' && projectId.length > 0 && projectId !== tokenProjectId;
}

export function requestRunOverride(
  runId: string | null | undefined,
  tokenRunId: string | null | undefined,
): boolean {
  return typeof runId === 'string' && runId.length > 0 && runId !== tokenRunId;
}
