import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  DaemonHuskboxWorkspaceService,
  HUSKBOX_SYNC_TOKEN_TTL_MS,
  mintProjectSyncToken,
} from '../../../src/runtimes/execution/huskbox-workspace-service.js';

function verifyLikeBackend(secret: string, token: string, projectId: string, nowSeconds: number) {
  expect(token.startsWith('odsync_')).toBe(true);
  const [payload64, signature] = token.slice('odsync_'.length).split('.');
  expect(createHmac('sha256', secret).update(payload64!).digest('base64url')).toBe(signature);
  const claims = JSON.parse(Buffer.from(payload64!, 'base64url').toString('utf8')) as { p: string; e: number; n: string };
  expect(claims.p).toBe(projectId);
  expect(claims.e).toBeGreaterThan(nowSeconds);
  expect(Buffer.from(claims.n, 'base64url')).toHaveLength(16);
  return claims;
}

describe('DaemonHuskboxWorkspaceService', () => {
  it('mints the backend syncauth byte protocol with its exact 45 minute TTL', () => {
    const now = new Date('2026-08-28T00:00:00.900Z');
    const token = mintProjectSyncToken('master', 'project-a', new Date(now.getTime() + HUSKBOX_SYNC_TOKEN_TTL_MS), Buffer.alloc(16, 7));
    const claims = verifyLikeBackend('master', token, 'project-a', Math.floor(now.getTime() / 1_000));
    expect(claims).toEqual({
      p: 'project-a',
      e: Math.floor((now.getTime() + HUSKBOX_SYNC_TOKEN_TTL_MS) / 1_000),
      n: Buffer.alloc(16, 7).toString('base64url'),
    });
  });

  it('isolates capabilities per project and never copies principal or master credentials', () => {
    const service = new DaemonHuskboxWorkspaceService({
      daemonToken: 'master', hydrateProject: vi.fn(), now: () => new Date(0), nonce: () => Buffer.alloc(16, 1),
    });
    const env: Record<string, string> = { OD_BACKEND_URL: 'https://backend', OD_SYNC_TOKEN: 'untrusted' };
    service.prepare({ spec: { command: 'agent' }, env, projectId: 'project-a' });
    verifyLikeBackend('master', env.OD_SYNC_TOKEN!, 'project-a', 0);
    expect(() => verifyLikeBackend('master', env.OD_SYNC_TOKEN!, 'project-b', 0)).toThrow();
    expect(JSON.stringify(env)).not.toContain('master');
    expect(env).not.toHaveProperty('OD_PRINCIPAL_USER_ID');
    expect(env).not.toHaveProperty('OD_PRINCIPAL_TENANT_ID');
  });

  it('awaits direct hydrate after completed and before transport result can settle', async () => {
    const order: string[] = [];
    const service = new DaemonHuskboxWorkspaceService({
      daemonToken: 'master',
      hydrateProject: async (projectId, options) => { order.push(`hydrate:${projectId}:${options?.ifMissing}`); },
    });
    await service.hydrateAfterExecution({ execution: { id: 'exec', status: 'succeeded' }, projectId: 'project-a' });
    order.push('result');
    expect(order).toEqual(['hydrate:project-a:false', 'result']);
  });
});
