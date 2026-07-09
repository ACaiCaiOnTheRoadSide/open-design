// @vitest-environment jsdom

/**
 * The daemon stamps a terminal end reason on every run (`run_end` status
 * event: user cancel, output truncation, quiet-period wrap-up, clean turn
 * end). The assistant footer must translate that into a human-readable "why
 * did this stop" label instead of silently flipping to "Done" — and the raw
 * `run_end` event must never render as an inline status pill.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
      setItem: (k: string, v: string) => store.set(k, v),
    },
  });
});

afterEach(cleanup);

function endedMessage(
  runStatus: ChatMessage['runStatus'],
  endReason?: { code: string; detail?: string },
): ChatMessage {
  return {
    id: 'msg-ended',
    role: 'assistant',
    content: 'partial reply',
    runStatus,
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [
      { kind: 'text', text: 'partial reply' },
      ...(endReason
        ? [{ kind: 'status', label: 'run_end', ...endReason }]
        : []),
    ] as ChatMessage['events'],
    producedFiles: [],
  } as ChatMessage;
}

describe('AssistantMessage terminal end reason', () => {
  it('shows the manual-stop label for a user-canceled run', () => {
    render(
      <AssistantMessage
        message={endedMessage('canceled', { code: 'user_canceled' })}
        streaming={false}
        projectId="p1"
        onFeedback={vi.fn()}
      />,
    );
    expect(screen.getByText('Stopped manually')).toBeTruthy();
  });

  it('shows the truncation label (with the raw detail as tooltip) when the model hit max_tokens', () => {
    render(
      <AssistantMessage
        message={endedMessage('succeeded', { code: 'output_truncated', detail: 'max_tokens' })}
        streaming={false}
        projectId="p1"
        onFeedback={vi.fn()}
      />,
    );
    const label = screen.getByText('Output length limit reached — the reply may be truncated');
    expect(label).toBeTruthy();
    expect(label.getAttribute('title')).toBe('max_tokens');
  });

  it('keeps the plain Done label for a clean completion', () => {
    render(
      <AssistantMessage
        message={endedMessage('succeeded', { code: 'completed' })}
        streaming={false}
        projectId="p1"
        onFeedback={vi.fn()}
      />,
    );
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('falls back to the run status for history without a stamped reason', () => {
    render(
      <AssistantMessage
        message={endedMessage('canceled')}
        streaming={false}
        projectId="p1"
        onFeedback={vi.fn()}
      />,
    );
    expect(screen.getByText('Stopped manually')).toBeTruthy();
  });

  it('never renders the run_end event as an inline status pill', () => {
    render(
      <AssistantMessage
        message={endedMessage('succeeded', { code: 'completed' })}
        streaming={false}
        projectId="p1"
        onFeedback={vi.fn()}
      />,
    );
    expect(screen.queryByText('run_end')).toBeNull();
  });
});
