type CanonicalEvent = Record<string, unknown>;
type Emit = (event: CanonicalEvent) => void;

type AgentEvent = {
  type?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
  tool_call_id?: unknown;
  parent_session_id?: unknown;
  parent_tool_call_id?: unknown;
  parent_name?: unknown;
  parent_agent_type?: unknown;
  parent_type?: unknown;
  parent_description?: unknown;
  seq?: unknown;
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
  type Lane = { modelText: string; thinkingText: string; hadVisibleText: boolean; directText: boolean };
  const lanes = new Map<string, Lane>();
  const laneEvents = new Map<string, AgentEvent>();
  const agentGroups = new Map<string, { parentSessionId: string; parentToolCallId: string; sessionId: string; name: string; agentType: string; description: string }>();
  const toolGroups = new Map<string, { parentSessionId: string; parentToolCallId: string; sessionId: string; name: string; agentType: string; description: string }>();
  const laneFor = (key: string) => {
    let lane = lanes.get(key);
    if (!lane) { lane = { modelText: '', thinkingText: '', hadVisibleText: false, directText: false }; lanes.set(key, lane); }
    return lane;
  };

  const emitFor = (event: AgentEvent, childEvent: CanonicalEvent) => {
    const parentSessionId = text(event.parent_session_id);
    const parentToolCallId = text(event.parent_tool_call_id);
    if (!parentSessionId) { onEvent(childEvent); return; }
    if (!parentToolCallId) { onEvent(rawEvent(event, 'missing_parent_tool_call_id')); return; }
    toolGroups.set(parentToolCallId, {
      parentSessionId, parentToolCallId, sessionId: text(event.session_id),
      name: text(event.parent_name), agentType: text(event.parent_agent_type) || text(event.parent_type),
      description: text(event.parent_description),
    });
    onEvent({
      type: 'subagent_event', parentSessionId, parentToolCallId,
      sessionId: text(event.session_id), name: text(event.parent_name),
      agentType: text(event.parent_agent_type) || text(event.parent_type),
      description: text(event.parent_description), seq: typeof event.seq === 'number' ? event.seq : undefined,
      state: childEvent.type === 'error' ? 'error' : 'running', event: childEvent,
    });
  };
  const flushModelText = (event: AgentEvent, kind: 'text' | 'thinking') => {
    const lane = laneFor(text(event.session_id) || 'main');
    if (lane.modelText) {
      if (!lane.directText) emitFor(event, { type: kind === 'text' ? 'text_delta' : 'thinking_delta', delta: lane.modelText });
      if (kind === 'text') lane.hadVisibleText = true;
      lane.modelText = '';
      lane.directText = false;
    }
  };

  const emitAuthoritative = (
    kind: 'text' | 'thinking',
    complete: string,
    lane: Lane,
    event: AgentEvent,
  ) => {
    const streamed = kind === 'text' ? lane.modelText : lane.thinkingText;
    if (!complete || complete === streamed) return;
    if (complete.startsWith(streamed)) {
      const suffix = complete.slice(streamed.length);
      if (suffix) {
        if (kind === 'text' && lane.directText) {
          emitFor(event, { type: 'text_delta', delta: suffix });
          lane.modelText += suffix;
          lane.hadVisibleText = true;
        } else if (kind === 'text') lane.modelText += suffix;
        else emitFor(event, { type: 'thinking_delta', delta: suffix });
      }
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
    const laneKey = text(event.session_id) || 'main';
    const lane = laneFor(laneKey);
    laneEvents.set(laneKey, event);
    const topLevel = !text(event.parent_session_id);
    if (!capturedSession && topLevel && text(event.session_id)) {
      capturedSession = true;
      onEvent({ type: 'status', label: 'running', sessionId: event.session_id });
    }

    switch (type) {
      case 'model_start':
        // A new model pass after uncommitted prose means the preceding pass
        // continued into tool work. Keep that narration in the thinking lane.
        flushModelText(event, 'thinking');
        lane.thinkingText = '';
        return;
      case 'model_delta': {
        const delta = text(data.text);
        lane.modelText += delta;
        return;
      }
      case 'thinking_delta': {
        const delta = text(data.text);
        lane.thinkingText += delta;
        if (delta) emitFor(event, { type: 'thinking_delta', delta });
        return;
      }
      case 'model_done':
        emitAuthoritative('text', text(data.text), lane, event);
        emitAuthoritative('thinking', text(data.thinking), lane, event);
        return;
      case 'tool_call': {
        // MiniMax can expose pre-tool narration as model_delta rather than a
        // dedicated thinking_delta. Once a tool call follows, that segment is
        // execution reasoning, not the assistant's final answer.
        flushModelText(event, 'thinking');
        const id = text(event.tool_call_id) || text(data.id);
        const name = text(data.name);
        if (id && name) emitFor(event, { type: 'tool_use', id, name, input: data.input ?? null, raw: event });
        else onEvent(rawEvent(event, 'invalid_tool_call'));
        return;
      }
      case 'tool_result': {
        const id = text(event.tool_call_id);
        if (id) emitFor(event, { type: 'tool_result', toolUseId: id, content: text(data.content), isError: data.is_error === true, raw: event });
        else onEvent(rawEvent(event, 'invalid_tool_result'));
        return;
      }
      case 'usage':
        emitFor(event, { type: 'usage', usage: data, raw: event });
        return;
      case 'error':
        if (data.kind === 'transient_retry') {
          emitFor(event, { type: 'status', label: 'retrying', detail: text(data.error), raw: event });
        } else {
          emitFor(event, { type: 'error', message: text(data.error) || 'OhMyAgent error', raw: JSON.stringify(event) });
        }
        return;
      case 'turn_done':
        flushModelText(event, 'text');
        if (data.structured_output !== undefined) {
          onEvent({ type: 'status', label: 'turn_done', structuredOutput: data.structured_output, raw: event });
        }
        return;
      case 'send_user_message': {
        const message = text(data.message);
        if (message) emitFor(event, { type: 'text_delta', delta: message, raw: event });
        else onEvent(rawEvent(event));
        return;
      }
      case 'todo_update':
        emitFor(event, { type: 'tool_use', id: `ohmyagent-todo-${text(event.turn_id) || 'turn'}`, name: 'TodoWrite', input: { todos: data.todos }, raw: event });
        return;
      case 'compaction':
      case 'session_summary':
        return;
      case 'agent_result': {
        const parentToolCallId = text(event.tool_call_id);
        if (!parentToolCallId) { onEvent(rawEvent(event, 'invalid_agent_result')); return; }
        const childSessionId = text(data.sessionId);
        const known = toolGroups.get(parentToolCallId);
        const group = {
          parentSessionId: text(event.session_id), parentToolCallId,
          sessionId: childSessionId || known?.sessionId || '', name: known?.name || '',
          agentType: text(data.agentType) || known?.agentType || '', description: known?.description || '',
        };
        const agentId = text(data.agentId);
        if (agentId) agentGroups.set(agentId, group);
        const childLane = laneFor(childSessionId || `tool:${parentToolCallId}`);
        const content = text(data.content);
        onEvent({ type: 'subagent_event', ...group, state: text(data.status) || 'completed',
          ...(content && !childLane.hadVisibleText ? { event: { type: 'text_delta', delta: content } } : {}) });
        return;
      }
      case 'task_notification': {
        if (text(data.source) === 'monitor') return;
        const group = agentGroups.get(text(data.agent_id));
        if (!group) return;
        const content = text(data.result);
        onEvent({ type: 'subagent_event', ...group, name: text(data.name) || group.name,
          agentType: text(data.agent_type) || group.agentType, description: text(data.description) || group.description,
          state: text(data.status) || 'completed', ...(content ? { event: { type: 'text_delta', delta: content } } : {}) });
        return;
      }
      case 'report_findings':
        emitFor(event, rawEvent(event));
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
      for (const [key, lane] of lanes) {
        if (lane.modelText) {
          if (!lane.directText) emitFor(laneEvents.get(key) ?? {}, { type: 'text_delta', delta: lane.modelText });
          lane.modelText = '';
          lane.directText = false;
        }
      }
    },
    handle,
  };
}
