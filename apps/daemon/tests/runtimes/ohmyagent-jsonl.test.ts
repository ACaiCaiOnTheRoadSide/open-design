import { describe, expect, it } from 'vitest';
import { createOhMyAgentJsonlHandler } from '../../src/runtimes/ohmyagent-jsonl.js';

const frame = (type: string, data: unknown = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, session_id: 's1', turn_id: 't1', data, timestamp: 1, ...extra });

describe('OhMyAgent JSONL parser', () => {
  it('captures the first top-level session and reconciles model_done without duplicates', () => {
    const events: any[] = [];
    const parser = createOhMyAgentJsonlHandler((event) => events.push(event));
    parser.feed([
      frame('model_start'),
      frame('model_delta', { text: 'hel' }),
      frame('thinking_delta', { text: 'why' }),
      frame('model_done', { text: 'hello', thinking: 'why' }),
      frame('model_delta', { text: 'sub' }, { session_id: 'sub', parent_session_id: 's1' }),
      frame('turn_done'),
    ].join('\n') + '\n');
    expect(events.filter((event) => event.type === 'status' && event.sessionId)).toEqual([
      expect.objectContaining({ type: 'status', sessionId: 's1' }),
    ]);
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.delta)).toEqual(['hello']);
    expect(events.filter((event) => event.type === 'thinking_delta').map((event) => event.delta)).toEqual(['why']);
    expect(events.filter((event) => ['model_running', 'model_done'].includes(event.label))).toEqual([]);
  });

  it('moves pre-tool model narration into thinking and keeps the final pass as text', () => {
    const events: any[] = [];
    const parser = createOhMyAgentJsonlHandler((event) => events.push(event));
    for (const line of [
      frame('model_start'),
      frame('model_delta', { text: 'Let me inspect.' }),
      frame('model_done', { text: 'Let me inspect.' }),
      frame('tool_call', { id: 'tc', name: 'Bash', input: {} }, { tool_call_id: 'tc' }),
      frame('tool_result', { tool: 'Bash', content: 'ok' }, { tool_call_id: 'tc' }),
      frame('model_start'),
      frame('model_delta', { text: '处理完成' }),
      frame('model_done', { text: '处理完成' }),
      frame('turn_done'),
    ]) parser.feed(`${line}\n`);
    expect(events.filter((event) => event.type === 'thinking_delta').map((event) => event.delta)).toEqual(['Let me inspect.']);
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.delta)).toEqual(['处理完成']);
  });

  it('maps tools, usage, todos and terminal/progress events', () => {
    const events: any[] = [];
    const parser = createOhMyAgentJsonlHandler((event) => events.push(event));
    for (const line of [
      frame('tool_call', { id: 'tc', name: 'Bash', input: { command: 'pwd' } }, { tool_call_id: 'tc' }),
      frame('tool_result', { tool: 'Bash', content: 'ok', is_error: false }, { tool_call_id: 'tc' }),
      frame('usage', { input_tokens: 2, output_tokens: 3 }),
      frame('todo_update', { todos: [{ content: 'x', status: 'completed' }] }),
      frame('compaction', { kind: 'auto', status: 'starting' }),
      frame('session_summary', { summary: 'x' }),
      frame('turn_done'),
    ]) parser.feed(`${line}\n`);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', id: 'tc', name: 'Bash' }),
      expect.objectContaining({ type: 'tool_result', toolUseId: 'tc', isError: false }),
      expect.objectContaining({ type: 'usage', usage: { input_tokens: 2, output_tokens: 3 } }),
      expect.objectContaining({ type: 'tool_use', name: 'TodoWrite' }),
    ]));
    expect(events.filter((event) => ['compaction', 'session_summary', 'turn_done'].includes(event.label))).toEqual([]);
  });

  it('keeps transient_retry non-terminal and preserves lossless-only payloads as raw', () => {
    const events: any[] = [];
    const parser = createOhMyAgentJsonlHandler((event) => events.push(event));
    for (const type of ['agent_result', 'task_notification', 'report_findings']) {
      parser.feed(`${frame(type, { secretStructure: true })}\n`);
    }
    parser.feed(`${frame('send_user_message', { message: 'notice', status: 'proactive' })}\n`);
    parser.feed(`${frame('error', { error: 'retry', kind: 'transient_retry', attempt: '1', retry_in: '1s' })}\n`);
    parser.feed(`${frame('error', { error: 'fatal' })}\n`);
    expect(events.filter((event) => event.type === 'raw')).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', delta: 'notice' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', label: 'retrying' }));
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
  });

  it('routes child activity and completion into an isolated subagent stream', () => {
    const events: any[] = [];
    const parser = createOhMyAgentJsonlHandler((event) => events.push(event));
    const parent = {
      session_id: 'child-session',
      parent_session_id: 's1',
      parent_tool_call_id: 'agent-call-1',
      parent_name: 'auditor',
      parent_agent_type: 'explore',
      parent_description: 'Audit the flow',
      seq: 4,
    };
    parser.feed(`${frame('model_delta', { text: 'I will inspect.' }, parent)}\n`);
    parser.feed(`${frame('tool_call', { id: 'read-1', name: 'Read', input: {} }, { ...parent, tool_call_id: 'read-1' })}\n`);
    parser.feed(`${frame('tool_result', { content: 'ok' }, { ...parent, tool_call_id: 'read-1' })}\n`);
    parser.feed(`${frame('error', { error: 'child failed' }, parent)}\n`);
    parser.feed(`${frame('agent_result', { status: 'completed', agentId: 'agent-1', agentType: 'explore', sessionId: 'child-session', content: 'done' }, { tool_call_id: 'agent-call-1' })}\n`);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([]);
    expect(events.filter((event) => event.type === 'subagent_event')).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentToolCallId: 'agent-call-1', sessionId: 'child-session', description: 'Audit the flow', state: 'running' }),
      expect.objectContaining({ state: 'running', event: { type: 'thinking_delta', delta: 'I will inspect.' } }),
      expect.objectContaining({ state: 'error', event: expect.objectContaining({ type: 'error', message: 'child failed' }) }),
      expect.objectContaining({ parentToolCallId: 'agent-call-1', sessionId: 'child-session', state: 'completed' }),
    ]));
  });

  it('preserves malformed JSON and parses a final unterminated line', () => {
    const events: any[] = [];
    const parser = createOhMyAgentJsonlHandler((event) => events.push(event));
    parser.feed('{bad}\n' + frame('model_delta', { text: 'tail' }));
    parser.flush();
    expect(events).toEqual(expect.arrayContaining([
      { type: 'raw', line: '{bad}', malformed: true },
      { type: 'text_delta', delta: 'tail' },
    ]));
  });
});
