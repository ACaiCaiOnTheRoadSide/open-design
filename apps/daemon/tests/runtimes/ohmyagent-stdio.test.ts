import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { attachOhMyAgentStdioSession } from '../../src/runtimes/ohmyagent-stdio.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('OhMyAgent stdio session', () => {
  it('keeps stdin open while reclaim is busy and closes only after reclaimed', async () => {
    const stdout = new PassThrough();
    const writes: any[] = [];
    let ended = false;
    const execution = {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(),
      result: new Promise(() => undefined),
      writeStdin(chunk: string) { writes.push(JSON.parse(chunk)); return true; },
      endStdin() { ended = true; },
    } as any;
    const events: any[] = [];

    attachOhMyAgentStdioSession({
      execution,
      prompt: 'do work',
      cwd: '/workspace',
      reclaimRetryMs: 5,
      onEvent: (event) => events.push(event),
    });

    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'system/ready', params: { capabilities: ['sessionSafeReclaim'] } })}\n`);
    await tick();
    expect(writes[0]).toMatchObject({ method: 'session/create', params: { cwd: '/workspace', execution_mode: 'autonomous' } });

    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: writes[0].id, result: { session_id: 'main-1' } })}\n`);
    await tick();
    expect(writes[1]).toMatchObject({ method: 'session/sendMessage', params: { session_id: 'main-1', message: 'do work' } });
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: writes[1].id, result: { status: 'ok' } })}\n`);
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/stopped', params: { session_id: 'main-1', stop_reason: 'complete' } })}\n`);
    await tick();

    expect(writes[2]).toMatchObject({ method: 'session/reclaim', params: { session_id: 'main-1' } });
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: writes[2].id, result: { status: 'busy', running_subagents: 1 } })}\n`);
    await tick();
    expect(ended).toBe(false);

    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/stopped', params: { session_id: 'main-1', source: 'notification', stop_reason: 'complete' } })}\n`);
    await tick();
    const reclaim = writes.at(-1);
    expect(reclaim.method).toBe('session/reclaim');
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: reclaim.id, result: { status: 'reclaimed' } })}\n`);
    await tick();
    expect(ended).toBe(true);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('does not forward internal notification-turn model output', async () => {
    const stdout = new PassThrough();
    const writes: any[] = [];
    const execution = {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), result: new Promise(() => undefined),
      writeStdin(chunk: string) { writes.push(JSON.parse(chunk)); return true; }, endStdin() {},
    } as any;
    const events: any[] = [];
    attachOhMyAgentStdioSession({ execution, prompt: 'x', cwd: '/workspace', onEvent: (event) => events.push(event) });
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { source: 'notification' } })}\n`);
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event/stream', params: { type: 'model_delta', session_id: 'main-1', data: { text: '<task-notification>internal' } } })}\n`);
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event/stream', params: { type: 'tool_call', session_id: 'child-1', parent_session_id: 'main-1', parent_tool_call_id: 'agent-1', data: { id: 'read-1', name: 'Read' } } })}\n`);
    await tick();
    expect(events.some((event) => event.type === 'model_delta')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', session_id: 'child-1' }));
  });

  it('contains stdin errors and fails only the active session', async () => {
    const stdin = new PassThrough();
    const events: any[] = [];
    let ended = false;
    const session = attachOhMyAgentStdioSession({
      execution: {
        stdin,
        stdout: new PassThrough(),
        result: new Promise(() => undefined),
        writeStdin: () => true,
        endStdin: () => { ended = true; },
      },
      prompt: 'x',
      cwd: '/workspace',
      onEvent: (event) => events.push(event),
    });

    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await tick();

    expect(session.hasFatalError()).toBe(true);
    expect(ended).toBe(true);
    expect(events).toContainEqual({ type: 'error', message: 'OhMyAgent stdin failed: write EPIPE' });
  });

  it('fails a JSON-RPC request that never receives a response', async () => {
    const stdout = new PassThrough();
    const events: any[] = [];
    const session = attachOhMyAgentStdioSession({
      execution: {
        stdin: new PassThrough(),
        stdout,
        result: new Promise(() => undefined),
        writeStdin: () => true,
        endStdin: () => undefined,
      },
      prompt: 'x',
      cwd: '/workspace',
      rpcTimeoutMs: 5,
      onEvent: (event) => events.push(event),
    });

    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'system/ready', params: { capabilities: ['sessionSafeReclaim'] } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(session.hasFatalError()).toBe(true);
    expect(events).toContainEqual({ type: 'error', message: 'OhMyAgent session/create timed out' });
  });
});
