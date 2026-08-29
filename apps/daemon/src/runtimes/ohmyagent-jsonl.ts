type CanonicalEvent = Record<string, unknown>;
type Emit = (event: CanonicalEvent) => void;

type AgentEvent = {
  type?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
  tool_call_id?: unknown;
  parent_session_id?: unknown;
  data?: unknown;
  [key: string]: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function rawEvent(event: AgentEvent, reason?: string): CanonicalEvent {
  return { type: 'raw', line: JSON.stringify(event), raw: event, ...(reason ? { reason } : {}) };
}

/**
 * Parses the top-level AgentEvent JSONL emitted by OhMyAgent JSONLinesSink.
 * Invalid complete lines are preserved as raw. flush() parses a non-newline
 * terminated tail with the same rule; an empty final line is ignored.
 */
export function createOhMyAgentJsonlHandler(onEvent: Emit) {
  let buffer = '';
  let capturedSession = false;
  let modelText = '';
  let thinkingText = '';

  const emitAuthoritative = (
    kind: 'text' | 'thinking',
    complete: string,
    streamed: string,
    event: AgentEvent,
  ) => {
    if (!complete || complete === streamed) return;
    if (complete.startsWith(streamed)) {
      const suffix = complete.slice(streamed.length);
      if (suffix) onEvent({ type: kind === 'text' ? 'text_delta' : 'thinking_delta', delta: suffix });
      return;
    }
    // Canonical deltas cannot retract already rendered bytes. Preserve the
    // authoritative model_done payload rather than fabricating a lossy delta.
    onEvent(rawEvent(event, `${kind}_reconciliation`));
  };

  const handle = (line: string) => {
    let event: AgentEvent;
    try { event = JSON.parse(line) as AgentEvent; } catch {
      onEvent({ type: 'raw', line, malformed: true });
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      onEvent({ type: 'raw', raw: event });
      return;
    }
    const type = text(event.type);
    const data = record(event.data);
    const topLevel = !text(event.parent_session_id);
    if (!capturedSession && topLevel && text(event.session_id)) {
      capturedSession = true;
      onEvent({ type: 'status', label: 'running', sessionId: event.session_id });
    }

    switch (type) {
      case 'model_start':
        modelText = '';
        thinkingText = '';
        return;
      case 'model_delta': {
        const delta = text(data.text);
        modelText += delta;
        if (delta) onEvent({ type: 'text_delta', delta });
        return;
      }
      case 'thinking_delta': {
        const delta = text(data.text);
        thinkingText += delta;
        if (delta) onEvent({ type: 'thinking_delta', delta });
        return;
      }
      case 'model_done':
        emitAuthoritative('text', text(data.text), modelText, event);
        emitAuthoritative('thinking', text(data.thinking), thinkingText, event);
        return;
      case 'tool_call': {
        const id = text(event.tool_call_id) || text(data.id);
        const name = text(data.name);
        if (id && name) onEvent({ type: 'tool_use', id, name, input: data.input ?? null, raw: event });
        else onEvent(rawEvent(event, 'invalid_tool_call'));
        return;
      }
      case 'tool_result': {
        const id = text(event.tool_call_id);
        if (id) onEvent({ type: 'tool_result', toolUseId: id, content: text(data.content), isError: data.is_error === true, raw: event });
        else onEvent(rawEvent(event, 'invalid_tool_result'));
        return;
      }
      case 'usage':
        onEvent({ type: 'usage', usage: data, raw: event });
        return;
      case 'error':
        if (data.kind === 'transient_retry') {
          onEvent({ type: 'status', label: 'retrying', message: text(data.error), attempt: data.attempt, retryIn: data.retry_in, raw: event });
        } else {
          onEvent({ type: 'error', message: text(data.error) || 'OhMyAgent error', raw: JSON.stringify(event) });
        }
        return;
      case 'turn_done':
        if (data.structured_output !== undefined) {
          onEvent({ type: 'status', label: 'turn_done', structuredOutput: data.structured_output, raw: event });
        }
        return;
      case 'send_user_message': {
        const message = text(data.message);
        if (message) onEvent({ type: 'text_delta', delta: message, raw: event });
        else onEvent(rawEvent(event));
        return;
      }
      case 'todo_update':
        onEvent({ type: 'tool_use', id: `ohmyagent-todo-${text(event.turn_id) || 'turn'}`, name: 'TodoWrite', input: { todos: data.todos }, raw: event });
        return;
      case 'compaction':
      case 'session_summary':
        return;
      case 'agent_result':
      case 'task_notification':
      case 'report_findings':
        onEvent(rawEvent(event));
        return;
      case 'user_message':
        return;
      default:
        onEvent(rawEvent(event));
    }
  };

  return {
    feed(chunk: string) {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handle(line);
      }
    },
    flush() {
      const tail = buffer.replace(/\r$/u, '');
      buffer = '';
      if (tail.trim()) handle(tail);
    },
  };
}
