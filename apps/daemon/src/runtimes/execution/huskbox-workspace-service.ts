import { createHmac, randomBytes } from 'node:crypto';

import type { HuskboxExecutionStatus } from './huskbox-client.js';
import type { HuskboxWorkspaceService } from './huskbox-transport.js';
import type { ExecutionSpec } from './transport.js';

const TOKEN_PREFIX = 'odsync_';
export const HUSKBOX_SYNC_TOKEN_TTL_MS = 45 * 60_000;

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** Byte-compatible with backend/internal/syncauth.Mint (claims p/e/n + HMAC-SHA256). */
export function mintProjectSyncToken(
  secret: string,
  projectId: string,
  expiresAt: Date,
  nonce: Buffer = randomBytes(16),
): string {
  if (!secret || !projectId || projectId.includes('/') || projectId.includes('..') || nonce.length !== 16) {
    throw new Error('invalid sync token input');
  }
  const payload = JSON.stringify({
    p: projectId,
    e: Math.floor(expiresAt.getTime() / 1_000),
    n: base64Url(nonce),
  });
  const encoded = base64Url(payload);
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${TOKEN_PREFIX}${encoded}.${signature}`;
}

export interface DaemonHuskboxWorkspaceServiceOptions {
  daemonToken: string;
  hydrateProject: (projectId: string, options?: { ifMissing?: boolean }) => Promise<unknown>;
  now?: () => Date;
  nonce?: () => Buffer;
}

/**
 * Keeps daemon-owned sync credentials and hydration in-process. Only the
 * project-bound capability enters the sandbox; completion is not observable by
 * run consumers until the pushed manifest has been hydrated onto daemon disk.
 */
export class DaemonHuskboxWorkspaceService implements HuskboxWorkspaceService {
  constructor(private readonly options: DaemonHuskboxWorkspaceServiceOptions) {}

  prepare(context: { spec: ExecutionSpec; env: Record<string, string>; projectId: string | null }): void {
    delete context.env.OD_SYNC_TOKEN;
    if (!context.projectId || !context.env.OD_BACKEND_URL) return;
    if (!this.options.daemonToken) throw new Error('OD_API_TOKEN is required to mint project sync capability');
    const now = this.options.now?.() ?? new Date();
    context.env.OD_SYNC_TOKEN = mintProjectSyncToken(
      this.options.daemonToken,
      context.projectId,
      new Date(now.getTime() + HUSKBOX_SYNC_TOKEN_TTL_MS),
      this.options.nonce?.(),
    );
  }

  async hydrateAfterExecution(context: { execution: HuskboxExecutionStatus; projectId: string | null }): Promise<void> {
    if (!context.projectId) return;
    await this.options.hydrateProject(context.projectId, { ifMissing: false });
  }
}
