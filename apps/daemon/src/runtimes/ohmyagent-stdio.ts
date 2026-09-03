import type { ExecutionHandle } from './execution/transport.js';

type JsonRecord = Record<string, unknown>;
type Emit = (event: JsonRecord) => void;

export interface OhMyAgentStdioOptions {
  execution: Pick<ExecutionHandle, 'stdin' | 'stdout' | 'result' | 'writeStdin' | 'endStdin'>;
  prompt: string;
  cwd: string;
  model?: string | null;
  modelConfig?: JsonRecord | null;
  mcpConfig?: JsonRecord | null;
  onEvent: (event: JsonRecord) => void;
  onReady?: () => void;
  onSession?: (sessionId: string) => void;
  reclaimRetryMs?: number;
  rpcTimeoutMs?: number;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function attachOhMyAgentStdioSession(options: OhMyAgentStdioOptions) {
  const { execution } = options;
  if (!execution.stdin) {
    throw new Error('OhMyAgent stdio requires an interactive execution transport');
  }

  let buffer = '';
  let nextId = 1;
  let sessionId = '';
  let closed = false;
  let fatal = false;
  let completed = false;
  let reclaiming = false;
  let notificationTurn = false;
  let reclaimTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, {
    resolve: (value: JsonRecord) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const fail = (error: Error) => {
    if (closed) return;
    fatal = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    options.onEvent({ type: 'error', message: error.message });
    closed = true;
    try { execution.endStdin(); } catch {}
  };
  execution.stdin.on('error', (error: NodeJS.ErrnoException) => {
    fail(new Error(`OhMyAgent stdin failed: ${error.message}`));
  });

  const request = (method: string, params: JsonRecord): Promise<JsonRecord> => {
    if (closed) return Promise.reject(new Error('OhMyAgent stdio session is closed'));
    const id = nextId++;
    const promise = new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`OhMyAgent ${method} timed out`));
      }, options.rpcTimeoutMs ?? 30_000);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
    });
    try {
      execution.writeStdin(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (error) {
      const waiter = pending.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      pending.delete(id);
    }
    return promise;
  };

  const scheduleReclaim = () => {
    if (closed || reclaimTimer) return;
    reclaimTimer = setTimeout(() => {
      reclaimTimer = null;
      void reclaim();
    }, options.reclaimRetryMs ?? 3000);
    reclaimTimer.unref?.();
  };

  const reclaim = async () => {
    if (!sessionId || closed || reclaiming) return;
    reclaiming = true;
    try {
      const result = await request('session/reclaim', { session_id: sessionId });
      if (result.status === 'reclaimed') {
        completed = true;
        closed = true;
        if (reclaimTimer) clearTimeout(reclaimTimer);
        reclaimTimer = null;
        execution.endStdin();
      } else {
        scheduleReclaim();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reclaiming = false;
    }
  };

  const handle = (line: string) => {
    let message: JsonRecord;
    try {
      message = record(JSON.parse(line));
    } catch {
      fail(new Error(`Invalid OhMyAgent JSON-RPC frame: ${line.slice(0, 200)}`));
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      const rpcError = record(message.error);
      if (Object.keys(rpcError).length > 0) {
        waiter.reject(new Error(String(rpcError.message || 'OhMyAgent JSON-RPC request failed')));
      } else {
        waiter.resolve(record(message.result));
      }
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const params = record(message.params);
    if (method === 'system/ready') {
      options.onReady?.();
      const capabilities = Array.isArray(params.capabilities) ? params.capabilities : [];
      if (!capabilities.includes('sessionSafeReclaim')) {
        fail(new Error('OhMyAgent does not support safe session reclaim'));
        return;
      }
      void request('session/create', {
        cwd: options.cwd,
        permission_mode: 'bypassPermissions',
        execution_mode: 'autonomous',
        interactive: true,
        ...(options.model && options.model !== 'default' ? { model: options.model } : {}),
        ...(options.modelConfig ? { model_config: options.modelConfig } : {}),
        ...(options.mcpConfig ? { mcp_config: options.mcpConfig } : {}),
      }).then((result) => {
        sessionId = String(result.session_id || '');
        if (!sessionId) throw new Error('OhMyAgent session/create returned no session_id');
        options.onSession?.(sessionId);
        return request('session/sendMessage', { session_id: sessionId, message: options.prompt });
      }).catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (method === 'event/stream') {
      if (
        notificationTurn &&
        !params.parent_session_id &&
        params.type !== 'task_notification' &&
        params.type !== 'send_user_message'
      ) return;
      options.onEvent(params);
      return;
    }
    if (method === 'turn/started') {
      notificationTurn = params.source === 'notification';
      options.onEvent({ type: 'status', label: 'running', source: params.source });
      return;
    }
    if (method === 'turn/stopped' && params.session_id === sessionId) {
      notificationTurn = false;
      const reason = String(params.stop_reason || 'complete');
      if (reason === 'error') {
        fatal = true;
        options.onEvent({ type: 'error', message: String(params.error || 'OhMyAgent turn failed') });
      }
      void reclaim();
      return;
    }
    if (method === 'events/dropped') {
      options.onEvent({ type: 'status', label: 'stream_reconciled', detail: 'OhMyAgent dropped streaming deltas; final model output was reconciled.' });
    }
  };

  execution.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) handle(line);
    }
  });
  void execution.result.then(() => {
    if (reclaimTimer) clearTimeout(reclaimTimer);
    const tail = buffer.replace(/\r$/u, '');
    buffer = '';
    if (tail.trim()) handle(tail);
    if (!completed && !fatal) fail(new Error('OhMyAgent exited before its session was safely reclaimed'));
    closed = true;
  });

  return {
    abort() {
      closed = true;
      if (reclaimTimer) clearTimeout(reclaimTimer);
      reclaimTimer = null;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('OhMyAgent session aborted'));
      }
      pending.clear();
    },
    hasFatalError: () => fatal,
    completedSuccessfully: () => completed && !fatal,
  };
}
