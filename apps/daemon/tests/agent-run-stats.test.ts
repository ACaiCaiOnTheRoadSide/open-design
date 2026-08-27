import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { recordAgentRunTerminalFact } from '../src/routes/runs.js';
import { createChatRunService } from '../src/runtimes/runs.js';

describe('App Stats run terminal facts', () => {
  const admission = {
    principal: { tenantId: 'tenant-a', userId: 'user-a' },
    accessMode: 'online' as const,
    feature: 'agent.run' as const,
  };

  it('maps a genuinely waited successful attempt to success', async () => {
    const records: unknown[] = [];
    await recordAgentRunTerminalFact({
      wait: async () => ({ status: 'succeeded' }),
      runId: 'run-1',
      attempt: 1,
      admission,
      now: () => 99,
      record: async (fact, principal) => { records.push({ fact, principal }); },
    });
    expect(records).toEqual([{
      fact: {
        eventKey: 'agent-run:run-1:1', runId: 'run-1', attempt: 1,
        accessMode: 'online', feature: 'agent.run', result: 'success', completedAt: 99,
      },
      principal: admission.principal,
    }]);
  });

  it.each(['failed', 'canceled'])('maps waited %s to failed', async (status) => {
    const results: string[] = [];
    await recordAgentRunTerminalFact({
      wait: async () => ({ status }),
      runId: 'run-2',
      attempt: 2,
      admission,
      record: async (fact) => { results.push(fact.result); },
    });
    expect(results).toEqual(['failed']);
  });

  it('does not start execution when trusted stats admission cannot be persisted', () => {
    const runs = createChatRunService({
      createSseResponse: () => ({ send: () => true, end: () => {}, cleanup: () => {} }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      runsLogDir: '/dev/null/od-runs' as unknown as null,
    });
    const run = runs.create({ projectId: 'p', conversationId: 'c', agentId: 'amr' });
    let started = false;

    expect(() => (runs as any).start(run, async () => { started = true; }, {
      agentRunStatsAdmission: { ...admission, attempt: 1 },
    })).toThrow('Failed to persist App Stats run admission before execution');
    expect(started).toBe(false);
  });

  it('persists trusted stats admission when the run is armed', () => {
    const runsLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-stats-'));
    try {
      const runs = createChatRunService({
        createSseResponse: () => ({ send: () => true, end: () => {}, cleanup: () => {} }),
        createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
        runsLogDir: runsLogDir as unknown as null,
      });
      const run = runs.create({ projectId: 'p', conversationId: 'c', agentId: 'amr' });
      (runs as any).start(run, async () => {}, {
        agentRunStatsAdmission: { ...admission, attempt: 1 },
      });
      const state = JSON.parse(fs.readFileSync(path.join(runsLogDir, run.id, 'state.json'), 'utf8'));
      expect(state.agentRunStatsAdmission).toEqual({ ...admission, attempt: 1 });
    } finally {
      fs.rmSync(runsLogDir, { recursive: true, force: true });
    }
  });
});
