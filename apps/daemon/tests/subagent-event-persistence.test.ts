import { describe, expect, it } from 'vitest';
import { daemonAgentPayloadToPersistedAgentEvent } from '../src/runtimes/chat-run-messages.js';

describe('subagent event persistence', () => {
  it('persists identity, parent grouping, lifecycle and nested child events', () => {
    expect(daemonAgentPayloadToPersistedAgentEvent({
      type: 'subagent_event',
      parentSessionId: 'main-1',
      parentToolCallId: 'agent-call-1',
      sessionId: 'child-1',
      name: 'auditor',
      agentType: 'explore',
      description: 'Audit the flow',
      seq: 7,
      state: 'running',
      event: { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } },
    })).toEqual({
      kind: 'subagent',
      parentSessionId: 'main-1',
      parentToolCallId: 'agent-call-1',
      sessionId: 'child-1',
      name: 'auditor',
      agentType: 'explore',
      description: 'Audit the flow',
      seq: 7,
      state: 'running',
      event: { kind: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } },
    });
  });

  it('persists a nested child error message', () => {
    expect(daemonAgentPayloadToPersistedAgentEvent({
      type: 'subagent_event',
      parentSessionId: 'main-1',
      parentToolCallId: 'agent-call-1',
      sessionId: 'child-1',
      state: 'error',
      event: { type: 'error', message: 'child failed' },
    })).toMatchObject({
      kind: 'subagent',
      state: 'error',
      event: { kind: 'error', message: 'child failed' },
    });
  });
});
