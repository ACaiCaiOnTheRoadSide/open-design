// Token usage metering: every persisted `usage` agent event must also land as
// one flat row in message_token_usage, attributed to the caller's tenant
// (X-Tenant-Id) AND user (X-OD-User-Id — team tenants share one tenant_id, so
// per-user accounting needs the separate header), carrying the model the spawn
// resolved for the run. The same model id must be stamped onto the usage event
// stored in messages.events_json.
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { openDatabase } from '../src/db.js';

async function withFakeAgent<T>(
  binName: string,
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'od-token-usage-bin-'));
  const oldPath = process.env.PATH;
  try {
    if (process.platform === 'win32') {
      const runner = join(dir, `${binName}-test-runner.cjs`);
      await fsp.writeFile(runner, script);
      await fsp.writeFile(
        join(dir, `${binName}.cmd`),
        `@echo off\r\nnode "${runner}" %*\r\n`,
      );
    } else {
      const bin = join(dir, binName);
      await fsp.writeFile(bin, `#!/usr/bin/env node\n${script}`);
      await fsp.chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('token usage metering', () => {
  let server: http.Server;
  let baseUrl: string;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(() => {
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('flattens each usage event into a tenant/user-attributed metering row', async () => {
    const tenantId = `team-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const projectId = `proj-${randomUUID()}`;
    const assistantMessageId = `msg-${randomUUID()}`;
    const model = 'anthropic/claude-usage-test';
    const identityHeaders = {
      'X-Tenant-Id': tenantId,
      'X-OD-User-Id': userId,
    };

    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identityHeaders },
      body: JSON.stringify({ id: projectId, name: 'token usage fixture' }),
    });
    expect(createProject.ok).toBe(true);

    const createConversation = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...identityHeaders },
        body: JSON.stringify({ title: 'token usage fixture' }),
      },
    );
    expect(createConversation.ok).toBe(true);
    const conversationId = ((await createConversation.json()) as {
      conversation: { id: string };
    }).conversation.id;
    expect(conversationId).toBeTruthy();

    // The web client pre-creates the assistant message row before starting
    // the run; agent events (including usage) append onto that row.
    const createAssistantMessage = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages/${assistantMessageId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...identityHeaders },
        body: JSON.stringify({ role: 'assistant', content: '' }),
      },
    );
    expect(createAssistantMessage.ok).toBe(true);

    await withFakeAgent(
      'opencode',
      `
console.log(JSON.stringify({ type: 'step_start' }));
console.log(JSON.stringify({ type: 'text', part: { text: 'hello from fake agent' } }));
console.log(JSON.stringify({
  type: 'step_finish',
  part: {
    tokens: { input: 1200, output: 34, reasoning: 5, cache: { read: 7, write: 3 } },
    cost: 0.0123,
  },
}));
process.exit(0);
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...identityHeaders },
          body: JSON.stringify({
            agentId: 'opencode',
            projectId,
            conversationId,
            // The web client pre-creates the assistant row id and passes it in;
            // without it the run has no assistant message to persist events to.
            assistantMessageId,
            model,
            message: 'hello',
          }),
        });
        const body = await response.text();
        expect(response.ok).toBe(true);
        expect(body).toContain('"status":"succeeded"');
      },
    );

    // The metering insert is fired off the SSE relay without blocking the
    // stream, so the response can complete a beat before the row commits.
    const db = await openDatabase(process.cwd());
    let rows: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      rows = await db.prepare(
        `SELECT tenant_id AS tenantId, user_id AS userId, project_id AS projectId,
                conversation_id AS conversationId, message_id AS messageId,
                run_id AS runId, agent_id AS agentId, model,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                reasoning_tokens AS reasoningTokens,
                cache_read_tokens AS cacheReadTokens,
                cache_write_tokens AS cacheWriteTokens,
                cost_usd AS costUsd, created_at AS createdAt
           FROM message_token_usage
          WHERE conversation_id = ?`,
      ).all(conversationId);
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(rows).toHaveLength(1);
    const usageRow = rows[0]!;
    expect(usageRow).toMatchObject({
      tenantId,
      userId,
      projectId,
      conversationId,
      agentId: 'opencode',
      model,
      inputTokens: 1200,
      outputTokens: 34,
      reasoningTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
    expect(usageRow.messageId).toBeTruthy();
    expect(usageRow.runId).toBeTruthy();
    expect(usageRow.costUsd as number).toBeCloseTo(0.0123, 6);
    expect(typeof usageRow.createdAt).toBe('number');

    // The persisted usage event inside events_json carries the same model
    // attribution and token breakdown.
    const messageRow = await db.prepare(
      `SELECT events_json AS eventsJson FROM messages WHERE id = ? AND tenant_id = ?`,
    ).get(usageRow.messageId, tenantId) as { eventsJson: string } | undefined;
    expect(messageRow).toBeTruthy();
    const events = JSON.parse(messageRow!.eventsJson) as Array<Record<string, unknown>>;
    const usageEvent = events.find((event) => event.kind === 'usage');
    expect(usageEvent).toMatchObject({
      kind: 'usage',
      model,
      inputTokens: 1200,
      outputTokens: 34,
      reasoningTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
  });
});
