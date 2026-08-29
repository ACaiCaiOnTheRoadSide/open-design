import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAuthorizeProjectRequest } from '../src/collab/project-request-authority.js';
import { createToolRequestAuth } from '../src/http/tool-request-auth.js';
import { getRequestContext, requireRequestContext, runWithRequestContext } from '../src/request-context.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

describe('tool token principal recovery', () => {
  it('passes the authenticated run principal explicitly when minting after queued work', () => {
    const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const startChatRunSource = serverSource.slice(
      serverSource.indexOf('const startChatRun = async'),
      serverSource.indexOf('const runtimeToolPrompt =', serverSource.indexOf('const startChatRun = async')),
    );

    expect(startChatRunSource).toContain('const runPrincipal = getRequestContext();');
    expect(startChatRunSource).toMatch(/toolTokenRegistry\.mint\(\{[\s\S]*?principal: runPrincipal,/);
  });

  it('restores an explicitly captured principal after async queue context is gone and authorizes its project mutation', async () => {
    const tokens = new ToolTokenRegistry();
    const owner = { tenantId: 'tenant-a', userId: 'alice' };
    const captured = runWithRequestContext(owner, () => requireRequestContext());

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(getRequestContext()).toBeUndefined();

    const grant = tokens.mint({
      runId: 'persisted-run-1',
      projectId: 'project-1',
      principal: captured,
    });
    const auth = createToolRequestAuth(tokens);
    const req = {
      path: '/api/tools/media/generate',
      get(name: string) {
        if (name.toLowerCase() === 'authorization') return `Bearer ${grant.token}`;
        if (name.toLowerCase() === 'x-tenant-id') return 'tenant-b';
        if (name.toLowerCase() === 'x-od-user-id') return 'mallory';
        return undefined;
      },
    } as never;

    const authorizeProjectMutation = createAuthorizeProjectRequest({
      db: {},
      getWorkspaceProject: () => null,
      getWorkspaceProjectByProjectId: () => null,
      enforceUnboundProjectOwner: true,
      getProjectFactOwner: () => owner,
      sendApiError: () => undefined,
    });
    const authorized = await runWithRequestContext(
      { tenantId: 'untrusted-callback', userId: 'untrusted-callback' },
      async () => {
        const recovered = auth.authorizeToolRequest(req, {} as never, 'media:generate');
        return recovered?.projectId === 'project-1' && authorizeProjectMutation(
          { query: {}, get: () => undefined },
          {} as never,
          recovered.projectId,
          { mode: 'write', capability: 'writeFiles' },
        );
      },
    );

    expect(authorized).toBe(true);
    tokens.clear();
  });

  it('keeps a principal-less callback denied for an owned project mutation', async () => {
    const tokens = new ToolTokenRegistry();
    const grant = tokens.mint({ runId: 'legacy-run', projectId: 'project-1' });
    const auth = createToolRequestAuth(tokens);
    const req = {
      path: '/api/tools/media/generate',
      get(name: string) {
        return name.toLowerCase() === 'authorization' ? `Bearer ${grant.token}` : undefined;
      },
    } as never;

    const recovered = auth.authorizeToolRequest(req, {} as never, 'media:generate');
    const owner = { tenantId: 'tenant-a', userId: 'alice' };
    const deniedCodes: string[] = [];
    const authorizeProjectMutation = createAuthorizeProjectRequest({
      db: {},
      getWorkspaceProject: () => null,
      getWorkspaceProjectByProjectId: () => null,
      enforceUnboundProjectOwner: true,
      getProjectFactOwner: () => owner,
      sendApiError: (_res, _status, code) => deniedCodes.push(code),
    });
    const authorized = await authorizeProjectMutation(
      { query: {}, get: () => undefined },
      {} as never,
      'project-1',
      { mode: 'write', capability: 'writeFiles' },
    );

    expect(recovered?.principal).toBeUndefined();
    expect(authorized).toBe(false);
    expect(deniedCodes).toEqual(['PROJECT_PERMISSION_DENIED']);
    tokens.clear();
  });

  it('restores mint-time principal and ignores callback identity headers', () => {
    const tokens = new ToolTokenRegistry();
    const grant = runWithRequestContext({ tenantId: 'tenant-a', userId: 'alice' }, () =>
      tokens.mint({ runId: 'run-1', projectId: 'project-1' }));
    const auth = createToolRequestAuth(tokens);
    const req = {
      path: '/api/tools/library/search',
      get(name: string) {
        if (name.toLowerCase() === 'authorization') return `Bearer ${grant.token}`;
        if (name.toLowerCase() === 'x-tenant-id') return 'tenant-b';
        if (name.toLowerCase() === 'x-od-user-id') return 'mallory';
        return undefined;
      },
    } as never;
    const res = {} as never;

    const recovered = auth.authorizeToolRequest(req, res, 'library:search');
    expect(recovered?.principal).toEqual({ tenantId: 'tenant-a', userId: 'alice' });
    expect(getRequestContext()).toEqual({ tenantId: 'tenant-a', userId: 'alice' });
    tokens.clear();
  });
});
