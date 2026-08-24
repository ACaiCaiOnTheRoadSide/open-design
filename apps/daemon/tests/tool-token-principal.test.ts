import { describe, expect, it } from 'vitest';
import { createToolRequestAuth } from '../src/http/tool-request-auth.js';
import { getRequestContext, runWithRequestContext } from '../src/request-context.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

describe('tool token principal recovery', () => {
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
